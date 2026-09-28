-- Teen accounts in family leagues (docs/ROADMAP.md 4.10, decision 3).
--
-- 13 to 17 year olds can use PaceLeague for their own running and join family leagues that an
-- adult created, once that adult (the league's owner, confirming they're the parent or guardian)
-- approves them. Under 13 stays locked ('minor'). The store's age range sets the band:
--   teen_16_17   16 or 17
--   teen_13_15   13 to 15, who also can't bring in health data (heart rate, Apple Health,
--                Health Connect, Garmin)
-- Everything outside the family league is off for teens, enforced here rather than in the app:
--   * every profile-scoped API call from a teen account must be on private.teen_allowed_rpcs(),
--     checked in private.require_profile() against the function the API actually called, so a
--     new API is closed to teens until someone decides otherwise;
--   * triggers keep teens in family leagues only (never as owners), keep their runs and defaults
--     to "only me" or "my leagues", keep them out of clubs, follows, leaderboards and Strava, and
--     keep comments and kudos off their runs;
--   * their live-location links open only for members of their family leagues.
-- A store answer can't turn a teen account into an adult one; staff can, after checking.
-- Teen accounts stay off (under 18 is locked, as in the beta) until an operator turns on
-- teen_accounts_enabled, after counsel's review of state age laws.

-- ---------------------------------------------------------------------------------------
-- Age bands, and the switch
-- ---------------------------------------------------------------------------------------
insert into private.app_flags (key, enabled, reason) values
  ('teen_accounts_enabled', false, 'Enable after counsel reviews state age laws (docs/ROADMAP.md 4.10)')
on conflict (key) do nothing;

create or replace function public.get_app_config()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'competition_enabled', private.flag_enabled('competition_enabled'),
    'invites_enabled', private.flag_enabled('invites_enabled'),
    'registration_enabled', private.flag_enabled('registration_enabled'),
    'teen_accounts_enabled', private.flag_enabled('teen_accounts_enabled'),
    'rule_version', 1,
    'validator_version', 1,
    'competition_time_zone', 'America/Chicago',
    'league_capacity', 20,
    'server_time_ms', private.ts_to_ms(now())
  )
$$;

alter table public.profiles drop constraint profiles_age_signal_check;
alter table public.profiles add constraint profiles_age_signal_check
  check (age_signal in ('adult', 'not_required', 'minor', 'teen_13_15', 'teen_16_17'));
alter table public.profiles
  add column teen_consent_at timestamptz,
  add column teen_consent_by uuid references auth.users (id) on delete set null;

create or replace function private.is_teen(p_user uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.profiles where user_id = p_user and age_signal in ('teen_13_15', 'teen_16_17'))
$$;

create or replace function private.is_young_teen(p_user uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.profiles where user_id = p_user and age_signal = 'teen_13_15')
$$;

create or replace function private.valid_age_report(p_signal text, p_source text)
returns boolean
language sql immutable set search_path = ''
as $$
  select p_signal in ('adult', 'not_required', 'minor', 'teen_13_15', 'teen_16_17')
     and (p_source is null or (char_length(p_source) between 1 and 32 and p_source ~ '^[A-Za-z0-9_]+$'))
$$;

