-- Route planning (docs/ROADMAP.md 5.1): runners plan a route, save it, follow it on a run and send
-- it to their watch.
--   * Planning goes through a routing service with a walking profile (GraphHopper's API, hosted or
--     self-hosted), which the API service calls itself (server/src/routing.ts) so its key never
--     reaches the app. It is off until the service is configured; drawing a route by hand works
--     without it.
--   * Saved routes are private to the runner: nobody else can list, open or follow them, and they
--     are in the export and go with the account.
--   * The server recomputes each route's distance from its points; it never trusts the phone's.

alter table private.integrations drop constraint integrations_name_check;
alter table private.integrations add constraint integrations_name_check check (name in ('strava', 'garmin', 'push', 'routing'));
insert into private.integrations (name) values ('routing');

create table private.saved_routes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  -- loop: planned from a start and a distance; path: drawn along paths by the routing service;
  -- drawn: straight lines between the runner's points.
  kind text not null check (kind in ('loop', 'path', 'drawn')),
  -- [[lat, lon], …] with 6 decimals (about 10 cm).
  points jsonb not null,
  -- [{"i": point index, "turn": …, "street": name or null, "exit": roundabout exit or null}]
  cues jsonb not null default '[]'::jsonb,
  distance_m integer not null check (distance_m between 50 and 200000),
  ascent_m integer check (ascent_m is null or ascent_m between 0 and 20000),
  start_lat double precision not null,
  start_lon double precision not null,
  min_lat double precision not null,
  max_lat double precision not null,
  min_lon double precision not null,
  max_lon double precision not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index saved_routes_user_idx on private.saved_routes (user_id, updated_at desc);

create or replace function private.route_limits()
returns jsonb
language sql immutable
as $$
  select jsonb_build_object('routes', 100, 'points', 5000, 'distance_m', 200000, 'gap_m', 25000, 'cues', 1000)
$$;

create or replace function private.route_turns()
returns text[]
language sql immutable
as $$
  select array['left', 'right', 'slight_left', 'slight_right', 'sharp_left', 'sharp_right', 'keep_left', 'keep_right', 'u_turn', 'roundabout']
$$;

-- Checks a route's points and measures it: the points rounded to 6 decimals, their number, the
-- distance, the start and the bounding box. Fails with invalid_input for anything that isn't a
-- plausible route.
create or replace function private.route_geometry(p_points jsonb)
returns jsonb
language plpgsql immutable set search_path = ''
as $$
declare
  v_limits jsonb := private.route_limits();
  v_n integer;
  v_bad boolean;
  v_out jsonb;
begin
  if p_points is null or jsonb_typeof(p_points) <> 'array' then
    perform private.fail('invalid_input', 'points');
  end if;
  v_n := jsonb_array_length(p_points);
  if v_n < 2 or v_n > (v_limits ->> 'points')::integer then
    perform private.fail('invalid_input', 'points');
  end if;
  select bool_or(case
           when jsonb_typeof(value) <> 'array' then true
           when jsonb_array_length(value) <> 2 then true
           when jsonb_typeof(value -> 0) <> 'number' or jsonb_typeof(value -> 1) <> 'number' then true
           when (value ->> 0)::numeric not between -90 and 90 or (value ->> 1)::numeric not between -180 and 180 then true
           else false end)
    into v_bad
    from jsonb_array_elements(p_points);
  if v_bad then
    perform private.fail('invalid_input', 'points');
  end if;
  with pts as (
    select e.ord, round((e.value ->> 0)::numeric, 6)::double precision as lat, round((e.value ->> 1)::numeric, 6)::double precision as lon
    from jsonb_array_elements(p_points) with ordinality e(value, ord)
  ), steps as (
    select ord, lat, lon, private.haversine_m(lag(lat) over w, lag(lon) over w, lat, lon) as gap
    from pts window w as (order by ord)
  )
  select jsonb_build_object(
           'points', jsonb_agg(jsonb_build_array(lat, lon) order by ord),
           'n', count(*),
           'total', coalesce(sum(gap), 0),
           'max_gap', coalesce(max(gap), 0),
           'start_lat', min(lat) filter (where ord = 1), 'start_lon', min(lon) filter (where ord = 1),
           'min_lat', min(lat), 'max_lat', max(lat), 'min_lon', min(lon), 'max_lon', max(lon))
    into v_out
    from steps;
  if (v_out ->> 'max_gap')::double precision > (v_limits ->> 'gap_m')::double precision then
    perform private.fail('invalid_input', 'gap');
  end if;
  if (v_out ->> 'total')::double precision < 50 or (v_out ->> 'total')::double precision > (v_limits ->> 'distance_m')::double precision then
    perform private.fail('invalid_input', 'distance');
  end if;
  return (v_out - 'total' - 'max_gap') || jsonb_build_object('distance_m', round((v_out ->> 'total')::double precision)::integer);
