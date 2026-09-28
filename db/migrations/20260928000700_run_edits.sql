-- Fixing a run (docs/ROADMAP.md 1.5): trim the start or end, cut out a stretch recorded while
-- stopped, change the activity type, merge two runs split by accident, and undo.
--
-- An edit rewrites the run's segments and its stored route, then the run goes through the same
-- validator and scoring as a new upload. Two guarantees keep edits from being a way to cheat:
--   * Distance can only go down. Merging adds nothing for the gap between the runs (the validator
--     never bridges segments). An edit that would raise the validated distance is refused.
--   * A run can't be promoted by editing. If the edited run would be accepted but the original
--     wasn't (or wasn't a run), it is held for review with the reason `edited` instead.
-- The original is kept, so the runner can undo their edits (not a merge).

-- Points of a run, from staged chunks during finalize or from the stored route afterwards.
create or replace function private.run_points(p_run_id uuid)
returns table (seq bigint, t bigint, lat double precision, lon double precision, acc double precision, seg integer)
language sql stable security definer set search_path = ''
as $$
  select (e ->> 0)::bigint, (e ->> 1)::bigint, (e ->> 2)::double precision, (e ->> 3)::double precision,
         (e ->> 4)::double precision, (e ->> 5)::integer
  from private.route_chunks c, jsonb_array_elements(c.points) e
  where c.run_id = p_run_id
  union all
  select (e ->> 0)::bigint, (e ->> 1)::bigint, (e ->> 2)::double precision, (e ->> 3)::double precision,
         (e ->> 4)::double precision, (e ->> 5)::integer
  from private.run_routes r, jsonb_array_elements(r.points) e
  where r.run_id = p_run_id
$$;

-- The validator, unchanged except that it reads points through private.run_points, so it can
-- re-validate a finalized run from its stored route (the parity suite still holds it equal to
-- src/domain/validator.ts).
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

  select count(*)::integer into v_total_points from private.run_points(p_run_id);

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
      select rp.seq, rp.t, rp.lat, rp.lon, rp.acc
      from private.run_points(p_run_id) rp
      where rp.seg = v_seg.idx and rp.t between s_start and s_end
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

-- Only runs earn XP: any other activity type is never scored.
create or replace function private.runs_only_runs_score()
returns trigger
language plpgsql
as $$
begin
  if new.activity_type <> 'run' and new.scoring_state <> 'none' then
    new.scoring_state := 'none';
  end if;
  return new;
end
$$;

create trigger runs_only_runs_score before insert or update on public.runs
  for each row execute function private.runs_only_runs_score();

alter table public.runs add column merged_into uuid references public.runs (id);

alter table private.xp_ledger drop constraint xp_ledger_cause_kind_check;
alter table private.xp_ledger add constraint xp_ledger_cause_kind_check
  check (cause_kind in ('run_accepted', 'run_deleted', 'run_review_resolved', 'recompute',
                        'run_edited', 'runs_merged', 'run_edit_undone'));

