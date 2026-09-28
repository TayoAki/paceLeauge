-- Live location (docs/ROADMAP.md 4.8): a link that shows where a runner is during one run, for the
-- people they send it to. It's free, because it's a safety feature, and never public:
--   * the link carries a long random code, and only its hash is stored;
--   * it isn't listed anywhere, and opening it shows the runner's name and latest position only;
--   * it stops working the moment the run ends, when the runner stops sharing, or at the time they
--     chose (at most six hours), whichever comes first;
--   * only the latest position is kept (no trail), and it's wiped when the link stops.
-- The phone posts a position about every 30 seconds. Viewers open the web app (P.2) and don't need
-- an account.

create table private.live_shares (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ended_at timestamptz,
  ended_reason text check (ended_reason in ('run_ended', 'stopped', 'replaced', 'expired')),
  lat double precision check (lat is null or lat between -90 and 90),
  lon double precision check (lon is null or lon between -180 and 180),
  accuracy_m real check (accuracy_m is null or accuracy_m between 0 and 5000),
  position_at timestamptz,
  distance_m double precision check (distance_m is null or distance_m between 0 and 1000000),
  elapsed_ms bigint check (elapsed_ms is null or elapsed_ms between 0 and 86400000),
  updated_at timestamptz not null default now()
);
create index live_shares_open_idx on private.live_shares (owner_id) where ended_at is null;
create index live_shares_expiry_idx on private.live_shares (expires_at) where ended_at is null;

create or replace function private.live_token_hash(p_token text)
returns text
language sql immutable
as $$
  select encode(sha256(convert_to('pl-live-v1:' || coalesce(p_token, ''), 'UTF8')), 'hex')
$$;

-- Stops a link and wipes what it showed.
create or replace function private.stop_live_share(p_share_id uuid, p_reason text)
returns void
language sql security definer set search_path = ''
as $$
  update private.live_shares
     set ended_at = coalesce(ended_at, now()), ended_reason = coalesce(ended_reason, p_reason),
         lat = null, lon = null, accuracy_m = null, position_at = null, distance_m = null, elapsed_ms = null, updated_at = now()
   where id = p_share_id
$$;

-- Starts a link for this run, replacing any link the runner still has open. Returns the code
-- once; the server keeps only its hash.
create or replace function public.start_live_share(p_minutes integer default 120)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_token text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  v_share private.live_shares;
  v_old uuid;
begin
  if p_minutes is null or p_minutes < 15 or p_minutes > 360 then
    perform private.fail('invalid_input', 'minutes');
  end if;
  perform private.check_rate_limit('live_start:' || v_uid, 20, interval '1 day');
  for v_old in select id from private.live_shares where owner_id = v_uid and ended_at is null loop
    perform private.stop_live_share(v_old, 'replaced');
  end loop;
  insert into private.live_shares (owner_id, token_hash, expires_at)
  values (v_uid, private.live_token_hash(v_token), now() + make_interval(mins => p_minutes))
  returning * into v_share;
  return jsonb_build_object('share_id', v_share.id, 'token', v_token, 'expires_at_ms', private.ts_to_ms(v_share.expires_at));
end
$$;