end
$$;

-- Checks the turn cues against the route's points, sorted by where they come.
create or replace function private.route_cues(p_cues jsonb, p_n integer)
returns jsonb
language plpgsql immutable set search_path = ''
as $$
declare
  v_cue jsonb;
  v_i integer;
  v_street text;
  v_exit integer;
  v_out jsonb := '[]'::jsonb;
begin
  if p_cues is null or p_cues = 'null'::jsonb then
    return '[]'::jsonb;
  end if;
  if jsonb_typeof(p_cues) <> 'array' or jsonb_array_length(p_cues) > (private.route_limits() ->> 'cues')::integer then
    perform private.fail('invalid_input', 'cues');
  end if;
  for v_cue in select value from jsonb_array_elements(p_cues) loop
    if jsonb_typeof(v_cue) <> 'object' or jsonb_typeof(v_cue -> 'i') <> 'number'
       or not coalesce(v_cue ->> 'turn' = any (private.route_turns()), false) then
      perform private.fail('invalid_input', 'cues');
    end if;
    v_i := (v_cue ->> 'i')::numeric::integer;
    if v_i < 0 or v_i >= p_n then
      perform private.fail('invalid_input', 'cues');
    end if;
    v_street := nullif(btrim(regexp_replace(coalesce(v_cue ->> 'street', ''), '[[:cntrl:]]', '', 'g')), '');
    if v_street is not null and char_length(v_street) > 80 then
      v_street := left(v_street, 80);
    end if;
    v_exit := case when jsonb_typeof(v_cue -> 'exit') = 'number' then (v_cue ->> 'exit')::numeric::integer end;
    if v_exit is not null and (v_exit < 1 or v_exit > 12) then
      v_exit := null;
    end if;
    v_out := v_out || jsonb_build_array(jsonb_build_object('i', v_i, 'turn', v_cue ->> 'turn', 'street', v_street, 'exit', v_exit));
  end loop;
  return coalesce((select jsonb_agg(c order by (c ->> 'i')::integer) from jsonb_array_elements(v_out) c), '[]'::jsonb);
end
$$;

create or replace function private.clean_route_name(p_name text)
returns text
language plpgsql immutable set search_path = ''
as $$
declare
  v_name text := btrim(regexp_replace(regexp_replace(coalesce(p_name, ''), '[[:cntrl:]]', '', 'g'), '\s+', ' ', 'g'));
begin
  if char_length(v_name) < 1 or char_length(v_name) > 40 then
    perform private.fail('invalid_input', 'name');
  end if;
  return v_name;
end
$$;

-- A route as the app gets it. With p_full, its points and cues (each with how far along it
-- comes); otherwise about 60 points to draw a small preview.
create or replace function private.route_json(p_route private.saved_routes, p_full boolean)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_n integer := jsonb_array_length(p_route.points);
  v_step integer := greatest(1, ceil(v_n / 60.0)::integer);
  v_base jsonb;
