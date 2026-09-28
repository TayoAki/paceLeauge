-- Segments (docs/ROADMAP.md 5.3): stretches of path with boards of the fastest times, and a
-- "local legend" for whoever ran it on the most different days.
--   * Curated: staff make segments from routes they plan, on paths rather than roads (a safety
--     call), and can retire them.
--   * Opt-in: a runner's times are on the boards only after they join, and leaving takes them off.
--   * Matched on the server, only from accepted runs (so the validator's vehicle and e-bike checks
--     apply) that the runner shares with everyone, map included, and only on the part of the run
--     a shared map shows: not the first or last 200 m, and nothing across a privacy zone.
--   * An effort runs the whole segment in its direction: in near the start, along it (within 30 m,
--     a few GPS slips allowed, never back more than 30 m), out near the end, timed between the
--     start and end lines. Passes the other way, and runs that leave or join it part way, don't
--     count. Faster than 7 m/s is held for a moderator; faster than 11 m/s isn't a run.
--   * The local legend counts distinct days in the last 90, not the number of efforts.
-- Matching needs no PostGIS (Railway's standard Postgres has none): segments are found by their
-- bounding boxes and matched in plpgsql by the frequent job, run by run.

create table private.segments (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 3 and 60),
  surface text not null check (surface in ('path', 'trail', 'track', 'park')),
  -- [[lat, lon], …]
  points jsonb not null,
  distance_m integer not null check (distance_m between 200 and 20000),
  start_lat double precision not null,
  start_lon double precision not null,
  end_lat double precision not null,
  end_lon double precision not null,
  min_lat double precision not null,
  max_lat double precision not null,
  min_lon double precision not null,
  max_lon double precision not null,
  status text not null default 'active' check (status in ('active', 'retired')),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  retired_at timestamptz
);
create index segments_active_idx on private.segments (min_lat, max_lat) where status = 'active';

create table private.segment_members (
  user_id uuid primary key references auth.users (id) on delete cascade,
  joined_at timestamptz not null default now(),
  -- A moderator took the runner off the boards for good.
  banned_at timestamptz
);

