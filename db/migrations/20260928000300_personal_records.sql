-- Personal records (docs/ROADMAP.md 1.4): the fastest 1K, mile, 5K, 10K, half and marathon inside
-- a runner's accepted runs, plus their longest run. Free, and never part of XP.
--
-- An effort must lie inside one stretch of continuous running: it never spans a pause, a GPS gap
-- longer than 15 s, or a point the validator would reject (accuracy worse than 50 m, or an implied
-- speed above 12 m/s). The time is interpolated between points at the exact distance. Efforts
-- faster than the world record for the distance are ignored as GPS error.

create table private.run_efforts (
  run_id uuid not null references public.runs (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  effort text not null check (effort in ('1k', '1mi', '5k', '10k', 'half', 'marathon')),
  elapsed_ms bigint not null check (elapsed_ms > 0),
  started_at timestamptz not null,
  primary key (run_id, effort)
);
create index run_efforts_owner_idx on private.run_efforts (owner_id, effort, elapsed_ms);

create or replace function private.effort_catalog()
returns table (effort text, distance_m double precision, fastest_ms bigint, sort integer)
language sql immutable
as $$
  values ('1k', 1000::double precision, 130000::bigint, 1),
         ('1mi', 1609.344, 223000, 2),
         ('5k', 5000, 755000, 3),
         ('10k', 10000, 1571000, 4),
         ('half', 21097.5, 3450000, 5),
         ('marathon', 42195, 7235000, 6)
$$;

-- Fastest time to cover p_target metres along one stretch (cumulative distance p_cum at times p_t),
-- with the end interpolated. Two pointers: O(n).
create or replace function private.fastest_span(
  p_t bigint[],
  p_cum double precision[],
  p_target double precision,
  out elapsed_ms bigint,
  out start_ms bigint
)
language plpgsql immutable
as $$
declare
  n integer := coalesce(array_length(p_t, 1), 0);
  i integer;
  j integer := 1;
  v_end double precision;
  v_elapsed double precision;
  v_best double precision;
  v_best_start bigint;
begin
  elapsed_ms := null;
  start_ms := null;
  if n < 2 or p_cum[n] < p_target then
    return;
  end if;
  for i in 1 .. n loop
    exit when p_cum[n] - p_cum[i] < p_target;
    if j <= i then
      j := i + 1;
    end if;
    while p_cum[j] - p_cum[i] < p_target loop
      j := j + 1;
    end loop;
    v_end := p_t[j - 1] + (p_target - (p_cum[j - 1] - p_cum[i])) / (p_cum[j] - p_cum[j - 1]) * (p_t[j] - p_t[j - 1]);
    v_elapsed := v_end - p_t[i];
    if v_best is null or v_elapsed < v_best then
      v_best := v_elapsed;
      v_best_start := p_t[i];
    end if;
  end loop;
  if v_best is not null then
    elapsed_ms := round(v_best)::bigint;
    start_ms := v_best_start;
  end if;
end
$$;

-- Recomputes one run's efforts from its stored route. Runs of other activity types and deleted
-- runs have none. Records read only accepted runs, so status changes need no recomputation.
create or replace function private.compute_run_efforts(p_run_id uuid)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  c_max_acc constant double precision := 50;
  c_gap constant bigint := 15000;
  c_jump constant double precision := 12;
  v_run public.runs;
  v_seg record;
  p record;
  v_t bigint[];
  v_cum double precision[];
  v_n integer;
  a_t bigint;
  a_lat double precision;
  a_lon double precision;
  v_dt bigint;
  v_d double precision;
  v_best bigint[] := array[null, null, null, null, null, null]::bigint[];
  v_best_start bigint[] := array[null, null, null, null, null, null]::bigint[];
  v_catalog record;
  v_span record;
  v_count integer := 0;
begin
  delete from private.run_efforts where run_id = p_run_id;
  select * into v_run from public.runs where id = p_run_id;
  if not found or v_run.deleted_at is not null or v_run.activity_type <> 'run'
     or jsonb_typeof(v_run.segments) <> 'array' then
    return 0;
  end if;

  for v_seg in
    select (s ->> 'index')::integer as idx, (s ->> 'startAt')::bigint as start_ms, (s ->> 'endAt')::bigint as end_ms
    from jsonb_array_elements(v_run.segments) with ordinality as t(s, ord)
    order by ord
  loop
    v_t := '{}';
    v_cum := '{}';
    v_n := 0;
    a_t := null;
    for p in
      select (e ->> 1)::bigint as t, (e ->> 2)::double precision as lat, (e ->> 3)::double precision as lon,
             (e ->> 4)::double precision as acc
      from private.run_routes r, jsonb_array_elements(r.points) e
      where r.run_id = p_run_id and (e ->> 5)::integer = v_seg.idx
        and (e ->> 1)::bigint between v_seg.start_ms and v_seg.end_ms
      order by (e ->> 1)::bigint, (e ->> 0)::bigint
    loop
      if not coalesce(p.lat between -90 and 90 and p.lon between -180 and 180 and p.acc >= 0 and p.acc <= c_max_acc, false) then
        continue;
      end if;
      if a_t is not null and p.t <= a_t then
        continue;
      end if;
      if a_t is not null then
        v_dt := p.t - a_t;
        v_d := private.haversine_m(a_lat, a_lon, p.lat, p.lon);
        if v_dt <= c_gap and v_d / (v_dt::double precision / 1000) > c_jump then
          continue; -- implausible jump: skip the point, keep the anchor
        end if;
        if v_dt > c_gap then
          -- A gap ends the stretch: score what we have, start again from this point.
          for v_catalog in select * from private.effort_catalog() loop
            select * into v_span from private.fastest_span(v_t, v_cum, v_catalog.distance_m);
            if v_span.elapsed_ms is not null and v_span.elapsed_ms >= v_catalog.fastest_ms
               and (v_best[v_catalog.sort] is null or v_span.elapsed_ms < v_best[v_catalog.sort]) then
              v_best[v_catalog.sort] := v_span.elapsed_ms;
              v_best_start[v_catalog.sort] := v_span.start_ms;
            end if;
          end loop;
          v_t := '{}';
          v_cum := '{}';
          v_n := 0;
        end if;
      end if;
      v_n := v_n + 1;
      v_t[v_n] := p.t;
      v_cum[v_n] := case when v_n = 1 then 0 else v_cum[v_n - 1] + v_d end;
      a_t := p.t;
      a_lat := p.lat;
      a_lon := p.lon;
    end loop;

    for v_catalog in select * from private.effort_catalog() loop
      select * into v_span from private.fastest_span(v_t, v_cum, v_catalog.distance_m);
      if v_span.elapsed_ms is not null and v_span.elapsed_ms >= v_catalog.fastest_ms
         and (v_best[v_catalog.sort] is null or v_span.elapsed_ms < v_best[v_catalog.sort]) then
        v_best[v_catalog.sort] := v_span.elapsed_ms;
        v_best_start[v_catalog.sort] := v_span.start_ms;
      end if;
    end loop;
  end loop;

  for v_catalog in select * from private.effort_catalog() loop
    if v_best[v_catalog.sort] is not null then
      insert into private.run_efforts (run_id, owner_id, effort, elapsed_ms, started_at)
      values (p_run_id, v_run.owner_id, v_catalog.effort, v_best[v_catalog.sort], private.ms_to_ts(v_best_start[v_catalog.sort]));
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end
$$;

-- Efforts follow the stored route: computed when finalize consolidates it, and again whenever an
-- edit rewrites it. Deleting a run removes its route and so its efforts.
create or replace function private.run_routes_efforts()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    delete from private.run_efforts where run_id = old.run_id;
    return old;
  end if;
  perform private.compute_run_efforts(new.run_id);
  return new;
end
$$;

create trigger run_routes_efforts after insert or update or delete on private.run_routes
  for each row execute function private.run_routes_efforts();

-- The runs counted for records: accepted, not deleted, runs.
create or replace function private.record_efforts(p_user uuid)
returns table (run_id uuid, effort text, elapsed_ms bigint, started_at timestamptz, run_started_at timestamptz, title text)
language sql stable security definer set search_path = ''
as $$
  select e.run_id, e.effort, e.elapsed_ms, e.started_at, r.started_at, r.title
  from private.run_efforts e
  join public.runs r on r.id = e.run_id
  where e.owner_id = p_user and r.owner_id = p_user and r.status = 'accepted' and r.deleted_at is null
    and r.activity_type = 'run'
$$;

create or replace function public.get_personal_records()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_longest public.runs;
begin
  select * into v_longest from public.runs
  where owner_id = v_uid and status = 'accepted' and deleted_at is null and activity_type = 'run' and distance_cm is not null
  order by distance_cm desc, started_at
  limit 1;

  return jsonb_build_object(
    'records', coalesce((
      select jsonb_agg(jsonb_build_object(
               'effort', c.effort,
               'distance_m', c.distance_m,
               'best', case when b.run_id is null then null else jsonb_build_object(
                 'run_id', b.run_id, 'elapsed_ms', b.elapsed_ms, 'started_at_ms', private.ts_to_ms(b.run_started_at),
                 'title', b.title) end,
               'efforts', (select count(*) from private.record_efforts(v_uid) x where x.effort = c.effort))
             order by c.sort)
      from private.effort_catalog() c
      left join lateral (
        select * from private.record_efforts(v_uid) x
        where x.effort = c.effort
        order by x.elapsed_ms, x.run_started_at
        limit 1
      ) b on true), '[]'::jsonb),
    'longest_run', case when v_longest.id is null then null else jsonb_build_object(
      'run_id', v_longest.id, 'distance_m', v_longest.distance_cm / 100.0,
      'started_at_ms', private.ts_to_ms(v_longest.started_at), 'title', v_longest.title) end
  );
end
$$;

-- Each time the record for one distance improved, oldest first.
create or replace function public.get_record_history(p_effort text)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
begin
  if not exists (select 1 from private.effort_catalog() where effort = p_effort) then
    perform private.fail('invalid_input', 'effort');
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('run_id', run_id, 'elapsed_ms', elapsed_ms,
                                        'started_at_ms', private.ts_to_ms(run_started_at), 'title', title)
                     order by run_started_at, run_id)
    from (
      select x.*, min(x.elapsed_ms) over (order by x.run_started_at, x.run_id
                                          rows between unbounded preceding and 1 preceding) as best_before
      from private.record_efforts(v_uid) x
      where x.effort = p_effort
    ) h
    where best_before is null or elapsed_ms < best_before), '[]'::jsonb);
