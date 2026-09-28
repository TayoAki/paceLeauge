-- Every run counts (docs/ROADMAP.md Phase 2 and Part A): runs from more places than the phone's GPS,
-- with where each came from, and one run however many devices recorded it.
--
-- Sources:
--   phone_gps      recorded by this app on the phone (V1)
--   watch          recorded by the PaceLeague Apple Watch app (2.2); validated like phone runs
--   health_import  a workout read from Apple Health (2.1); validated from its route, if it has one
--   garmin         a Garmin activity from the data aggregator (2.4); validated from its GPS samples
--   file_import    a GPX, FIT or TCX file (2.4); a file can be edited, so history only
--   indoor         a treadmill or indoor run (2.5); no GPS to check, so history only for now
-- A run without a route, one typed in by hand, an indoor run and a file import can't be checked by
-- the validator, so they are personal history: they never earn league XP, but they count for the
-- runner's own weekly goal and streak.
--
-- Duplicates (Part A, principle 3): when two runs overlap in time for most of the shorter one, the
-- one with the better GPS record is kept and the other becomes a 'duplicate' of it. A duplicate
-- earns nothing and is hidden from history; deleting the kept run brings its duplicate back.

-- ---------------------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------------------
alter table public.runs drop constraint runs_source_check;
alter table public.runs add constraint runs_source_check
  check (source in ('phone_gps', 'watch', 'health_import', 'file_import', 'garmin', 'indoor'));

alter table public.runs drop constraint runs_status_check;
alter table public.runs add constraint runs_status_check
  check (status in ('uploading', 'accepted', 'personal_only', 'review', 'duplicate'));