create table private.segment_efforts (
  id uuid primary key default gen_random_uuid(),
  segment_id uuid not null references private.segments (id) on delete cascade,
  run_id uuid not null references public.runs (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  started_at timestamptz not null,
  elapsed_ms integer not null check (elapsed_ms > 0),
  -- The competition day it was run on, for the local legend's distinct days.
  run_date date not null,
  -- counted: on the board · held: too fast, off the board until a moderator decides · removed
  status text not null default 'counted' check (status in ('counted', 'held', 'removed')),
  -- A moderator looked and released it.
  cleared_at timestamptz,
  created_at timestamptz not null default now(),
  constraint segment_efforts_once unique (run_id, segment_id, started_at)
);
create index segment_efforts_board_idx on private.segment_efforts (segment_id, status, elapsed_ms);
create index segment_efforts_user_idx on private.segment_efforts (user_id, segment_id);

-- Runs to match again: new, edited, shared or unshared, or their runner's zones changed.
create table private.segment_match_queue (
  run_id uuid primary key references public.runs (id) on delete cascade,
  queued_at timestamptz not null default now()
);

create trigger segment_members_teens before insert on private.segment_members
  for each row execute function private.guard_teen_user();

create or replace function private.segment_limits()
returns jsonb
language sql immutable
as $$
  select jsonb_build_object(
    'start_m', 25, 'end_m', 25, 'corridor_m', 30, 'outlier_m', 60, 'backtrack_m', 30,
    'held_speed', 7.0, 'max_speed', 11.0, 'legend_days', 90, 'backfill_days', 90, 'board', 50)
$$;

create or replace function private.segment_member(p_user uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from private.segment_members m where m.user_id = p_user and m.banned_at is null)
     and not private.is_teen(p_user)
$$;

-- A run whose route may be matched: accepted, a run, shared with everyone with its map, by a
-- runner on the boards.
create or replace function private.segment_run_eligible(p_run public.runs)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select p_run.status = 'accepted' and p_run.deleted_at is null and p_run.activity_type = 'run'
     and p_run.visibility = 'everyone' and p_run.map_shared
     and private.segment_member(p_run.owner_id)
$$;

-- The part of a run segments may use: the points a shared map shows (not the first or last
-- 200 m, nothing inside the runner's privacy zones), with their times, in order. `part` changes
-- at every pause and wherever points were left out, and an effort must lie within one part.
create or replace function private.segment_track(p_run public.runs)
returns table (i bigint, t_ms bigint, lat double precision, lon double precision, part bigint)
language sql stable security definer set search_path = ''
as $$
  with raw as (
    select (e ->> 1)::bigint as t, (e ->> 2)::double precision as lat, (e ->> 3)::double precision as lon,
           coalesce((e ->> 5)::integer, 0) as seg, ord
    from private.run_routes rr, jsonb_array_elements(rr.points) with ordinality as x(e, ord)
    where rr.run_id = p_run.id
  ), steps as (
    select r.*, coalesce(private.haversine_m(lag(r.lat) over w, lag(r.lon) over w, r.lat, r.lon), 0) as step
    from raw r window w as (order by r.ord)
  ), cum as (
    select s.*, sum(s.step) over (order by s.ord) as d from steps s
  ), total as (
    select coalesce(max(d), 0) as total_m from cum
  ), kept as (
    select c.* from cum c, total t
    where c.d >= private.shared_trim_m() and c.d <= t.total_m - private.shared_trim_m()
      and not exists (
        select 1 from private.privacy_zones z
        where z.user_id = p_run.owner_id and private.haversine_m(z.lat, z.lon, c.lat, c.lon) <= z.radius_m)
  ), breaks as (
    select k.*, case when lag(k.ord) over w is null or k.ord - lag(k.ord) over w > 1 or k.seg <> lag(k.seg) over w then 1 else 0 end as brk
    from kept k window w as (order by k.ord)
  )
  select row_number() over (order by b.ord), b.t, b.lat, b.lon, sum(b.brk) over (order by b.ord)
  from breaks b
  order by b.ord
$$;

-- Where a point falls along a segment: its distance from the segment and how far along it is,
-- looking only between `from_m` and `to_m` along (so a segment that doubles back isn't confused
-- with itself).
create or replace function private.segment_project(
  p_lat double precision, p_lon double precision,
  p_slat double precision[], p_slon double precision[], p_cum double precision[],
  p_from_m double precision, p_to_m double precision,
  out distance_m double precision, out along_m double precision
)
language plpgsql immutable set search_path = ''
as $$
declare
  k constant double precision := pi() / 180;
  r constant double precision := 6371008.8;
  v_cos double precision;
  v_bx double precision;
  v_by double precision;
  v_px double precision;
  v_py double precision;
  v_len2 double precision;
  v_t double precision;
  v_d double precision;
begin
  distance_m := null;
  along_m := null;
  for q in 1 .. array_length(p_slat, 1) - 1 loop
    continue when p_cum[q + 1] < p_from_m or p_cum[q] > p_to_m;
    v_cos := cos(p_slat[q] * k);
    v_bx := (p_slon[q + 1] - p_slon[q]) * k * r * v_cos;
    v_by := (p_slat[q + 1] - p_slat[q]) * k * r;
    v_px := (p_lon - p_slon[q]) * k * r * v_cos;
    v_py := (p_lat - p_slat[q]) * k * r;
    v_len2 := v_bx * v_bx + v_by * v_by;
    v_t := case when v_len2 = 0 then 0 else greatest(0, least(1, (v_px * v_bx + v_py * v_by) / v_len2)) end;
    v_d := sqrt((v_px - v_t * v_bx) ^ 2 + (v_py - v_t * v_by) ^ 2);
    if distance_m is null or v_d < distance_m then
      distance_m := v_d;
      along_m := p_cum[q] + (p_cum[q + 1] - p_cum[q]) * v_t;
    end if;
  end loop;
end
$$;

-- When the track crossed a line across the segment at (lat0, lon0), heading along (ux, uy):
-- interpolated between the two points either side, searched from index `around`. Null if it
-- didn't cross there.
create or replace function private.segment_gate_ms(
  p_t bigint[], p_lat double precision[], p_lon double precision[], p_part bigint[],
  p_around integer, p_lat0 double precision, p_lon0 double precision, p_ux double precision, p_uy double precision
)
returns double precision
language plpgsql immutable set search_path = ''
as $$
declare
  k constant double precision := pi() / 180;
  r constant double precision := 6371008.8;
  v_n integer := array_length(p_lat, 1);
  v_cos double precision := cos(p_lat0 * k);
  v_a double precision;
  v_b double precision;
  v_best double precision;
  v_best_gap integer;
begin
  for q in greatest(1, p_around - 8) .. least(v_n - 1, p_around + 8) loop
    continue when p_part[q] <> p_part[p_around] or p_part[q + 1] <> p_part[p_around];
    v_a := (p_lon[q] - p_lon0) * k * r * v_cos * p_ux + (p_lat[q] - p_lat0) * k * r * p_uy;
    v_b := (p_lon[q + 1] - p_lon0) * k * r * v_cos * p_ux + (p_lat[q + 1] - p_lat0) * k * r * p_uy;
    if v_a < 0 and v_b >= 0 and (v_best_gap is null or abs(q - p_around) < v_best_gap) then
      v_best := p_t[q] + (0 - v_a) / (v_b - v_a) * (p_t[q + 1] - p_t[q]);
      v_best_gap := abs(q - p_around);
    end if;
  end loop;
  return v_best;
end
$$;

-- Every time the track runs the whole segment in its direction: when it crossed the start line,
-- and how long it took to cross the end line.
create or replace function private.match_segment(
  p_segment private.segments, p_t bigint[], p_lat double precision[], p_lon double precision[], p_part bigint[]
)
returns table (started_at_ms bigint, elapsed_ms bigint)
language plpgsql immutable set search_path = ''
as $$
declare
  k constant double precision := pi() / 180;
  r constant double precision := 6371008.8;
  v_limits jsonb := private.segment_limits();
  v_start_m double precision := (v_limits ->> 'start_m')::double precision;
  v_end_m double precision := (v_limits ->> 'end_m')::double precision;
  v_corridor double precision := (v_limits ->> 'corridor_m')::double precision;
  v_outlier double precision := (v_limits ->> 'outlier_m')::double precision;
  v_back double precision := (v_limits ->> 'backtrack_m')::double precision;
  v_n integer := coalesce(array_length(p_lat, 1), 0);
  v_slat double precision[];
  v_slon double precision[];
  v_cum double precision[] := array[0::double precision];
  v_m integer;
  v_len double precision;
  v_i integer := 1;
  v_best integer;
  v_j integer;
  v_end integer;
  v_d double precision;
  v_s double precision;
  v_smax double precision;
  v_bad integer;
  v_seen integer;
  v_ok boolean;
  v_step double precision;
  v_proj record;
  v_start_ms double precision;
  v_end_ms double precision;
  v_ux double precision;
  v_uy double precision;
  v_norm double precision;
begin
  select array_agg((e.value ->> 0)::double precision order by e.ord), array_agg((e.value ->> 1)::double precision order by e.ord)
    into v_slat, v_slon
    from jsonb_array_elements(p_segment.points) with ordinality e(value, ord);
  v_m := coalesce(array_length(v_slat, 1), 0);
  if v_m < 2 or v_n < 3 then
    return;
  end if;
  for q in 2 .. v_m loop
    v_cum := v_cum || (v_cum[q - 1] + private.haversine_m(v_slat[q - 1], v_slon[q - 1], v_slat[q], v_slon[q]));
  end loop;
  v_len := v_cum[v_m];

  while v_i <= v_n loop
    if private.haversine_m(p_lat[v_i], p_lon[v_i], v_slat[1], v_slon[1]) > v_start_m then
      v_i := v_i + 1;
      continue;
    end if;
    -- The closest approach to the start among the nearby points in a row.
    v_best := v_i;
    while v_i < v_n and p_part[v_i + 1] = p_part[v_best]
          and private.haversine_m(p_lat[v_i + 1], p_lon[v_i + 1], v_slat[1], v_slon[1]) <= v_start_m loop
      v_i := v_i + 1;
      if private.haversine_m(p_lat[v_i], p_lon[v_i], v_slat[1], v_slon[1])
         < private.haversine_m(p_lat[v_best], p_lon[v_best], v_slat[1], v_slon[1]) then
        v_best := v_i;
      end if;
    end loop;

    -- Along the segment from there, to its end.
    v_j := v_best;
    v_smax := 0;
    v_bad := 0;
    v_seen := 0;
    v_ok := true;
    v_end := null;
    while v_ok loop
      v_j := v_j + 1;
      if v_j > v_n or p_part[v_j] <> p_part[v_best] then
        v_ok := false;
        exit;
      end if;
      v_step := private.haversine_m(p_lat[v_j - 1], p_lon[v_j - 1], p_lat[v_j], p_lon[v_j]);
      select * into v_proj from private.segment_project(p_lat[v_j], p_lon[v_j], v_slat, v_slon, v_cum, v_smax - v_back, v_smax + v_step + v_corridor);
      if v_proj.distance_m is null then
        select * into v_proj from private.segment_project(p_lat[v_j], p_lon[v_j], v_slat, v_slon, v_cum, v_smax - v_back, v_len);
      end if;
      v_d := v_proj.distance_m;
      v_s := v_proj.along_m;
      v_seen := v_seen + 1;
      if v_d is null or v_d > v_outlier or v_s < v_smax - v_back then
        v_ok := false;
        exit;
      end if;
      if v_d > v_corridor then
        v_bad := v_bad + 1;
      end if;
      v_smax := greatest(v_smax, v_s);
      if v_smax >= v_len * 0.95 and private.haversine_m(p_lat[v_j], p_lon[v_j], v_slat[v_m], v_slon[v_m]) <= v_end_m then
        -- The closest approach to the end among the nearby points in a row.
        v_end := v_j;
        while v_j < v_n and p_part[v_j + 1] = p_part[v_best]
              and private.haversine_m(p_lat[v_j + 1], p_lon[v_j + 1], v_slat[v_m], v_slon[v_m]) <= v_end_m loop
          v_j := v_j + 1;
          if private.haversine_m(p_lat[v_j], p_lon[v_j], v_slat[v_m], v_slon[v_m])
             < private.haversine_m(p_lat[v_end], p_lon[v_end], v_slat[v_m], v_slon[v_m]) then
            v_end := v_j;
          end if;
        end loop;
        exit;
      end if;
    end loop;

    if v_ok and v_end is not null and v_bad <= greatest(1, v_seen / 10) then
      -- Timed between lines across the segment at its start and its end.
      v_ux := (v_slon[2] - v_slon[1]) * k * r * cos(v_slat[1] * k);
      v_uy := (v_slat[2] - v_slat[1]) * k * r;
      v_norm := sqrt(v_ux * v_ux + v_uy * v_uy);
      v_start_ms := case when v_norm > 0 then private.segment_gate_ms(p_t, p_lat, p_lon, p_part, v_best, v_slat[1], v_slon[1], v_ux / v_norm, v_uy / v_norm) end;
      v_ux := (v_slon[v_m] - v_slon[v_m - 1]) * k * r * cos(v_slat[v_m - 1] * k);
      v_uy := (v_slat[v_m] - v_slat[v_m - 1]) * k * r;
      v_norm := sqrt(v_ux * v_ux + v_uy * v_uy);
      v_end_ms := case when v_norm > 0 then private.segment_gate_ms(p_t, p_lat, p_lon, p_part, v_end, v_slat[v_m], v_slon[v_m], v_ux / v_norm, v_uy / v_norm) end;
      if v_start_ms is not null and v_end_ms is not null and v_end_ms > v_start_ms then
        started_at_ms := round(v_start_ms)::bigint;
        elapsed_ms := round(v_end_ms - v_start_ms)::bigint;
        return next;
      end if;
      v_i := v_end + 1;
    else
      v_i := v_i + 1;
    end if;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------------------
-- Reports on efforts (defined before the job, which reports held efforts itself)
-- ---------------------------------------------------------------------------------------
alter table private.reports drop constraint reports_target_kind_check;
alter table private.reports add constraint reports_target_kind_check
  check (target_kind in ('member', 'league', 'runner', 'run', 'comment', 'club', 'group_run', 'challenge', 'leaderboard', 'segment'));
alter table private.reports add column target_effort_id uuid references private.segment_efforts (id) on delete set null;

-- An effort held for its speed goes to the moderation queue, like a report nobody sent.
create or replace function private.report_held_effort(p_effort_id uuid)
returns void
language sql security definer set search_path = ''
as $$
  insert into private.reports (reporter_id, target_kind, target_user_id, target_effort_id, reason_code, content_snapshot)
  select null, 'segment', e.user_id, e.id, 'cheating',
         jsonb_build_object('alias', p.alias, 'segment', s.name, 'distance_m', s.distance_m, 'elapsed_ms', e.elapsed_ms,
                            'started_at_ms', private.ts_to_ms(e.started_at), 'automatic', true)
  from private.segment_efforts e
  join private.segments s on s.id = e.segment_id
  join public.profiles p on p.user_id = e.user_id
  where e.id = p_effort_id
    and not exists (select 1 from private.reports o where o.status = 'open' and o.target_effort_id = p_effort_id)
$$;

-- ---------------------------------------------------------------------------------------
-- What to match again, and the job that does it
-- ---------------------------------------------------------------------------------------
create or replace function private.on_run_for_segments()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_row jsonb := to_jsonb(new);
  v_run uuid := coalesce(v_row ->> 'run_id', v_row ->> 'id')::uuid;
  v_owner uuid := (v_row ->> 'owner_id')::uuid;
begin
  if exists (select 1 from private.segment_members m where m.user_id = v_owner)
     or exists (select 1 from private.segment_efforts e where e.run_id = v_run) then
    insert into private.segment_match_queue (run_id) values (v_run)
    on conflict (run_id) do update set queued_at = now();
  end if;
  return null;
end
$$;

create trigger runs_segments after update on public.runs
  for each row
  when (old.status is distinct from new.status or old.visibility is distinct from new.visibility
        or old.map_shared is distinct from new.map_shared or old.deleted_at is distinct from new.deleted_at
        or old.activity_type is distinct from new.activity_type)
  execute function private.on_run_for_segments();
create trigger run_routes_segments after insert or update of points on private.run_routes
  for each row execute function private.on_run_for_segments();

-- The runner's recent runs, and any with efforts, are matched again (after joining, or when
-- their privacy zones change).
create or replace function private.queue_runner_segments(p_user uuid)
returns integer
language sql security definer set search_path = ''
as $$
  with queued as (
    insert into private.segment_match_queue (run_id)
    select r.id from public.runs r
    where r.owner_id = p_user and r.deleted_at is null and r.status = 'accepted'
      and (r.started_at >= now() - make_interval(days => (private.segment_limits() ->> 'backfill_days')::integer)
           or exists (select 1 from private.segment_efforts e where e.run_id = r.id))
    on conflict (run_id) do update set queued_at = now()
    returning 1
  )
  select count(*)::integer from queued
$$;

create or replace function private.on_zones_for_segments()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := coalesce(to_jsonb(new) ->> 'user_id', to_jsonb(old) ->> 'user_id')::uuid;
begin
  if exists (select 1 from private.segment_members m where m.user_id = v_user) then
    perform private.queue_runner_segments(v_user);
  end if;
  return null;
end
$$;

create trigger privacy_zones_segments after insert or update or delete on private.privacy_zones
  for each row execute function private.on_zones_for_segments();

-- Matches queued runs against the segments near them. Efforts a moderator decided on stay as they
-- are; a run that may no longer be matched loses its efforts.
create or replace function private.process_segment_matches(p_limit integer default 100)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_limits jsonb := private.segment_limits();
  v_margin constant double precision := 0.001;
  v_id uuid;
  v_run public.runs;
  v_done integer := 0;
  v_t bigint[];
  v_lat double precision[];
  v_lon double precision[];
  v_part bigint[];
  v_min_lat double precision;
  v_max_lat double precision;
  v_min_lon double precision;
  v_max_lon double precision;
  v_seg private.segments;
  v_eff record;
  v_speed double precision;
  v_effort private.segment_efforts;
begin
  for v_id in
    select q.run_id from private.segment_match_queue q
    order by q.queued_at limit greatest(1, coalesce(p_limit, 100))
    for update skip locked
  loop
    delete from private.segment_match_queue where run_id = v_id;
    v_done := v_done + 1;
    select * into v_run from public.runs where id = v_id;
    if not found or not private.segment_run_eligible(v_run) then
      delete from private.segment_efforts where run_id = v_id and status <> 'removed';
      continue;
    end if;
    delete from private.segment_efforts where run_id = v_id and status = 'counted' and cleared_at is null;
    select array_agg(t.t_ms order by t.i), array_agg(t.lat order by t.i), array_agg(t.lon order by t.i), array_agg(t.part order by t.i),
           min(t.lat), max(t.lat), min(t.lon), max(t.lon)
      into v_t, v_lat, v_lon, v_part, v_min_lat, v_max_lat, v_min_lon, v_max_lon
      from private.segment_track(v_run) t;
    continue when v_lat is null;
    for v_seg in
      select s.* from private.segments s
      where s.status = 'active'
        and s.max_lat >= v_min_lat - v_margin and s.min_lat <= v_max_lat + v_margin
        and s.max_lon >= v_min_lon - v_margin and s.min_lon <= v_max_lon + v_margin
    loop
      for v_eff in select * from private.match_segment(v_seg, v_t, v_lat, v_lon, v_part) loop
        v_speed := v_seg.distance_m / (v_eff.elapsed_ms / 1000.0);
        -- Faster than anyone runs: not a run, whatever the validator said about the whole.
        continue when v_speed > (v_limits ->> 'max_speed')::double precision;
        v_effort := null;
        insert into private.segment_efforts (segment_id, run_id, user_id, started_at, elapsed_ms, run_date, status)
        values (v_seg.id, v_run.id, v_run.owner_id, private.ms_to_ts(v_eff.started_at_ms), v_eff.elapsed_ms,
                private.competition_date(private.ms_to_ts(v_eff.started_at_ms)),
                case when v_speed > (v_limits ->> 'held_speed')::double precision then 'held' else 'counted' end)
        on conflict (run_id, segment_id, started_at) do nothing
        returning * into v_effort;
        if v_effort.id is not null and v_effort.status = 'held' then
          perform private.report_held_effort(v_effort.id);
        end if;
      end loop;
    end loop;
  end loop;
  return v_done;
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
    'live_shares_expired', private.expire_live_shares(),
    'segment_matches', private.process_segment_matches(200));