-- ---------------------------------------------------------------------------------------
-- What a teen account may call
-- ---------------------------------------------------------------------------------------
-- Their own running, training and settings, their family leagues (standings, cheers, duels,
-- seasons, group runs, the league's challenges), live location, blocking and reporting.
create or replace function private.teen_allowed_rpcs()
returns text[]
language sql immutable
as $$
  select array[
    -- runs and their sharing (kept to "only me" or "my leagues" by a trigger)
    'start_run_upload', 'put_route_chunk', 'finalize_run', 'edit_run', 'merge_runs', 'update_run_details', 'set_run_sharing',
    -- settings, privacy zones and pushes
    'get_social_settings', 'set_social_settings', 'save_privacy_zone', 'delete_privacy_zone',
    'get_notification_settings', 'set_notification_prefs', 'register_push_token', 'unregister_push_token',
    -- family leagues
    'get_my_league', 'leave_league', 'cheer_member', 'get_league_cheers', 'get_league_season', 'get_week_recap',
    'list_duels', 'challenge_duel', 'respond_duel', 'cancel_duel',
    'list_group_runs', 'create_group_run', 'update_group_run', 'cancel_group_run', 'rsvp_group_run',
    'request_family_join', 'list_my_family_requests', 'cancel_family_request',
    -- the family league's challenges (the monthly ones for everyone are hidden from teens)
    'list_challenges', 'get_challenge', 'join_challenge', 'leave_challenge',
    -- live location, for the family
    'start_live_share', 'post_live_location', 'end_live_share',
    -- safety
    'block_runner', 'block_member', 'report_content', 'submit_report'
  ]::text[]
$$;

-- The API function this call came in through: the outermost function on the call stack.
create or replace function private.outermost_function(p_context text)
returns text
language sql immutable
as $$
  select (regexp_match(x.line, 'function "?(?:public\.)?([a-z0-9_]+)'))[1]
  from unnest(string_to_array(coalesce(p_context, ''), E'\n')) with ordinality as x(line, n)
  where x.line ~ 'function '
  order by x.n desc
  limit 1
$$;

create or replace function private.require_profile()
returns uuid
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_status text;
  v_age text;
  v_context text;
  v_rpc text;
begin
  select status, age_signal into v_status, v_age from public.profiles where user_id = v_uid;
  if v_status is null then
    perform private.fail('profile_required');
  elsif v_status <> 'active' then
    perform private.fail('account_deleting');
  elsif v_age = 'minor' then
    perform private.fail('age_restricted');
  elsif v_age in ('teen_13_15', 'teen_16_17') then
    get diagnostics v_context = pg_context;
    v_rpc := private.outermost_function(v_context);
    if v_rpc is null or not (v_rpc = any (private.teen_allowed_rpcs())) then
      perform private.fail('teen_restricted', v_rpc);
    end if;
  end if;
  return v_uid;
end
$$;

-- ---------------------------------------------------------------------------------------
-- Joining a family league: the adult who runs it approves, confirming they're the parent or
-- guardian
-- ---------------------------------------------------------------------------------------
create table private.family_requests (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references public.leagues (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'approved', 'declined', 'cancelled')),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references auth.users (id) on delete set null
);
create unique index family_requests_pending_once on private.family_requests (league_id, user_id) where status = 'pending';
create index family_requests_user_idx on private.family_requests (user_id, created_at desc);

create or replace function private.family_request_json(p_request private.family_requests, p_viewer uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'id', p_request.id,
    'league_id', p_request.league_id,
    'league_name', (select l.name from public.leagues l where l.id = p_request.league_id),
    'alias', (select p.alias from public.profiles p where p.user_id = p_request.user_id),
    'band', (select case p.age_signal when 'teen_13_15' then '13_15' when 'teen_16_17' then '16_17' end
             from public.profiles p where p.user_id = p_request.user_id),
    'status', p_request.status,
    'created_at_ms', private.ts_to_ms(p_request.created_at),
    'is_mine', p_request.user_id = p_viewer)
$$;

