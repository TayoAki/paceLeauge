-- Age assurance (docs/ROADMAP.md, Phase 0 and decision 3).
-- PaceLeague is for adults. The app asks the App Store (Declared Age Range) or Google Play (Age
-- Signals) for the runner's age range where the platform provides one, and reports the outcome:
--   adult         the store says 18 or older
--   not_required  the store says age rules don't apply here, or has no answer outside a regulated
--                 region; the runner's own adult declaration (eligibility_ack_at) stands
--   minor         the store says under 18: no profile is created, and an existing one is locked
-- The server can't verify a device signal; it records what the app reported so the check is
-- auditable, and enforces the lock on every profile-scoped RPC.

alter table public.profiles
  add column age_signal text check (age_signal in ('adult', 'not_required', 'minor')),
  add column age_signal_source text check (age_signal_source is null or char_length(age_signal_source) between 1 and 32),
  add column age_checked_at timestamptz;

-- A locked account leaves its league the moment the store reports it as a minor.
alter table public.league_members drop constraint league_members_left_reason_check;
alter table public.league_members add constraint league_members_left_reason_check
  check (left_reason in ('left', 'removed', 'league_closed', 'account_deleted', 'age_restricted'));

-- Locked (minor) accounts can still read their account, export and delete (those use require_user).
create or replace function private.require_profile()
returns uuid
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_status text;
  v_age text;
begin
  select status, age_signal into v_status, v_age from public.profiles where user_id = v_uid;
  if v_status is null then
    perform private.fail('profile_required');
  elsif v_status <> 'active' then
    perform private.fail('account_deleting');
  elsif v_age = 'minor' then
    perform private.fail('age_restricted');
  end if;
  return v_uid;
end
$$;

create or replace function private.valid_age_report(p_signal text, p_source text)
returns boolean
language sql immutable set search_path = ''
as $$
  select p_signal in ('adult', 'not_required', 'minor')
     and (p_source is null or (char_length(p_source) between 1 and 32 and p_source ~ '^[A-Za-z0-9_]+$'))
$$;

-- Adding parameters would leave two overloads, which named-argument RPC calls can't choose between.
drop function public.save_profile(text, text, integer, text, boolean);