-- The phone's latest position, about every 30 seconds while the run records.
create or replace function public.post_live_location(
  p_share_id uuid,
  p_lat double precision,
  p_lon double precision,
  p_accuracy_m double precision default null,
  p_at_ms bigint default null,
  p_distance_m double precision default null,
  p_elapsed_ms bigint default null
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_share private.live_shares;
  v_at timestamptz := least(now(), coalesce(private.ms_to_ts(p_at_ms), now()));
begin
  select * into v_share from private.live_shares where id = p_share_id and owner_id = v_uid for update;
  if not found then
    perform private.fail('not_found');
  end if;
  if v_share.ended_at is null and v_share.expires_at <= now() then
    perform private.stop_live_share(v_share.id, 'expired');
    v_share.ended_at := now();
  end if;
  if v_share.ended_at is not null then
    return jsonb_build_object('live', false, 'expires_at_ms', private.ts_to_ms(v_share.expires_at));
  end if;
  if p_lat is null or p_lon is null or p_lat not between -90 and 90 or p_lon not between -180 and 180
     or (p_accuracy_m is not null and p_accuracy_m not between 0 and 5000)
     or (p_distance_m is not null and p_distance_m not between 0 and 1000000)
     or (p_elapsed_ms is not null and p_elapsed_ms not between 0 and 86400000) then
    perform private.fail('invalid_input', 'position');
  end if;
  -- About one every 30 seconds; a phone catching up after a dead zone can send a few at once.
  perform private.check_rate_limit('live_post:' || v_share.id, 20, interval '1 minute');
  if v_share.position_at is not null and v_at < v_share.position_at then
    return jsonb_build_object('live', true, 'expires_at_ms', private.ts_to_ms(v_share.expires_at));
  end if;
  update private.live_shares
     set lat = p_lat, lon = p_lon, accuracy_m = p_accuracy_m, position_at = greatest(v_at, now() - interval '10 minutes'),
         distance_m = p_distance_m, elapsed_ms = p_elapsed_ms, updated_at = now()
   where id = v_share.id;
  return jsonb_build_object('live', true, 'expires_at_ms', private.ts_to_ms(v_share.expires_at));
end
$$;

-- The run ended, or the runner stopped sharing: the link stops at once.
create or replace function public.end_live_share(p_share_id uuid default null, p_reason text default 'stopped')
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_id uuid;
  v_count integer := 0;
begin
  if p_reason is null or p_reason not in ('run_ended', 'stopped') then
    perform private.fail('invalid_input', 'reason');
  end if;
  for v_id in
    select id from private.live_shares where owner_id = v_uid and ended_at is null and (p_share_id is null or id = p_share_id)
  loop
    perform private.stop_live_share(v_id, p_reason);
    v_count := v_count + 1;
  end loop;
  return jsonb_build_object('ended', v_count);
end
$$;

-- What a link shows, to anyone who has it (no account needed): the runner's name and latest
-- position while the link is live, and nothing at all once it has stopped or never existed.
create or replace function public.get_live_location(p_token text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_hash text;
  v_share private.live_shares;
  v_alias text;
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

-- Links whose time ran out stop, and their last position goes; stopped links are gone after a week.
create or replace function private.expire_live_shares()
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_count integer := 0;
begin
  for v_id in select id from private.live_shares where ended_at is null and expires_at <= now() limit 500 loop
    perform private.stop_live_share(v_id, 'expired');
    v_count := v_count + 1;
  end loop;
  delete from private.live_shares where ended_at < now() - interval '7 days';
  return v_count;
end
$$;

create or replace function private.run_frequent_jobs()
returns jsonb
language plpgsql security definer set search_path = ''
as $$
begin
  return jsonb_build_object(
    'deletions_completed', private.process_deletion_jobs(20),
    'pending_scored', private.apply_pending_scoring(500),
    'results_queued', private.enqueue_week_results(),
    'seasons_settled', private.settle_seasons(),
    'group_run_reminders', private.enqueue_group_run_reminders(),
    'leaderboard_changes', private.refresh_leaderboards(),
    'live_shares_expired', private.expire_live_shares());
end
$$;

-- The live-location viewer is the third function anyone may call without signing in.
create or replace function private.apply_function_grants()
returns void
language plpgsql
as $$
declare
  f record;
  anon_allowed constant text[] := array['get_app_config', 'get_invite_preview', 'get_live_location'];
begin
  for f in
    select p.oid::regprocedure as signature, p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
  loop
    execute format('revoke all on function %s from public, anon', f.signature);
    execute format('grant execute on function %s to authenticated, service_role', f.signature);
    if f.proname = any (anon_allowed) then
      execute format('grant execute on function %s to anon', f.signature);
    end if;
  end loop;
  for f in
    select p.oid::regprocedure as signature
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.signature);
  end loop;
  -- Needed by the leagues RLS policy.
  grant execute on function private.is_active_member(uuid, uuid) to authenticated;
end
$$;

select private.apply_function_grants();
