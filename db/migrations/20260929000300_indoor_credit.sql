-- Indoor league credit (docs/ROADMAP.md 2.5). GPS can't check an indoor run, so:
--   * an indoor run recorded on a watch, with heart rate and steps that look like running (pace,
--     cadence, stride and effort all plausible), earns league XP, but only for up to 5 km a day;
--   * one that doesn't look like running is kept as history ('indoor_unverified');
--   * an indoor run from the phone, or a typed-in one, never earns XP (history, as before).
-- History runs count for the weekly goal and streak either way.

alter table public.runs add column indoor boolean not null default false;
update public.runs set indoor = true where source = 'indoor';

-- The most indoor distance one day can credit.
create or replace function private.indoor_daily_cap_cm()
returns bigint
language sql immutable parallel safe
as $$
  select 500000::bigint
$$;

-- A day's credited distance: outdoor distance in full, indoor distance up to the cap.
create or replace function private.credited_distance_cm(p_outdoor_cm bigint, p_indoor_cm bigint)
returns bigint
language sql immutable parallel safe
as $$
  select coalesce(p_outdoor_cm, 0) + least(coalesce(p_indoor_cm, 0), private.indoor_daily_cap_cm())
$$;

-- The checks an indoor run fails (empty when it looks like running). CASE keeps each division
-- behind its guard.
create or replace function private.indoor_checks(r public.runs)
returns text[]
language sql immutable
as $$
  with m as (
    select coalesce(r.claimed_distance_m, r.client_distance_m) as distance_m,
           r.client_active_ms / 1000.0 as active_s
  )
  select array_remove(array[
    case when r.activity_type <> 'run' then 'not_a_run' end,
    case when r.avg_heart_rate is null or r.avg_heart_rate not between 100 and 210
              or (r.max_heart_rate is not null and r.max_heart_rate < r.avg_heart_rate) then 'heart_rate' end,
    case when r.steps is null or m.active_s < 60 then 'cadence'
         when r.steps / (m.active_s / 60.0) not between 140 and 220 then 'cadence' end,
    case when r.steps is null or r.steps = 0 then 'stride'
         when m.distance_m / r.steps not between 0.5 and 2.0 then 'stride' end,
    case when m.active_s < 60 or m.distance_m < 100 then 'pace'
         when m.distance_m / m.active_s not between 1.8 and 6.5 then 'pace' end
  ]::text[], null)
  from m
$$;

-- The outcome for a run given its source and the validator's result:
-- {outcome, reasons, distance_cm, active_ms, coverage, history, claimed}. `history` means the run
-- can never score; `claimed` means its distance is the one the source reported, allocated to the
-- day it started.
create or replace function private.source_outcome(p_run public.runs, p_validation jsonb)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_claimed_cm bigint := round(coalesce(p_run.claimed_distance_m, p_run.client_distance_m) * 100)::bigint;
  v_reason text;
  v_timing text[];
begin
  -- An indoor run from a watch: capped credit when it looks like running, history when not.
  if p_run.indoor and p_run.source in ('watch', 'health_import', 'garmin') and not p_run.manual_entry
     and p_run.expected_points = 0 then
    if cardinality(private.indoor_checks(p_run)) > 0 then
      return jsonb_build_object('outcome', 'personal_only', 'reasons', jsonb_build_array('indoor_unverified'),
                                'distance_cm', v_claimed_cm, 'active_ms', p_run.client_active_ms,
                                'coverage', null, 'history', true, 'claimed', true);
    end if;
    -- The validator's timing rules still apply.
    v_timing := array(select x from jsonb_array_elements_text(p_validation -> 'reasons') x
                      where x in ('invalid_timestamps', 'future_timestamp', 'late_upload'));
    return jsonb_build_object(
      'outcome', case when v_timing && array['invalid_timestamps', 'future_timestamp'] then 'personal_only'
                      when 'late_upload' = any(v_timing) then 'review' else 'accepted' end,
      'reasons', to_jsonb(v_timing),
      'distance_cm', v_claimed_cm, 'active_ms', p_run.client_active_ms,
      'coverage', null, 'history', false, 'claimed', true);
  end if;
  v_reason := case
    when p_run.manual_entry then 'manual_entry'
    when p_run.source = 'indoor' or p_run.indoor then 'indoor'
    when p_run.expected_points = 0 and p_run.source <> 'phone_gps' then 'no_route'
  end;
  if v_reason is not null then
    return jsonb_build_object('outcome', 'personal_only', 'reasons', jsonb_build_array(v_reason),
                              'distance_cm', v_claimed_cm, 'active_ms', p_run.client_active_ms,
                              'coverage', null, 'history', true, 'claimed', true);
  end if;
  if p_run.source = 'file_import' then
    -- Measured from the file's points, but a file can be edited, so it never scores.
    return jsonb_build_object('outcome', 'personal_only', 'reasons', jsonb_build_array('file_import'),
                              'distance_cm', (p_validation ->> 'distance_cm')::bigint,
                              'active_ms', (p_validation ->> 'active_ms')::bigint,
                              'coverage', p_validation -> 'coverage', 'history', false, 'claimed', false);
  end if;
  return jsonb_build_object('outcome', p_validation ->> 'outcome', 'reasons', p_validation -> 'reasons',
                            'distance_cm', (p_validation ->> 'distance_cm')::bigint,
                            'active_ms', (p_validation ->> 'active_ms')::bigint,
                            'coverage', p_validation -> 'coverage', 'history', false, 'claimed', false);