create or replace function public.save_profile(
  p_alias text,
  p_units text,
  p_goal_days integer,
  p_notification_tz text,
  p_ack_eligibility boolean default false,
  p_age_signal text default null,
  p_age_source text default null
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_profile public.profiles;
  v_alias text := private.normalize_name(p_alias);
  v_problem text;
begin
  select * into v_profile from public.profiles where user_id = v_uid for update;
  if found and v_profile.status <> 'active' then
    perform private.fail('account_deleting');
  end if;
  if found and v_profile.age_signal = 'minor' then
    perform private.fail('age_restricted');
  end if;
  if p_age_signal is not null and not private.valid_age_report(p_age_signal, p_age_source) then
    perform private.fail('invalid_input', 'age_signal');
  end if;
  if p_age_signal = 'minor' then
    perform private.fail('age_restricted');
  end if;

  v_problem := private.name_problem(v_alias, 2, 24);
  if v_problem = 'invalid' then
    perform private.fail('alias_invalid');
  elsif v_problem = 'not_allowed' then
    perform private.fail('alias_not_allowed');
  end if;
  if p_units is null or p_units not in ('metric', 'imperial') then
    perform private.fail('invalid_input', 'units');
  end if;
  if p_goal_days is not null and p_goal_days not between 1 and 3 then
    perform private.fail('invalid_input', 'goal_days');
  end if;
  if p_notification_tz is not null and not exists (select 1 from pg_catalog.pg_timezone_names where name = p_notification_tz) then
    perform private.fail('invalid_input', 'notification_tz');
  end if;

  if v_profile.user_id is null then
    if not coalesce(p_ack_eligibility, false) then
      perform private.fail('eligibility_required');
    end if;
    if not private.flag_enabled('registration_enabled') then
      perform private.fail('registration_paused');
    end if;
  elsif lower(v_profile.alias) <> lower(v_alias) then
    perform private.check_rate_limit('alias_change:' || v_uid, 10, interval '1 day');
  end if;

  if exists (select 1 from public.profiles where lower(alias) = lower(v_alias) and user_id <> v_uid) then
    perform private.fail('alias_taken');
  end if;

  begin
    if v_profile.user_id is null then
      insert into public.profiles (user_id, alias, units, goal_days, notification_tz, eligibility_ack_at,
                                   age_signal, age_signal_source, age_checked_at)
      values (v_uid, v_alias, p_units, p_goal_days, p_notification_tz, now(),
              p_age_signal, case when p_age_signal is null then null else p_age_source end,
              case when p_age_signal is null then null else now() end);
      insert into private.profile_stats (user_id) values (v_uid) on conflict (user_id) do nothing;
      perform private.log_server_event('onboarding_completed', v_uid,
        jsonb_build_object('goal_set', p_goal_days is not null, 'units', p_units));
    else
      update public.profiles
         set alias = v_alias, units = p_units, goal_days = p_goal_days, notification_tz = p_notification_tz,
             age_signal = coalesce(p_age_signal, age_signal),
             age_signal_source = case when p_age_signal is null then age_signal_source else p_age_source end,
             age_checked_at = case when p_age_signal is null then age_checked_at else now() end,
             updated_at = now()
       where user_id = v_uid;
    end if;
  exception when unique_violation then
    perform private.fail('alias_taken');
  end;
  return public.get_me();
end
$$;

-- For accounts that finished onboarding before the check existed, or whose store answer changed.
-- A minor report locks the account and removes it from its league at once; the runner can still
-- export and delete. Only a staff member can clear the lock (a store signal can be wrong, for
-- example on a shared Apple ID).
create or replace function public.record_age_signal(p_signal text, p_source text default null)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_profile public.profiles;
begin
  if not private.valid_age_report(p_signal, p_source) then
    perform private.fail('invalid_input', 'age_signal');
  end if;
  select * into v_profile from public.profiles where user_id = v_uid for update;
  if not found then
    perform private.fail('profile_required');
  end if;
  if v_profile.status <> 'active' then
    perform private.fail('account_deleting');
  end if;
  perform private.check_rate_limit('age_signal:' || v_uid, 20, interval '1 day');

  if v_profile.age_signal = 'minor' then
    -- Locked accounts stay locked until staff review; a later "adult" answer doesn't unlock them.
    return public.get_me();
  end if;

  update public.profiles
     set age_signal = p_signal, age_signal_source = p_source, age_checked_at = now(), updated_at = now()
   where user_id = v_uid;
  if p_signal = 'minor' then
    perform private.detach_from_league(v_uid, 'age_restricted');
    delete from public.blocks where blocker_id = v_uid or blocked_id = v_uid;
    perform private.log_server_event('age_restricted', null, jsonb_build_object('source', p_source));
  end if;
  return public.get_me();
end
$$;

-- Staff: clear a lock after checking the account holder's age another way.
create or replace function private.clear_age_restriction(p_user uuid, p_reason text, p_actor text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if p_reason is null or char_length(trim(p_reason)) < 3 then
    raise exception 'a reason is required';
  end if;
  update public.profiles
     set age_signal = 'adult', age_signal_source = 'staff_review', age_checked_at = now(), updated_at = now()
   where user_id = p_user and age_signal = 'minor';
  insert into private.audit_log (actor, action, target, reason)
  values (p_actor, 'clear_age_restriction', private.subject_ref(p_user), p_reason);
end
$$;

-- get_me reports the age fields so the app can show the locked screen and skip repeat checks.
create or replace function public.get_me()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_profile public.profiles;
  v_xp integer := private.lifetime_xp(v_uid);
begin
  select * into v_profile from public.profiles where user_id = v_uid;
  return jsonb_build_object(
    'user_id', v_uid,
    'profile', case when v_profile.user_id is null then null else jsonb_build_object(
      'alias', v_profile.alias,
      'units', v_profile.units,
      'goal_days', v_profile.goal_days,
      'notification_tz', v_profile.notification_tz,
      'status', v_profile.status,
      'created_at_ms', private.ts_to_ms(v_profile.created_at),
      'age_signal', v_profile.age_signal,
      'age_checked_at_ms', case when v_profile.age_checked_at is null then null else private.ts_to_ms(v_profile.age_checked_at) end) end,
    'lifetime_xp', v_xp,
    'tier', private.tier_name(v_xp),
    'is_staff', exists (select 1 from private.staff_roles where user_id = v_uid),
    'config', public.get_app_config()
  );
end
$$;

select private.apply_function_grants();