create table private.run_originals (
  run_id uuid primary key references public.runs (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  segments jsonb not null,
  started_at timestamptz not null,
  ended_at timestamptz not null,
  activity_type text not null,
  status text not null,
  points jsonb not null,
  point_count integer not null,
  checksum text not null,
  saved_at timestamptz not null default now()
);

create or replace function private.route_checksum(p_points jsonb)
returns text
language sql immutable
as $$
  select encode(sha256(convert_to(p_points::text, 'UTF8')), 'hex')
$$;

create or replace function private.save_original(p_run public.runs)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  insert into private.run_originals (run_id, owner_id, segments, started_at, ended_at, activity_type, status,
                                     points, point_count, checksum)
  select p_run.id, p_run.owner_id, p_run.segments, p_run.started_at, p_run.ended_at, p_run.activity_type, p_run.status,
         rr.points, rr.point_count, rr.checksum
  from private.run_routes rr where rr.run_id = p_run.id
  on conflict (run_id) do nothing;
end
$$;

-- Re-validates an edited run and re-scores the affected days. Caller holds the run row lock and
-- private.lock_user_scoring(owner).
create or replace function private.rescore_edited_run(
  p_run_id uuid,
  p_old_dates date[],
  p_was_accepted_run boolean,
  p_cause text
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_run public.runs;
  v_validation jsonb;
  v_outcome text;
  v_reasons text[];
  v_scoring text;
  v_dates date[];
  v_changes jsonb;
begin
  select * into v_run from public.runs where id = p_run_id;
  delete from private.run_day_allocations where run_id = p_run_id;
  v_validation := private.validate_run(p_run_id, v_run.first_received_at);
  insert into private.run_day_allocations (run_id, owner_id, segment_index, competition_date, segment_start_at, distance_cm, active_ms)
  select p_run_id, v_run.owner_id, (a ->> 'segment_index')::integer, (a ->> 'competition_date')::date,
         private.ms_to_ts((a ->> 'segment_start_ms')::bigint), (a ->> 'distance_cm')::bigint, (a ->> 'active_ms')::bigint
  from jsonb_array_elements(v_validation -> 'allocations') a;

  v_outcome := v_validation ->> 'outcome';
  v_reasons := array(select jsonb_array_elements_text(v_validation -> 'reasons'));
  if v_outcome = 'accepted' and v_run.activity_type = 'run' and not p_was_accepted_run then
    v_outcome := 'review';
    v_reasons := array_append(v_reasons, 'edited');
  end if;
  v_scoring := case
    when v_outcome = 'accepted' and v_run.activity_type = 'run' then
      case when private.flag_enabled('competition_enabled') then 'applied' else 'pending' end
    else 'none' end;

  update public.runs
     set status = v_outcome, reason_codes = v_reasons,
         distance_cm = (v_validation ->> 'distance_cm')::bigint,
         active_ms = (v_validation ->> 'active_ms')::bigint,
         coverage = round((v_validation ->> 'coverage')::numeric, 5),
         diagnostics = v_validation -> 'diagnostics',
         validator_version = (v_validation ->> 'validator_version')::smallint,
         scoring_state = v_scoring, xp_award = null, updated_at = now()
   where id = p_run_id;

  select array_agg(distinct competition_date) into v_dates from private.run_day_allocations where run_id = p_run_id;
  v_dates := array(select d from unnest(coalesce(p_old_dates, '{}'::date[]) || coalesce(v_dates, '{}'::date[])) d
                   where d is not null group by d);
  v_changes := private.recompute_daily_scores(v_run.owner_id, v_dates, p_cause, p_run_id);
  perform private.record_league_revisions(v_run.owner_id, v_dates, p_cause);
  return v_changes;
end
$$;

create or replace function private.edit_response(p_run_id uuid, p_changes jsonb)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'run', private.run_json(r),
    'xp_changes', coalesce(p_changes, '[]'::jsonb),
    'lifetime_xp', private.lifetime_xp(r.owner_id),
    'can_undo', exists (select 1 from private.run_originals o where o.run_id = r.id)
                and not exists (select 1 from public.runs m where m.merged_into = r.id))
  from public.runs r where r.id = p_run_id
$$;

create or replace function private.editable_run(p_uid uuid, p_run_id uuid, p_expected_version integer)
returns public.runs
language plpgsql security definer set search_path = ''
as $$
declare
  v_run public.runs;
begin
  select * into v_run from public.runs where id = p_run_id and owner_id = p_uid for update;
  if not found or v_run.deleted_at is not null or v_run.status not in ('accepted', 'personal_only', 'review') then
    perform private.fail('not_found');
  end if;
  if p_expected_version is not null and p_expected_version <> v_run.version then
    perform private.fail('version_conflict');
  end if;
  if not exists (select 1 from private.run_routes where run_id = p_run_id) then
    perform private.fail('not_found', 'route');
  end if;
  return v_run;
end
$$;

-- Trim to [p_keep_from_ms, p_keep_to_ms], cut out p_cut_ranges ([{from_ms, to_ms}]), and/or change
-- the activity type. Omitted arguments leave that part unchanged.
create or replace function public.edit_run(
  p_run_id uuid,
  p_expected_version integer,
  p_keep_from_ms bigint default null,
  p_keep_to_ms bigint default null,
  p_cut_ranges jsonb default '[]'::jsonb,
  p_activity_type text default null
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_run public.runs;
  v_after public.runs;
  v_started bigint;
  v_ended bigint;
  v_from bigint;
  v_to bigint;
  v_type text;
  v_cuts jsonb := coalesce(p_cut_ranges, '[]'::jsonb);
  v_cut jsonb;
  v_seg record;
  v_pieces jsonb := '[]'::jsonb;
  v_work jsonb;
  v_next jsonb;
  v_piece jsonb;
  v_c_from bigint;
  v_c_to bigint;
  v_segments jsonb := '[]'::jsonb;
  v_points jsonb;
  v_old_dates date[];
  v_changes jsonb;
  v_k integer := 0;
begin
  v_run := private.editable_run(v_uid, p_run_id, p_expected_version);
  v_started := private.ts_to_ms(v_run.started_at);
  v_ended := private.ts_to_ms(v_run.ended_at);
  v_from := coalesce(p_keep_from_ms, v_started);
  v_to := coalesce(p_keep_to_ms, v_ended);
  v_type := coalesce(p_activity_type, v_run.activity_type);
  if v_from < v_started or v_to > v_ended or v_to - v_from < 60000 then
    perform private.fail('invalid_input', 'range');
  end if;
  if v_type not in ('run', 'walk', 'hike', 'ride', 'other') then
    perform private.fail('invalid_input', 'activity_type');
  end if;
  if jsonb_typeof(v_cuts) <> 'array' or jsonb_array_length(v_cuts) > 20 then
    perform private.fail('invalid_input', 'cut_ranges');
  end if;
  for v_cut in select * from jsonb_array_elements(v_cuts) loop
    if jsonb_typeof(v_cut -> 'from_ms') <> 'number' or jsonb_typeof(v_cut -> 'to_ms') <> 'number'
       or (v_cut ->> 'from_ms')::numeric >= (v_cut ->> 'to_ms')::numeric
       or (v_cut ->> 'from_ms')::numeric < v_from or (v_cut ->> 'to_ms')::numeric > v_to then
      perform private.fail('invalid_input', 'cut_ranges');
    end if;
  end loop;

  -- Each old segment, clipped to the kept window, minus every cut range.
  for v_seg in
    select (s ->> 'index')::integer as idx, (s ->> 'startAt')::bigint as start_ms, (s ->> 'endAt')::bigint as end_ms
    from jsonb_array_elements(v_run.segments) with ordinality as t(s, ord)
    order by ord
  loop
    continue when greatest(v_seg.start_ms, v_from) >= least(v_seg.end_ms, v_to);
    v_work := jsonb_build_array(jsonb_build_array(greatest(v_seg.start_ms, v_from), least(v_seg.end_ms, v_to)));
    for v_cut in select * from jsonb_array_elements(v_cuts) loop
      v_c_from := (v_cut ->> 'from_ms')::numeric::bigint;
      v_c_to := (v_cut ->> 'to_ms')::numeric::bigint;
      v_next := '[]'::jsonb;
      for v_piece in select * from jsonb_array_elements(v_work) loop
        if v_c_to <= (v_piece ->> 0)::bigint or v_c_from >= (v_piece ->> 1)::bigint then
          v_next := v_next || jsonb_build_array(v_piece);
        else
          if v_c_from > (v_piece ->> 0)::bigint then
            v_next := v_next || jsonb_build_array(jsonb_build_array((v_piece ->> 0)::bigint, v_c_from));
          end if;
          if v_c_to < (v_piece ->> 1)::bigint then
            v_next := v_next || jsonb_build_array(jsonb_build_array(v_c_to, (v_piece ->> 1)::bigint));
          end if;
        end if;
      end loop;
      v_work := v_next;
    end loop;
    for v_piece in select p from jsonb_array_elements(v_work) p order by (p ->> 0)::bigint loop
      v_pieces := v_pieces || jsonb_build_array(jsonb_build_object(
        'old', v_seg.idx, 'from', (v_piece ->> 0)::bigint, 'to', (v_piece ->> 1)::bigint, 'new', v_k));
      v_segments := v_segments || jsonb_build_array(jsonb_build_object(
        'index', v_k, 'startAt', (v_piece ->> 0)::bigint, 'endAt', (v_piece ->> 1)::bigint));
      v_k := v_k + 1;
    end loop;
  end loop;
  if v_k = 0 then
    perform private.fail('invalid_input', 'nothing_left');
  end if;

  select coalesce(jsonb_agg(jsonb_build_array(e -> 0, e -> 1, e -> 2, e -> 3, e -> 4, (pc ->> 'new')::integer)
                            order by (e ->> 1)::bigint, (e ->> 0)::bigint), '[]'::jsonb)
    into v_points
  from private.run_routes rr, jsonb_array_elements(rr.points) e, jsonb_array_elements(v_pieces) pc
  where rr.run_id = p_run_id and (e ->> 5)::integer = (pc ->> 'old')::integer
    and (e ->> 1)::bigint between (pc ->> 'from')::bigint and (pc ->> 'to')::bigint;

  perform private.save_original(v_run);
  select array_agg(distinct competition_date) into v_old_dates from private.run_day_allocations where run_id = p_run_id;
  perform private.lock_user_scoring(v_uid);

  update public.runs
     set segments = v_segments,
         started_at = private.ms_to_ts((v_segments -> 0 ->> 'startAt')::bigint),
         ended_at = private.ms_to_ts((v_segments -> (v_k - 1) ->> 'endAt')::bigint),
         activity_type = v_type, edited_at = now(), version = version + 1, updated_at = now()
   where id = p_run_id;
  update private.run_routes
     set points = v_points, point_count = jsonb_array_length(v_points), checksum = private.route_checksum(v_points)
   where run_id = p_run_id;

  v_changes := private.rescore_edited_run(p_run_id, v_old_dates,
                                          v_run.status = 'accepted' and v_run.activity_type = 'run', 'run_edited');
  select * into v_after from public.runs where id = p_run_id;
  if coalesce(v_after.distance_cm, 0) > coalesce(v_run.distance_cm, 0) + 100 then
    perform private.fail('edit_increases_distance');
  end if;
  return private.edit_response(p_run_id, v_changes);
end
$$;

-- Joins a run that was split by accident: the second run's segments follow the first's. The second
-- run is removed (it points at the merged run). Merges can't be undone.
create or replace function public.merge_runs(p_first_run_id uuid, p_second_run_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_a public.runs;
  v_b public.runs;
  v_after public.runs;
  v_count integer;
  v_segments jsonb;
  v_points jsonb;
  v_old_dates date[];
  v_changes jsonb;
begin
  if p_first_run_id = p_second_run_id then
    perform private.fail('invalid_input', 'same_run');
  end if;
  -- Lock in id order so two merges can't deadlock.
  perform 1 from public.runs where id in (p_first_run_id, p_second_run_id) and owner_id = v_uid order by id for update;
  v_a := private.editable_run(v_uid, p_first_run_id, null);
  v_b := private.editable_run(v_uid, p_second_run_id, null);
  if v_b.started_at < v_a.ended_at or v_b.started_at - v_a.ended_at > interval '6 hours' then
    perform private.fail('invalid_input', 'not_consecutive');
  end if;
  if v_a.activity_type <> v_b.activity_type then
    perform private.fail('invalid_input', 'activity_type');
  end if;

  v_count := jsonb_array_length(v_a.segments);
  v_segments := v_a.segments || coalesce((
    select jsonb_agg(jsonb_build_object('index', (s ->> 'index')::integer + v_count,
                                        'startAt', (s ->> 'startAt')::bigint, 'endAt', (s ->> 'endAt')::bigint) order by ord)
    from jsonb_array_elements(v_b.segments) with ordinality as t(s, ord)), '[]'::jsonb);
  select coalesce(jsonb_agg(p order by (p ->> 1)::bigint, k, (p ->> 0)::bigint), '[]'::jsonb) into v_points
  from (
    select e as p, 0 as k from private.run_routes rr, jsonb_array_elements(rr.points) e where rr.run_id = v_a.id
    union all
    select jsonb_build_array(e -> 0, e -> 1, e -> 2, e -> 3, e -> 4, (e ->> 5)::integer + v_count), 1
    from private.run_routes rr, jsonb_array_elements(rr.points) e where rr.run_id = v_b.id
  ) x;

  perform private.save_original(v_a);
  perform private.save_original(v_b);
  select array_agg(distinct competition_date) into v_old_dates
  from private.run_day_allocations where run_id in (v_a.id, v_b.id);
  perform private.lock_user_scoring(v_uid);

  -- The second run becomes a tombstone that points at the merged run.
  delete from private.run_day_allocations where run_id = v_b.id;
  delete from private.run_routes where run_id = v_b.id;
  update public.runs
     set deleted_at = now(), merged_into = v_a.id, title = '', segments = '[]'::jsonb, started_at = now(), ended_at = now(),
         client_distance_m = 0, client_active_ms = 0, distance_cm = null, active_ms = null, coverage = null,
         diagnostics = null, xp_award = null, reason_codes = '{}', scoring_state = 'none', notes = null,
         version = version + 1, updated_at = now()
   where id = v_b.id;

  update public.runs
     set segments = v_segments, ended_at = v_b.ended_at,
         client_distance_m = v_a.client_distance_m + v_b.client_distance_m,
         client_active_ms = v_a.client_active_ms + v_b.client_active_ms,
         notes = coalesce(v_a.notes, v_b.notes), edited_at = now(), version = version + 1, updated_at = now(),
         -- The merged run was fully received when its second part was.
         first_received_at = greatest(v_a.first_received_at, v_b.first_received_at)
   where id = v_a.id;
  update private.run_routes
     set points = v_points, point_count = jsonb_array_length(v_points), checksum = private.route_checksum(v_points)
   where run_id = v_a.id;

  v_changes := private.rescore_edited_run(v_a.id, v_old_dates,
    v_a.status = 'accepted' and v_b.status = 'accepted' and v_a.activity_type = 'run', 'runs_merged');
  select * into v_after from public.runs where id = v_a.id;
  if coalesce(v_after.distance_cm, 0) > coalesce(v_a.distance_cm, 0) + coalesce(v_b.distance_cm, 0) + 100 then
    perform private.fail('edit_increases_distance');
  end if;
  return private.edit_response(v_a.id, v_changes) || jsonb_build_object('removed_run_id', v_b.id);
end
$$;

-- Restores a run to how it was first saved (not after a merge).
create or replace function public.undo_run_edits(p_run_id uuid, p_expected_version integer default null)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_run public.runs;
  v_original private.run_originals;
  v_old_dates date[];
  v_changes jsonb;
begin
  v_run := private.editable_run(v_uid, p_run_id, p_expected_version);
  select * into v_original from private.run_originals where run_id = p_run_id;
  if not found then
    perform private.fail('not_found', 'original');
  end if;
  if exists (select 1 from public.runs where merged_into = p_run_id) then
    perform private.fail('cannot_undo_merge');
  end if;
  select array_agg(distinct competition_date) into v_old_dates from private.run_day_allocations where run_id = p_run_id;
  perform private.lock_user_scoring(v_uid);
  update public.runs
     set segments = v_original.segments, started_at = v_original.started_at, ended_at = v_original.ended_at,
         activity_type = v_original.activity_type, edited_at = null, version = version + 1, updated_at = now()
   where id = p_run_id;
  update private.run_routes
     set points = v_original.points, point_count = v_original.point_count, checksum = v_original.checksum
   where run_id = p_run_id;
  delete from private.run_originals where run_id = p_run_id;
  v_changes := private.rescore_edited_run(p_run_id, v_old_dates,
                                          v_original.status = 'accepted' and v_original.activity_type = 'run', 'run_edit_undone');
  return private.edit_response(p_run_id, v_changes);
end
$$;

select private.apply_function_grants();