begin
  v_base := jsonb_build_object(
    'id', p_route.id, 'name', p_route.name, 'kind', p_route.kind,
    'distance_m', p_route.distance_m, 'ascent_m', p_route.ascent_m,
    'start', jsonb_build_object('lat', p_route.start_lat, 'lon', p_route.start_lon),
    'bbox', jsonb_build_array(p_route.min_lat, p_route.min_lon, p_route.max_lat, p_route.max_lon),
    'turns', jsonb_array_length(p_route.cues),
    'created_at_ms', private.ts_to_ms(p_route.created_at), 'updated_at_ms', private.ts_to_ms(p_route.updated_at));
  if not p_full then
    return v_base || jsonb_build_object('preview', (
      select jsonb_agg(e.value order by e.ord)
      from jsonb_array_elements(p_route.points) with ordinality e(value, ord)
      where (e.ord - 1) % v_step = 0 or e.ord = v_n));
  end if;
  return v_base || jsonb_build_object(
    'points', p_route.points,
    'cues', coalesce((
      with pts as (
        select e.ord, (e.value ->> 0)::double precision as lat, (e.value ->> 1)::double precision as lon
        from jsonb_array_elements(p_route.points) with ordinality e(value, ord)
      ), steps as (
        select ord, coalesce(private.haversine_m(lag(lat) over w, lag(lon) over w, lat, lon), 0) as gap
        from pts window w as (order by ord)
      ), along as (
        select ord, sum(gap) over (order by ord) as at_m from steps
      )
      select jsonb_agg(c.value || jsonb_build_object('at_m', round(a.at_m)::integer) order by (c.value ->> 'i')::integer)
      from jsonb_array_elements(p_route.cues) c
      join along a on a.ord = (c.value ->> 'i')::integer + 1), '[]'::jsonb));
end
$$;

create or replace function private.routing_available()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce((select available from private.integrations where name = 'routing'), false)
$$;

-- The API service reports whether a routing service is configured.
create or replace function private.set_routing_integration(p_available boolean)
returns void
language sql security definer set search_path = ''
as $$
  update private.integrations set available = coalesce(p_available, false), updated_at = now() where name = 'routing'
$$;

