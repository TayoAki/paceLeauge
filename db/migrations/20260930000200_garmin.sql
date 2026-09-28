-- Garmin sync through a data aggregator (docs/ROADMAP.md 2.4 and decision 1). Garmin shares
-- workouts with Apple Health without their routes, so for league credit Garmin activities come
-- from an aggregator that already has Garmin access (Terra first). The runner connects Garmin in
-- the aggregator's widget; the aggregator then sends each activity, with its GPS samples, to the
-- API service's webhook. The service queues it here and uploads it as the runner through the same
-- path as a recorded run (source 'garmin'): validated from its GPS, one copy kept when Apple
-- Health has it too.
--
-- The service switches this on only when its aggregator credentials are set, which the roadmap
-- ties to a user-count trigger.

alter table private.integrations drop constraint integrations_name_check;
alter table private.integrations add constraint integrations_name_check check (name in ('strava', 'garmin'));
insert into private.integrations (name) values ('garmin');

-- A runner's link to the aggregator for one provider (Garmin).
create table private.aggregator_links (
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null check (provider in ('garmin')),
  aggregator text not null check (aggregator in ('terra')),
  aggregator_user_id text not null check (char_length(aggregator_user_id) between 1 and 200),
  connected_at timestamptz not null default now(),
  primary key (user_id, provider),
  unique (aggregator, aggregator_user_id)
);

-- One-time references handed to the aggregator's widget, stored hashed. The aggregator echoes the
-- reference in its auth event, which is how a connection finds its runner.
create table private.aggregator_connect_states (
  state_hash text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null check (provider in ('garmin')),
  created_at timestamptz not null default now()
);
create index aggregator_connect_states_created_idx on private.aggregator_connect_states (created_at);