end
$$;

-- ---------------------------------------------------------------------------------------
-- Boards and the local legend
-- ---------------------------------------------------------------------------------------
-- Whoever ran the segment on the most different days in the last 90 (ties: whoever got there
-- first), among runners on the boards the viewer hasn't blocked.
create or replace function private.segment_legend(p_segment uuid, p_viewer uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('alias', p.alias, 'days', d.days, 'is_me', d.user_id = p_viewer)
  from (
    select e.user_id, count(distinct e.run_date) as days, max(e.run_date) as reached
    from private.segment_efforts e
    where e.segment_id = p_segment and e.status = 'counted'
      and e.run_date > private.competition_date(now()) - (private.segment_limits() ->> 'legend_days')::integer
      and private.segment_member(e.user_id)
      and not private.are_blocked(p_viewer, e.user_id)
    group by e.user_id
    order by count(distinct e.run_date) desc, max(e.run_date), e.user_id
    limit 1
  ) d
  join public.profiles p on p.user_id = d.user_id
$$;

-- Each runner's best time, fastest first: the top 50, and the viewer wherever they are.
create or replace function private.segment_board(p_segment uuid, p_viewer uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  with best as (
    select distinct on (e.user_id) e.user_id, e.id, e.elapsed_ms, e.started_at
    from private.segment_efforts e
    where e.segment_id = p_segment and e.status = 'counted'
      and private.segment_member(e.user_id) and not private.are_blocked(p_viewer, e.user_id)
    order by e.user_id, e.elapsed_ms, e.started_at
  ), ranked as (
    select b.*, rank() over (order by b.elapsed_ms) as place from best b
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'place', r.place, 'alias', p.alias, 'elapsed_ms', r.elapsed_ms, 'run_at_ms', private.ts_to_ms(r.started_at),
           'effort_id', r.id, 'is_me', r.user_id = p_viewer)
         order by r.place, r.started_at), '[]'::jsonb)
  from ranked r
  join public.profiles p on p.user_id = r.user_id
  where r.place <= (private.segment_limits() ->> 'board')::integer or r.user_id = p_viewer