-- A teen asks to join with the family league's invite code.
create or replace function public.request_family_join(p_code text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_invite private.league_invites;
  v_league public.leagues;
  v_request private.family_requests;
  v_alias text;
begin
  if not private.is_teen(v_uid) then
    perform private.fail('not_allowed');
  end if;
  perform private.check_rate_limit('family_join:' || v_uid, 10, interval '1 day');
  select * into v_invite from private.league_invites where code_hash = private.invite_hash(p_code);
  if not found or v_invite.revoked_at is not null or v_invite.expires_at <= now() then
    perform private.fail('invite_not_found');
  end if;
  select * into v_league from public.leagues where id = v_invite.league_id for update;
  if v_league.status <> 'active' or v_league.kind <> 'family' then
    -- Other leagues' codes don't work for teen accounts.
    perform private.fail('family_only');
  end if;
  if private.is_teen(v_league.owner_id)
     or exists (select 1 from private.league_bans where league_id = v_league.id and user_id = v_uid)
     or private.are_blocked(v_uid, v_league.owner_id) then
    perform private.fail('invite_unavailable');
  end if;
  if exists (select 1 from public.league_members where league_id = v_league.id and user_id = v_uid and left_at is null) then
    perform private.fail('already_member');
  end if;
  select * into v_request from private.family_requests where league_id = v_league.id and user_id = v_uid and status = 'pending';
  if not found then
    insert into private.family_requests (league_id, user_id) values (v_league.id, v_uid) returning * into v_request;
    select alias into v_alias from public.profiles where user_id = v_uid;
    perform private.notify(v_league.owner_id, v_uid, 'league', v_alias || ' wants to join ' || v_league.name,
      'Approve them in League if you’re their parent or guardian.', '/league', 'family_request:' || v_request.id);
  end if;
  return private.family_request_json(v_request, v_uid);
end
$$;

create or replace function public.list_my_family_requests()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(private.family_request_json(r, private.require_profile()) order by r.created_at desc), '[]'::jsonb)
  from private.family_requests r
  where r.user_id = private.require_profile() and (r.status = 'pending' or r.decided_at > now() - interval '7 days')
$$;

create or replace function public.cancel_family_request(p_request_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
begin
  update private.family_requests set status = 'cancelled', decided_at = now()
  where id = p_request_id and user_id = v_uid and status = 'pending';
  if not found then
    perform private.fail('not_found');
  end if;
  return public.list_my_family_requests();
end
$$;

-- For the adult who runs a family league: teens waiting to join.
create or replace function public.list_family_requests(p_league_id uuid default null)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(private.family_request_json(r, private.require_profile()) order by r.created_at), '[]'::jsonb)
  from private.family_requests r
  join public.leagues l on l.id = r.league_id and l.owner_id = private.require_profile() and l.status = 'active'
  where r.status = 'pending' and (p_league_id is null or r.league_id = p_league_id)
$$;

-- Approving is the parent's consent: it's recorded with who gave it.
create or replace function public.decide_family_request(p_request_id uuid, p_approve boolean)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_request private.family_requests;
  v_league public.leagues;
begin
  select * into v_request from private.family_requests where id = p_request_id and status = 'pending' for update;
  if not found then
    perform private.fail('not_found');
  end if;
  select * into v_league from public.leagues where id = v_request.league_id for update;
  if v_league.owner_id <> v_uid or v_league.status <> 'active' then
    perform private.fail('not_found');
  end if;
  if not coalesce(p_approve, false) then
    update private.family_requests set status = 'declined', decided_at = now(), decided_by = v_uid where id = v_request.id;
    return public.list_family_requests(v_league.id);
  end if;
  if (select count(*) from public.league_members where league_id = v_league.id and left_at is null) >= v_league.capacity then
    perform private.fail('league_full');
  end if;
  if private.league_count(v_request.user_id) >= private.max_leagues() then
    perform private.fail('league_limit');
  end if;
  update private.family_requests set status = 'approved', decided_at = now(), decided_by = v_uid where id = v_request.id;
  update public.profiles set teen_consent_at = now(), teen_consent_by = v_uid, updated_at = now() where user_id = v_request.user_id;
  insert into public.league_members (league_id, user_id, role) values (v_league.id, v_request.user_id, 'member')
  on conflict do nothing;
  perform private.notify(v_request.user_id, v_uid, 'league', 'You’re in ' || v_league.name,
    'Your family league is ready. Your best three days each week count.', '/league', 'family_approved:' || v_request.id);
  return public.list_family_requests(v_league.id);
end
$$;

