-- Profiles, idempotent run upload (create → chunks → finalize), history, and scoring.
--
-- Transaction rules (TECHNICAL_SPEC.md "API outline and transaction rules"):
-- * finalize locks the run row first; concurrent or repeated finalize calls for the same run
--   wait, then return the stored result (one accepted result, one set of score effects).
-- * All score changes for a user are serialized by a per-user advisory lock and recomputed
--   from source allocations, so two runs on one day can never each receive a day bonus.
-- * Lock order everywhere: run row → user scoring lock → daily score rows (date order).

-- ---------------------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------------------
create or replace function private.environment()
returns text
language sql stable
as $$
  select case
    when current_setting('app.environment', true) in ('development', 'staging', 'production', 'test')
      then current_setting('app.environment', true)
    else 'development'
  end
$$;

-- Stable pseudonymous reference for operational events (never the raw user id).
create or replace function private.subject_ref(p_user uuid)
returns text
language sql immutable
as $$
  select case when p_user is null then null
    else encode(sha256(convert_to('pl-subject-v1:' || p_user::text, 'UTF8')), 'hex') end
$$;

create or replace function private.log_server_event(p_name text, p_user uuid, p_props jsonb default '{}'::jsonb)
returns void
language sql security definer set search_path = ''
as $$
  insert into private.operational_events (event_id, schema_version, environment, name, occurred_at, subject, props)
  values (gen_random_uuid(), 1, private.environment(), p_name, now(), private.subject_ref(p_user), coalesce(p_props, '{}'::jsonb))
$$;

create or replace function private.lock_user_scoring(p_user uuid)
returns void
language sql
as $$
  select pg_advisory_xact_lock(hashtextextended('pl:scoring:' || p_user::text, 0))
$$;

create or replace function private.lifetime_xp(p_user uuid)
returns integer
language sql stable security definer set search_path = ''
as $$
  select coalesce((select lifetime_xp from private.profile_stats where user_id = p_user), 0)
$$;

create or replace function private.run_json(r public.runs)
returns jsonb
language sql stable
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
    'finalized_at_ms', private.ts_to_ms(r.finalized_at)
  )
$$;

-- Validates one compact wire point [seq, t, lat, lon, accuracy|null, segment]. CASE keeps
-- the numeric casts behind the type checks.
create or replace function private.is_valid_compact_point(e jsonb)
returns boolean
language sql immutable
as $$
  select case
    when jsonb_typeof(e) <> 'array' or jsonb_array_length(e) <> 6 then false
    when jsonb_typeof(e -> 0) <> 'number' or jsonb_typeof(e -> 1) <> 'number' or jsonb_typeof(e -> 2) <> 'number'
      or jsonb_typeof(e -> 3) <> 'number' or jsonb_typeof(e -> 4) not in ('number', 'null')
      or jsonb_typeof(e -> 5) <> 'number' then false
    else
      (e ->> 0)::numeric = trunc((e ->> 0)::numeric) and (e ->> 0)::numeric between 0 and 1000000
      and (e ->> 1)::numeric = trunc((e ->> 1)::numeric) and (e ->> 1)::numeric between 0 and 99999999999999
      and abs((e ->> 2)::numeric) <= 1000 and abs((e ->> 3)::numeric) <= 1000
      and (jsonb_typeof(e -> 4) = 'null' or abs((e ->> 4)::numeric) <= 1000000)
      and (e ->> 5)::numeric = trunc((e ->> 5)::numeric) and (e ->> 5)::numeric between 0 and 10000
  end
$$;

-- ---------------------------------------------------------------------------------------
-- Scoring
-- ---------------------------------------------------------------------------------------
-- Recomputes the listed days from accepted, applied, non-deleted allocations. Appends a
-- ledger correction for every changed day and keeps lifetime XP equal to the ledger sum.
-- Caller must hold private.lock_user_scoring(p_owner).
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
    select coalesce(sum(a.distance_cm), 0)::bigint, coalesce(sum(a.active_ms), 0)::bigint
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