-- Events waiting for the service (activities are uploaded outside the webhook's time limit).
create table private.aggregator_inbox (
  id bigint generated always as identity primary key,
  aggregator text not null,
  event_type text not null check (char_length(event_type) <= 60),
  aggregator_user_id text not null check (char_length(aggregator_user_id) <= 200),
  payload jsonb not null,
  received_at timestamptz not null default now(),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  processed_at timestamptz,
  last_error text check (last_error is null or char_length(last_error) <= 300)
);
create index aggregator_inbox_due_idx on private.aggregator_inbox (next_attempt_at) where processed_at is null;

-- Links the service still has to end with the aggregator (after a disconnect or account deletion).
create table private.aggregator_revocations (
  id bigint generated always as identity primary key,
  aggregator text not null,
  aggregator_user_id text not null,
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------------------
-- The runner's RPCs (connecting starts in the service: it needs the aggregator's API key)
-- ---------------------------------------------------------------------------------------
create or replace function private.garmin_settings()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select case when i.available then i.settings end from private.integrations i where i.name = 'garmin'
$$;

create or replace function public.get_garmin_status()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_link private.aggregator_links;
begin
  select * into v_link from private.aggregator_links where user_id = v_uid and provider = 'garmin';
  return jsonb_build_object(
    'available', private.garmin_settings() is not null,
    'connected', v_link.user_id is not null,
    'connected_at_ms', case when v_link.user_id is null then null else private.ts_to_ms(v_link.connected_at) end,
    'imported', (select count(*) from public.runs r where r.owner_id = v_uid and r.source = 'garmin' and r.deleted_at is null),
    'last_activity_at_ms', (select private.ts_to_ms(max(r.started_at)) from public.runs r
                            where r.owner_id = v_uid and r.source = 'garmin' and r.deleted_at is null)
  );
end
$$;

create or replace function public.disconnect_garmin()
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_link private.aggregator_links;
begin
  delete from private.aggregator_links where user_id = v_uid and provider = 'garmin' returning * into v_link;
  if v_link.user_id is not null then
    insert into private.aggregator_revocations (aggregator, aggregator_user_id) values (v_link.aggregator, v_link.aggregator_user_id);
    perform private.log_server_event('garmin_disconnected', v_uid, jsonb_build_object('reason', 'runner'));
  end if;
  return public.get_garmin_status();
end
$$;

-- ---------------------------------------------------------------------------------------
-- The service's side
-- ---------------------------------------------------------------------------------------
create or replace function private.set_garmin_integration(p_available boolean, p_settings jsonb)
returns void
language sql security definer set search_path = ''
as $$
  update private.integrations set available = coalesce(p_available, false), settings = coalesce(p_settings, '{}'::jsonb), updated_at = now()
  where name = 'garmin'
$$;

-- A fresh reference for the aggregator's widget, for a runner who asked to connect Garmin.
create or replace function private.garmin_new_state(p_user uuid)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_state text;
begin
  if private.garmin_settings() is null then
    perform private.fail('not_available', 'garmin');
  end if;
  if not exists (select 1 from public.profiles where user_id = p_user and status = 'active') then
    perform private.fail('profile_required');
  end if;
  perform private.check_rate_limit('garmin_connect:' || p_user, 20, interval '1 hour');
  v_state := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  insert into private.aggregator_connect_states (state_hash, user_id, provider)
  values (encode(sha256(convert_to(v_state, 'UTF8')), 'hex'), p_user, 'garmin');
  return v_state;
end
$$;

-- The aggregator's auth event: links its user to the runner who started the widget.
-- 'linked', 'unknown_reference' (never issued, used or older than a day) or 'in_use' (that Garmin
-- account is linked to another runner).
create or replace function private.aggregator_link(p_reference text, p_aggregator text, p_aggregator_user_id text)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_state private.aggregator_connect_states;
  v_old private.aggregator_links;
begin
  delete from private.aggregator_connect_states s
  where s.state_hash = encode(sha256(convert_to(coalesce(p_reference, ''), 'UTF8')), 'hex')
    and s.created_at > now() - interval '1 day'
  returning * into v_state;
  if v_state.user_id is null then
    return 'unknown_reference';
  end if;
  if exists (select 1 from private.aggregator_links
             where aggregator = p_aggregator and aggregator_user_id = p_aggregator_user_id and user_id <> v_state.user_id) then
    return 'in_use';
  end if;
  select * into v_old from private.aggregator_links where user_id = v_state.user_id and provider = v_state.provider for update;
  if v_old.user_id is not null and v_old.aggregator_user_id <> p_aggregator_user_id then
    insert into private.aggregator_revocations (aggregator, aggregator_user_id) values (v_old.aggregator, v_old.aggregator_user_id);
    delete from private.aggregator_links where user_id = v_state.user_id and provider = v_state.provider;
  end if;
  insert into private.aggregator_links (user_id, provider, aggregator, aggregator_user_id)
  values (v_state.user_id, v_state.provider, p_aggregator, p_aggregator_user_id)
  on conflict (user_id, provider) do nothing;
  perform private.log_server_event('garmin_connected', v_state.user_id, '{}'::jsonb);
  return 'linked';
end
$$;

-- The runner disconnected on the aggregator's or Garmin's side.
create or replace function private.aggregator_unlink(p_aggregator text, p_aggregator_user_id text)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_link private.aggregator_links;
begin
  delete from private.aggregator_links where aggregator = p_aggregator and aggregator_user_id = p_aggregator_user_id returning * into v_link;
  if v_link.user_id is null then
    return false;
  end if;
  perform private.log_server_event('garmin_disconnected', v_link.user_id, jsonb_build_object('reason', 'provider'));
  return true;
end
$$;

-- The aggregator replaced a runner's id after they reconnected.
create or replace function private.aggregator_reauth(p_aggregator text, p_old_id text, p_new_id text)
returns boolean
language sql security definer set search_path = ''
as $$
  update private.aggregator_links set aggregator_user_id = p_new_id
  where aggregator = p_aggregator and aggregator_user_id = p_old_id
    and not exists (select 1 from private.aggregator_links l where l.aggregator = p_aggregator and l.aggregator_user_id = p_new_id)
  returning true
$$;

create or replace function private.aggregator_user(p_aggregator text, p_aggregator_user_id text)
returns uuid
language sql stable security definer set search_path = ''
as $$
  select l.user_id from private.aggregator_links l
  join public.profiles p on p.user_id = l.user_id and p.status = 'active'
  where l.aggregator = p_aggregator and l.aggregator_user_id = p_aggregator_user_id
$$;

create or replace function private.aggregator_enqueue(p_aggregator text, p_event_type text, p_aggregator_user_id text, p_payload jsonb)
returns bigint
language sql security definer set search_path = ''
as $$
  insert into private.aggregator_inbox (aggregator, event_type, aggregator_user_id, payload)
  values (p_aggregator, left(p_event_type, 60), left(p_aggregator_user_id, 200), p_payload)
  returning id
$$;

create or replace function private.aggregator_claim_inbox(p_limit integer default 5)
returns table (id bigint, aggregator text, event_type text, aggregator_user_id text, payload jsonb, attempts integer)
language sql security definer set search_path = ''
as $$
  update private.aggregator_inbox i
     set next_attempt_at = now() + interval '5 minutes'
   where i.id in (
     select d.id from private.aggregator_inbox d
     where d.processed_at is null and d.next_attempt_at <= now()
     order by d.next_attempt_at, d.id
     limit greatest(1, least(coalesce(p_limit, 5), 50))
     for update skip locked)
  returning i.id, i.aggregator, i.event_type, i.aggregator_user_id, i.payload, i.attempts
$$;

-- Done (ok), or tried again later with backoff; after ten tries it is set aside with its error.
create or replace function private.aggregator_inbox_result(p_id bigint, p_ok boolean, p_error text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if p_ok then
    update private.aggregator_inbox set processed_at = now(), last_error = left(p_error, 300) where id = p_id;
    return;
  end if;
  update private.aggregator_inbox
     set attempts = attempts + 1, last_error = left(p_error, 300),
         next_attempt_at = now() + least(interval '6 hours', interval '1 minute' * power(2, attempts)),
         processed_at = case when attempts + 1 >= 10 then now() end
   where id = p_id;
end
$$;

create or replace function private.aggregator_claim_revocations(p_limit integer default 10)
returns table (id bigint, aggregator text, aggregator_user_id text, attempts integer)
language sql security definer set search_path = ''
as $$
  update private.aggregator_revocations v
     set next_attempt_at = now() + interval '5 minutes'
   where v.id in (
     select d.id from private.aggregator_revocations d
     where d.next_attempt_at <= now()
     order by d.next_attempt_at
     limit greatest(1, least(coalesce(p_limit, 10), 50))
     for update skip locked)
  returning v.id, v.aggregator, v.aggregator_user_id, v.attempts
$$;

create or replace function private.aggregator_revocation_result(p_id bigint, p_done boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if p_done then
    delete from private.aggregator_revocations where id = p_id;
    return;
  end if;
  update private.aggregator_revocations
     set attempts = attempts + 1, next_attempt_at = now() + least(interval '6 hours', interval '1 minute' * power(2, attempts))
   where id = p_id;
  delete from private.aggregator_revocations where id = p_id and attempts >= 10;
end
$$;

-- Processed events are kept a week (to answer "did my run arrive?"), unknown references a day.
create or replace function private.aggregator_purge()
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_count integer;
begin
  delete from private.aggregator_inbox where processed_at < now() - interval '7 days';
  get diagnostics v_count = row_count;
  delete from private.aggregator_connect_states where created_at < now() - interval '1 day';
  return v_count;
end
$$;

-- ---------------------------------------------------------------------------------------
-- Account deletion ends integrations too (Strava grants and aggregator links)
-- ---------------------------------------------------------------------------------------
create or replace function private.purge_user_data(p_user uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  insert into private.strava_revocations (refresh_token_enc, access_token_enc)
  select c.refresh_token_enc, c.access_token_enc from private.strava_connections c where c.user_id = p_user;
  insert into private.aggregator_revocations (aggregator, aggregator_user_id)
  select l.aggregator, l.aggregator_user_id from private.aggregator_links l where l.user_id = p_user;
  delete from private.aggregator_inbox i
  where exists (select 1 from private.aggregator_links l
                where l.user_id = p_user and l.aggregator = i.aggregator and l.aggregator_user_id = i.aggregator_user_id);
  perform private.detach_from_league(p_user, 'account_deleted');
  delete from public.runs where owner_id = p_user;
  delete from public.daily_scores where owner_id = p_user;
  delete from private.xp_ledger where owner_id = p_user;
  delete from private.profile_stats where user_id = p_user;
  delete from public.blocks where blocker_id = p_user or blocked_id = p_user;
  delete from private.export_jobs where user_id = p_user;
  delete from private.league_bans where user_id = p_user;
  delete from private.operational_events where subject = private.subject_ref(p_user);
  update private.reports set content_snapshot = '{}'::jsonb where target_user_id = p_user;
  delete from public.league_members where user_id = p_user;
  delete from private.staff_roles where user_id = p_user;
  delete from public.profiles where user_id = p_user;
  delete from auth.users where id = p_user;
end
$$;

-- ---------------------------------------------------------------------------------------
-- Export format 3: everything Phase 2 holds about the runner, in one place later phases extend:
-- the Strava connection (never its tokens), the Garmin link and diagnostics reports. Runs carry
-- their source and provenance through private.run_json.
-- ---------------------------------------------------------------------------------------
create or replace function private.export_extras(p_uid uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_strava private.strava_connections;
  v_garmin private.aggregator_links;
begin
  select * into v_strava from private.strava_connections where user_id = p_uid;
  select * into v_garmin from private.aggregator_links where user_id = p_uid and provider = 'garmin';
  return jsonb_build_object(
    'strava', jsonb_build_object(
      'connected', v_strava.user_id is not null,
      'athlete_id', v_strava.athlete_id::text,
      'athlete_name', v_strava.athlete_name,
      'connected_at_ms', case when v_strava.user_id is null then null else private.ts_to_ms(v_strava.connected_at) end,
      'auto_upload', v_strava.auto_upload,
      'uploads', coalesce((select jsonb_agg(jsonb_build_object('run_id', u.run_id, 'state', u.state,
                                             'activity_id', u.activity_id::text, 'updated_at_ms', private.ts_to_ms(u.updated_at))
                                           order by u.created_at)
                           from private.strava_uploads u where u.user_id = p_uid), '[]'::jsonb)),
    'garmin', jsonb_build_object(
      'connected', v_garmin.user_id is not null,
      'aggregator', v_garmin.aggregator,
      'connected_at_ms', case when v_garmin.user_id is null then null else private.ts_to_ms(v_garmin.connected_at) end),
    'diagnostic_reports', coalesce((select jsonb_agg(jsonb_build_object('created_at_ms', private.ts_to_ms(d.created_at), 'report', d.report)
                                                     order by d.created_at)
                                    from private.diagnostic_reports d where d.user_id = p_uid), '[]'::jsonb)
  );
end
$$;

create or replace function public.get_export(p_export_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_profile public.profiles;
  v_email text;
begin
  perform private.require_export(v_uid, p_export_id);
  select * into v_profile from public.profiles where user_id = v_uid;
  select email into v_email from auth.users where id = v_uid;
  return jsonb_build_object(
    'format', 'paceleague-export',
    'format_version', 3,
    'generated_at_ms', private.ts_to_ms(now()),
    'account', jsonb_build_object('email', v_email, 'alias', v_profile.alias, 'units', v_profile.units,
      'goal_days', v_profile.goal_days, 'notification_tz', v_profile.notification_tz,
      'created_at_ms', private.ts_to_ms(v_profile.created_at),
      'eligibility_ack_at_ms', private.ts_to_ms(v_profile.eligibility_ack_at),
      'age_signal', v_profile.age_signal, 'age_signal_source', v_profile.age_signal_source,
      'age_checked_at_ms', case when v_profile.age_checked_at is null then null else private.ts_to_ms(v_profile.age_checked_at) end),
    'lifetime_xp', private.lifetime_xp(v_uid),
    'tier', private.tier_name(private.lifetime_xp(v_uid)),
    'runs', coalesce((select jsonb_agg(private.run_json(r) || jsonb_build_object('segments', r.segments)
                                       order by r.started_at)
                      from public.runs r where r.owner_id = v_uid and r.deleted_at is null and r.status <> 'uploading'), '[]'::jsonb),
    'daily_scores', coalesce((select jsonb_agg(jsonb_build_object('date', d.competition_date, 'rule_version', d.rule_version,
                                'distance_cm', d.distance_cm, 'active_ms', d.active_ms, 'xp', d.xp, 'revision', d.revision)
                                order by d.competition_date)
                              from public.daily_scores d where d.owner_id = v_uid), '[]'::jsonb),
    'league_memberships', coalesce((select jsonb_agg(jsonb_build_object('league_name', l.name, 'role', m.role,
                                      'joined_at_ms', private.ts_to_ms(m.joined_at), 'left_at_ms', private.ts_to_ms(m.left_at),
                                      'left_reason', m.left_reason) order by m.joined_at)
                                    from public.league_members m join public.leagues l on l.id = m.league_id
                                    where m.user_id = v_uid), '[]'::jsonb),
    'blocked_count', (select count(*) from public.blocks where blocker_id = v_uid),
    'shoes', coalesce((select jsonb_agg(private.shoe_json(s) order by s.created_at)
                       from private.shoes s where s.owner_id = v_uid), '[]'::jsonb),
    'efforts', coalesce((select jsonb_agg(jsonb_build_object('run_id', e.run_id, 'effort', e.effort,
                                            'elapsed_ms', e.elapsed_ms, 'started_at_ms', private.ts_to_ms(e.started_at))
                                          order by r.started_at, r.id, c.sort)
                         from private.run_efforts e
                         join public.runs r on r.id = e.run_id and r.deleted_at is null
                         join private.effort_catalog() c on c.effort = e.effort
                         where e.owner_id = v_uid), '[]'::jsonb),
    'badges', coalesce((select jsonb_agg(jsonb_build_object('badge', b.badge, 'earned_at_ms', private.ts_to_ms(b.earned_at))
                                         order by b.earned_at, b.badge)
                        from private.user_badges b where b.user_id = v_uid), '[]'::jsonb),
    'streak_weeks', coalesce((select jsonb_agg(jsonb_build_object('week_start', w.week_start, 'goal_days', w.goal_days,
                                                'active_days', w.active_days, 'met', w.met, 'frozen', w.frozen)
                                              order by w.week_start)
                              from private.streak_weeks w where w.user_id = v_uid), '[]'::jsonb),
    'cheers', jsonb_build_object(
      'given', coalesce((select jsonb_agg(jsonb_build_object('week_start', g.week_start, 'count', g.n) order by g.week_start)
                         from (select c.week_start, count(*) as n from private.cheers c
                               where c.from_user = v_uid group by c.week_start) g), '[]'::jsonb),
      'received', coalesce((select jsonb_agg(jsonb_build_object('week_start', g.week_start, 'count', g.n) order by g.week_start)
                            from (select c.week_start, count(*) as n from private.cheers c
                                  where c.to_user = v_uid group by c.week_start) g), '[]'::jsonb)),
    'run_edits', coalesce((select jsonb_agg(jsonb_build_object(
                                    'run_id', o.run_id,
                                    'original_started_at_ms', private.ts_to_ms(o.started_at),
                                    'original_ended_at_ms', private.ts_to_ms(o.ended_at),
                                    'original_activity_type', o.activity_type,
                                    'original_status', o.status,
                                    'original_point_count', o.point_count,
                                    'original_segments', o.segments,
                                    'first_edited_at_ms', private.ts_to_ms(o.saved_at))
                                  order by o.saved_at)
                           from private.run_originals o
                           join public.runs r on r.id = o.run_id and r.deleted_at is null
                           where o.owner_id = v_uid), '[]'::jsonb)
  ) || private.export_extras(v_uid);
end
$$;

select private.apply_function_grants();