-- For the adult who runs a family league: how the teens in it are doing, and their membership
-- (to remove one, use the league's usual "Remove from league").
create or replace function public.list_family_teens(p_league_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_owner public.league_members := private.require_league_owner(v_uid, p_league_id);
  v_week date := private.current_week_start();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'member_id', m.id,
             'alias', p.alias,
             'band', case p.age_signal when 'teen_13_15' then '13_15' else '16_17' end,
             'joined_at_ms', private.ts_to_ms(m.joined_at),
             'consent_at_ms', case when p.teen_consent_at is null then null else private.ts_to_ms(p.teen_consent_at) end,
             'runs_this_week', (select count(*) from public.runs r
                                where r.owner_id = m.user_id and r.deleted_at is null and r.status in ('accepted', 'review', 'personal_only')
                                  and r.started_at >= private.day_start(v_week)),
             'last_run_at_ms', (select private.ts_to_ms(max(r.started_at)) from public.runs r
                                where r.owner_id = m.user_id and r.deleted_at is null and r.status in ('accepted', 'review', 'personal_only')))
           order by m.joined_at)
    from public.league_members m
    join public.profiles p on p.user_id = m.user_id and p.age_signal in ('teen_13_15', 'teen_16_17')
    where m.league_id = v_owner.league_id and m.left_at is null), '[]'::jsonb);
end
$$;

-- ---------------------------------------------------------------------------------------
-- Keeping teens inside the family
-- ---------------------------------------------------------------------------------------
-- League memberships: family leagues only, never as owner, and only through an approved request.
create or replace function private.guard_teen_membership()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.is_teen(new.user_id) then
    return new;
  end if;
  if new.left_at is not null then
    return new;
  end if;
  if new.role = 'owner' then
    perform private.fail('teen_restricted', 'owner');
  end if;
  if tg_op = 'INSERT' then
    if not exists (select 1 from public.leagues l where l.id = new.league_id and l.kind = 'family' and l.status = 'active') then
      perform private.fail('family_only');
    end if;
    if not exists (select 1 from private.family_requests r
                   where r.league_id = new.league_id and r.user_id = new.user_id and r.status = 'approved') then
      perform private.fail('teen_approval_required');
    end if;
  end if;
  return new;
end
$$;

create trigger league_members_teens before insert or update of role, left_at on public.league_members
  for each row execute function private.guard_teen_membership();

-- Clubs, follows, leaderboards and Strava are closed to teens, whatever the path.
create or replace function private.guard_teen_user()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  -- Read through jsonb: each table names its columns differently.
  v_row jsonb := to_jsonb(new);
  v_user uuid := coalesce(v_row ->> 'user_id', v_row ->> 'follower_id')::uuid;
  v_other uuid := (v_row ->> 'followee_id')::uuid;
begin
  if tg_table_name = 'club_members' and v_row ->> 'left_at' is not null then
    return new;
  end if;
  if tg_table_name = 'leaderboard_members'
     and (v_row ->> 'joined_at' is null or v_row ->> 'left_at' is not null or v_row ->> 'banned_at' is not null) then
    return new;
  end if;
  -- Garmin brings heart rate: closed under 16 only.
  if tg_table_name = 'aggregator_links' then
    if private.is_young_teen(v_user) then
      perform private.fail('teen_restricted', tg_table_name);
    end if;
    return new;
  end if;
  if private.is_teen(v_user) or (v_other is not null and private.is_teen(v_other)) then
    perform private.fail('teen_restricted', tg_table_name);
  end if;
  return new;
end
$$;

create trigger club_members_teens before insert or update on private.club_members
  for each row execute function private.guard_teen_user();
create trigger follows_teens before insert on private.follows
  for each row execute function private.guard_teen_user();
create trigger leaderboard_members_teens before insert or update on private.leaderboard_members
  for each row execute function private.guard_teen_user();
create trigger strava_connections_teens before insert on private.strava_connections
  for each row execute function private.guard_teen_user();