$$;

create or replace function private.segment_json(p_segment private.segments, p_viewer uuid, p_full boolean)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_n integer := jsonb_array_length(p_segment.points);
  v_step integer := greatest(1, ceil(v_n / 60.0)::integer);
  v_base jsonb;
begin
  v_base := jsonb_build_object(
    'id', p_segment.id, 'name', p_segment.name, 'surface', p_segment.surface, 'distance_m', p_segment.distance_m,
    'status', p_segment.status,
    'start', jsonb_build_object('lat', p_segment.start_lat, 'lon', p_segment.start_lon),
    'end', jsonb_build_object('lat', p_segment.end_lat, 'lon', p_segment.end_lon),
    'runners', (select count(distinct e.user_id) from private.segment_efforts e
                where e.segment_id = p_segment.id and e.status = 'counted' and private.segment_member(e.user_id)),
    'my_best_ms', (select min(e.elapsed_ms) from private.segment_efforts e
                   where e.segment_id = p_segment.id and e.user_id = p_viewer and e.status = 'counted'),
    'legend', private.segment_legend(p_segment.id, p_viewer));
  if not p_full then
    return v_base || jsonb_build_object('preview', (
      select jsonb_agg(e.value order by e.ord)
      from jsonb_array_elements(p_segment.points) with ordinality e(value, ord)
      where (e.ord - 1) % v_step = 0 or e.ord = v_n));
  end if;
  return v_base || jsonb_build_object(
    'points', p_segment.points,
    'board', private.segment_board(p_segment.id, p_viewer),
    'my_efforts', coalesce((select jsonb_agg(jsonb_build_object('effort_id', x.id, 'elapsed_ms', x.elapsed_ms,
                                                                'run_at_ms', private.ts_to_ms(x.started_at), 'status', x.status)
                                             order by x.started_at desc)
                            from (select e.* from private.segment_efforts e
                                  where e.segment_id = p_segment.id and e.user_id = p_viewer and e.status <> 'removed'
                                  order by e.started_at desc limit 20) x), '[]'::jsonb),
    'my_days', (select count(distinct e.run_date) from private.segment_efforts e
                where e.segment_id = p_segment.id and e.user_id = p_viewer and e.status = 'counted'
                  and e.run_date > private.competition_date(now()) - (private.segment_limits() ->> 'legend_days')::integer));