-- Credits an accepted run whose scoring is pending. Idempotent.
create or replace function private.apply_run_scoring(p_run_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_run public.runs;
  v_dates date[];
  v_changes jsonb;
  v_award jsonb;
begin
  select * into v_run from public.runs where id = p_run_id for update;
  if not found or v_run.status <> 'accepted' or v_run.deleted_at is not null or v_run.scoring_state <> 'pending' then
    return v_run.xp_award;
  end if;
  perform private.lock_user_scoring(v_run.owner_id);
  update public.runs set scoring_state = 'applied', updated_at = now() where id = p_run_id;
  select array_agg(distinct competition_date) into v_dates from private.run_day_allocations where run_id = p_run_id;
  v_changes := private.recompute_daily_scores(v_run.owner_id, v_dates, 'run_accepted', p_run_id);
  select jsonb_build_object(
           'days', v_changes,
           'total_xp', coalesce(sum((c ->> 'delta')::integer), 0),
           'distance_xp', coalesce(sum((c -> 'after' ->> 'distance_xp')::integer - (c -> 'before' ->> 'distance_xp')::integer), 0),
           'active_day_bonus', coalesce(sum((c -> 'after' ->> 'active_day_bonus')::integer - (c -> 'before' ->> 'active_day_bonus')::integer), 0))
    into v_award
  from jsonb_array_elements(v_changes) c;
  update public.runs set xp_award = v_award where id = p_run_id;
  return v_award;
end
$$;

-- Applies scoring that was deferred while competition was disabled (oldest first).
create or replace function private.apply_pending_scoring(p_limit integer default 500)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_count integer := 0;
begin
  if not private.flag_enabled('competition_enabled') then
    return 0;
  end if;
  for v_id in
    select id from public.runs
    where status = 'accepted' and scoring_state = 'pending' and deleted_at is null
    order by finalized_at, id
    limit p_limit
  loop
    perform private.apply_run_scoring(v_id);
    v_count := v_count + 1;
  end loop;
  return v_count;
end
$$;

-- When a deletion or correction changes a league week that has already settled, record a
-- revision so standings are labelled "revised" instead of silently changing.
create or replace function private.record_league_revisions(p_owner uuid, p_dates date[], p_reason text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_member public.league_members;
  v_week date;
begin
  select * into v_member from public.league_members where user_id = p_owner and left_at is null;
  if not found then
    return;
  end if;
  for v_week in
    select distinct private.week_start(d) from unnest(coalesce(p_dates, '{}'::date[])) as d where d is not null
  loop
    if now() >= private.day_start(v_week + 7) + interval '24 hours'
       and private.day_start(v_week + 7) > v_member.joined_at then
      insert into private.league_week_revisions (league_id, week_start, revision, reason)
      select v_member.league_id, v_week, coalesce(max(revision), 0) + 1, p_reason
      from private.league_week_revisions where league_id = v_member.league_id and week_start = v_week;
    end if;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------------------
-- Configuration and profile
-- ---------------------------------------------------------------------------------------
create or replace function public.get_app_config()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'competition_enabled', private.flag_enabled('competition_enabled'),
    'invites_enabled', private.flag_enabled('invites_enabled'),
    'registration_enabled', private.flag_enabled('registration_enabled'),
    'rule_version', 1,
    'validator_version', 1,
    'competition_time_zone', 'America/Chicago',
    'league_capacity', 20,
    'server_time_ms', private.ts_to_ms(now())
  )
$$;

create or replace function public.get_me()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_profile public.profiles;
  v_xp integer := private.lifetime_xp(v_uid);
begin
  select * into v_profile from public.profiles where user_id = v_uid;
  return jsonb_build_object(
    'user_id', v_uid,
    'profile', case when v_profile.user_id is null then null else jsonb_build_object(
      'alias', v_profile.alias,
      'units', v_profile.units,
      'goal_days', v_profile.goal_days,
      'notification_tz', v_profile.notification_tz,
      'status', v_profile.status,
      'created_at_ms', private.ts_to_ms(v_profile.created_at)) end,
    'lifetime_xp', v_xp,
    'tier', private.tier_name(v_xp),
    'is_staff', exists (select 1 from private.staff_roles where user_id = v_uid),
    'config', public.get_app_config()
  );
end
$$;

create or replace function public.check_alias(p_alias text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_alias text := private.normalize_name(p_alias);
  v_problem text;
begin
  perform private.check_rate_limit('alias_check:' || v_uid, 30, interval '1 minute');
  v_problem := private.name_problem(v_alias, 2, 24);
  if v_problem is null and exists (
    select 1 from public.profiles where lower(alias) = lower(v_alias) and user_id <> v_uid
  ) then
    v_problem := 'taken';
  end if;
  return jsonb_build_object('alias', v_alias, 'available', v_problem is null, 'problem', v_problem);
end
$$;

create or replace function public.save_profile(
  p_alias text,
  p_units text,
  p_goal_days integer,
  p_notification_tz text,
  p_ack_eligibility boolean default false
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_profile public.profiles;
  v_alias text := private.normalize_name(p_alias);
  v_problem text;
begin
  select * into v_profile from public.profiles where user_id = v_uid for update;
  if found and v_profile.status <> 'active' then
    perform private.fail('account_deleting');
  end if;

  v_problem := private.name_problem(v_alias, 2, 24);
  if v_problem = 'invalid' then
    perform private.fail('alias_invalid');
  elsif v_problem = 'not_allowed' then
    perform private.fail('alias_not_allowed');
  end if;
  if p_units is null or p_units not in ('metric', 'imperial') then
    perform private.fail('invalid_input', 'units');
  end if;
  if p_goal_days is not null and p_goal_days not between 1 and 3 then
    perform private.fail('invalid_input', 'goal_days');
  end if;
  if p_notification_tz is not null and not exists (select 1 from pg_catalog.pg_timezone_names where name = p_notification_tz) then
    perform private.fail('invalid_input', 'notification_tz');
  end if;

  if v_profile.user_id is null then
    if not coalesce(p_ack_eligibility, false) then
      perform private.fail('eligibility_required');
    end if;
    if not private.flag_enabled('registration_enabled') then
      perform private.fail('registration_paused');
    end if;
  elsif lower(v_profile.alias) <> lower(v_alias) then
    perform private.check_rate_limit('alias_change:' || v_uid, 10, interval '1 day');
  end if;

  if exists (select 1 from public.profiles where lower(alias) = lower(v_alias) and user_id <> v_uid) then
    perform private.fail('alias_taken');
  end if;

  begin
    if v_profile.user_id is null then
      insert into public.profiles (user_id, alias, units, goal_days, notification_tz, eligibility_ack_at)
      values (v_uid, v_alias, p_units, p_goal_days, p_notification_tz, now());
      insert into private.profile_stats (user_id) values (v_uid) on conflict (user_id) do nothing;
      perform private.log_server_event('onboarding_completed', v_uid,
        jsonb_build_object('goal_set', p_goal_days is not null, 'units', p_units));
    else
      update public.profiles
         set alias = v_alias, units = p_units, goal_days = p_goal_days, notification_tz = p_notification_tz, updated_at = now()
       where user_id = v_uid;
    end if;
  exception when unique_violation then
    perform private.fail('alias_taken');
  end;
  return public.get_me();
end
$$;

-- ---------------------------------------------------------------------------------------
-- Run upload protocol
-- ---------------------------------------------------------------------------------------
create or replace function private.upload_state(r public.runs)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'run_id', r.id,
    'status', case when r.deleted_at is not null then 'deleted' else r.status end,
    'version', r.version,
    'expected_chunks', r.expected_chunks,
    'received_chunks', coalesce((select jsonb_agg(c.seq order by c.seq) from private.route_chunks c where c.run_id = r.id), '[]'::jsonb),
    'run', case when r.deleted_at is null and r.status <> 'uploading' then private.run_json(r) end
  )
$$;

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
  p_source text default 'phone_gps'
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
begin
  if p_client_run_id is null or p_started_at_ms is null or p_ended_at_ms is null
     or p_client_distance_m is null or p_client_active_ms is null or p_expected_points is null
     or p_expected_chunks is null or p_source is distinct from 'phone_gps' then
    perform private.fail('invalid_input');
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

  v_hash := encode(sha256(convert_to(concat_ws('|', p_client_run_id, p_started_at_ms, p_ended_at_ms, v_segments::text,
    p_client_distance_m, p_client_active_ms, p_expected_points, p_expected_chunks, v_title, coalesce(p_interrupted, false),
    p_source), 'UTF8')), 'hex');

  select * into v_run from public.runs where owner_id = v_uid and client_run_id = p_client_run_id;
  if found then
    if v_run.deleted_at is null and v_run.request_hash <> v_hash then
      perform private.fail('idempotency_conflict');
    end if;
    return private.upload_state(v_run);
  end if;

  perform private.check_rate_limit('run_upload:' || v_uid, 60, interval '1 hour');

  insert into public.runs (owner_id, client_run_id, request_hash, source, title, started_at, ended_at, segments,
                           client_distance_m, client_active_ms, expected_points, expected_chunks, interrupted)
  values (v_uid, p_client_run_id, v_hash, p_source, v_title, private.ms_to_ts(p_started_at_ms), private.ms_to_ts(p_ended_at_ms),
          v_segments, p_client_distance_m, p_client_active_ms, p_expected_points, p_expected_chunks, coalesce(p_interrupted, false))
  on conflict (owner_id, client_run_id) do nothing
  returning * into v_run;

  if v_run.id is null then
    -- A concurrent request created it first; answer as a retry would.
    select * into v_run from public.runs where owner_id = v_uid and client_run_id = p_client_run_id;
    if v_run.deleted_at is null and v_run.request_hash <> v_hash then
      perform private.fail('idempotency_conflict');
    end if;
  end if;
  return private.upload_state(v_run);
end
$$;

create or replace function public.put_route_chunk(p_run_id uuid, p_seq integer, p_points text, p_checksum text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_run public.runs;
  v_sum text;
  v_existing text;
  v_json jsonb;
  v_count integer;
begin
  select * into v_run from public.runs where id = p_run_id and owner_id = v_uid;
  if not found or v_run.deleted_at is not null then
    perform private.fail('not_found');
  end if;
  if v_run.status <> 'uploading' then
    return jsonb_build_object('status', 'already_finalized', 'seq', p_seq);
  end if;
  if p_seq is null or p_seq < 0 or p_seq >= v_run.expected_chunks then
    perform private.fail('invalid_chunk', 'seq');
  end if;
  if p_points is null or octet_length(p_points) > 131072 then
    perform private.fail('chunk_too_large');
  end if;
  v_sum := encode(sha256(convert_to(p_points, 'UTF8')), 'hex');
  if v_sum <> lower(coalesce(p_checksum, '')) then
    perform private.fail('checksum_mismatch');
  end if;

  select checksum into v_existing from private.route_chunks where run_id = p_run_id and seq = p_seq;
  if found then
    if v_existing = v_sum then
      return jsonb_build_object('status', 'stored', 'seq', p_seq);
    end if;
    perform private.fail('chunk_conflict');
  end if;

  begin
    v_json := p_points::jsonb;
  exception when others then
    perform private.fail('invalid_chunk', 'json');
  end;
  if jsonb_typeof(v_json) <> 'array' then
    perform private.fail('invalid_chunk', 'shape');
  end if;
  v_count := jsonb_array_length(v_json);
  if v_count < 1 or v_count > 500 then
    perform private.fail('invalid_chunk', 'size');
  end if;
  if exists (select 1 from jsonb_array_elements(v_json) e where not private.is_valid_compact_point(e)) then
    perform private.fail('invalid_chunk', 'point');
  end if;

  insert into private.route_chunks (run_id, seq, checksum, point_count, points)
  values (p_run_id, p_seq, v_sum, v_count, v_json)
  on conflict (run_id, seq) do nothing;
  if not found then
    select checksum into v_existing from private.route_chunks where run_id = p_run_id and seq = p_seq;
    if v_existing is distinct from v_sum then
      perform private.fail('chunk_conflict');
    end if;
  end if;
  return jsonb_build_object('status', 'stored', 'seq', p_seq);
end
$$;

create or replace function private.finalize_response(r public.runs)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'run', private.run_json(r),
    'lifetime_xp', private.lifetime_xp(r.owner_id),
    'tier', private.tier_name(private.lifetime_xp(r.owner_id)),
    'competition_enabled', private.flag_enabled('competition_enabled')
  )
$$;

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
  v_scoring text;
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

  insert into private.run_day_allocations (run_id, owner_id, segment_index, competition_date, segment_start_at, distance_cm, active_ms)
  select p_run_id, v_uid, (a ->> 'segment_index')::integer, (a ->> 'competition_date')::date,
         private.ms_to_ts((a ->> 'segment_start_ms')::bigint), (a ->> 'distance_cm')::bigint, (a ->> 'active_ms')::bigint
  from jsonb_array_elements(v_validation -> 'allocations') a;

  v_scoring := case when v_validation ->> 'outcome' = 'accepted' then 'pending' else 'none' end;
  update public.runs
     set status = v_validation ->> 'outcome',
         reason_codes = array(select jsonb_array_elements_text(v_validation -> 'reasons')),
         distance_cm = (v_validation ->> 'distance_cm')::bigint,
         active_ms = (v_validation ->> 'active_ms')::bigint,
         coverage = round((v_validation ->> 'coverage')::numeric, 5),
         diagnostics = v_validation -> 'diagnostics',
         validator_version = (v_validation ->> 'validator_version')::smallint,
         rule_version = 1,
         scoring_state = v_scoring,
         finalized_at = now(),
         version = version + 1,
         updated_at = now()
   where id = p_run_id;

  if v_scoring = 'pending' and private.flag_enabled('competition_enabled') then
    perform private.apply_run_scoring(p_run_id);
  end if;

  select * into v_run from public.runs where id = p_run_id;
  perform private.log_server_event('run_sync_outcome', v_uid,
    jsonb_build_object('outcome', v_run.status, 'reason', coalesce(v_run.reason_codes[1], 'none')));
  return private.finalize_response(v_run);
end
$$;

-- ---------------------------------------------------------------------------------------
-- History (owner only)
-- ---------------------------------------------------------------------------------------
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
    where r.owner_id = v_uid and r.deleted_at is null and r.status <> 'uploading'
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

create or replace function public.get_my_run(p_run_id uuid)
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
  return private.run_json(v_run);
end
$$;

-- The private route is a separate, owner-only fetch; no league or social API returns it.
create or replace function public.get_my_run_route(p_run_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_run public.runs;
  v_points jsonb;
begin
  select * into v_run from public.runs where id = p_run_id and owner_id = v_uid and deleted_at is null;
  if not found then
    perform private.fail('not_found');
  end if;
  select points into v_points from private.run_routes where run_id = p_run_id and owner_id = v_uid;
  return jsonb_build_object('run_id', v_run.id, 'segments', v_run.segments, 'points', coalesce(v_points, '[]'::jsonb));
end
$$;

create or replace function public.rename_run(p_run_id uuid, p_title text, p_expected_version integer default null)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_run public.runs;
  v_title text := private.normalize_name(p_title);
begin
  if char_length(v_title) < 1 or char_length(v_title) > 60 then
    perform private.fail('invalid_input', 'title');
  end if;
  select * into v_run from public.runs where id = p_run_id and owner_id = v_uid and deleted_at is null for update;
  if not found then
    perform private.fail('not_found');
  end if;
  if p_expected_version is not null and p_expected_version <> v_run.version then
    perform private.fail('version_conflict');
  end if;
  -- Title only: accepted distance, time and route are never editable.
  update public.runs set title = v_title, version = version + 1, updated_at = now()
  where id = p_run_id
  returning * into v_run;
  return private.run_json(v_run);
end
$$;

create or replace function public.delete_run(p_run_id uuid, p_expected_version integer default null)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_run public.runs;
  v_dates date[];
  v_changes jsonb;
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
         version = version + 1, updated_at = now()
   where id = p_run_id;

  v_changes := private.recompute_daily_scores(v_uid, v_dates, 'run_deleted', p_run_id);
  perform private.record_league_revisions(v_uid, v_dates, 'run_deleted');
  return jsonb_build_object('run_id', p_run_id, 'deleted', true, 'xp_changes', v_changes,
                            'lifetime_xp', private.lifetime_xp(v_uid));
end
$$;

-- ---------------------------------------------------------------------------------------
-- Progress
-- ---------------------------------------------------------------------------------------
create or replace function private.week_summary(p_user uuid, p_week date)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  with days as (
    select d::date as day, ds.xp, ds.active_day_bonus, ds.distance_cm
    from generate_series(p_week, p_week + 6, interval '1 day') d
    left join public.daily_scores ds
      on ds.owner_id = p_user and ds.competition_date = d::date and ds.rule_version = 1
  )
  select jsonb_build_object(
    'week_start', p_week,
    'starts_at_ms', private.ts_to_ms(private.day_start(p_week)),
    'ends_at_ms', private.ts_to_ms(private.day_start(p_week + 7)),
    'settles_at_ms', private.ts_to_ms(private.day_start(p_week + 7) + interval '24 hours'),
    'days', (select jsonb_agg(jsonb_build_object('date', day, 'xp', coalesce(xp, 0),
                                                 'active', coalesce(active_day_bonus, 0) > 0,
                                                 'distance_cm', coalesce(distance_cm, 0)) order by day) from days),
    'active_days', (select count(*) from days where coalesce(active_day_bonus, 0) > 0),
    'weekly_xp', (select coalesce(sum(xp), 0) from (select xp from days where xp is not null order by xp desc limit 3) top3),
    'goal_days', (select goal_days from public.profiles where user_id = p_user)
  )
$$;

create or replace function public.get_week_summary(p_week_offset integer default 0)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
begin
  return private.week_summary(v_uid, private.current_week_start() + 7 * greatest(-52, least(0, coalesce(p_week_offset, 0))));
end
$$;

-- Weekly distance of all saved runs (any outcome) for the progress chart.
create or replace function private.distance_by_week(p_user uuid, p_weeks integer)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  with weeks as (
    select (private.current_week_start() - 7 * g)::date as week_start
    from generate_series(0, greatest(1, least(coalesce(p_weeks, 4), 26)) - 1) g
  )
  select jsonb_agg(jsonb_build_object(
           'week_start', w.week_start,
           'distance_cm', coalesce((
             select sum(a.distance_cm) from private.run_day_allocations a
             join public.runs r on r.id = a.run_id
             where a.owner_id = p_user and r.deleted_at is null
               and a.competition_date >= w.week_start and a.competition_date < w.week_start + 7), 0),
           'runs', (select count(*) from public.runs r
                    where r.owner_id = p_user and r.deleted_at is null and r.status <> 'uploading'
                      and private.competition_date(r.started_at) >= w.week_start
                      and private.competition_date(r.started_at) < w.week_start + 7))
         order by w.week_start)
  from weeks w
$$;

create or replace function public.get_progress(p_weeks integer default 4)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_xp integer := private.lifetime_xp(v_uid);
begin
  return jsonb_build_object(
    'lifetime_xp', v_xp,
    'tier', private.tier_name(v_xp),
    'week', private.week_summary(v_uid, private.current_week_start()),
    'distance_by_week', private.distance_by_week(v_uid, p_weeks),
    'competition_enabled', private.flag_enabled('competition_enabled')
  );
end
$$;

select private.apply_function_grants();