end
$$;

-- One run's efforts: its time, whether it is the current record, its rank among the runner's
-- efforts, and whether it was a record when it was run.
create or replace function public.get_run_efforts(p_run_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_run public.runs;
begin
  select * into v_run from public.runs where id = p_run_id and owner_id = v_uid and deleted_at is null;
  if not found then
    perform private.fail('not_found');
  end if;
  return jsonb_build_object(
    'run_id', p_run_id,
    'counts_for_records', v_run.status = 'accepted' and v_run.activity_type = 'run',
    'efforts', coalesce((
      select jsonb_agg(jsonb_build_object(
               'effort', e.effort,
               'elapsed_ms', e.elapsed_ms,
               'rank', (select count(*) + 1 from private.record_efforts(v_uid) x
                        where x.effort = e.effort and (x.elapsed_ms < e.elapsed_ms
                              or (x.elapsed_ms = e.elapsed_ms and x.run_started_at < v_run.started_at))),
               'record_when_run', not exists (select 1 from private.record_efforts(v_uid) x
                                              where x.effort = e.effort and x.run_started_at < v_run.started_at
                                                and x.elapsed_ms <= e.elapsed_ms))
             order by c.sort)
      from private.run_efforts e
      join private.effort_catalog() c on c.effort = e.effort
      where e.run_id = p_run_id), '[]'::jsonb));
end
$$;

-- Backfill runs saved before records existed.
select private.compute_run_efforts(run_id) from private.run_routes;

select private.apply_function_grants();