end
$$;

-- ---------------------------------------------------------------------------------------
-- Runners' calls
-- ---------------------------------------------------------------------------------------
create or replace function public.list_segments()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
begin
  return jsonb_build_object(
    'joined', private.segment_member(v_uid),
    'banned', exists (select 1 from private.segment_members m where m.user_id = v_uid and m.banned_at is not null),
    'segments', coalesce((select jsonb_agg(private.segment_json(s, v_uid, false) order by s.name)
                          from private.segments s where s.status = 'active'), '[]'::jsonb));
end
$$;

create or replace function public.get_segment(p_segment_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_segment private.segments;
begin
  select * into v_segment from private.segments where id = p_segment_id and status = 'active';
  if not found then
    perform private.fail('not_found');
  end if;
  return private.segment_json(v_segment, v_uid, true) || jsonb_build_object('joined', private.segment_member(v_uid));
end
$$;

-- Joining puts the runner's recent runs shared with everyone on the boards.
create or replace function public.join_segments()
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
begin
  if exists (select 1 from private.segment_members where user_id = v_uid and banned_at is not null) then
    perform private.fail('not_allowed');
  end if;
  perform private.check_rate_limit('segments_join:' || v_uid, 10, interval '1 day');
  insert into private.segment_members (user_id) values (v_uid) on conflict (user_id) do nothing;
  return jsonb_build_object('joined', true, 'queued', private.queue_runner_segments(v_uid));
end
$$;

-- Leaving takes every one of the runner's times off the boards at once.
create or replace function public.leave_segments()
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
begin
  delete from private.segment_efforts where user_id = v_uid and status <> 'removed';
  delete from private.segment_members where user_id = v_uid and banned_at is null;
  return jsonb_build_object('joined', false);
end
$$;

-- The segments one of the runner's own runs went through: the time on each, and whether it's
-- their best there.
create or replace function public.get_run_segments(p_run_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
begin
  if not exists (select 1 from public.runs r where r.id = p_run_id and r.owner_id = v_uid and r.deleted_at is null) then
    perform private.fail('not_found');
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'effort_id', e.id, 'segment_id', s.id, 'name', s.name, 'distance_m', s.distance_m, 'elapsed_ms', e.elapsed_ms,
             'started_at_ms', private.ts_to_ms(e.started_at), 'status', e.status,
             'is_best', e.status = 'counted' and not exists (
               select 1 from private.segment_efforts o
               where o.segment_id = e.segment_id and o.user_id = v_uid and o.status = 'counted'
                 and (o.elapsed_ms < e.elapsed_ms or (o.elapsed_ms = e.elapsed_ms and o.started_at < e.started_at))))
           order by e.started_at)
    from private.segment_efforts e
    join private.segments s on s.id = e.segment_id and s.status = 'active'
    where e.run_id = p_run_id and e.user_id = v_uid and e.status <> 'removed'), '[]'::jsonb);
end
$$;