end
$$;

-- Writes a run's day allocations: the validator's per segment, or for a run it can't measure, its
-- claimed distance and time on the day it started.
create or replace function private.write_allocations(p_run public.runs, p_validation jsonb, p_outcome jsonb)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  delete from private.run_day_allocations where run_id = p_run.id;
  if coalesce((p_outcome ->> 'claimed')::boolean, (p_outcome ->> 'history')::boolean, false) then
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

-- Unverified indoor runs are history too, so they count for goals.
create or replace function private.streak_counts_run(r public.runs)
returns boolean
language sql immutable
as $$
  select r.activity_type = 'run' and r.deleted_at is null
     and (r.status = 'accepted'
          or (r.status = 'review' and r.reason_codes = array['late_upload']::text[])
          or (r.status = 'personal_only' and cardinality(r.reason_codes) > 0
              and r.reason_codes <@ array['no_route', 'indoor', 'indoor_unverified', 'manual_entry', 'file_import']::text[]))
$$;

-- ---------------------------------------------------------------------------------------
-- Scoring with the indoor cap
-- ---------------------------------------------------------------------------------------
create or replace function private.recompute_daily_scores(p_owner uuid, p_dates date[], p_cause_kind text, p_cause_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_date date;
  v_distance bigint;
  v_active bigint;
  v_new record;
  v_old public.daily_scores;
  v_had_row boolean;
  v_revision integer;
  v_delta integer;
  v_total integer := 0;
  v_changes jsonb := '[]'::jsonb;
begin
  for v_date in
    select distinct d from unnest(coalesce(p_dates, '{}'::date[])) as d where d is not null order by d
  loop
    select private.credited_distance_cm(coalesce(sum(a.distance_cm) filter (where not r.indoor), 0)::bigint,
                                        coalesce(sum(a.distance_cm) filter (where r.indoor), 0)::bigint),
           coalesce(sum(a.active_ms), 0)::bigint
      into v_distance, v_active
    from private.run_day_allocations a
    join public.runs r on r.id = a.run_id
    where a.owner_id = p_owner and a.competition_date = v_date
      and r.status = 'accepted' and r.scoring_state = 'applied' and r.deleted_at is null;

    v_new := private.daily_xp(v_distance, v_active);

    select * into v_old from public.daily_scores
    where owner_id = p_owner and competition_date = v_date and rule_version = 1
    for update;
    v_had_row := found;

    if v_had_row then
      continue when v_old.distance_cm = v_distance and v_old.active_ms = v_active;
      v_revision := v_old.revision + 1;
      update public.daily_scores
         set distance_cm = v_distance, active_ms = v_active, distance_xp = v_new.distance_xp,
             active_day_bonus = v_new.active_day_bonus, xp = v_new.xp, revision = v_revision, updated_at = now()
       where owner_id = p_owner and competition_date = v_date and rule_version = 1;
      v_delta := v_new.xp - v_old.xp;
    else
      continue when v_distance = 0 and v_active = 0;
      v_revision := 1;
      insert into public.daily_scores (owner_id, competition_date, rule_version, distance_cm, active_ms,
                                       distance_xp, active_day_bonus, xp, revision)
      values (p_owner, v_date, 1, v_distance, v_active, v_new.distance_xp, v_new.active_day_bonus, v_new.xp, v_revision);
      v_delta := v_new.xp;
    end if;

    if v_delta <> 0 then
      insert into private.xp_ledger (owner_id, competition_date, rule_version, revision, delta, cause_kind, cause_id)
      values (p_owner, v_date, 1, v_revision, v_delta, p_cause_kind, p_cause_id);
    end if;
    v_total := v_total + v_delta;

    v_changes := v_changes || jsonb_build_object(
      'competition_date', v_date,
      'before', jsonb_build_object(
        'distance_xp', case when v_had_row then v_old.distance_xp else 0 end,
        'active_day_bonus', case when v_had_row then v_old.active_day_bonus else 0 end,
        'xp', case when v_had_row then v_old.xp else 0 end),
      'after', jsonb_build_object('distance_xp', v_new.distance_xp, 'active_day_bonus', v_new.active_day_bonus, 'xp', v_new.xp),
      'delta', v_delta);
  end loop;

  if v_total <> 0 then
    insert into private.profile_stats as ps (user_id, lifetime_xp) values (p_owner, greatest(0, v_total))
    on conflict (user_id) do update set lifetime_xp = greatest(0, ps.lifetime_xp + v_total), updated_at = now();
  end if;
  return v_changes;
end
$$;

create or replace function private.league_standings(p_league_id uuid, p_week date, p_viewer uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  with members as (
    select m.id as member_id, m.user_id, m.role, m.joined_at, p.alias,
           coalesce(ps.lifetime_xp, 0) as lifetime_xp
    from public.league_members m
    join public.profiles p on p.user_id = m.user_id and p.status = 'active'
    left join private.profile_stats ps on ps.user_id = m.user_id
    where m.league_id = p_league_id and m.left_at is null
  ),
  day_totals as (
    select mb.member_id, a.competition_date,
           private.credited_distance_cm(coalesce(sum(a.distance_cm) filter (where not r.indoor), 0)::bigint,
                                        coalesce(sum(a.distance_cm) filter (where r.indoor), 0)::bigint) as distance_cm,
           sum(a.active_ms)::bigint as active_ms
    from members mb
    join private.run_day_allocations a on a.owner_id = mb.user_id
    join public.runs r on r.id = a.run_id
    where a.competition_date >= p_week and a.competition_date < p_week + 7
      and a.segment_start_at >= mb.joined_at
      and r.status = 'accepted' and r.scoring_state = 'applied' and r.deleted_at is null
      and r.first_received_at <= private.day_start(p_week + 7) + interval '24 hours'
    group by mb.member_id, a.competition_date
  ),
  day_xp as (
    select member_id, (private.daily_xp(distance_cm, active_ms)).xp as xp from day_totals
  ),
  weekly as (
    select member_id, sum(xp) filter (where rn <= 3)::integer as xp
    from (select member_id, xp, row_number() over (partition by member_id order by xp desc) as rn from day_xp) d
    group by member_id
  ),
  scored as (
    select mb.*, coalesce(w.xp, 0) as weekly_xp,
           mb.user_id <> p_viewer and private.are_blocked(p_viewer, mb.user_id) as hidden
    from members mb
    left join weekly w on w.member_id = mb.member_id
  ),
  ranked as (
    select s.*, rank() over (order by s.weekly_xp desc) as place from scored s
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'member_id', r.member_id,
           'rank', r.place,
           'alias', case when r.hidden then null else r.alias end,
           'tier', case when r.hidden then null else private.tier_name(r.lifetime_xp) end,
           'weekly_xp', r.weekly_xp,
           'is_me', r.user_id = p_viewer,
           'is_owner', r.role = 'owner',
           'hidden', r.hidden)
         order by r.weekly_xp desc, lower(r.alias) collate "C", r.member_id), '[]'::jsonb)
  from ranked r
