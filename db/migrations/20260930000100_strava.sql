-- Strava export (docs/ROADMAP.md 2.3). A runner can connect Strava and have each accepted run they
-- record with PaceLeague posted to their Strava account. Nothing is read back from Strava (Strava's
-- terms forbid showing a runner's Strava data to others), so leagues never see any of it.
--
-- The database keeps the state; the API service (server/src/strava.ts) holds the client secret and
-- does the HTTP: the code exchange, token refresh, uploads, revocation and Strava's webhook.
-- Tokens arrive already encrypted by the service (AES-256-GCM with STRAVA_TOKEN_KEY), and no RPC
-- ever returns them.

-- ---------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------
-- Integrations the API service has credentials for; the service writes this at boot.
create table private.integrations (
  name text primary key check (name in ('strava')),
  available boolean not null default false,
  -- Public settings only: the client id, the redirect URI and the allowed return URL prefixes.
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
insert into private.integrations (name) values ('strava');

create table private.strava_connections (
  user_id uuid primary key references auth.users (id) on delete cascade,
  athlete_id bigint not null unique,
  athlete_name text check (athlete_name is null or char_length(athlete_name) <= 100),
  scope text not null check (char_length(scope) <= 200),
  access_token_enc text not null check (char_length(access_token_enc) <= 1000),
  refresh_token_enc text not null check (char_length(refresh_token_enc) <= 1000),
  expires_at timestamptz not null,
  auto_upload boolean not null default true,
  -- Runs that ended before this are posted only when the runner asks.
  upload_since timestamptz not null default now(),
  -- Strava said the athlete revoked access; the service confirms it with a token refresh.
  verify_requested_at timestamptz,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One-time `state` values for the OAuth round trip, stored hashed.
create table private.strava_connect_states (
  state_hash text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  return_to text not null check (char_length(return_to) <= 300),
  created_at timestamptz not null default now()
);
create index strava_connect_states_created_idx on private.strava_connect_states (created_at);

create table private.strava_uploads (
  run_id uuid primary key references public.runs (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  state text not null default 'queued' check (state in ('queued', 'processing', 'done', 'failed', 'cancelled')),
  upload_id bigint,
  activity_id bigint,
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text check (last_error is null or char_length(last_error) <= 300),
  -- Posted because the runner asked, rather than automatically.
  requested boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index strava_uploads_due_idx on private.strava_uploads (next_attempt_at) where state in ('queued', 'processing');
create index strava_uploads_user_idx on private.strava_uploads (user_id, updated_at desc);

-- Grants the service still has to revoke with Strava (after a disconnect or an account deletion).
-- Not tied to the account, so it outlives the deletion it came from.
create table private.strava_revocations (
  id bigint generated always as identity primary key,
  refresh_token_enc text not null,
  access_token_enc text,
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------------------
create or replace function private.url_encode(p text)
returns text
language sql stable
as $$
  select coalesce(string_agg(case when ch ~ '^[A-Za-z0-9_.~-]$' then ch
                                  else upper(regexp_replace(encode(convert_to(ch, 'UTF8'), 'hex'), '(..)', '%\1', 'g')) end,
                             '' order by ord), '')
  from regexp_split_to_table(coalesce(p, ''), '') with ordinality as t(ch, ord)
$$;

-- Strava's public settings when the service has credentials, else null.
create or replace function private.strava_settings()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select case when i.available then i.settings end from private.integrations i where i.name = 'strava'
$$;

-- ---------------------------------------------------------------------------------------
-- The runner's RPCs
-- ---------------------------------------------------------------------------------------
create or replace function public.get_strava_status()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_conn private.strava_connections;
begin
  select * into v_conn from private.strava_connections where user_id = v_uid;
  return jsonb_build_object(
    'available', private.strava_settings() is not null,
    'connected', v_conn.user_id is not null,
    'athlete_name', v_conn.athlete_name,
    'auto_upload', coalesce(v_conn.auto_upload, true),
    'connected_at_ms', case when v_conn.user_id is null then null else private.ts_to_ms(v_conn.connected_at) end,
    'posted', (select count(*) from private.strava_uploads where user_id = v_uid and state = 'done'),
    'pending', (select count(*) from private.strava_uploads where user_id = v_uid and state in ('queued', 'processing')),
    'failed', (select count(*) from private.strava_uploads where user_id = v_uid and state = 'failed'),
    'last_error', (select u.last_error from private.strava_uploads u
                   where u.user_id = v_uid and u.state = 'failed' order by u.updated_at desc limit 1)
  );
end
$$;

-- Starts connecting: returns Strava's authorization URL. `p_return_to` is where the service sends
-- the runner afterwards (the app's URL scheme, or the web app); it must match an allowed prefix.
create or replace function public.start_strava_connect(p_return_to text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_settings jsonb := private.strava_settings();
  v_state text;
begin
  if v_settings is null then
    perform private.fail('not_available', 'strava');
  end if;
  if p_return_to is null or char_length(p_return_to) > 300 or not exists (
       select 1 from jsonb_array_elements_text(coalesce(v_settings -> 'return_prefixes', '[]'::jsonb)) p
       where starts_with(p_return_to, p)) then
    perform private.fail('invalid_input', 'return_to');
  end if;
  perform private.check_rate_limit('strava_connect:' || v_uid, 20, interval '1 hour');
  v_state := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  insert into private.strava_connect_states (state_hash, user_id, return_to)
  values (encode(sha256(convert_to(v_state, 'UTF8')), 'hex'), v_uid, p_return_to);
  return jsonb_build_object(
    'url', 'https://www.strava.com/oauth/mobile/authorize?client_id=' || private.url_encode(v_settings ->> 'client_id')
           || '&redirect_uri=' || private.url_encode(v_settings ->> 'redirect_uri')
           || '&response_type=code&approval_prompt=auto&scope=' || private.url_encode('activity:write')
           || '&state=' || v_state);
end
$$;

create or replace function public.set_strava_auto_upload(p_enabled boolean)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
begin
  update private.strava_connections
     set auto_upload = coalesce(p_enabled, true),
         -- Turning it back on posts runs from now, not the ones recorded while it was off.
         upload_since = case when coalesce(p_enabled, true) and not auto_upload then now() else upload_since end,
         updated_at = now()
   where user_id = v_uid;
  if not found then
    perform private.fail('not_found', 'strava');
  end if;
  return public.get_strava_status();
end
$$;

-- Disconnects: stops posting at once, and the service revokes the grant with Strava.
create or replace function public.disconnect_strava()
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_conn private.strava_connections;
begin
  delete from private.strava_connections where user_id = v_uid returning * into v_conn;
  if v_conn.user_id is not null then
    insert into private.strava_revocations (refresh_token_enc, access_token_enc)
    values (v_conn.refresh_token_enc, v_conn.access_token_enc);
    update private.strava_uploads set state = 'cancelled', last_error = 'disconnected', updated_at = now()
     where user_id = v_uid and state in ('queued', 'processing');
    perform private.log_server_event('strava_disconnected', v_uid, jsonb_build_object('reason', 'runner'));
  end if;
  return public.get_strava_status();
end
$$;

create or replace function public.get_strava_upload(p_run_id uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('state', u.state, 'activity_id', u.activity_id::text, 'error', u.last_error,
                            'updated_at_ms', private.ts_to_ms(u.updated_at))
  from private.strava_uploads u
  join public.runs r on r.id = u.run_id
  where u.run_id = p_run_id and r.owner_id = private.require_user()
$$;

-- Posts one run now: an older run, one recorded while posting was off, or a retry after a failure.
create or replace function public.post_run_to_strava(p_run_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_run public.runs;
begin
  if not exists (select 1 from private.strava_connections where user_id = v_uid) then
    perform private.fail('not_found', 'strava');
  end if;
  select * into v_run from public.runs where id = p_run_id and owner_id = v_uid;
  if not found or v_run.deleted_at is not null or v_run.status not in ('accepted', 'review', 'personal_only') then
    perform private.fail('not_found');
  end if;
  if not exists (select 1 from private.run_routes where run_id = p_run_id and point_count >= 2) then
    perform private.fail('invalid_input', 'no_route');
  end if;
  perform private.check_rate_limit('strava_post:' || v_uid, 30, interval '1 hour');
  insert into private.strava_uploads (run_id, user_id, requested) values (p_run_id, v_uid, true)
  on conflict (run_id) do update
    set state = 'queued', attempts = 0, last_error = null, upload_id = null, next_attempt_at = now(), requested = true, updated_at = now()
    where private.strava_uploads.state in ('failed', 'cancelled');
  return public.get_strava_upload(p_run_id);
end
$$;

-- ---------------------------------------------------------------------------------------
-- The service's side (called by the API service as the database owner, never over RPC)
-- ---------------------------------------------------------------------------------------
create or replace function private.set_strava_integration(p_available boolean, p_settings jsonb)
returns void
language sql security definer set search_path = ''
as $$
  update private.integrations set available = coalesce(p_available, false), settings = coalesce(p_settings, '{}'::jsonb), updated_at = now()
  where name = 'strava'
$$;

-- Uses up a `state` from the OAuth round trip. Expired states still return (so the service can
-- send the runner back), marked as expired.
create or replace function private.strava_take_state(p_state text)
returns table (user_id uuid, return_to text, expired boolean)
language sql security definer set search_path = ''
as $$
  delete from private.strava_connect_states s
  where s.state_hash = encode(sha256(convert_to(coalesce(p_state, ''), 'UTF8')), 'hex')
  returning s.user_id, s.return_to, s.created_at <= now() - interval '15 minutes'
$$;

-- Saves a connection after the code exchange: 'connected', 'athlete_in_use' (that Strava account is
-- connected to another PaceLeague account) or 'no_profile'.
create or replace function private.strava_save_connection(
  p_user uuid,
  p_athlete_id bigint,
  p_athlete_name text,
  p_scope text,
  p_access_enc text,
  p_refresh_enc text,
  p_expires_at timestamptz
)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_old private.strava_connections;
begin
  if not exists (select 1 from public.profiles where user_id = p_user and status = 'active') then
    return 'no_profile';
  end if;
  if exists (select 1 from private.strava_connections where athlete_id = p_athlete_id and user_id <> p_user) then
    return 'athlete_in_use';
  end if;
  select * into v_old from private.strava_connections where user_id = p_user for update;
  if v_old.user_id is not null and v_old.athlete_id <> p_athlete_id then
    -- Switching Strava accounts: let go of the old one.
    insert into private.strava_revocations (refresh_token_enc, access_token_enc) values (v_old.refresh_token_enc, v_old.access_token_enc);
  end if;
  insert into private.strava_connections as c (user_id, athlete_id, athlete_name, scope, access_token_enc, refresh_token_enc, expires_at)
  values (p_user, p_athlete_id, left(nullif(btrim(coalesce(p_athlete_name, '')), ''), 100), left(coalesce(p_scope, ''), 200),
          p_access_enc, p_refresh_enc, p_expires_at)
  on conflict (user_id) do update
    set athlete_id = excluded.athlete_id, athlete_name = excluded.athlete_name, scope = excluded.scope,
        access_token_enc = excluded.access_token_enc, refresh_token_enc = excluded.refresh_token_enc,
        expires_at = excluded.expires_at, verify_requested_at = null, updated_at = now(),
        upload_since = case when c.athlete_id = excluded.athlete_id then c.upload_since else now() end,
        connected_at = case when c.athlete_id = excluded.athlete_id then c.connected_at else now() end;
  perform private.log_server_event('strava_connected', p_user, '{}'::jsonb);
  return 'connected';
end
$$;

-- Queues accepted runs recorded with PaceLeague (the phone or the watch app) since the runner
-- connected. Imports are left out: they came from somewhere that can post to Strava itself.
create or replace function private.strava_enqueue(p_limit integer default 200)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_count integer;
begin
  insert into private.strava_uploads (run_id, user_id)
  select r.id, r.owner_id
  from private.strava_connections c
  join public.runs r on r.owner_id = c.user_id and r.ended_at >= c.upload_since
  where c.auto_upload and c.verify_requested_at is null
    and r.status = 'accepted' and r.deleted_at is null and r.source in ('phone_gps', 'watch')
    and exists (select 1 from private.run_routes rr where rr.run_id = r.id and rr.point_count >= 2)
    and not exists (select 1 from private.strava_uploads u where u.run_id = r.id)
  order by r.finalized_at
  limit greatest(1, least(coalesce(p_limit, 200), 1000))
  on conflict (run_id) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

-- Claims due uploads with a two-minute lease, so a crash mid-upload retries rather than sticks.
create or replace function private.strava_claim_uploads(p_limit integer default 10)
returns table (run_id uuid, user_id uuid, state text, upload_id bigint, attempts integer)
language sql security definer set search_path = ''
as $$
  update private.strava_uploads u
     set next_attempt_at = now() + interval '2 minutes', updated_at = now()
   where u.run_id in (
     select d.run_id from private.strava_uploads d
     where d.state in ('queued', 'processing') and d.next_attempt_at <= now()
     order by d.next_attempt_at
     limit greatest(1, least(coalesce(p_limit, 10), 50))
     for update skip locked)
  returning u.run_id, u.user_id, u.state, u.upload_id, u.attempts
$$;

-- What the service needs to write the run's GPX file.
create or replace function private.strava_run_file(p_run_id uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('title', r.title, 'activity_type', r.activity_type, 'status', r.status,
                            'deleted', r.deleted_at is not null, 'started_at_ms', private.ts_to_ms(r.started_at),
                            'segments', r.segments, 'points', rr.points)
  from public.runs r
  join private.run_routes rr on rr.run_id = r.id
  where r.id = p_run_id
$$;

create or replace function private.strava_record_upload(
  p_run_id uuid,
  p_state text,
  p_upload_id bigint,
  p_activity_id bigint,
  p_error text,
  p_retry_in_s integer,
  p_count_attempt boolean
)
returns void
language sql security definer set search_path = ''
as $$
  update private.strava_uploads
     set state = p_state,
         upload_id = coalesce(p_upload_id, upload_id),
         activity_id = coalesce(p_activity_id, activity_id),
         last_error = left(p_error, 300),
         attempts = attempts + case when p_count_attempt then 1 else 0 end,
         next_attempt_at = now() + make_interval(secs => greatest(0, coalesce(p_retry_in_s, 0))),
         updated_at = now()
   where run_id = p_run_id
$$;

create or replace function private.strava_store_tokens(p_user uuid, p_access_enc text, p_refresh_enc text, p_expires_at timestamptz)
returns void
language sql security definer set search_path = ''
as $$
  update private.strava_connections
     set access_token_enc = p_access_enc, refresh_token_enc = p_refresh_enc, expires_at = p_expires_at,
         verify_requested_at = null, updated_at = now()
   where user_id = p_user
$$;

-- Strava refused the runner's grant (they revoked it on Strava): forget it and stop posting.
create or replace function private.strava_forget(p_user uuid, p_reason text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  delete from private.strava_connections where user_id = p_user;
  update private.strava_uploads set state = 'cancelled', last_error = left(p_reason, 300), updated_at = now()
   where user_id = p_user and state in ('queued', 'processing');
  perform private.log_server_event('strava_disconnected', p_user, jsonb_build_object('reason', left(p_reason, 60)));
end
$$;

-- Strava's webhook says an athlete revoked access. Webhooks aren't signed, so this only asks the
-- service to check with a token refresh; the refresh failing is what disconnects.
create or replace function private.strava_athlete_deauthorized(p_athlete_id bigint)
returns boolean
language sql security definer set search_path = ''
as $$
  update private.strava_connections set verify_requested_at = now(), updated_at = now()
  where athlete_id = p_athlete_id
  returning true
$$;

create or replace function private.strava_claim_revocations(p_limit integer default 10)
returns table (id bigint, refresh_token_enc text, access_token_enc text, attempts integer)
language sql security definer set search_path = ''
as $$
  update private.strava_revocations v
     set next_attempt_at = now() + interval '5 minutes'
   where v.id in (
     select d.id from private.strava_revocations d
     where d.next_attempt_at <= now()
     order by d.next_attempt_at
     limit greatest(1, least(coalesce(p_limit, 10), 50))
     for update skip locked)
  returning v.id, v.refresh_token_enc, v.access_token_enc, v.attempts
$$;

-- A revocation is done once Strava accepts it, or after ten tries (the grant then lapses unused).
create or replace function private.strava_revocation_result(p_id bigint, p_done boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if p_done then
    delete from private.strava_revocations where id = p_id;
    return;
  end if;
  update private.strava_revocations
     set attempts = attempts + 1, next_attempt_at = now() + least(interval '6 hours', interval '1 minute' * power(2, attempts))
   where id = p_id;
  delete from private.strava_revocations where id = p_id and attempts >= 10;
end
$$;

create or replace function private.strava_purge()
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_count integer;
begin
  delete from private.strava_connect_states where created_at < now() - interval '1 day';
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

-- ---------------------------------------------------------------------------------------
-- Account deletion revokes the grant too
-- ---------------------------------------------------------------------------------------
create or replace function private.purge_user_data(p_user uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  insert into private.strava_revocations (refresh_token_enc, access_token_enc)
  select c.refresh_token_enc, c.access_token_enc from private.strava_connections c where c.user_id = p_user;
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
-- Export format 3: Phase 2 adds the Strava connection (never its tokens) and diagnostics reports.
-- Runs already carry their source and provenance through private.run_json.
-- ---------------------------------------------------------------------------------------
create or replace function public.get_export(p_export_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_profile public.profiles;
  v_email text;
  v_strava private.strava_connections;
begin
  perform private.require_export(v_uid, p_export_id);
  select * into v_profile from public.profiles where user_id = v_uid;
  select email into v_email from auth.users where id = v_uid;
  select * into v_strava from private.strava_connections where user_id = v_uid;
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
                           where o.owner_id = v_uid), '[]'::jsonb),
    'strava', jsonb_build_object(
      'connected', v_strava.user_id is not null,
      'athlete_id', v_strava.athlete_id::text,
      'athlete_name', v_strava.athlete_name,
      'connected_at_ms', case when v_strava.user_id is null then null else private.ts_to_ms(v_strava.connected_at) end,
      'auto_upload', v_strava.auto_upload,
      'uploads', coalesce((select jsonb_agg(jsonb_build_object('run_id', u.run_id, 'state', u.state,
                                             'activity_id', u.activity_id::text, 'updated_at_ms', private.ts_to_ms(u.updated_at))
                                           order by u.created_at)
                           from private.strava_uploads u where u.user_id = v_uid), '[]'::jsonb)),
    'diagnostic_reports', coalesce((select jsonb_agg(jsonb_build_object('created_at_ms', private.ts_to_ms(d.created_at), 'report', d.report)
                                                     order by d.created_at)
                                    from private.diagnostic_reports d where d.user_id = v_uid), '[]'::jsonb)
  );
end
$$;

select private.apply_function_grants();