create trigger aggregator_links_teens before insert on private.aggregator_links
  for each row execute function private.guard_teen_user();

-- Runs: shared with the family at most; no health data under 16.
create or replace function private.guard_teen_run()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.is_teen(new.owner_id) then
    return new;
  end if;
  if new.visibility in ('followers', 'everyone') then
    if tg_op = 'INSERT' then
      new.visibility := 'only_me';
    else
      perform private.fail('teen_restricted', 'visibility');
    end if;
  end if;
  if private.is_young_teen(new.owner_id) then
    if tg_op = 'INSERT' and new.source in ('health_import', 'garmin') then
      perform private.fail('teen_restricted', 'health_data');
    end if;
    new.avg_heart_rate := null;
    new.max_heart_rate := null;
  end if;
  return new;
end
$$;

create trigger runs_teens before insert or update of visibility, avg_heart_rate, max_heart_rate on public.runs
  for each row execute function private.guard_teen_run();

-- Settings: never findable by name, and new runs "only me" or "my leagues" at most. A store
-- answer can't turn a teen account back into an adult one (staff can, after checking).
create or replace function private.guard_teen_profile()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  -- Until teen accounts are on, a teen answer is treated like any other under-18 one.
  if new.age_signal in ('teen_13_15', 'teen_16_17') and not private.flag_enabled('teen_accounts_enabled')
     and (tg_op = 'INSERT' or old.age_signal is distinct from new.age_signal) then
    if tg_op = 'INSERT' then
      perform private.fail('age_restricted');
    end if;
    new.age_signal := 'minor';
  end if;
  if tg_op = 'UPDATE' and old.age_signal in ('teen_13_15', 'teen_16_17')
     and new.age_signal in ('adult', 'not_required') and coalesce(new.age_signal_source, '') <> 'staff_review' then
    new.age_signal := old.age_signal;
    new.age_signal_source := old.age_signal_source;
  end if;
  if new.age_signal in ('teen_13_15', 'teen_16_17') then
    new.discoverable := false;
    if new.default_visibility in ('followers', 'everyone') then
      new.default_visibility := 'only_me';
    end if;
  end if;
  return new;
end
$$;

create trigger profiles_teens before insert or update on public.profiles
  for each row execute function private.guard_teen_profile();

