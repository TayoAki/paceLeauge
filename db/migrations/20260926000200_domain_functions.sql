-- Domain functions: time helpers, score contract v1 and run validator v1.
-- These mirror src/domain (TypeScript) operation-for-operation so that the device's
-- provisional numbers and the server's authoritative numbers agree;
-- tests/backend/parity.test.ts runs the same routes through both implementations.

-- ---------------------------------------------------------------------------------------
-- Errors and identity
-- ---------------------------------------------------------------------------------------
-- All client-facing errors are raised with a stable snake_case code as the message.
create or replace function private.fail(p_code text, p_detail text default null)
returns void
language plpgsql volatile
as $$
begin
  raise exception using errcode = 'P0001', message = p_code, detail = coalesce(p_detail, '');
end
$$;

create or replace function private.require_user()
returns uuid
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception using errcode = '28000', message = 'not_authenticated';
  end if;
  return v_uid;
end
$$;

-- The caller with an active (not deleting) profile.
create or replace function private.require_profile()
returns uuid
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_status text;
begin
  select status into v_status from public.profiles where user_id = v_uid;
  if v_status is null then
    perform private.fail('profile_required');
  elsif v_status <> 'active' then
    perform private.fail('account_deleting');
  end if;
  return v_uid;
end
$$;

-- Supabase access tokens carry `amr` entries with the time of each authentication method;
-- refreshing a session does not change them, so they prove a *recent sign-in*.
create or replace function private.has_recent_auth(p_max_age interval default interval '10 minutes')
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce(
    (select max((e ->> 'timestamp')::bigint)
       from jsonb_array_elements(coalesce(auth.jwt() -> 'amr', '[]'::jsonb)) e
      where jsonb_typeof(e -> 'timestamp') = 'number'),
    0
  ) >= floor(extract(epoch from now() - p_max_age))
$$;

