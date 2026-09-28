-- The heatmap and route discovery (docs/ROADMAP.md 5.4): a map of popular running paths, and
-- the busiest places near a runner for suggested loops.
--   * Opt-in: only runners who choose to contribute (never teens), and only their accepted runs
--     shared with everyone with the map, from the last 365 days.
--   * Only what a shared map shows: not the first or last 200 m of a run, nothing inside the
--     runner's privacy zones (the same track segments are matched on).
--   * A cell of the map appears only once 5 different runners have run through it, however many
--     times one runner does; its brightness is one of four levels, never a count.
--   * Each run's cells are worked out once, by the minute job; the map itself is rebuilt weekly,
--     and the API service renders and keeps its tiles until the next build.
-- Cells are the tiles of the web map grid at zoom 21 (about 19 m across at the equator, 14 m at
-- 45°): x and y are whole numbers, so cells need no PostGIS.

create table private.heatmap_contributors (
  user_id uuid primary key references auth.users (id) on delete cascade,
  joined_at timestamptz not null default now()
);

create trigger heatmap_contributors_teens before insert on private.heatmap_contributors
  for each row execute function private.guard_teen_user();

-- The cells each contributed run passes through (once each).
create table private.heatmap_run_cells (
  run_id uuid not null references public.runs (id) on delete cascade,
  x integer not null,
  y integer not null,
  primary key (run_id, x, y)
);

-- Runs whose cells need working out again: new, edited, shared or unshared, or their runner
-- started contributing or changed a privacy zone.
create table private.heatmap_queue (
  run_id uuid primary key references public.runs (id) on delete cascade,
  queued_at timestamptz not null default now()
);

create table private.heatmap_builds (
  id bigint generated always as identity primary key,
  built_at timestamptz not null default now(),
  runs integer not null,
  runners integer not null,
  cells integer not null
);

-- The published map: cells used by at least 5 different runners.
create table private.heatmap_cells (
  x integer not null,
  y integer not null,
  runners integer not null,
  primary key (x, y)
);

-- Tiles the API service rendered from the current build, kept until the next build.
create table private.heatmap_tiles (
  build_id bigint not null references private.heatmap_builds (id) on delete cascade,
  z smallint not null,
  x integer not null,
  y integer not null,
  png bytea not null,
  created_at timestamptz not null default now(),
  primary key (build_id, z, x, y)
);

create or replace function private.heatmap_limits()
returns jsonb
language sql immutable
as $$
  select jsonb_build_object(
    'min_runners', 5, 'window_days', 365, 'rebuild_days', 7, 'cell_zoom', 21, 'min_zoom', 10, 'max_zoom', 18,
    -- Runners per cell from which each brightness level starts.
    'levels', jsonb_build_array(5, 10, 20, 50),
    'hotspot_radius_m', 5000, 'hotspot_spacing_m', 400, 'hotspots', 12)
$$;

-- The zoom-21 cell a point falls in.
create or replace function private.heatmap_cell(p_lat double precision, p_lon double precision)
returns table (x integer, y integer)
language sql immutable
as $$
  select least(2097151, greatest(0, floor((p_lon + 180.0) / 360.0 * 2097152)))::integer,
         least(2097151, greatest(0, floor((1.0 - ln(tan(radians(v.lat)) + 1.0 / cos(radians(v.lat))) / pi()) / 2.0 * 2097152)))::integer
  from (select least(85.05, greatest(-85.05, p_lat)) as lat) v
$$;

-- The middle of a cell.
create or replace function private.heatmap_cell_center(p_x integer, p_y integer)
returns table (lat double precision, lon double precision)
language sql immutable
as $$
  select degrees(atan(sinh(pi() * (1.0 - 2.0 * (p_y + 0.5) / 2097152)))), (p_x + 0.5) / 2097152 * 360.0 - 180.0
$$;