-- ---------------------------------------------------------------------------------------
-- Staff: segments are made from routes they plan, on paths
-- ---------------------------------------------------------------------------------------
create or replace function public.mod_create_segment(p_route_id uuid, p_name text, p_surface text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_staff('moderator');
  v_problem text := private.name_problem(p_name, 3, 60);
  v_route private.saved_routes;
  v_segment private.segments;
begin
  if v_problem is not null then
    perform private.fail('invalid_input', 'name');
  end if;
  if p_surface is null or p_surface not in ('path', 'trail', 'track', 'park') then
    perform private.fail('invalid_input', 'surface');
  end if;
  select * into v_route from private.saved_routes where id = p_route_id and user_id = v_uid;
  if not found then
    perform private.fail('not_found');
  end if;
  if jsonb_array_length(v_route.points) > 1000 or v_route.distance_m < 200 or v_route.distance_m > 20000 then
    perform private.fail('invalid_input', 'length');
  end if;
  insert into private.segments (name, surface, points, distance_m, start_lat, start_lon, end_lat, end_lon,
                                min_lat, max_lat, min_lon, max_lon, created_by)
  values (private.normalize_name(p_name), p_surface, v_route.points, v_route.distance_m, v_route.start_lat, v_route.start_lon,
          (v_route.points -> -1 ->> 0)::double precision, (v_route.points -> -1 ->> 1)::double precision,
          v_route.min_lat, v_route.max_lat, v_route.min_lon, v_route.max_lon, v_uid)
  returning * into v_segment;
  -- The recent shared runs of everyone on the boards are matched against it too.
  insert into private.segment_match_queue (run_id)
  select r.id from public.runs r
  where r.status = 'accepted' and r.deleted_at is null and r.visibility = 'everyone' and r.map_shared
    and r.started_at >= now() - make_interval(days => (private.segment_limits() ->> 'backfill_days')::integer)
    and private.segment_member(r.owner_id)
  on conflict (run_id) do update set queued_at = now();
  insert into private.moderation_actions (moderator_id, action, reason)
  values (v_uid, 'segment_created', 'Segment "' || v_segment.name || '" (' || v_segment.id || ')');
  return private.segment_json(v_segment, v_uid, true);
end
$$;

create or replace function public.mod_retire_segment(p_segment_id uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_staff('moderator');
  v_segment private.segments;
begin
  if coalesce(char_length(btrim(p_reason)), 0) < 3 then
    perform private.fail('invalid_input', 'reason');
  end if;
  update private.segments set status = 'retired', retired_at = now()
  where id = p_segment_id and status = 'active'
  returning * into v_segment;
  if v_segment.id is null then
    perform private.fail('not_found');
  end if;
  insert into private.moderation_actions (moderator_id, action, reason)
  values (v_uid, 'segment_retired', btrim(p_reason) || ' (' || v_segment.id || ')');
  return jsonb_build_object('retired', true);
end
$$;

-- ---------------------------------------------------------------------------------------
-- Reporting a time, and what moderators can do about it
-- ---------------------------------------------------------------------------------------
create or replace function public.report_content(p_kind text, p_id uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_run public.runs;
  v_comment private.comments;
  v_club private.clubs;
  v_group_run private.group_runs;
  v_challenge private.challenges;
  v_result private.leaderboard_results;
  v_effort private.segment_efforts;
  v_other uuid;
  v_snapshot jsonb;
  v_report private.reports;
begin
  if p_reason is null or p_reason not in ('harassment', 'impersonation', 'cheating', 'spam', 'offensive_content', 'offensive_name', 'private_info', 'other') then
    perform private.fail('invalid_input', 'reason');
  end if;
  -- Reporting the same thing again (a double tap) returns the open report, even though what it
  -- reported is now hidden from the reporter.
  select * into v_report from private.reports r
  where r.reporter_id = v_uid and r.status = 'open' and r.target_kind = p_kind
    and case p_kind when 'comment' then r.target_comment_id = p_id
                    when 'run' then r.target_run_id = p_id
                    when 'club' then r.target_club_id = p_id
                    when 'group_run' then r.target_group_run_id = p_id
                    when 'challenge' then r.target_challenge_id = p_id
                    when 'leaderboard' then r.target_result_id = p_id
                    when 'segment' then r.target_effort_id = p_id
                    else r.target_user_id = private.runner_by_public_id(p_id) end
  limit 1;
  if found then
    return jsonb_build_object('report_id', v_report.id, 'status', v_report.status, 'due_at_ms', private.ts_to_ms(v_report.due_at));
  end if;
  if p_kind = 'runner' then
    v_other := private.require_other_runner(v_uid, p_id);
    v_snapshot := jsonb_build_object('alias', (select alias from public.profiles where user_id = v_other));
  elsif p_kind = 'run' then
    select * into v_run from public.runs where id = p_id;
    if not found or v_run.owner_id = v_uid or not private.can_view_run(v_uid, v_run) then
      perform private.fail('not_found');
    end if;
    v_other := v_run.owner_id;
    v_snapshot := jsonb_build_object('alias', (select alias from public.profiles where user_id = v_other),
      'title', v_run.title, 'started_at_ms', private.ts_to_ms(v_run.started_at),
      'distance_m', coalesce(v_run.distance_cm / 100.0, v_run.client_distance_m::numeric),
      'active_ms', coalesce(v_run.active_ms, v_run.client_active_ms), 'visibility', v_run.visibility);
  elsif p_kind = 'comment' then
    select * into v_comment from private.comments where id = p_id;
    if not found or v_comment.deleted_at is not null or v_comment.author_id = v_uid
       or not private.comment_allowed(v_uid, v_comment.id, v_comment.author_id, v_comment.held_at) then
      perform private.fail('not_found');
    end if;
    select * into v_run from public.runs where id = v_comment.run_id;
    if not private.can_view_run(v_uid, v_run) then
      perform private.fail('not_found');
    end if;
    v_other := v_comment.author_id;
    v_snapshot := jsonb_build_object('alias', (select alias from public.profiles where user_id = v_other),
      'body', v_comment.body, 'run_title', v_run.title);
  elsif p_kind = 'club' then
    v_club := private.visible_club(v_uid, p_id);
    v_other := (select m.user_id from private.club_members m where m.club_id = v_club.id and m.left_at is null and m.role = 'owner' limit 1);
    v_snapshot := jsonb_build_object('club_name', v_club.name, 'description', v_club.description, 'visibility', v_club.visibility);
  elsif p_kind = 'group_run' then
    select * into v_group_run from private.group_runs where id = p_id;
    if not found or not private.in_group_of(v_uid, v_group_run) or v_group_run.created_by = v_uid then
      perform private.fail('not_found');
    end if;
    v_other := v_group_run.created_by;
    v_snapshot := jsonb_build_object('alias', (select alias from public.profiles where user_id = v_other),
      'title', v_group_run.title, 'meeting_point', v_group_run.meeting_point, 'notes', v_group_run.notes,
      'group', coalesce((select l.name from public.leagues l where l.id = v_group_run.league_id),
                        (select c.name from private.clubs c where c.id = v_group_run.club_id)));
  elsif p_kind = 'challenge' then
    -- The monthly challenges have no one's words in them; a group's challenge has its name.
    select * into v_challenge from private.challenges where id = p_id;
    if not found or v_challenge.scope = 'global' or v_challenge.created_by = v_uid or not private.challenge_visible(v_uid, v_challenge) then
      perform private.fail('not_found');
    end if;
    v_other := v_challenge.created_by;
    v_snapshot := jsonb_build_object('alias', (select alias from public.profiles where user_id = v_other),
      'title', private.challenge_title(v_challenge), 'custom_title', v_challenge.title is not null,
      'metric', v_challenge.metric, 'target', v_challenge.target, 'starts_on', v_challenge.starts_on,
      'group', coalesce((select l.name from public.leagues l where l.id = v_challenge.league_id),
                        (select c.name from private.clubs c where c.id = v_challenge.club_id)));
  elsif p_kind = 'leaderboard' then
    -- A result on a board anyone signed in can see.
    select * into v_result from private.leaderboard_results where id = p_id;
    if not found or v_result.user_id = v_uid or v_result.status not in ('provisional', 'final')
       or not private.leaderboard_member(v_result.user_id) then
      perform private.fail('not_found');
    end if;
    v_other := v_result.user_id;
    v_snapshot := jsonb_build_object('alias', (select alias from public.profiles where user_id = v_other),
      'week_start', v_result.week_start, 'score', v_result.score, 'tier', v_result.tier, 'country', v_result.country);
  elsif p_kind = 'segment' then
    -- A time on a segment's board (docs/ROADMAP.md 5.3).
    if private.is_teen(v_uid) then
      perform private.fail('teen_restricted', 'segment');
    end if;
    select * into v_effort from private.segment_efforts where id = p_id;
    if not found or v_effort.user_id = v_uid or v_effort.status <> 'counted' or not private.segment_member(v_effort.user_id)
       or private.are_blocked(v_uid, v_effort.user_id) then
      perform private.fail('not_found');
    end if;
    v_other := v_effort.user_id;
    v_snapshot := jsonb_build_object('alias', (select alias from public.profiles where user_id = v_other),
      'segment', (select s.name from private.segments s where s.id = v_effort.segment_id),
      'distance_m', (select s.distance_m from private.segments s where s.id = v_effort.segment_id),
      'elapsed_ms', v_effort.elapsed_ms, 'started_at_ms', private.ts_to_ms(v_effort.started_at));
  else
    perform private.fail('invalid_input', 'kind');
  end if;
  perform private.check_rate_limit('report:' || v_uid, 20, interval '1 day');
  insert into private.reports (reporter_id, target_kind, target_user_id, target_league_id, target_run_id, target_comment_id,
                               target_club_id, target_group_run_id, target_challenge_id, target_result_id, target_effort_id, reason_code, content_snapshot)
  values (v_uid, p_kind, v_other, case when p_kind = 'challenge' then v_challenge.league_id end,
          case when p_kind in ('run', 'comment') then v_run.id end,
          case when p_kind = 'comment' then v_comment.id end,
          case when p_kind = 'club' then v_club.id when p_kind = 'group_run' then v_group_run.club_id
               when p_kind = 'challenge' then v_challenge.club_id end,
          case when p_kind = 'group_run' then v_group_run.id end,
          case when p_kind = 'challenge' then v_challenge.id end,
          case when p_kind = 'leaderboard' then v_result.id end,
          case when p_kind = 'segment' then v_effort.id end, p_reason, v_snapshot)
  returning * into v_report;

  if p_kind in ('run', 'comment') then
    insert into private.hidden_content (user_id, target_kind, target_id)
    values (v_uid, p_kind, case when p_kind = 'run' then v_run.id else v_comment.id end)
    on conflict do nothing;
  end if;
  if p_kind = 'comment' and v_comment.held_at is null
     and (select count(distinct r.reporter_id) from private.reports r
          where r.target_comment_id = v_comment.id and r.status = 'open') >= 3 then
    update private.comments set held_at = now() where id = v_comment.id;
  end if;
  return jsonb_build_object('report_id', v_report.id, 'status', v_report.status, 'due_at_ms', private.ts_to_ms(v_report.due_at));
end
$$;

create or replace function private.mod_actions_for(p_kind text)
returns jsonb
language sql immutable
as $$
  select case p_kind
    when 'member' then '["dismiss", "reset_alias", "remove_from_league"]'::jsonb
    when 'league' then '["dismiss", "rename_league"]'::jsonb
    when 'runner' then '["dismiss", "reset_alias"]'::jsonb
    when 'run' then '["dismiss", "hide_run", "reset_alias"]'::jsonb
    when 'comment' then '["dismiss", "remove_comment", "reset_alias"]'::jsonb
    when 'club' then '["dismiss", "reset_club", "close_club"]'::jsonb
    when 'group_run' then '["dismiss", "remove_group_run", "reset_alias"]'::jsonb
    when 'challenge' then '["dismiss", "reset_challenge_name", "remove_challenge", "reset_alias"]'::jsonb
    when 'leaderboard' then '["dismiss", "release_result", "remove_result", "remove_from_leaderboards", "reset_alias"]'::jsonb
    when 'segment' then '["dismiss", "release_effort", "remove_effort", "remove_from_segments", "reset_alias"]'::jsonb
    else '["dismiss"]'::jsonb
  end
$$;

create or replace function private.same_target(a private.reports, b private.reports)
returns boolean
language sql immutable
as $$
  select a.target_kind = b.target_kind
     and a.target_user_id is not distinct from b.target_user_id
     and a.target_league_id is not distinct from b.target_league_id
     and a.target_run_id is not distinct from b.target_run_id
     and a.target_comment_id is not distinct from b.target_comment_id
     and a.target_club_id is not distinct from b.target_club_id
     and a.target_group_run_id is not distinct from b.target_group_run_id
     and a.target_challenge_id is not distinct from b.target_challenge_id
     and a.target_result_id is not distinct from b.target_result_id
     and a.target_effort_id is not distinct from b.target_effort_id
$$;

create or replace function public.mod_list_reports(p_status text default 'open', p_limit integer default 50)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_staff('moderator');
  v_status text := coalesce(p_status, 'open');
begin
  if v_status not in ('open', 'actioned', 'dismissed') then
    perform private.fail('invalid_input', 'status');
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
             'report_id', r.id,
             'target_kind', r.target_kind,
             'reason_code', r.reason_code,
             'content_snapshot', r.content_snapshot,
             'status', r.status,
             'created_at_ms', private.ts_to_ms(r.created_at),
             'due_at_ms', private.ts_to_ms(r.due_at),
             'overdue', r.status = 'open' and r.due_at < now(),
             'resolution', r.resolution,
             'resolved_at_ms', case when r.resolved_at is null then null else private.ts_to_ms(r.resolved_at) end,
             'open_on_target', (select count(*) from private.reports o where o.status = 'open' and private.same_target(o, r)),
             'target_state', case r.target_kind
               when 'comment' then jsonb_build_object(
                 'removed', coalesce((select c.deleted_at is not null from private.comments c where c.id = r.target_comment_id), true),
                 'held', coalesce((select c.held_at is not null from private.comments c where c.id = r.target_comment_id), false))
               when 'run' then jsonb_build_object(
                 'visibility', (select x.visibility from public.runs x where x.id = r.target_run_id),
                 'deleted', coalesce((select x.deleted_at is not null from public.runs x where x.id = r.target_run_id), true))
               when 'club' then jsonb_build_object(
                 'status', (select c.status from private.clubs c where c.id = r.target_club_id),
                 'visibility', (select c.visibility from private.clubs c where c.id = r.target_club_id))
               when 'group_run' then jsonb_build_object(
                 'removed', not exists (select 1 from private.group_runs g where g.id = r.target_group_run_id))
               when 'challenge' then jsonb_build_object(
                 'removed', not exists (select 1 from private.challenges c where c.id = r.target_challenge_id),
                 'title', (select private.challenge_title(c) from private.challenges c where c.id = r.target_challenge_id))
               when 'leaderboard' then jsonb_build_object(
                 'result_status', (select x.status from private.leaderboard_results x where x.id = r.target_result_id),
                 'flags', (select to_jsonb(x.flags) from private.leaderboard_results x where x.id = r.target_result_id),
                 'removed', coalesce((select x.status = 'removed' from private.leaderboard_results x where x.id = r.target_result_id), true))
               when 'segment' then jsonb_build_object(
                 'effort_status', (select x.status from private.segment_efforts x where x.id = r.target_effort_id),
                 'removed', coalesce((select x.status = 'removed' from private.segment_efforts x where x.id = r.target_effort_id), true))
               else '{}'::jsonb end,
             'actions', private.mod_actions_for(r.target_kind))
           order by case when v_status = 'open' then r.due_at end, r.created_at desc), '[]'::jsonb)
    from (select x.id from private.reports x where x.status = v_status
          order by case when v_status = 'open' then x.due_at end, x.created_at desc
          limit least(greatest(coalesce(p_limit, 50), 1), 200)) pick
    join private.reports r on r.id = pick.id
  );