create or replace function private.flag_enabled(p_key text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce((select enabled from private.app_flags where key = p_key), false)
$$;

-- Fixed-window limiter. Raising rolls back the increment with the rest of the request.
create or replace function private.check_rate_limit(p_bucket text, p_max integer, p_window interval)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_window_s double precision := extract(epoch from p_window);
  v_start timestamptz := to_timestamp(floor(extract(epoch from now()) / v_window_s) * v_window_s);
  v_hits integer;
begin
  insert into private.rate_limits as rl (bucket, window_start, hits)
  values (p_bucket, v_start, 1)
  on conflict (bucket, window_start) do update set hits = rl.hits + 1
  returning hits into v_hits;
  if v_hits > p_max then
    perform private.fail('rate_limited');
  end if;
end
$$;

-- Best-effort client address from the API gateway (used only for anonymous rate limits).
create or replace function private.request_ip()
returns text
language sql stable
as $$
  select coalesce(
    nullif(split_part(coalesce(nullif(current_setting('request.headers', true), '')::json ->> 'x-forwarded-for', ''), ',', 1), ''),
    'unknown'
  )
$$;

-- ---------------------------------------------------------------------------------------
-- User-generated names (aliases, league names)
-- ---------------------------------------------------------------------------------------
create or replace function private.normalize_name(p_value text)
returns text
language sql immutable
as $$
  select regexp_replace(btrim(coalesce(p_value, '')), '\s+', ' ', 'g')
$$;

-- Returns null when acceptable, else 'invalid' (length/characters) or 'not_allowed' (filter).
create or replace function private.name_problem(p_value text, p_min integer, p_max integer)
returns text
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_name text := private.normalize_name(p_value);
  v_squashed text := regexp_replace(lower(v_name), '[^[:alnum:]]', '', 'g');
begin
  if char_length(v_name) < p_min or char_length(v_name) > p_max then
    return 'invalid';
  end if;
  -- Letters, numbers, spaces and . _ ' - only; no control characters or markup.
  if v_name ~ '[[:cntrl:]<>{}\[\]\\/@#$%^&*=+|~`"!?;:,()]' then
    return 'invalid';
  end if;
  if lower(v_name) ~ '(https?|www\.|\.com|\.net|\.org)' then
    return 'not_allowed';
  end if;
  if lower(v_name) in ('you', 'hidden runner', 'paceleague', 'pace league', 'admin', 'moderator', 'support', 'staff') then
    return 'not_allowed';
  end if;
  if exists (select 1 from private.blocked_terms t where position(t.term in v_squashed) > 0) then
    return 'not_allowed';
  end if;
  return null;
end
$$;

-- ---------------------------------------------------------------------------------------
-- Time (competition calendar: America/Chicago; see src/domain/calendar.ts)
-- ---------------------------------------------------------------------------------------
create or replace function private.ms_to_ts(p_ms bigint)
returns timestamptz
language sql immutable strict parallel safe
as $$
  select timestamptz 'epoch' + p_ms * interval '1 millisecond'
$$;

create or replace function private.ts_to_ms(p_ts timestamptz)
returns bigint
language sql immutable strict parallel safe
as $$
  select floor(extract(epoch from p_ts) * 1000)::bigint
$$;

create or replace function private.competition_date(p_ts timestamptz)
returns date
language sql stable strict parallel safe
as $$
  select (p_ts at time zone 'America/Chicago')::date
$$;

create or replace function private.day_start(p_date date)
returns timestamptz
language sql stable strict parallel safe
as $$
  select (p_date::timestamp) at time zone 'America/Chicago'
$$;

create or replace function private.week_start(p_date date)
returns date
language sql immutable strict parallel safe
as $$
  select p_date - (extract(isodow from p_date)::integer - 1)
$$;

create or replace function private.current_week_start()
returns date
language sql stable
as $$
  select private.week_start(private.competition_date(now()))
$$;

-- ---------------------------------------------------------------------------------------
-- Score contract v1 (src/domain/scoring.ts)
-- ---------------------------------------------------------------------------------------
create or replace function private.daily_xp(
  p_distance_cm bigint,
  p_active_ms bigint,
  out distance_xp integer,
  out active_day_bonus integer,
  out xp integer
)
language sql immutable parallel safe
as $$
  select s.d, s.b, s.d + s.b
  from (
    select least(100, greatest(coalesce(p_distance_cm, 0), 0) / 10000)::integer as d,
           case when p_distance_cm >= 100000 and p_active_ms >= 300000 then 25 else 0 end as b
  ) s
$$;

create or replace function private.tier_name(p_xp integer)
returns text
language sql immutable parallel safe
as $$
  select case
    when p_xp >= 10000 then 'Elite'
    when p_xp >= 4000 then 'Surge'
    when p_xp >= 1500 then 'Tempo'
    when p_xp >= 500 then 'Stride'
    else 'Seed'
  end
$$;

-- ---------------------------------------------------------------------------------------
-- Geometry (src/domain/geo.ts — identical formula, radius and operation order)
-- ---------------------------------------------------------------------------------------
create or replace function private.haversine_m(
  p_lat1 double precision, p_lon1 double precision, p_lat2 double precision, p_lon2 double precision
)
returns double precision
language plpgsql immutable strict parallel safe
as $$
declare
  k constant double precision := pi() / 180;
  sin_dphi double precision := sin((p_lat2 - p_lat1) * k / 2);
  sin_dlambda double precision := sin((p_lon2 - p_lon1) * k / 2);
  h double precision;
begin
  h := sin_dphi * sin_dphi + cos(p_lat1 * k) * cos(p_lat2 * k) * sin_dlambda * sin_dlambda;
  return 2 * 6371008.8::double precision * asin(least(1::double precision, sqrt(h)));
end
$$;

-- Adds a credited stretch [t0, t1] of distance d to the day windows of its segment: whole
-- if it lies inside one window, otherwise in proportion to time (src/domain/allocation.ts).
create or replace function private.alloc_add(
  p_from bigint[], p_to bigint[], p_dist double precision[], p_t0 bigint, p_t1 bigint, p_d double precision
)
returns double precision[]
language plpgsql immutable parallel safe
as $$
declare
  i integer;
  v_overlap bigint;
  v_span bigint := p_t1 - p_t0;
begin
  for i in 1 .. coalesce(array_length(p_from, 1), 0) loop
    if p_t0 >= p_from[i] and p_t1 <= p_to[i] then
      p_dist[i] := p_dist[i] + p_d;
      return p_dist;
    end if;
    v_overlap := least(p_t1, p_to[i]) - greatest(p_t0, p_from[i]);
    if v_overlap > 0 then
      p_dist[i] := p_dist[i] + (p_d * v_overlap) / v_span;
    end if;
  end loop;
  return p_dist;
end
$$;

-- ---------------------------------------------------------------------------------------
-- Run validator v1 (src/domain/validator.ts). Reads the staged route chunks of a run.
-- Returns the validation summary and its competition-day allocations as jsonb.
-- ---------------------------------------------------------------------------------------
create or replace function private.validate_run(p_run_id uuid, p_received_at timestamptz)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  c_max_acc constant double precision := 50;
  c_gap constant bigint := 15000;
  c_jump constant double precision := 12;
  c_chain constant integer := 3;
  c_teleport_m constant double precision := 250;
  c_review_speed constant double precision := 7;
  c_review_speed_min_m constant double precision := 1000;
  c_review_jump_min constant integer := 10;
  c_review_jump_fraction constant double precision := 0.2;
  c_future_skew constant bigint := 300000;
  c_late constant bigint := 259200000;
  c_min_m constant double precision := 100;
  c_min_active constant bigint := 60000;
  c_min_coverage constant double precision := 0.8;
  c_earliest constant bigint := 1704067200000;

  v_run public.runs;
  v_started bigint;
  v_ended bigint;
  v_received bigint := private.ts_to_ms(p_received_at);
  v_valid boolean := true;
  v_prev_end bigint;
  v_seg record;

  v_distance double precision := 0;
  v_active bigint := 0;
  v_covered bigint := 0;
  v_usable integer := 0;
  v_unusable integer := 0;
  v_dupes integer := 0;
  v_jumps integer := 0;
  v_teleports integer := 0;
  v_gaps integer := 0;
  v_outliers integer := 0;
  v_assigned integer := 0;
  v_total_points integer := 0;

  s_start bigint;
  s_end bigint;
  s_distance double precision;
  s_covered bigint;
  a_t bigint;
  a_lat double precision;
  a_lon double precision;
  v_last_seen bigint;
  sk_t bigint[];
  sk_lat double precision[];
  sk_lon double precision[];
  sk_n integer;
  p record;
  v_dt bigint;
  v_d double precision;
  v_i integer;

  w_date date[];
  w_from bigint[];
  w_to bigint[];
  w_dist double precision[];
  v_day date;
  v_from bigint;
  v_next bigint;
  v_cm bigint;

  v_allocations jsonb := '[]'::jsonb;
  v_segments_out jsonb := '[]'::jsonb;
  v_reasons text[] := '{}';
  v_coverage double precision := 0;
  v_avg_speed double precision := 0;
  v_outcome text;
begin
  select * into strict v_run from public.runs where id = p_run_id;
  v_started := private.ts_to_ms(v_run.started_at);
  v_ended := private.ts_to_ms(v_run.ended_at);

  select count(*)::integer into v_total_points
  from private.route_chunks c, jsonb_array_elements(c.points) e
  where c.run_id = p_run_id;

  -- Structural timeline checks (segmentsAreValid).
  if jsonb_typeof(v_run.segments) <> 'array' or jsonb_array_length(v_run.segments) = 0
     or v_started < c_earliest or v_ended < v_started then
    v_valid := false;
  else
    v_prev_end := v_started;
    for v_seg in
      select (s ->> 'index')::bigint as idx, (s ->> 'startAt')::bigint as start_ms,
             (s ->> 'endAt')::bigint as end_ms, ord
      from jsonb_array_elements(v_run.segments) with ordinality as t(s, ord)
      order by ord
    loop
      if v_seg.idx is distinct from v_seg.ord - 1 or v_seg.start_ms is null or v_seg.end_ms is null
         or v_seg.start_ms < v_prev_end or v_seg.end_ms < v_seg.start_ms then
        v_valid := false;
        exit;
      end if;
      v_prev_end := v_seg.end_ms;
    end loop;
    if v_valid and v_prev_end > v_ended then
      v_valid := false;
    end if;
  end if;

  if not v_valid then
    return jsonb_build_object(
      'validator_version', 1, 'outcome', 'personal_only', 'reasons', jsonb_build_array('invalid_timestamps'),
      'distance_m', 0, 'distance_cm', 0, 'active_ms', 0, 'coverage', 0,
      'diagnostics', jsonb_build_object('usable_samples', 0, 'unusable_samples', 0, 'duplicate_samples', 0,
        'outside_segment_samples', v_total_points, 'jump_samples', 0, 'teleports', 0, 'gaps', 0,
        'anchor_outliers', 0, 'average_speed_mps', 0),
      'segments', '[]'::jsonb, 'allocations', '[]'::jsonb);
  end if;

  for v_seg in
    select (s ->> 'index')::integer as idx, (s ->> 'startAt')::bigint as start_ms, (s ->> 'endAt')::bigint as end_ms
    from jsonb_array_elements(v_run.segments) with ordinality as t(s, ord)
    order by ord
  loop
    s_start := v_seg.start_ms;
    s_end := v_seg.end_ms;
    s_distance := 0;
    s_covered := 0;
    a_t := null;
    a_lat := null;
    a_lon := null;
    v_last_seen := null;
    sk_t := '{}';
    sk_lat := '{}';
    sk_lon := '{}';
    sk_n := 0;

    -- Day windows of this segment (zero-length segments allocate nothing).
    w_date := '{}';
    w_from := '{}';
    w_to := '{}';
    w_dist := '{}';
    if s_end > s_start then
      v_day := private.competition_date(private.ms_to_ts(s_start));
      v_from := s_start;
      loop
        v_next := private.ts_to_ms(private.day_start(v_day + 1));
        w_date := w_date || v_day;
        w_from := w_from || v_from;
        w_to := w_to || least(s_end, v_next);
        w_dist := w_dist || 0::double precision;
        exit when s_end <= v_next;
        v_day := v_day + 1;
        v_from := v_next;
      end loop;
    end if;

    for p in
      select (e ->> 0)::bigint as seq, (e ->> 1)::bigint as t, (e ->> 2)::double precision as lat,
             (e ->> 3)::double precision as lon, (e ->> 4)::double precision as acc
      from private.route_chunks c, jsonb_array_elements(c.points) e
      where c.run_id = p_run_id and (e ->> 5)::integer = v_seg.idx
        and (e ->> 1)::bigint between s_start and s_end
      order by 2, 1
    loop
      v_assigned := v_assigned + 1;
      if not coalesce(p.lat between -90 and 90 and p.lon between -180 and 180
                      and p.acc >= 0 and p.acc <= c_max_acc, false) then
        v_unusable := v_unusable + 1;
        continue;
      end if;
      if v_last_seen is not null and p.t <= v_last_seen then
        v_dupes := v_dupes + 1;
        continue;
      end if;
      v_last_seen := p.t;
      v_usable := v_usable + 1;

      if a_t is null then
        s_covered := s_covered + least(greatest(0, p.t - s_start), c_gap);
        a_t := p.t;
        a_lat := p.lat;
        a_lon := p.lon;
        continue;
      end if;

      v_dt := p.t - a_t;
      v_d := private.haversine_m(a_lat, a_lon, p.lat, p.lon);
      if v_dt > c_gap then
        if v_d > c_teleport_m and v_d / (v_dt::double precision / 1000) > c_jump then
          v_teleports := v_teleports + 1;
        end if;
        v_gaps := v_gaps + 1;
        s_covered := s_covered + c_gap;
        a_t := p.t;
        a_lat := p.lat;
        a_lon := p.lon;
        sk_n := 0;
        continue;
      end if;

      if v_d / (v_dt::double precision / 1000) <= c_jump then
        s_distance := s_distance + v_d;
        s_covered := s_covered + v_dt;
        w_dist := private.alloc_add(w_from, w_to, w_dist, a_t, p.t, v_d);
        a_t := p.t;
        a_lat := p.lat;
        a_lon := p.lon;
        sk_n := 0;
        continue;
      end if;

      -- Implausible relative to the anchor: skip it and look for a plausible chain.
      v_jumps := v_jumps + 1;
      if sk_n > 0 and private.haversine_m(sk_lat[sk_n], sk_lon[sk_n], p.lat, p.lon)
                      / ((p.t - sk_t[sk_n])::double precision / 1000) <= c_jump then
        sk_n := sk_n + 1;
      else
        sk_n := 1;
      end if;
      sk_t[sk_n] := p.t;
      sk_lat[sk_n] := p.lat;
      sk_lon[sk_n] := p.lon;

      if sk_n >= c_chain then
        v_outliers := v_outliers + 1;
        v_jumps := v_jumps - sk_n;
        s_covered := s_covered + least(sk_t[1] - a_t, c_gap);
        for v_i in 2 .. sk_n loop
          v_d := private.haversine_m(sk_lat[v_i - 1], sk_lon[v_i - 1], sk_lat[v_i], sk_lon[v_i]);
          s_distance := s_distance + v_d;
          s_covered := s_covered + (sk_t[v_i] - sk_t[v_i - 1]);
          w_dist := private.alloc_add(w_from, w_to, w_dist, sk_t[v_i - 1], sk_t[v_i], v_d);
        end loop;
        a_t := sk_t[sk_n];
        a_lat := sk_lat[sk_n];
        a_lon := sk_lon[sk_n];
        sk_n := 0;
      end if;
    end loop;

    -- Trailing boundary interval.
    s_covered := s_covered + least(greatest(0, s_end - coalesce(a_t, s_start)), c_gap);

    v_distance := v_distance + s_distance;
    v_active := v_active + greatest(0, s_end - s_start);
    v_covered := v_covered + s_covered;
    v_segments_out := v_segments_out || jsonb_build_object(
      'index', v_seg.idx, 'start_ms', s_start, 'end_ms', s_end, 'active_ms', greatest(0, s_end - s_start),
      'distance_m', s_distance, 'covered_ms', s_covered);

    for v_i in 1 .. coalesce(array_length(w_date, 1), 0) loop
      v_cm := floor(w_dist[v_i] * 100 + 0.5)::bigint;
      if (w_to[v_i] - w_from[v_i]) > 0 or v_cm > 0 then
        v_allocations := v_allocations || jsonb_build_object(
          'segment_index', v_seg.idx, 'segment_start_ms', s_start, 'competition_date', w_date[v_i],
          'distance_cm', v_cm, 'active_ms', w_to[v_i] - w_from[v_i]);
      end if;
    end loop;
  end loop;

  if v_active > 0 then
    v_coverage := least(1::double precision, v_covered::double precision / v_active);
    v_avg_speed := v_distance / (v_active::double precision / 1000);
  end if;

  if v_ended > v_received + c_future_skew then
    v_reasons := array_append(v_reasons, 'future_timestamp'::text);
  end if;
  if v_distance < c_min_m then
    v_reasons := array_append(v_reasons, 'too_short_distance'::text);
  end if;
  if v_active < c_min_active then
    v_reasons := array_append(v_reasons, 'too_short_time'::text);
  end if;
  if v_coverage < c_min_coverage then
    v_reasons := array_append(v_reasons, 'low_gps_coverage'::text);
  end if;
  if v_teleports > 0
     or (v_jumps >= c_review_jump_min and v_jumps > c_review_jump_fraction * v_usable)
     or (v_distance >= c_review_speed_min_m and v_avg_speed > c_review_speed) then
    v_reasons := array_append(v_reasons, 'speed_anomaly'::text);
  end if;
  if v_received - v_ended > c_late then
    v_reasons := array_append(v_reasons, 'late_upload'::text);
  end if;

  v_outcome := case
    when v_reasons && array['invalid_timestamps', 'future_timestamp', 'too_short_distance', 'too_short_time', 'low_gps_coverage'] then 'personal_only'
    when v_reasons && array['speed_anomaly', 'late_upload'] then 'review'
    else 'accepted'
  end;

  return jsonb_build_object(
    'validator_version', 1,
    'outcome', v_outcome,
    'reasons', to_jsonb(v_reasons),
    'distance_m', v_distance,
    'distance_cm', floor(v_distance * 100 + 0.5)::bigint,
    'active_ms', v_active,
    'coverage', v_coverage,
    'diagnostics', jsonb_build_object(
      'usable_samples', v_usable, 'unusable_samples', v_unusable, 'duplicate_samples', v_dupes,
      'outside_segment_samples', v_total_points - v_assigned, 'jump_samples', v_jumps,
      'teleports', v_teleports, 'gaps', v_gaps, 'anchor_outliers', v_outliers,
      'average_speed_mps', v_avg_speed),
    'segments', v_segments_out,
    'allocations', v_allocations);
end
$$;

-- ---------------------------------------------------------------------------------------
-- Grants helper: every public function is revoked from PUBLIC/anon and granted to
-- authenticated, except the explicit anonymous allowlist. Re-run at the end of each
-- migration that adds functions.
-- ---------------------------------------------------------------------------------------
create or replace function private.apply_function_grants()
returns void
language plpgsql
as $$
declare
  f record;
  anon_allowed constant text[] := array['get_app_config', 'get_invite_preview'];
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