create or replace function private.heatmap_level(p_runners integer)
returns smallint
language sql immutable
as $$
  select case when p_runners >= 50 then 4 when p_runners >= 20 then 3 when p_runners >= 10 then 2 else 1 end::smallint
$$;

create or replace function private.heatmap_contributor(p_user uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from private.heatmap_contributors c where c.user_id = p_user) and not private.is_teen(p_user)
$$;

-- A run that may add to the heatmap: accepted, a run, shared with everyone with its map, from
-- the last year, by a runner who contributes.
create or replace function private.heatmap_run_eligible(p_run public.runs)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select p_run.status = 'accepted' and p_run.deleted_at is null and p_run.activity_type = 'run'
     and p_run.visibility = 'everyone' and p_run.map_shared
     and p_run.started_at >= now() - make_interval(days => (private.heatmap_limits() ->> 'window_days')::integer)
     and private.heatmap_contributor(p_run.owner_id)
$$;

-- ---------------------------------------------------------------------------------------
-- What to work out again, and the job that does it
-- ---------------------------------------------------------------------------------------
create or replace function private.on_run_for_heatmap()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_row jsonb := to_jsonb(new);
  v_run uuid := coalesce(v_row ->> 'run_id', v_row ->> 'id')::uuid;
  v_owner uuid := (v_row ->> 'owner_id')::uuid;
begin
  if v_owner is null then
    select owner_id into v_owner from public.runs where id = v_run;
  end if;
  if exists (select 1 from private.heatmap_contributors c where c.user_id = v_owner)
     or exists (select 1 from private.heatmap_run_cells c where c.run_id = v_run) then
    insert into private.heatmap_queue (run_id) values (v_run)
    on conflict (run_id) do update set queued_at = now();
  end if;
  return null;
end
$$;

create trigger runs_heatmap after update on public.runs
  for each row
  when (old.status is distinct from new.status or old.visibility is distinct from new.visibility
        or old.map_shared is distinct from new.map_shared or old.deleted_at is distinct from new.deleted_at
        or old.activity_type is distinct from new.activity_type)
  execute function private.on_run_for_heatmap();
create trigger run_routes_heatmap after insert or update of points on private.run_routes
  for each row execute function private.on_run_for_heatmap();

-- The runner's runs from the last year, and any already on the map, are worked out again.
create or replace function private.queue_runner_heatmap(p_user uuid)
returns integer
language sql security definer set search_path = ''
as $$
  with queued as (
    insert into private.heatmap_queue (run_id)
    select r.id from public.runs r
    where r.owner_id = p_user and r.deleted_at is null and r.status = 'accepted'
      and (r.started_at >= now() - make_interval(days => (private.heatmap_limits() ->> 'window_days')::integer)
           or exists (select 1 from private.heatmap_run_cells c where c.run_id = r.id))
    on conflict (run_id) do update set queued_at = now()
    returning 1
  )
  select count(*)::integer from queued
$$;

create or replace function private.on_zones_for_heatmap()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := coalesce(to_jsonb(new) ->> 'user_id', to_jsonb(old) ->> 'user_id')::uuid;
begin
  if exists (select 1 from private.heatmap_contributors c where c.user_id = v_user) then
    perform private.queue_runner_heatmap(v_user);
  end if;
  return null;
end
$$;

create trigger privacy_zones_heatmap after insert or update or delete on private.privacy_zones
  for each row execute function private.on_zones_for_heatmap();