$$;

-- ---------------------------------------------------------------------------------------
-- Upload: the indoor flag
-- ---------------------------------------------------------------------------------------
drop function public.start_run_upload(uuid, bigint, bigint, jsonb, double precision, bigint, integer, integer, text, boolean,
                                      text, text, text, text, boolean, text, double precision, integer, integer, integer);

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
  p_steps integer default null,
  p_indoor boolean default false
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
  v_indoor boolean := coalesce(p_indoor, false) or p_source = 'indoor';
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
  -- only join the hash when set, so earlier clients' retries keep matching.
  v_hash := encode(sha256(convert_to(concat_ws('|', p_client_run_id, p_started_at_ms, p_ended_at_ms, v_segments::text,
    p_client_distance_m, p_client_active_ms, p_expected_points, p_expected_chunks, v_title, coalesce(p_interrupted, false),
    p_source,
    case when p_activity_type is not null or v_app is not null or v_device is not null or coalesce(p_manual_entry, false)
              or v_external is not null or p_claimed_distance_m is not null or p_avg_heart_rate is not null
              or p_max_heart_rate is not null or p_steps is not null
         then concat_ws('|', v_type, v_app, v_device, coalesce(p_manual_entry, false), v_external, p_claimed_distance_m,
                        p_avg_heart_rate, p_max_heart_rate, p_steps) end,
    case when coalesce(p_indoor, false) then 'indoor' end), 'UTF8')), 'hex');

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
                           avg_heart_rate, max_heart_rate, steps, indoor)
  values (v_uid, p_client_run_id, v_hash, p_source, v_title, private.ms_to_ts(p_started_at_ms), private.ms_to_ts(p_ended_at_ms),
          v_segments, p_client_distance_m, p_client_active_ms, p_expected_points, p_expected_chunks, coalesce(p_interrupted, false),
          v_type, v_app, v_device, coalesce(p_manual_entry, false), v_external, p_claimed_distance_m,
          p_avg_heart_rate, p_max_heart_rate, p_steps, v_indoor)
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
    'duplicate_of', r.duplicate_of,
    'indoor', r.indoor
  )
$$;

select private.apply_function_grants();