-- Called by the API service before each planning request: the runner's account, and fair use
-- of a service that costs per call. A loop can take up to 16 calls, a leg one.
create or replace function private.route_plan_check(p_user uuid, p_mode text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_status text;
  v_age text;
begin
  if not private.routing_available() then
    perform private.fail('not_available', 'routing');
  end if;
  select status, age_signal into v_status, v_age from public.profiles where user_id = p_user;
  if v_status is null then
    perform private.fail('profile_required');
  elsif v_status <> 'active' then
    perform private.fail('account_deleting');
  elsif v_age = 'minor' then
    perform private.fail('age_restricted');
  end if;
  if p_mode = 'loop' then
    perform private.check_rate_limit('route_loop:' || p_user, 12, interval '10 minutes');
    perform private.check_rate_limit('route_loop_day:' || p_user, 40, interval '1 day');
  elsif p_mode = 'leg' then
    perform private.check_rate_limit('route_leg:' || p_user, 150, interval '10 minutes');
    perform private.check_rate_limit('route_leg_day:' || p_user, 600, interval '1 day');
  else
    perform private.fail('invalid_input', 'mode');
  end if;
end
$$;

-- ---------------------------------------------------------------------------------------
-- The runner's routes
-- ---------------------------------------------------------------------------------------
create or replace function public.list_routes()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
begin
  return jsonb_build_object(
    'planning_available', private.routing_available(),
    'limit', (private.route_limits() ->> 'routes')::integer,
    'routes', coalesce((select jsonb_agg(private.route_json(r, false) order by r.updated_at desc)
                        from private.saved_routes r where r.user_id = v_uid), '[]'::jsonb));
end
$$;

create or replace function public.get_route(p_route_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_route private.saved_routes;
begin
  select * into v_route from private.saved_routes where id = p_route_id and user_id = v_uid;
  if v_route.id is null then
    perform private.fail('not_found');
  end if;
  return private.route_json(v_route, true);
end
$$;

-- Saves a new route (p_route_id null) or replaces one of the runner's routes.
create or replace function public.save_route(
  p_route_id uuid,
  p_name text,
  p_kind text,
  p_points jsonb,
  p_cues jsonb default '[]'::jsonb,
  p_ascent_m integer default null
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_name text := private.clean_route_name(p_name);
  v_geo jsonb;
  v_cues jsonb;
  v_route private.saved_routes;
begin
  if p_kind is null or p_kind not in ('loop', 'path', 'drawn') then
    perform private.fail('invalid_input', 'kind');
  end if;
  if p_ascent_m is not null and (p_ascent_m < 0 or p_ascent_m > 20000) then
    perform private.fail('invalid_input', 'ascent');
  end if;
  perform private.check_rate_limit('route_save:' || v_uid, 200, interval '1 day');
  v_geo := private.route_geometry(p_points);
  v_cues := private.route_cues(p_cues, (v_geo ->> 'n')::integer);
  if p_route_id is null then
    perform pg_advisory_xact_lock(hashtext('saved_routes:' || v_uid));
    if (select count(*) from private.saved_routes where user_id = v_uid) >= (private.route_limits() ->> 'routes')::integer then
      perform private.fail('route_limit');
    end if;
    insert into private.saved_routes (user_id, name, kind, points, cues, distance_m, ascent_m,
                                      start_lat, start_lon, min_lat, max_lat, min_lon, max_lon)
    values (v_uid, v_name, p_kind, v_geo -> 'points', v_cues, (v_geo ->> 'distance_m')::integer, p_ascent_m,
            (v_geo ->> 'start_lat')::double precision, (v_geo ->> 'start_lon')::double precision,
            (v_geo ->> 'min_lat')::double precision, (v_geo ->> 'max_lat')::double precision,
            (v_geo ->> 'min_lon')::double precision, (v_geo ->> 'max_lon')::double precision)
    returning * into v_route;
  else
    update private.saved_routes
       set name = v_name, kind = p_kind, points = v_geo -> 'points', cues = v_cues,
           distance_m = (v_geo ->> 'distance_m')::integer, ascent_m = p_ascent_m,
           start_lat = (v_geo ->> 'start_lat')::double precision, start_lon = (v_geo ->> 'start_lon')::double precision,
           min_lat = (v_geo ->> 'min_lat')::double precision, max_lat = (v_geo ->> 'max_lat')::double precision,
           min_lon = (v_geo ->> 'min_lon')::double precision, max_lon = (v_geo ->> 'max_lon')::double precision,
           updated_at = now()
     where id = p_route_id and user_id = v_uid
    returning * into v_route;
    if v_route.id is null then
      perform private.fail('not_found');
    end if;
  end if;
  return private.route_json(v_route, true);
end
$$;

create or replace function public.rename_route(p_route_id uuid, p_name text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_route private.saved_routes;
begin
  update private.saved_routes set name = private.clean_route_name(p_name), updated_at = now()
   where id = p_route_id and user_id = v_uid
  returning * into v_route;
  if v_route.id is null then
    perform private.fail('not_found');
  end if;
  return private.route_json(v_route, false);
end
$$;

create or replace function public.delete_route(p_route_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_count integer;
begin
  delete from private.saved_routes where id = p_route_id and user_id = v_uid;
  get diagnostics v_count = row_count;
  return jsonb_build_object('deleted', v_count);
end
$$;

-- ---------------------------------------------------------------------------------------
-- Teens plan and follow their own routes too; export
-- ---------------------------------------------------------------------------------------
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
    -- their own planned routes (docs/ROADMAP.md 5.1), which nobody else sees
    'list_routes', 'get_route', 'save_route', 'rename_route', 'delete_route',
    -- safety
    'block_runner', 'block_member', 'report_content', 'submit_report'
  ]::text[]
$$;

create or replace function private.route_export(p_uid uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(private.route_json(r, true) order by r.created_at), '[]'::jsonb)
  from private.saved_routes r where r.user_id = p_uid
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
    'routes', private.route_export(p_uid)
  );
end
$$;

select private.apply_function_grants();