alter table public.runs
  -- The app or device that recorded an imported run, as the source reported it.
  add column source_app text check (source_app is null or char_length(source_app) between 1 and 100),
  add column source_device text check (source_device is null or char_length(source_device) between 1 and 100),
  -- Typed in by hand (for example Apple Health's "was user entered").
  add column manual_entry boolean not null default false,
  -- The source's own id (Apple Health workout UUID, Garmin activity id, file checksum).
  add column external_id text check (external_id is null or char_length(external_id) between 1 and 200),
  -- Distance the source reported, for runs the validator can't measure (no route, indoor, typed in).
  add column claimed_distance_m double precision
    check (claimed_distance_m is null or claimed_distance_m between 0 and 1000000),
  add column avg_heart_rate smallint check (avg_heart_rate is null or avg_heart_rate between 25 and 250),
  add column max_heart_rate smallint check (max_heart_rate is null or max_heart_rate between 25 and 250),
  add column steps integer check (steps is null or steps between 0 and 1000000),
  add column duplicate_of uuid references public.runs (id) on delete set null,
  -- What a duplicate was before it was set aside (status, reasons), for when it is brought back.
  add column duplicate_state jsonb;

create unique index runs_external_key on public.runs (owner_id, source, external_id)
  where external_id is not null and deleted_at is null;
create index runs_duplicate_of_idx on public.runs (duplicate_of) where duplicate_of is not null;
create index runs_owner_time_idx on public.runs (owner_id, started_at, ended_at) where deleted_at is null;

alter table private.xp_ledger drop constraint xp_ledger_cause_kind_check;
alter table private.xp_ledger add constraint xp_ledger_cause_kind_check
  check (cause_kind in ('run_accepted', 'run_deleted', 'run_review_resolved', 'recompute',
                        'run_edited', 'runs_merged', 'run_edit_undone', 'run_duplicate', 'run_restored'));

-- ---------------------------------------------------------------------------------------
-- What a run's source allows
-- ---------------------------------------------------------------------------------------
-- The outcome for a run given its source and the validator's result:
-- {outcome, reasons, distance_cm, active_ms, coverage, history}. `history` means the run counts
-- for goals from its claimed distance but can never score.
create or replace function private.source_outcome(p_run public.runs, p_validation jsonb)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_claimed_cm bigint := round(coalesce(p_run.claimed_distance_m, p_run.client_distance_m) * 100)::bigint;
  v_reason text;
begin
  v_reason := case
    when p_run.manual_entry then 'manual_entry'
    when p_run.source = 'indoor' then 'indoor'
    when p_run.expected_points = 0 and p_run.source <> 'phone_gps' then 'no_route'
  end;
  if v_reason is not null then
    return jsonb_build_object('outcome', 'personal_only', 'reasons', jsonb_build_array(v_reason),
                              'distance_cm', v_claimed_cm, 'active_ms', p_run.client_active_ms,
                              'coverage', null, 'history', true);
  end if;
  if p_run.source = 'file_import' then
    -- Measured from the file's points, but a file can be edited, so it never scores.
    return jsonb_build_object('outcome', 'personal_only', 'reasons', jsonb_build_array('file_import'),
                              'distance_cm', (p_validation ->> 'distance_cm')::bigint,
                              'active_ms', (p_validation ->> 'active_ms')::bigint,
                              'coverage', p_validation -> 'coverage', 'history', false);
  end if;
  return jsonb_build_object('outcome', p_validation ->> 'outcome', 'reasons', p_validation -> 'reasons',
                            'distance_cm', (p_validation ->> 'distance_cm')::bigint,
                            'active_ms', (p_validation ->> 'active_ms')::bigint,
                            'coverage', p_validation -> 'coverage', 'history', false);
end
$$;

-- Writes a run's day allocations: the validator's per segment, or for a run it can't measure,
-- its claimed distance and time on the day it started (used for goals, never for XP).
create or replace function private.write_allocations(p_run public.runs, p_validation jsonb, p_outcome jsonb)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  delete from private.run_day_allocations where run_id = p_run.id;
  if coalesce((p_outcome ->> 'history')::boolean, false) then
    if coalesce((p_outcome ->> 'distance_cm')::bigint, 0) > 0 or p_run.client_active_ms > 0 then
      insert into private.run_day_allocations (run_id, owner_id, segment_index, competition_date, segment_start_at, distance_cm, active_ms)
      values (p_run.id, p_run.owner_id, 0, private.competition_date(p_run.started_at), p_run.started_at,
              coalesce((p_outcome ->> 'distance_cm')::bigint, 0), p_run.client_active_ms);
    end if;
    return;
  end if;
  insert into private.run_day_allocations (run_id, owner_id, segment_index, competition_date, segment_start_at, distance_cm, active_ms)
  select p_run.id, p_run.owner_id, (a ->> 'segment_index')::integer, (a ->> 'competition_date')::date,
         private.ms_to_ts((a ->> 'segment_start_ms')::bigint), (a ->> 'distance_cm')::bigint, (a ->> 'active_ms')::bigint
  from jsonb_array_elements(p_validation -> 'allocations') a;
end
$$;

-- Runs that count toward the weekly goal and streak: accepted runs, runs held only for arriving
-- late, and history the validator couldn't check (no route, indoor, typed in, a file). Runs that
-- failed a check still don't count.
create or replace function private.streak_counts_run(r public.runs)
returns boolean
language sql immutable
as $$
  select r.activity_type = 'run' and r.deleted_at is null
     and (r.status = 'accepted'
          or (r.status = 'review' and r.reason_codes = array['late_upload']::text[])
          or (r.status = 'personal_only' and cardinality(r.reason_codes) > 0
              and r.reason_codes <@ array['no_route', 'indoor', 'manual_entry', 'file_import']::text[]))
$$;

-- ---------------------------------------------------------------------------------------
-- Duplicates
-- ---------------------------------------------------------------------------------------
-- Which of two copies of one run to keep: a checked route over none, then better coverage, then a
-- better outcome, then a source we can trust more, then the one that arrived first.
create or replace function private.duplicate_rank(r public.runs)
returns numeric[]
language sql stable
as $$
  select array[
    case when r.coverage is not null and not r.manual_entry and r.source not in ('indoor', 'file_import') then 1 else 0 end,
    coalesce(r.coverage, 0),
    case r.status when 'accepted' then 3 when 'review' then 2 when 'personal_only' then 1 else 0 end,
    case r.source when 'phone_gps' then 3 when 'watch' then 3 when 'garmin' then 2 when 'health_import' then 2 else 1 end,
    -extract(epoch from r.first_received_at)
  ]::numeric[]
$$;

-- True when the two runs overlap for at least half of the shorter one.
create or replace function private.runs_overlap(a public.runs, b public.runs)
returns boolean
language sql immutable
as $$
  select a.started_at < b.ended_at and b.started_at < a.ended_at
     and extract(epoch from (least(a.ended_at, b.ended_at) - greatest(a.started_at, b.started_at)))
         >= 0.5 * greatest(1, least(extract(epoch from (a.ended_at - a.started_at)), extract(epoch from (b.ended_at - b.started_at))))
$$;

-- Sets a run aside as a duplicate of the kept one: it stops counting anywhere. Caller holds
-- private.lock_user_scoring(owner).
create or replace function private.demote_duplicate(p_run_id uuid, p_kept_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_run public.runs;
  v_dates date[];
  v_changes jsonb;
begin
  select * into v_run from public.runs where id = p_run_id for update;
  select array_agg(distinct competition_date) into v_dates from private.run_day_allocations where run_id = p_run_id;
  delete from private.run_day_allocations where run_id = p_run_id;
  update public.runs
     set duplicate_of = p_kept_id,
         duplicate_state = jsonb_build_object('status', v_run.status, 'reasons', to_jsonb(v_run.reason_codes)),
         status = 'duplicate', scoring_state = 'none', xp_award = null,
         version = version + 1, updated_at = now()
   where id = p_run_id;
  v_changes := private.recompute_daily_scores(v_run.owner_id, v_dates, 'run_duplicate', p_run_id);
  perform private.record_league_revisions(v_run.owner_id, v_dates, 'run_duplicate');
  return v_changes;
end
$$;

-- After a run is finalized: if another run covers the same time, keep the better one. Returns the
-- id of the run this one duplicates, or null when it is kept. Caller holds the scoring lock.
create or replace function private.resolve_duplicates(p_run_id uuid)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_run public.runs;
  v_other public.runs;
begin
  select * into v_run from public.runs where id = p_run_id;
  if v_run.status not in ('accepted', 'review', 'personal_only') then
    return null;
  end if;
  for v_other in
    select o.* from public.runs o
    where o.owner_id = v_run.owner_id and o.id <> v_run.id and o.deleted_at is null
      and o.status in ('accepted', 'review', 'personal_only')
      and o.started_at < v_run.ended_at and o.ended_at > v_run.started_at
      and private.runs_overlap(o, v_run)
    order by private.duplicate_rank(o) desc
  loop
    if private.duplicate_rank(v_other) >= private.duplicate_rank(v_run) then
      perform private.demote_duplicate(v_run.id, v_other.id);
      return v_other.id;
    end if;
    perform private.demote_duplicate(v_other.id, v_run.id);
  end loop;
  return null;
end
$$;

-- ---------------------------------------------------------------------------------------
-- Upload: sources and provenance
-- ---------------------------------------------------------------------------------------
drop function public.start_run_upload(uuid, bigint, bigint, jsonb, double precision, bigint, integer, integer, text, boolean, text);

create or replace function public.start_run_upload(
  p_client_run_id uuid,
  p_started_at_ms bigint,
  p_ended_at_ms bigint,
  p_segments jsonb,
  p_client_distance_m double precision,
  p_client_active_ms bigint,
  p_expected_points integer,
  p_expected_chunks integer,
  p_title text,
  p_interrupted boolean default false,
  p_source text default 'phone_gps',
  p_activity_type text default null,
  p_source_app text default null,
  p_source_device text default null,
  p_manual_entry boolean default false,
  p_external_id text default null,
  p_claimed_distance_m double precision default null,
  p_avg_heart_rate integer default null,
  p_max_heart_rate integer default null,
  p_steps integer default null
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_run public.runs;
  v_title text := left(private.normalize_name(p_title), 60);
  v_segments jsonb;
  v_hash text;
  v_now_ms bigint := private.ts_to_ms(now());
  v_type text := coalesce(p_activity_type, 'run');
  v_app text := nullif(left(btrim(coalesce(p_source_app, '')), 100), '');
  v_device text := nullif(left(btrim(coalesce(p_source_device, '')), 100), '');
  v_external text := nullif(btrim(coalesce(p_external_id, '')), '');
begin
  if p_client_run_id is null or p_started_at_ms is null or p_ended_at_ms is null
     or p_client_distance_m is null or p_client_active_ms is null or p_expected_points is null
     or p_expected_chunks is null
     or p_source is null or p_source not in ('phone_gps', 'watch', 'health_import', 'file_import', 'garmin', 'indoor') then
    perform private.fail('invalid_input');
  end if;
  if v_type not in ('run', 'walk', 'hike', 'ride', 'other') then
    perform private.fail('invalid_input', 'activity_type');
  end if;
  if (v_external is not null and char_length(v_external) > 200)
     or (p_claimed_distance_m is not null and (p_claimed_distance_m < 0 or p_claimed_distance_m > 1000000))
     or (p_avg_heart_rate is not null and p_avg_heart_rate not between 25 and 250)
     or (p_max_heart_rate is not null and p_max_heart_rate not between 25 and 250)
     or (p_steps is not null and p_steps not between 0 and 1000000) then
    perform private.fail('invalid_input', 'provenance');
  end if;
  if p_started_at_ms < 1704067200000 or p_ended_at_ms > v_now_ms + 30 * 86400000::bigint
     or p_ended_at_ms < p_started_at_ms then
    perform private.fail('invalid_input', 'timestamps');
  end if;
  if p_expected_points not between 0 and 50000
     or p_expected_chunks <> ceil(p_expected_points / 500.0)::integer
     or p_client_distance_m < 0 or p_client_distance_m > 1000000 or p_client_active_ms < 0 then
    perform private.fail('invalid_input', 'summary');
  end if;
  if jsonb_typeof(p_segments) is distinct from 'array' or jsonb_array_length(p_segments) not between 1 and 1000
     or exists (
       select 1 from jsonb_array_elements(p_segments) s
       where jsonb_typeof(s) <> 'object'
          or jsonb_typeof(s -> 'index') <> 'number' or jsonb_typeof(s -> 'startAt') <> 'number'
          or jsonb_typeof(s -> 'endAt') <> 'number'
          or (s ->> 'index')::numeric <> trunc((s ->> 'index')::numeric)
          or (s ->> 'startAt')::numeric <> trunc((s ->> 'startAt')::numeric)
          or (s ->> 'endAt')::numeric <> trunc((s ->> 'endAt')::numeric)
          or abs((s ->> 'startAt')::numeric) > 99999999999999 or abs((s ->> 'endAt')::numeric) > 99999999999999
     ) then
    perform private.fail('invalid_input', 'segments');
  end if;
  if v_title = '' then
    v_title := 'Run';
  end if;

  select jsonb_agg(jsonb_build_object('index', (s ->> 'index')::bigint, 'startAt', (s ->> 'startAt')::bigint,
                                      'endAt', (s ->> 'endAt')::bigint) order by ord)
    into v_segments
  from jsonb_array_elements(p_segments) with ordinality as t(s, ord);

  -- Provenance is part of the request: a retry must describe the same run. Fields added after V1
  -- only join the hash when set, so V1 clients' retries keep matching.
  v_hash := encode(sha256(convert_to(concat_ws('|', p_client_run_id, p_started_at_ms, p_ended_at_ms, v_segments::text,
    p_client_distance_m, p_client_active_ms, p_expected_points, p_expected_chunks, v_title, coalesce(p_interrupted, false),
    p_source,
    case when p_activity_type is not null or v_app is not null or v_device is not null or coalesce(p_manual_entry, false)
              or v_external is not null or p_claimed_distance_m is not null or p_avg_heart_rate is not null
              or p_max_heart_rate is not null or p_steps is not null
         then concat_ws('|', v_type, v_app, v_device, coalesce(p_manual_entry, false), v_external, p_claimed_distance_m,
                        p_avg_heart_rate, p_max_heart_rate, p_steps) end), 'UTF8')), 'hex');

  select * into v_run from public.runs where owner_id = v_uid and client_run_id = p_client_run_id;
  if found then
    if v_run.deleted_at is null and v_run.request_hash <> v_hash then
      perform private.fail('idempotency_conflict');
    end if;
    return private.upload_state(v_run);
  end if;
  -- The same workout arriving under a different id (for example from two devices) is the same run.
  if v_external is not null then
    select * into v_run from public.runs
    where owner_id = v_uid and source = p_source and external_id = v_external and deleted_at is null;
    if found then
      return private.upload_state(v_run);
    end if;
  end if;

  perform private.check_rate_limit('run_upload:' || v_uid, 60, interval '1 hour');

  insert into public.runs (owner_id, client_run_id, request_hash, source, title, started_at, ended_at, segments,
                           client_distance_m, client_active_ms, expected_points, expected_chunks, interrupted,
                           activity_type, source_app, source_device, manual_entry, external_id, claimed_distance_m,
                           avg_heart_rate, max_heart_rate, steps)
  values (v_uid, p_client_run_id, v_hash, p_source, v_title, private.ms_to_ts(p_started_at_ms), private.ms_to_ts(p_ended_at_ms),
          v_segments, p_client_distance_m, p_client_active_ms, p_expected_points, p_expected_chunks, coalesce(p_interrupted, false),
          v_type, v_app, v_device, coalesce(p_manual_entry, false), v_external, p_claimed_distance_m,
          p_avg_heart_rate, p_max_heart_rate, p_steps)
  on conflict do nothing
  returning * into v_run;

  if v_run.id is null then
    -- A concurrent request created it first; answer as a retry would.
    select * into v_run from public.runs where owner_id = v_uid and client_run_id = p_client_run_id;
    if not found and v_external is not null then
      select * into v_run from public.runs
      where owner_id = v_uid and source = p_source and external_id = v_external and deleted_at is null;
    end if;
    if v_run.deleted_at is null and v_run.client_run_id = p_client_run_id and v_run.request_hash <> v_hash then
      perform private.fail('idempotency_conflict');
    end if;
  end if;
  return private.upload_state(v_run);
end
$$;

-- ---------------------------------------------------------------------------------------
-- Finalize: source rules, then duplicates, then scoring
-- ---------------------------------------------------------------------------------------
create or replace function public.finalize_run(p_run_id uuid, p_expected_version integer, p_manifest jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_run public.runs;
  v_missing integer[];
  v_points integer;
  v_validation jsonb;
  v_outcome jsonb;
  v_scoring text;
  v_kept uuid;
begin
  select * into v_run from public.runs where id = p_run_id and owner_id = v_uid for update;
  if not found or v_run.deleted_at is not null then
    perform private.fail('not_found');
  end if;
  if v_run.status <> 'uploading' then
    return private.finalize_response(v_run);
  end if;
  if p_expected_version is distinct from v_run.version then
    perform private.fail('version_conflict');
  end if;

  select array_agg(g order by g) into v_missing
  from generate_series(0, v_run.expected_chunks - 1) g
  where not exists (select 1 from private.route_chunks c where c.run_id = p_run_id and c.seq = g);
  if v_missing is not null then
    perform private.fail('upload_incomplete', array_to_string(v_missing, ','));
  end if;
  if jsonb_typeof(p_manifest) is distinct from 'array' or jsonb_array_length(p_manifest) <> v_run.expected_chunks
     or exists (
       select 1 from jsonb_array_elements(p_manifest) m
       left join private.route_chunks c on c.run_id = p_run_id
        and c.seq = case when jsonb_typeof(m -> 'seq') = 'number' then (m ->> 'seq')::numeric::integer end
       where c.checksum is distinct from (m ->> 'checksum')
     ) then
    perform private.fail('manifest_mismatch');
  end if;
  select coalesce(sum(point_count), 0)::integer into v_points from private.route_chunks where run_id = p_run_id;
  if v_points <> v_run.expected_points then
    perform private.fail('manifest_mismatch', 'points');
  end if;

  v_validation := private.validate_run(p_run_id, v_run.first_received_at);
  v_outcome := private.source_outcome(v_run, v_validation);

  -- Consolidate the private route; staged chunks are removed and the route is immutable.
  insert into private.run_routes (run_id, owner_id, points, point_count, checksum)
  values (
    p_run_id, v_uid,
    coalesce((select jsonb_agg(e order by (e ->> 1)::bigint, (e ->> 0)::bigint)
              from private.route_chunks c, jsonb_array_elements(c.points) e where c.run_id = p_run_id), '[]'::jsonb),
    v_points,
    encode(sha256(convert_to(coalesce((select string_agg(checksum, ',' order by seq) from private.route_chunks
                                       where run_id = p_run_id), ''), 'UTF8')), 'hex'));
  delete from private.route_chunks where run_id = p_run_id;

  perform private.write_allocations(v_run, v_validation, v_outcome);

  v_scoring := case when v_outcome ->> 'outcome' = 'accepted' and v_run.activity_type = 'run' then 'pending' else 'none' end;
  update public.runs
     set status = v_outcome ->> 'outcome',
         reason_codes = array(select jsonb_array_elements_text(v_outcome -> 'reasons')),
         distance_cm = (v_outcome ->> 'distance_cm')::bigint,
         active_ms = (v_outcome ->> 'active_ms')::bigint,
         coverage = round((v_outcome ->> 'coverage')::numeric, 5),
         diagnostics = v_validation -> 'diagnostics',
         validator_version = (v_validation ->> 'validator_version')::smallint,
         rule_version = 1,
         scoring_state = v_scoring,
         finalized_at = now(),
         version = version + 1,
         updated_at = now()
   where id = p_run_id;

  perform private.lock_user_scoring(v_uid);
  v_kept := private.resolve_duplicates(p_run_id);

  if v_kept is null and v_scoring = 'pending' and private.flag_enabled('competition_enabled') then
    perform private.apply_run_scoring(p_run_id);
  end if;

  select * into v_run from public.runs where id = p_run_id;
  perform private.log_server_event('run_sync_outcome', v_uid,
    jsonb_build_object('outcome', v_run.status, 'reason', coalesce(v_run.reason_codes[1], 'none')));
  return private.finalize_response(v_run);
end
$$;

-- Edits re-validate under the same source rules (a fixed file import is still history).
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
  v_result jsonb;
  v_outcome text;
  v_reasons text[];
  v_scoring text;
  v_dates date[];
  v_changes jsonb;
begin
  select * into v_run from public.runs where id = p_run_id;
  v_validation := private.validate_run(p_run_id, v_run.first_received_at);
  v_result := private.source_outcome(v_run, v_validation);
  perform private.write_allocations(v_run, v_validation, v_result);

  v_outcome := v_result ->> 'outcome';
  v_reasons := array(select jsonb_array_elements_text(v_result -> 'reasons'));
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
         distance_cm = (v_result ->> 'distance_cm')::bigint,
         active_ms = (v_result ->> 'active_ms')::bigint,
         coverage = round((v_result ->> 'coverage')::numeric, 5),
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

-- Deleting a run brings back any duplicate that was set aside for it.
create or replace function public.delete_run(p_run_id uuid, p_expected_version integer default null)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_run public.runs;
  v_dates date[];
  v_changes jsonb;
  v_dup public.runs;
begin
  select * into v_run from public.runs where id = p_run_id and owner_id = v_uid for update;
  if not found then
    perform private.fail('not_found');
  end if;
  if v_run.deleted_at is not null then
    return jsonb_build_object('run_id', p_run_id, 'deleted', true, 'xp_changes', '[]'::jsonb,
                              'lifetime_xp', private.lifetime_xp(v_uid));
  end if;
  if p_expected_version is not null and p_expected_version <> v_run.version then
    perform private.fail('version_conflict');
  end if;

  perform private.lock_user_scoring(v_uid);
  select array_agg(distinct competition_date) into v_dates from private.run_day_allocations where run_id = p_run_id;
  delete from private.run_day_allocations where run_id = p_run_id;
  delete from private.run_routes where run_id = p_run_id;
  delete from private.route_chunks where run_id = p_run_id;
  -- Keep a minimal tombstone so a late retry of the same upload cannot resurrect the run.
  update public.runs
     set deleted_at = now(), title = '', segments = '[]'::jsonb, started_at = now(), ended_at = now(),
         client_distance_m = 0, client_active_ms = 0, distance_cm = null, active_ms = null, coverage = null,
         diagnostics = null, xp_award = null, reason_codes = '{}', scoring_state = 'none',
         notes = null, shoe_id = null, source_app = null, source_device = null, claimed_distance_m = null,
         avg_heart_rate = null, max_heart_rate = null, steps = null, duplicate_state = null,
         version = version + 1, updated_at = now()
   where id = p_run_id;

  v_changes := private.recompute_daily_scores(v_uid, v_dates, 'run_deleted', p_run_id);
  perform private.record_league_revisions(v_uid, v_dates, 'run_deleted');

  for v_dup in select * from public.runs where duplicate_of = p_run_id and deleted_at is null for update loop
    update public.runs set duplicate_of = null, duplicate_state = null, status = 'personal_only',
                           version = version + 1, updated_at = now()
     where id = v_dup.id;
    -- Allowed to score again only if it was eligible before it was set aside.
    v_changes := coalesce(v_changes, '[]'::jsonb) || coalesce(private.rescore_edited_run(
      v_dup.id, '{}'::date[], coalesce(v_dup.duplicate_state ->> 'status', '') in ('accepted', 'review'), 'run_restored'), '[]'::jsonb);
    perform private.resolve_duplicates(v_dup.id);
  end loop;

  return jsonb_build_object('run_id', p_run_id, 'deleted', true, 'xp_changes', v_changes,
                            'lifetime_xp', private.lifetime_xp(v_uid));
end
$$;

-- ---------------------------------------------------------------------------------------
-- Reads: provenance in run_json; duplicates stay out of history
-- ---------------------------------------------------------------------------------------
create or replace function private.run_json(r public.runs)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'id', r.id,
    'client_run_id', r.client_run_id,
    'title', r.title,
    'started_at_ms', private.ts_to_ms(r.started_at),
    'ended_at_ms', private.ts_to_ms(r.ended_at),
    'active_ms', coalesce(r.active_ms, r.client_active_ms),
    'distance_m', coalesce(r.distance_cm / 100.0, r.client_distance_m::numeric),
    'status', r.status,
    'reason_codes', to_jsonb(r.reason_codes),
    'coverage', r.coverage,
    'interrupted', r.interrupted,
    'scoring_state', r.scoring_state,
    'xp_award', r.xp_award,
    'version', r.version,
    'validator_version', r.validator_version,
    'rule_version', r.rule_version,
    'finalized_at_ms', private.ts_to_ms(r.finalized_at),
    'activity_type', r.activity_type,
    'source', r.source,
    'notes', r.notes,
    'shoe_id', r.shoe_id,
    'edited_at_ms', case when r.edited_at is null then null else private.ts_to_ms(r.edited_at) end,
    'source_app', r.source_app,
    'source_device', r.source_device,
    'manual_entry', r.manual_entry,
    'avg_heart_rate', r.avg_heart_rate,
    'max_heart_rate', r.max_heart_rate,
    'steps', r.steps,
    'duplicate_of', r.duplicate_of
  )
$$;

create or replace function public.list_my_runs(
  p_before_started_at_ms bigint default null,
  p_before_id uuid default null,
  p_limit integer default 20
)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_page jsonb;
  v_count integer;
  v_last jsonb;
begin
  select coalesce(jsonb_agg(private.run_json(r) order by r.started_at desc, r.id desc), '[]'::jsonb), count(*)
    into v_page, v_count
  from (
    select * from public.runs r
    where r.owner_id = v_uid and r.deleted_at is null and r.status not in ('uploading', 'duplicate')
      and (p_before_started_at_ms is null
           or (r.started_at, r.id) < (private.ms_to_ts(p_before_started_at_ms),
                                      coalesce(p_before_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)))
    order by r.started_at desc, r.id desc
    limit v_limit + 1
  ) r;

  if v_count > v_limit then
    v_page := v_page - v_limit;
    v_last := v_page -> (v_limit - 1);
    return jsonb_build_object('runs', v_page, 'next_cursor',
      jsonb_build_object('before_started_at_ms', (v_last ->> 'started_at_ms')::bigint, 'before_id', v_last ->> 'id'));
  end if;
  return jsonb_build_object('runs', v_page, 'next_cursor', null);
end
$$;

create or replace function public.list_my_runs_between(p_from_ms bigint, p_to_ms bigint, p_activity text default null)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
begin
  if p_from_ms is null or p_to_ms is null or p_to_ms <= p_from_ms or p_to_ms - p_from_ms > 400::bigint * 86400000 then
    perform private.fail('invalid_input', 'range');
  end if;
  if p_activity is not null and p_activity not in ('run', 'walk', 'hike', 'ride', 'other') then
    perform private.fail('invalid_input', 'activity');
  end if;
  return coalesce((
    select jsonb_agg(private.run_json(r) order by r.started_at desc, r.id desc)
    from (select * from public.runs r
          where r.owner_id = v_uid and r.deleted_at is null and r.status not in ('uploading', 'duplicate')
            and r.started_at >= private.ms_to_ts(p_from_ms) and r.started_at < private.ms_to_ts(p_to_ms)
            and (p_activity is null or r.activity_type = p_activity)
          order by r.started_at desc, r.id desc
          limit 500) r), '[]'::jsonb);
end
$$;

create or replace function private.shoe_json(s private.shoes)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'id', s.id,
    'name', s.name,
    'limit_km', s.limit_km,
    'is_default', s.is_default,
    'retired', s.retired_at is not null,
    'created_at_ms', private.ts_to_ms(s.created_at),
    'runs', (select count(*) from public.runs r
             where r.shoe_id = s.id and r.deleted_at is null and r.status not in ('uploading', 'duplicate')),
    'distance_m', coalesce((select sum(coalesce(r.distance_cm / 100.0, r.client_distance_m::numeric))
                            from public.runs r
                            where r.shoe_id = s.id and r.deleted_at is null and r.status not in ('uploading', 'duplicate')), 0)
  )
$$;

-- Duplicates of a run, so the app can say "also recorded on …".
create or replace function public.list_run_duplicates(p_run_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
begin
  if not exists (select 1 from public.runs where id = p_run_id and owner_id = v_uid and deleted_at is null) then
    perform private.fail('not_found');
  end if;
  return coalesce((select jsonb_agg(private.run_json(r) order by r.first_received_at)
                   from public.runs r
                   where r.owner_id = v_uid and r.duplicate_of = p_run_id and r.deleted_at is null), '[]'::jsonb);
end
$$;

-- ---------------------------------------------------------------------------------------
-- Diagnostics for support (2.6): a small, location-free report the runner chooses to send.
-- ---------------------------------------------------------------------------------------
create table private.diagnostic_reports (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  report jsonb not null check (octet_length(report::text) <= 32768),
  created_at timestamptz not null default now()
);
create index diagnostic_reports_user_idx on private.diagnostic_reports (user_id, created_at desc);

create or replace function public.submit_diagnostics(p_report jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_id bigint;
begin
  if jsonb_typeof(p_report) is distinct from 'object' or octet_length(p_report::text) > 32768 then
    perform private.fail('invalid_input', 'report');
  end if;
  perform private.check_rate_limit('diagnostics:' || v_uid, 5, interval '1 day');
  delete from private.diagnostic_reports where user_id = v_uid and created_at < now() - interval '30 days';
  insert into private.diagnostic_reports (user_id, report) values (v_uid, p_report) returning id into v_id;
  return jsonb_build_object('report_id', v_id);
end
$$;

create or replace function private.purge_diagnostics()
returns integer
language sql security definer set search_path = ''
as $$
  with gone as (delete from private.diagnostic_reports where created_at < now() - interval '30 days' returning 1)
  select count(*)::integer from gone
$$;

select private.apply_function_grants();