end
$$;

create or replace function public.mod_resolve_report(p_report_id uuid, p_action text, p_reason text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_staff('moderator');
  v_report private.reports;
  v_suffix text := private.generate_invite_code();
  v_member public.league_members;
  v_status text := case when p_action = 'dismiss' then 'dismissed' else 'actioned' end;
  v_also integer := 0;
begin
  if coalesce(char_length(btrim(p_reason)), 0) < 3 then
    perform private.fail('invalid_input', 'reason');
  end if;
  select * into v_report from private.reports where id = p_report_id for update;
  if not found then
    perform private.fail('not_found');
  end if;
  if v_report.status <> 'open' then
    perform private.fail('already_resolved');
  end if;
  if not (private.mod_actions_for(v_report.target_kind) ? p_action) then
    perform private.fail('invalid_input', 'action');
  end if;

  -- Taking something down (or deciding a held result) settles every open report about it.
  if p_action in ('remove_comment', 'hide_run', 'reset_club', 'close_club', 'remove_group_run', 'reset_challenge_name', 'remove_challenge',
                  'release_result', 'remove_result', 'remove_from_leaderboards', 'release_effort', 'remove_effort',
                  'remove_from_segments') then
    update private.reports o
       set status = 'actioned', resolved_at = now(), resolved_by = v_uid, resolution = p_action
     where o.status = 'open' and o.id <> v_report.id and private.same_target(o, v_report);
    get diagnostics v_also = row_count;
  end if;

  if p_action = 'reset_alias' and v_report.target_user_id is not null then
    update public.profiles set alias = 'Runner ' || left(v_suffix, 6), updated_at = now()
    where user_id = v_report.target_user_id;
  elsif p_action = 'rename_league' and v_report.target_league_id is not null then
    update public.leagues set name = 'Crew ' || left(v_suffix, 6), updated_at = now()
    where id = v_report.target_league_id;
  elsif p_action = 'remove_from_league' and v_report.target_user_id is not null then
    select * into v_member from public.league_members
    where user_id = v_report.target_user_id and league_id = v_report.target_league_id and left_at is null;
    if found then
      if v_member.role = 'owner' then
        perform private.fail('owner_must_transfer');
      end if;
      update public.league_members set left_at = now(), left_reason = 'removed' where id = v_member.id;
      insert into private.league_bans (league_id, user_id) values (v_member.league_id, v_member.user_id)
      on conflict do nothing;
    end if;
  elsif p_action = 'remove_comment' and v_report.target_comment_id is not null then
    update private.comments
       set deleted_at = coalesce(deleted_at, now()), body = null, removed_by = coalesce(removed_by, 'moderator'), held_at = null
     where id = v_report.target_comment_id;
  elsif p_action = 'hide_run' and v_report.target_run_id is not null then
    -- The runner keeps the run; nobody else sees it until they share it again.
    update public.runs set visibility = 'only_me', map_shared = false, updated_at = now() where id = v_report.target_run_id;
  elsif p_action = 'reset_club' and v_report.target_club_id is not null then
    -- A neutral name and no description; the club and its members stay.
    update private.clubs set name = 'Club ' || left(v_suffix, 6), description = null, updated_at = now()
    where id = v_report.target_club_id;
  elsif p_action = 'close_club' and v_report.target_club_id is not null then
    update private.clubs set status = 'closed', updated_at = now() where id = v_report.target_club_id;
    update private.club_invites set revoked_at = now() where club_id = v_report.target_club_id and revoked_at is null;
    update private.club_members set left_at = now(), left_reason = 'club_closed'
    where club_id = v_report.target_club_id and left_at is null;
  elsif p_action = 'remove_group_run' and v_report.target_group_run_id is not null then
    delete from private.group_runs where id = v_report.target_group_run_id;
  elsif p_action = 'reset_challenge_name' and v_report.target_challenge_id is not null then
    -- Back to the name made from the measure and the month; entries and badges stay.
    update private.challenges set title = null where id = v_report.target_challenge_id;
  elsif p_action = 'remove_challenge' and v_report.target_challenge_id is not null then
    delete from private.challenges where id = v_report.target_challenge_id;
  elsif p_action = 'release_result' and v_report.target_result_id is not null then
    -- A person looked: back on the board, and not checked again unless the score changes.
    update private.leaderboard_results
       set status = case when exists (select 1 from private.leaderboard_weeks w where w.week_start = leaderboard_results.week_start)
                         then 'final' else 'provisional' end,
           cleared_at = now(), updated_at = now()
     where id = v_report.target_result_id and status in ('held', 'removed');
  elsif p_action = 'remove_result' and v_report.target_result_id is not null then
    update private.leaderboard_results set status = 'removed', updated_at = now() where id = v_report.target_result_id;
  elsif p_action = 'remove_from_leaderboards' and v_report.target_user_id is not null then
    update private.leaderboard_members set banned_at = now(), updated_at = now() where user_id = v_report.target_user_id;
    update private.leaderboard_results set status = 'removed', updated_at = now()
    where user_id = v_report.target_user_id and status <> 'removed';
  elsif p_action = 'release_effort' and v_report.target_effort_id is not null then
    -- A person looked: back on the board, and not held again when the run is matched again.
    update private.segment_efforts set status = 'counted', cleared_at = now()
    where id = v_report.target_effort_id and status in ('held', 'removed');
  elsif p_action = 'remove_effort' and v_report.target_effort_id is not null then
    update private.segment_efforts set status = 'removed' where id = v_report.target_effort_id;
  elsif p_action = 'remove_from_segments' and v_report.target_user_id is not null then
    insert into private.segment_members (user_id, banned_at) values (v_report.target_user_id, now())
    on conflict (user_id) do update set banned_at = now();
    update private.segment_efforts set status = 'removed' where user_id = v_report.target_user_id and status <> 'removed';
  end if;

  update private.reports
     set status = v_status, resolved_at = now(), resolved_by = v_uid, resolution = p_action
   where id = p_report_id;
  -- A held comment goes back once no open report about it is left.
  if v_report.target_comment_id is not null
     and not exists (select 1 from private.reports o where o.status = 'open' and o.target_comment_id = v_report.target_comment_id) then
    update private.comments set held_at = null where id = v_report.target_comment_id and held_at is not null;
  end if;
  insert into private.moderation_actions (report_id, moderator_id, action, reason, target_user_id, target_league_id, target_run_id,
                                          target_comment_id, target_club_id)
  values (p_report_id, v_uid, p_action, btrim(p_reason), v_report.target_user_id, v_report.target_league_id,
          v_report.target_run_id, v_report.target_comment_id, v_report.target_club_id);
  return jsonb_build_object('report_id', p_report_id, 'status', v_status, 'also_resolved', v_also,
                            'within_target', now() <= v_report.due_at);
end
$$;

-- ---------------------------------------------------------------------------------------
-- Export
-- ---------------------------------------------------------------------------------------
create or replace function private.segment_export(p_uid uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'joined', private.segment_member(p_uid),
    'joined_at_ms', (select private.ts_to_ms(m.joined_at) from private.segment_members m where m.user_id = p_uid),
    'efforts', coalesce((select jsonb_agg(jsonb_build_object('segment', s.name, 'run_id', e.run_id,
                                                          'started_at_ms', private.ts_to_ms(e.started_at),
                                                          'elapsed_ms', e.elapsed_ms, 'status', e.status)
                                       order by e.started_at)
                         from private.segment_efforts e
                         join private.segments s on s.id = e.segment_id
                         where e.user_id = p_uid), '[]'::jsonb))
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
    'segments', private.segment_export(p_uid)
  );
end
$$;

select private.apply_function_grants();