-- Staff: a teen who has turned 18, checked another way, becomes an adult account.
create or replace function private.clear_teen_account(p_user uuid, p_reason text, p_actor text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if p_reason is null or char_length(trim(p_reason)) < 3 then
    raise exception 'a reason is required';
  end if;
  update public.profiles
     set age_signal = 'adult', age_signal_source = 'staff_review', age_checked_at = now(), updated_at = now()
   where user_id = p_user and age_signal in ('teen_13_15', 'teen_16_17');
  insert into private.audit_log (actor, action, target, reason)
  values (p_actor, 'clear_teen_account', private.subject_ref(p_user), p_reason);
end
$$;

-- No comments or kudos on teens' runs.
create or replace function private.guard_teen_reactions()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if exists (select 1 from public.runs r where r.id = new.run_id and private.is_teen(r.owner_id)) then
    perform private.fail('teen_restricted', tg_table_name);
  end if;
  return new;
end
$$;

create trigger comments_teens before insert on private.comments
  for each row execute function private.guard_teen_reactions();
create trigger kudos_teens before insert on private.kudos
  for each row execute function private.guard_teen_reactions();

-- ---------------------------------------------------------------------------------------
-- An adult account that the store now says is a teen steps back to its family
-- ---------------------------------------------------------------------------------------
create or replace function private.enter_teen_mode(p_user uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_member public.league_members;
  v_successor public.league_members;
  v_share uuid;
begin
  for v_member in
    select m.* from public.league_members m join public.leagues l on l.id = m.league_id
    where m.user_id = p_user and m.left_at is null
    order by m.joined_at for update of m
  loop
    if v_member.role = 'owner' then
      select * into v_successor from public.league_members x
      where x.league_id = v_member.league_id and x.left_at is null and x.id <> v_member.id and not private.is_teen(x.user_id)
      order by x.joined_at, x.id limit 1;
      if found then
        update public.league_members set role = 'owner' where id = v_successor.id;
        update public.leagues set owner_id = v_successor.user_id, updated_at = now() where id = v_member.league_id;
      else
        update public.leagues set status = 'closed', updated_at = now() where id = v_member.league_id;
        update private.league_invites set revoked_at = now() where league_id = v_member.league_id and revoked_at is null;
        update public.league_members set left_at = now(), left_reason = 'league_closed'
        where league_id = v_member.league_id and left_at is null and id <> v_member.id;
      end if;
      update public.league_members set left_at = now(), left_reason = 'age_restricted', role = 'member' where id = v_member.id;
    elsif (select l.kind from public.leagues l where l.id = v_member.league_id) <> 'family' then
      update public.league_members set left_at = now(), left_reason = 'age_restricted' where id = v_member.id;
    end if;
  end loop;
  perform private.detach_from_clubs(p_user, 'age_restricted');
  update private.leaderboard_members set left_at = now(), updated_at = now()
  where user_id = p_user and joined_at is not null and left_at is null;
  delete from private.leaderboard_results where user_id = p_user and status in ('provisional', 'held');
  delete from private.follows where follower_id = p_user or followee_id = p_user;
  delete from private.follow_codes where user_id = p_user;
  update public.runs set visibility = 'only_me', updated_at = now()
  where owner_id = p_user and visibility in ('followers', 'everyone');
  update private.strava_connections set auto_upload = false where user_id = p_user;
  for v_share in select id from private.live_shares where owner_id = p_user and ended_at is null loop
    perform private.stop_live_share(v_share, 'stopped');
  end loop;
  perform private.log_server_event('teen_mode', null, '{}'::jsonb);
end
$$;

create or replace function private.on_age_signal_change()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  -- A teen answer turned into a lock (teen accounts off): the same as a minor report.
  if new.age_signal = 'minor' and old.age_signal is distinct from 'minor' then
    perform private.detach_from_league(new.user_id, 'age_restricted');
    delete from public.blocks where blocker_id = new.user_id or blocked_id = new.user_id;
    return null;
  end if;
  if new.age_signal in ('teen_13_15', 'teen_16_17') and old.age_signal is distinct from new.age_signal
     and coalesce(old.age_signal, '') not in ('teen_13_15', 'teen_16_17') then
    perform private.enter_teen_mode(new.user_id);
  end if;
  return null;
end
$$;

create trigger profiles_teen_mode after update of age_signal on public.profiles
  for each row execute function private.on_age_signal_change();

-- When the adult who runs a league leaves everything (deletion, an age lock), the league passes
-- to its longest-standing adult; a league of only teens closes.
create or replace function private.detach_from_league(p_user uuid, p_reason text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_member public.league_members;
  v_successor public.league_members;
begin
  for v_member in
    select * from public.league_members where user_id = p_user and left_at is null order by joined_at, id for update
  loop
    perform 1 from public.leagues where id = v_member.league_id for update;
    if v_member.role = 'owner' then
      select * into v_successor from public.league_members
      where league_id = v_member.league_id and left_at is null and id <> v_member.id and not private.is_teen(user_id)
      order by joined_at, id limit 1;
      if found then
        update public.league_members set role = 'owner' where id = v_successor.id;
        update public.leagues set owner_id = v_successor.user_id, updated_at = now() where id = v_member.league_id;
      else
        update public.leagues set status = 'closed', updated_at = now() where id = v_member.league_id;
        update private.league_invites set revoked_at = now() where league_id = v_member.league_id and revoked_at is null;
        update public.league_members set left_at = now(), left_reason = 'league_closed'
        where league_id = v_member.league_id and left_at is null and id <> v_member.id;
      end if;
    end if;
    update public.league_members set left_at = now(), left_reason = p_reason, role = 'member' where id = v_member.id;
  end loop;
  update private.league_invites set revoked_at = now() where created_by = p_user and revoked_at is null;
  -- Clubs too (docs/ROADMAP.md 4.5).
  perform private.detach_from_clubs(p_user, p_reason);
end
$$;

-- ---------------------------------------------------------------------------------------
-- Family only: challenges and live location
-- ---------------------------------------------------------------------------------------
create or replace function private.challenge_visible(p_user uuid, p_challenge private.challenges)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select case p_challenge.scope
    when 'global' then not private.is_teen(p_user)
    when 'league' then exists (select 1 from public.league_members m join public.leagues l on l.id = m.league_id and l.status = 'active'
                               where m.league_id = p_challenge.league_id and m.user_id = p_user and m.left_at is null)
    else exists (select 1 from private.club_members m join private.clubs c on c.id = m.club_id and c.status = 'active'
                 where m.club_id = p_challenge.club_id and m.user_id = p_user and m.left_at is null)
  end
$$;

-- Whether two runners are both in the same family league now.
create or replace function private.share_family(p_a uuid, p_b uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.league_members a
    join public.league_members b on b.league_id = a.league_id and b.left_at is null
    join public.leagues l on l.id = a.league_id and l.kind = 'family' and l.status = 'active'
    where a.user_id = p_a and a.left_at is null and b.user_id = p_b)
$$;

-- A teen's link opens only for someone signed in who's in one of their family leagues.
create or replace function public.get_live_location(p_token text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_hash text;
  v_share private.live_shares;
  v_alias text;
  v_viewer uuid := auth.uid();
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('state', 'ended');
  end if;
  v_hash := private.live_token_hash(p_token);
  -- Viewers look every 15 seconds or so; this is generous for a family, not for a scraper.
  perform private.check_rate_limit('live_view:' || v_hash, 600, interval '1 hour');
  select s.* into v_share from private.live_shares s where s.token_hash = v_hash;
  if not found or v_share.ended_at is not null or v_share.expires_at <= now() then
    return jsonb_build_object('state', 'ended');
  end if;
  select p.alias into v_alias from public.profiles p where p.user_id = v_share.owner_id and p.status = 'active';
  if v_alias is null then
    return jsonb_build_object('state', 'ended');
  end if;
  if private.is_teen(v_share.owner_id)
     and (v_viewer is null or (v_viewer <> v_share.owner_id and not private.share_family(v_viewer, v_share.owner_id))) then
    return jsonb_build_object('state', 'family_only');
  end if;
  return jsonb_build_object(
    'state', 'live',
    'alias', v_alias,
    'started_at_ms', private.ts_to_ms(v_share.created_at),
    'expires_at_ms', private.ts_to_ms(v_share.expires_at),
    'position', case when v_share.position_at is null then null else jsonb_build_object(
      'lat', v_share.lat, 'lon', v_share.lon, 'accuracy_m', v_share.accuracy_m, 'at_ms', private.ts_to_ms(v_share.position_at)) end,
    'distance_m', v_share.distance_m,
    'elapsed_ms', v_share.elapsed_ms);
end
$$;

-- ---------------------------------------------------------------------------------------
-- The app learns the band and the consent from get_me
-- ---------------------------------------------------------------------------------------
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
      'age_checked_at_ms', case when v_profile.age_checked_at is null then null else private.ts_to_ms(v_profile.age_checked_at) end,
      'teen_consent_at_ms', case when v_profile.teen_consent_at is null then null else private.ts_to_ms(v_profile.teen_consent_at) end) end,
    'lifetime_xp', v_xp,
    'tier', private.tier_name(v_xp),
    'is_staff', exists (select 1 from private.staff_roles where user_id = v_uid),
    'config', public.get_app_config()
  );
end
$$;

select private.apply_function_grants();