-- Works out the cells of queued runs: the points a shared map shows, with points every 5 m
-- between fixes up to 100 m apart in the same stretch (so sparse tracks from watches and other
-- apps don't skip cells), never across a pause or a gap.
create or replace function private.process_heatmap_queue(p_limit integer default 100)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_run public.runs;
  v_done integer := 0;
begin
  for v_id in
    select q.run_id from private.heatmap_queue q
    order by q.queued_at limit greatest(1, coalesce(p_limit, 100))
    for update skip locked
  loop
    delete from private.heatmap_queue where run_id = v_id;
    v_done := v_done + 1;
    delete from private.heatmap_run_cells where run_id = v_id;
    select * into v_run from public.runs where id = v_id;
    continue when not found or not private.heatmap_run_eligible(v_run);
    insert into private.heatmap_run_cells (run_id, x, y)
    select distinct v_run.id, c.x, c.y
    from (
      select t.lat, t.lon, lag(t.lat) over w as plat, lag(t.lon) over w as plon, lag(t.part) over w as ppart, t.part
      from private.segment_track(v_run) t
      window w as (order by t.i)
    ) s
    -- n: how many points stand for the stretch from the previous fix to this one.
    cross join lateral (
      select case when s.plat is not null and s.ppart = s.part
                  then greatest(1, least(20, ceil(private.haversine_m(s.plat, s.plon, s.lat, s.lon) / 5)))::integer
                  else 1 end as n,
             s.plat is not null and s.ppart = s.part
               and private.haversine_m(s.plat, s.plon, s.lat, s.lon) <= 100 as joined
    ) g
    cross join lateral generate_series(0, case when g.joined then g.n - 1 else 0 end) k
    cross join lateral (
      select case when k = 0 then s.lat else s.lat + (s.plat - s.lat) * k / g.n end as lat,
             case when k = 0 then s.lon else s.lon + (s.plon - s.lon) * k / g.n end as lon
    ) p
    cross join lateral private.heatmap_cell(p.lat, p.lon) c;
  end loop;
  return v_done;
end
$$;

-- ---------------------------------------------------------------------------------------
-- The weekly build
-- ---------------------------------------------------------------------------------------
-- The runs a build counts, checked again at build time: still accepted, shared with everyone
-- with the map, from the last year, by an active adult who contributes.
create or replace function private.heatmap_build_runs()
returns table (id uuid, owner_id uuid)
language sql stable security definer set search_path = ''
as $$
  select r.id, r.owner_id
  from public.runs r
  join private.heatmap_contributors hc on hc.user_id = r.owner_id
  join public.profiles p on p.user_id = r.owner_id
  where r.status = 'accepted' and r.deleted_at is null and r.activity_type = 'run'
    and r.visibility = 'everyone' and r.map_shared
    and r.started_at >= now() - make_interval(days => (private.heatmap_limits() ->> 'window_days')::integer)
    and p.status = 'active' and coalesce(p.age_signal, '') not in ('minor', 'teen_13_15', 'teen_16_17')
$$;

create or replace function private.build_heatmap()
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_limits jsonb := private.heatmap_limits();
  v_build bigint;
  v_cells integer;
  v_runners integer;
  v_runs integer;
begin
  -- Runs that aged out of the window.
  delete from private.heatmap_run_cells c using public.runs r
  where r.id = c.run_id and r.started_at < now() - make_interval(days => (v_limits ->> 'window_days')::integer);
  delete from private.heatmap_cells;
  insert into private.heatmap_cells (x, y, runners)
  select c.x, c.y, count(distinct e.owner_id)::integer
  from private.heatmap_run_cells c
  join private.heatmap_build_runs() e on e.id = c.run_id
  group by c.x, c.y
  having count(distinct e.owner_id) >= (v_limits ->> 'min_runners')::integer;
  get diagnostics v_cells = row_count;
  select count(distinct e.id)::integer, count(distinct e.owner_id)::integer into v_runs, v_runners
  from private.heatmap_build_runs() e
  where exists (select 1 from private.heatmap_run_cells c where c.run_id = e.id);
  insert into private.heatmap_builds (runs, runners, cells) values (v_runs, v_runners, v_cells) returning id into v_build;
  -- The previous build's tiles go; a few builds are kept for the record.
  delete from private.heatmap_tiles where build_id <> v_build;
  delete from private.heatmap_builds where id <= v_build - 10;
  return jsonb_build_object('build', v_build, 'cells', v_cells, 'runners', v_runners, 'runs', v_runs);
end
$$;

-- Called hourly by the API service: rebuilds once the last build is a week old.
create or replace function private.build_heatmap_if_due()
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_last timestamptz := (select max(built_at) from private.heatmap_builds);
begin
  if v_last is not null and v_last > now() - make_interval(days => (private.heatmap_limits() ->> 'rebuild_days')::integer) then
    return null;
  end if;
  return private.build_heatmap();
end
$$;

create or replace function private.heatmap_current_build()
returns bigint
language sql stable security definer set search_path = ''
as $$
  select max(id) from private.heatmap_builds
$$;

-- The cells inside one map tile, with their brightness level (never a count).
create or replace function private.heatmap_tile_cells(p_z integer, p_x integer, p_y integer)
returns table (x integer, y integer, level smallint)
language sql stable security definer set search_path = ''
as $$
  select c.x, c.y, private.heatmap_level(c.runners)
  from private.heatmap_cells c
  where p_z between 0 and 21
    and c.x >= p_x::bigint << (21 - p_z) and c.x < (p_x::bigint + 1) << (21 - p_z)
    and c.y >= p_y::bigint << (21 - p_z) and c.y < (p_y::bigint + 1) << (21 - p_z)
$$;

-- Who may have tile links (the API service signs them): signed-in adults with a profile, when a
-- map has been built. Returns the build.
create or replace function private.heatmap_tiles_check(p_user uuid)
returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  v_status text;
  v_age text;
  v_build bigint := private.heatmap_current_build();
begin
  select status, age_signal into v_status, v_age from public.profiles where user_id = p_user;
  if v_status is null then
    perform private.fail('profile_required');
  elsif v_status <> 'active' then
    perform private.fail('account_deleting');
  elsif v_age = 'minor' then
    perform private.fail('age_restricted');
  elsif v_age in ('teen_13_15', 'teen_16_17') then
    perform private.fail('teen_restricted', 'get_heatmap_tiles');
  end if;
  if v_build is null then
    perform private.fail('not_available', 'heatmap');
  end if;
  perform private.check_rate_limit('heatmap_tiles:' || p_user, 60, interval '1 hour');
  return v_build;
end
$$;

-- ---------------------------------------------------------------------------------------
-- Runners' calls
-- ---------------------------------------------------------------------------------------
create or replace function public.get_heatmap()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_limits jsonb := private.heatmap_limits();
  v_build private.heatmap_builds;
begin
  select * into v_build from private.heatmap_builds order by id desc limit 1;
  return jsonb_build_object(
    'contributing', private.heatmap_contributor(v_uid),
    'contributing_since_ms', (select private.ts_to_ms(c.joined_at) from private.heatmap_contributors c where c.user_id = v_uid),
    'min_runners', (v_limits ->> 'min_runners')::integer,
    'window_days', (v_limits ->> 'window_days')::integer,
    'min_zoom', (v_limits ->> 'min_zoom')::integer,
    'max_zoom', (v_limits ->> 'max_zoom')::integer,
    'build', case when v_build.id is null then null
                  else jsonb_build_object('id', v_build.id, 'built_at_ms', private.ts_to_ms(v_build.built_at), 'cells', v_build.cells) end);
end
$$;

-- Contributing adds the runner's shared runs from the last year at the next weekly build;
-- stopping takes them out of the next one (and their cells go at once).
create or replace function public.set_heatmap_contribution(p_on boolean)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
begin
  if p_on is null then
    perform private.fail('invalid_input', 'on');
  end if;
  perform private.check_rate_limit('heatmap_contribution:' || v_uid, 20, interval '1 day');
  if p_on then
    insert into private.heatmap_contributors (user_id) values (v_uid) on conflict (user_id) do nothing;
    perform private.queue_runner_heatmap(v_uid);
  else
    delete from private.heatmap_contributors where user_id = v_uid;
    delete from private.heatmap_run_cells c using public.runs r where r.id = c.run_id and r.owner_id = v_uid;
    delete from private.heatmap_queue q using public.runs r where r.id = q.run_id and r.owner_id = v_uid;
  end if;
  return public.get_heatmap();
end
$$;

-- The busiest places on the map near a point, spread out, for suggested loops: only cells the
-- published map shows, with their level.
create or replace function public.get_heatmap_hotspots(p_lat double precision, p_lon double precision)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_limits jsonb := private.heatmap_limits();
  v_radius double precision := (v_limits ->> 'hotspot_radius_m')::double precision;
  v_spacing double precision := (v_limits ->> 'hotspot_spacing_m')::double precision;
  v_cell_m double precision;
  v_span integer;
  v_x integer;
  v_y integer;
  v_pick record;
  v_chosen jsonb := '[]'::jsonb;
  v_far boolean;
begin
  if p_lat is null or p_lon is null or p_lat not between -85 and 85 or p_lon not between -180 and 180 then
    perform private.fail('invalid_input', 'point');
  end if;
  perform private.check_rate_limit('heatmap_hotspots:' || v_uid, 120, interval '1 hour');
  select c.x, c.y into v_x, v_y from private.heatmap_cell(p_lat, p_lon) c;
  v_cell_m := 40075016.686 * cos(radians(p_lat)) / 2097152;
  v_span := ceil(v_radius / v_cell_m)::integer;
  for v_pick in
    select m.lat, m.lon, private.heatmap_level(c.runners) as level, c.runners,
           private.haversine_m(p_lat, p_lon, m.lat, m.lon) as d
    from private.heatmap_cells c
    cross join lateral private.heatmap_cell_center(c.x, c.y) m
    where c.x between v_x - v_span and v_x + v_span and c.y between v_y - v_span and v_y + v_span
      and private.haversine_m(p_lat, p_lon, m.lat, m.lon) between 150 and v_radius
    order by c.runners desc, d
  loop
    select not exists (
      select 1 from jsonb_array_elements(v_chosen) h
      where private.haversine_m((h ->> 'lat')::double precision, (h ->> 'lon')::double precision, v_pick.lat, v_pick.lon) < v_spacing
    ) into v_far;
    continue when not v_far;
    v_chosen := v_chosen || jsonb_build_object('lat', round(v_pick.lat::numeric, 6), 'lon', round(v_pick.lon::numeric, 6),
                                               'level', v_pick.level, 'distance_m', round(v_pick.d));
    exit when jsonb_array_length(v_chosen) >= (v_limits ->> 'hotspots')::integer;
  end loop;
  return v_chosen;
end
$$;

-- ---------------------------------------------------------------------------------------
-- Jobs and the export
-- ---------------------------------------------------------------------------------------
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
    'live_shares_expired', private.expire_live_shares(),
    'segment_matches', private.process_segment_matches(200),
    'heatmap_runs', private.process_heatmap_queue(200));
end
$$;

create or replace function private.heatmap_export(p_uid uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'contributing', private.heatmap_contributor(p_uid),
    'contributing_since_ms', (select private.ts_to_ms(c.joined_at) from private.heatmap_contributors c where c.user_id = p_uid),
    'runs_contributed', (select count(distinct c.run_id) from private.heatmap_run_cells c join public.runs r on r.id = c.run_id
                         where r.owner_id = p_uid))
$$;

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
                                    from private.diagnostic_reports d where d.user_id = p_uid), '[]'::jsonb),
    'training_plans', coalesce((select jsonb_agg(private.plan_json(p.id) order by p.created_at)
                                from private.training_plans p where p.user_id = p_uid), '[]'::jsonb),
    'subscription', private.entitlements_json(p_uid),
    'social', private.social_export(p_uid),
    'clubs', private.club_export(p_uid),
    'challenges', private.challenge_export(p_uid),
    'leaderboards', private.leaderboard_export(p_uid),
    'routes', private.route_export(p_uid),
    'segments', private.segment_export(p_uid),
    'heatmap', private.heatmap_export(p_uid)
  );
end
$$;

select private.apply_function_grants();
