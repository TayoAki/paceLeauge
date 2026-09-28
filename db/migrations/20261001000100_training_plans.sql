-- Training plans (docs/ROADMAP.md 3.1 and 3.2, Part B). The plan engine runs in the app
-- (src/domain/plans): it is deterministic, so the server keeps what recreates a plan (the runner's
-- setup answers and their edits) plus the sessions the engine laid out. Sessions are what runs are
-- matched to, and they keep the log (done, missed, feedback) through later edits: days before the
-- runner's today are history and never change.
--
-- Plans never change XP or rank (Part B point 8), and nothing here is shown to anyone else.

-- ---------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------
create table private.training_plans (
  -- The app makes the id, so creating a plan is safe to retry.
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  plan_type text not null
    check (plan_type in ('start_running', '5k', '10k', 'half', 'marathon', 'consistency', 'return')),
  engine_version integer not null check (engine_version between 1 and 1000),
  -- The setup answers (PlanInput) and the edits since (PlanAdjustment[]), as the app sent them.
  input jsonb not null,
  adjustments jsonb not null default '[]'::jsonb,
  -- The runner's zone when the plan began: sessions and runs are matched on local dates in it.
  time_zone text not null check (char_length(time_zone) <= 64),
  start_date date not null,
  end_date date not null,
  status text not null default 'active' check (status in ('active', 'completed', 'ended', 'replaced')),
  -- Bumped by each save; a save from a stale copy is refused.
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  ended_at timestamptz,
  constraint training_plans_dates check (end_date >= start_date)
);
create unique index training_plans_one_active on private.training_plans (user_id) where status = 'active';
create index training_plans_user_idx on private.training_plans (user_id, created_at desc);

create table private.plan_sessions (
  plan_id uuid not null references private.training_plans (id) on delete cascade,
  -- The engine's id: the week and the day it was first planned for ("w3-d1").
  session_id text not null check (session_id ~ '^w[0-9]{1,3}-d[0-6]$'),
  user_id uuid not null references auth.users (id) on delete cascade,
  session_date date not null,
  week integer not null check (week between 1 and 200),
  kind text not null check (kind in ('easy', 'long', 'tempo', 'intervals', 'steady', 'run_walk', 'race')),
  title text not null check (char_length(title) between 1 and 80),
  hard boolean not null,
  duration_s integer not null check (duration_s between 60 and 43200),
  distance_m integer check (distance_m between 1 and 100000),
  effort text not null check (effort in ('easy', 'steady', 'tempo', 'interval', 'race', 'walk')),
  -- The workout's steps (WorkoutBlock[]).
  blocks jsonb not null check (jsonb_typeof(blocks) = 'array'),
  edited boolean not null default false,
  run_id uuid references public.runs (id) on delete set null,
  -- auto: a run on the session's day · runner: the runner chose (a null run_id means "none of them")
  matched_by text check (matched_by in ('auto', 'runner')),
  feedback text check (feedback in ('easy', 'about_right', 'hard', 'too_hard')),
  pain boolean not null default false,
  feedback_at timestamptz,
  primary key (plan_id, session_id)
);
create index plan_sessions_user_date_idx on private.plan_sessions (user_id, session_date);
create index plan_sessions_run_idx on private.plan_sessions (run_id) where run_id is not null;

-- ---------------------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------------------
create or replace function private.try_date(p text)
returns date
language plpgsql immutable set search_path = ''
as $$
begin
  if p is null or p !~ '^\d{4}-\d{2}-\d{2}$' then
    return null;
  end if;
  return p::date;
exception when others then
  return null;
end
$$;

-- The first thing wrong with one session from the app, or null.
create or replace function private.plan_session_problem(p jsonb, p_start date, p_end date)
returns text
language plpgsql immutable set search_path = ''
as $$
declare
  v_date date;
begin
  if jsonb_typeof(p) <> 'object' then
    return 'session';
  end if;
  if coalesce(p ->> 'id', '') !~ '^w[0-9]{1,3}-d[0-6]$' then
    return 'session_id';
  end if;
  v_date := private.try_date(p ->> 'date');
  if v_date is null or v_date < p_start or v_date > p_end then
    return 'session_date';
  end if;
  if jsonb_typeof(p -> 'week') <> 'number' or (p ->> 'week')::numeric not between 1 and 200
     or (p ->> 'week')::numeric <> trunc((p ->> 'week')::numeric) then
    return 'session_week';
  end if;
  if coalesce(p ->> 'kind', '') not in ('easy', 'long', 'tempo', 'intervals', 'steady', 'run_walk', 'race') then
    return 'session_kind';
  end if;
  if jsonb_typeof(p -> 'title') <> 'string' or char_length(p ->> 'title') not between 1 and 80 then
    return 'session_title';
  end if;
  if jsonb_typeof(p -> 'hard') <> 'boolean' then
    return 'session_hard';
  end if;
  if jsonb_typeof(p -> 'duration_s') <> 'number' or (p ->> 'duration_s')::numeric not between 60 and 43200
     or (p ->> 'duration_s')::numeric <> trunc((p ->> 'duration_s')::numeric) then
    return 'session_duration';
  end if;
  if coalesce(jsonb_typeof(p -> 'distance_m'), 'null') not in ('null', 'number')
     or (jsonb_typeof(p -> 'distance_m') = 'number'
         and ((p ->> 'distance_m')::numeric not between 1 and 100000
              or (p ->> 'distance_m')::numeric <> trunc((p ->> 'distance_m')::numeric))) then
    return 'session_distance';
  end if;
  if coalesce(p ->> 'effort', '') not in ('easy', 'steady', 'tempo', 'interval', 'race', 'walk') then
    return 'session_effort';
  end if;
  if jsonb_typeof(p -> 'blocks') <> 'array' or char_length((p -> 'blocks')::text) > 4000 then
    return 'session_blocks';
  end if;
  if coalesce(jsonb_typeof(p -> 'edited'), 'boolean') <> 'boolean' then
    return 'session_edited';
  end if;
  return null;
end
$$;

-- The runner's calendar date today, in the plan's zone.
create or replace function private.plan_today(p_plan private.training_plans)
returns date
language sql stable set search_path = ''
as $$
  select (now() at time zone p_plan.time_zone)::date
$$;

-- Runs that can complete a session: runs (not walks or rides), finished uploading, not deleted.
create or replace function private.run_counts_for_plan(p_run public.runs)
returns boolean
language sql immutable set search_path = ''
as $$
  select p_run.deleted_at is null and p_run.activity_type = 'run'
     and p_run.status in ('accepted', 'personal_only', 'review')
$$;

-- Matches the runner's runs to the plan's sessions on the same local date: a run on the planned
-- day completes the first open session that day. Sessions the runner settled themselves are left
-- alone. Returns how many were matched.
create or replace function private.match_plan_runs(p_plan_id uuid)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_plan private.training_plans;
  v_run record;
  v_session text;
  v_count integer := 0;
begin
  select * into v_plan from private.training_plans where id = p_plan_id;
  if not found or v_plan.status <> 'active' then
    return 0;
  end if;
  for v_run in
    select r.id, (r.started_at at time zone v_plan.time_zone)::date as local_date
    from public.runs r
    where r.owner_id = v_plan.user_id and private.run_counts_for_plan(r)
      and r.started_at >= (v_plan.start_date - 1)::timestamp at time zone v_plan.time_zone
      and r.started_at < (v_plan.end_date + 2)::timestamp at time zone v_plan.time_zone
      and not exists (select 1 from private.plan_sessions s where s.plan_id = p_plan_id and s.run_id = r.id)
    order by r.started_at, r.id
  loop
    select s.session_id into v_session
    from private.plan_sessions s
    where s.plan_id = p_plan_id and s.session_date = v_run.local_date and s.run_id is null and s.matched_by is null
    order by s.session_id
    limit 1
    for update;
    if found then
      update private.plan_sessions set run_id = v_run.id, matched_by = 'auto'
      where plan_id = p_plan_id and session_id = v_session;
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end
$$;

-- Runs are matched as they finish uploading, and let go when they stop counting (deleted, merged,
-- changed to a walk) or move to another day.
create or replace function private.runs_plan_match()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_plan uuid;
begin
  if not private.run_counts_for_plan(new) then
    update private.plan_sessions set run_id = null, matched_by = null where run_id = new.id;
    return new;
  end if;
  if tg_op = 'UPDATE' and old.started_at is distinct from new.started_at then
    update private.plan_sessions set run_id = null, matched_by = null where run_id = new.id and matched_by = 'auto';
  end if;
  select id into v_plan from private.training_plans where user_id = new.owner_id and status = 'active';
  if v_plan is not null then
    perform private.match_plan_runs(v_plan);
  end if;
  return new;
end
$$;

create trigger runs_plan_match
  after insert or update of status, deleted_at, activity_type, started_at on public.runs
  for each row execute function private.runs_plan_match();

create or replace function private.plan_json(p_plan_id uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'id', p.id,
    'version', p.version,
    'type', p.plan_type,
    'status', p.status,
    'engine_version', p.engine_version,
    'input', p.input,
    'adjustments', p.adjustments,
    'time_zone', p.time_zone,
    'start_date', p.start_date,
    'end_date', p.end_date,
    'today', private.plan_today(p),
    'created_at_ms', private.ts_to_ms(p.created_at),
    'updated_at_ms', private.ts_to_ms(p.updated_at),
    'ended_at_ms', case when p.ended_at is null then null else private.ts_to_ms(p.ended_at) end,
    'sessions', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', s.session_id,
               'date', s.session_date,
               'week', s.week,
               'kind', s.kind,
               'title', s.title,
               'hard', s.hard,
               'duration_s', s.duration_s,
               'distance_m', s.distance_m,
               'effort', s.effort,
               'blocks', s.blocks,
               'edited', s.edited,
               'run_id', s.run_id,
               'matched_by', s.matched_by,
               'feedback', s.feedback,
               'pain', s.pain,
               'run', case when r.id is null then null else jsonb_build_object(
                 'title', r.title,
                 'started_at_ms', private.ts_to_ms(r.started_at),
                 'distance_m', round(coalesce(r.distance_cm, 0) / 100.0),
                 'active_ms', coalesce(r.active_ms, 0)) end)
             order by s.session_date, s.session_id)
      from private.plan_sessions s
      left join public.runs r on r.id = s.run_id and r.deleted_at is null
      where s.plan_id = p.id), '[]'::jsonb))
  from private.training_plans p
  where p.id = p_plan_id
$$;

-- The caller's plan for writing: theirs and still running.
create or replace function private.own_active_plan(p_plan_id uuid)
returns private.training_plans
language plpgsql security definer set search_path = ''
as $$
declare
  v_plan private.training_plans;
begin
  select * into v_plan from private.training_plans where id = p_plan_id and user_id = private.require_user() for update;
  if not found then
    perform private.fail('not_found');
  end if;
  if v_plan.status <> 'active' then
    perform private.fail('plan_ended');
  end if;
  return v_plan;
end
$$;

-- ---------------------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------------------

-- Creates a plan (ending the one before) or saves a new version of it: the input, every edit so
-- far, and the sessions the engine laid out. Sessions before the runner's today are history and
-- stay as they were; so do sessions already done.
create or replace function public.save_plan(
  p_plan_id uuid,
  p_base_version integer,
  p_input jsonb,
  p_adjustments jsonb,
  p_sessions jsonb,
  p_engine_version integer,
  p_time_zone text,
  p_end_date date
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_plan private.training_plans;
  v_type text := p_input ->> 'type';
  v_start date := private.try_date(p_input ->> 'startDate');
  v_today date;
  v_created boolean := false;
  v_item jsonb;
  v_problem text;
  v_ids text[] := '{}';
begin
  perform private.check_rate_limit('plan_save:' || v_uid, 300, interval '1 hour');
  if p_plan_id is null then
    perform private.fail('invalid_input', 'plan_id');
  end if;
  if p_input is null or jsonb_typeof(p_input) <> 'object' or char_length(p_input::text) > 8000 then
    perform private.fail('invalid_input', 'input');
  end if;
  if v_type is null or v_type not in ('start_running', '5k', '10k', 'half', 'marathon', 'consistency', 'return') then
    perform private.fail('invalid_input', 'type');
  end if;
  if v_start is null or extract(isodow from v_start) <> 1 then
    perform private.fail('invalid_input', 'start_date');
  end if;
  if p_end_date is null or p_end_date < v_start or p_end_date > v_start + 7 * 104 then
    perform private.fail('invalid_input', 'end_date');
  end if;
  if p_adjustments is null or jsonb_typeof(p_adjustments) <> 'array' or jsonb_array_length(p_adjustments) > 500
     or char_length(p_adjustments::text) > 65536 then
    perform private.fail('invalid_input', 'adjustments');
  end if;
  if p_engine_version is null or p_engine_version not between 1 and 1000 then
    perform private.fail('invalid_input', 'engine_version');
  end if;
  if p_sessions is null or jsonb_typeof(p_sessions) <> 'array' or jsonb_array_length(p_sessions) > 500 then
    perform private.fail('invalid_input', 'sessions');
  end if;
  for v_item in select value from jsonb_array_elements(p_sessions) loop
    v_problem := private.plan_session_problem(v_item, v_start, p_end_date);
    if v_problem is not null then
      perform private.fail('invalid_input', v_problem);
    end if;
    if (v_item ->> 'id') = any (v_ids) then
      perform private.fail('invalid_input', 'session_id');
    end if;
    v_ids := v_ids || (v_item ->> 'id');
  end loop;

  select * into v_plan from private.training_plans where id = p_plan_id for update;
  if found then
    if v_plan.user_id <> v_uid then
      perform private.fail('not_found');
    end if;
    if v_plan.status <> 'active' then
      perform private.fail('plan_ended');
    end if;
    if p_base_version is distinct from v_plan.version then
      perform private.fail('conflict', v_plan.version::text);
    end if;
    -- A different kind of plan, or a new start, is a new plan.
    if v_plan.plan_type <> v_type or v_plan.start_date <> v_start then
      perform private.fail('invalid_input', 'type');
    end if;
    update private.training_plans
       set input = p_input, adjustments = p_adjustments, engine_version = p_engine_version, end_date = p_end_date,
           version = version + 1, updated_at = now()
     where id = p_plan_id
    returning * into v_plan;
  else
    if p_time_zone is null or not exists (select 1 from pg_catalog.pg_timezone_names where name = p_time_zone) then
      perform private.fail('invalid_input', 'time_zone');
    end if;
    perform private.check_rate_limit('plan_create:' || v_uid, 20, interval '1 day');
    update private.training_plans set status = 'replaced', ended_at = now(), updated_at = now()
    where user_id = v_uid and status = 'active';
    insert into private.training_plans (id, user_id, plan_type, engine_version, input, adjustments, time_zone, start_date, end_date)
    values (p_plan_id, v_uid, v_type, p_engine_version, p_input, p_adjustments, p_time_zone, v_start, p_end_date)
    returning * into v_plan;
    v_created := true;
  end if;

  v_today := private.plan_today(v_plan);
  -- Open sessions from today on that the plan no longer has.
  delete from private.plan_sessions s
  where s.plan_id = p_plan_id and s.session_date >= v_today and s.run_id is null and s.feedback is null
    and not (s.session_id = any (v_ids));
  insert into private.plan_sessions (plan_id, session_id, user_id, session_date, week, kind, title, hard, duration_s,
                                     distance_m, effort, blocks, edited)
  select p_plan_id, x.id, v_uid, x.date, x.week, x.kind, x.title, x.hard, x.duration_s, x.distance_m, x.effort, x.blocks,
         coalesce(x.edited, false)
  from jsonb_to_recordset(p_sessions) as x(id text, date date, week integer, kind text, title text, hard boolean,
                                            duration_s integer, distance_m integer, effort text, blocks jsonb, edited boolean)
  where v_created or x.date >= v_today
  on conflict (plan_id, session_id) do update
    set session_date = excluded.session_date, week = excluded.week, kind = excluded.kind, title = excluded.title,
        hard = excluded.hard, duration_s = excluded.duration_s, distance_m = excluded.distance_m, effort = excluded.effort,
        blocks = excluded.blocks, edited = excluded.edited
    where private.plan_sessions.session_date >= v_today and private.plan_sessions.run_id is null;

  perform private.match_plan_runs(p_plan_id);
  return private.plan_json(p_plan_id);
end
$$;

-- The runner's plan: the one running, else one that finished in the last 30 days.
create or replace function public.get_plan()
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_plan private.training_plans;
begin
  select * into v_plan from private.training_plans
  where user_id = v_uid and (status = 'active' or ended_at > now() - interval '30 days')
  order by (status = 'active') desc, created_at desc
  limit 1;
  if not found then
    return jsonb_build_object('plan', null);
  end if;
  -- A plan whose last day has passed is complete.
  if v_plan.status = 'active' and private.plan_today(v_plan) > v_plan.end_date then
    update private.training_plans set status = 'completed', ended_at = now(), updated_at = now() where id = v_plan.id;
  end if;
  return jsonb_build_object('plan', private.plan_json(v_plan.id));
end
$$;

create or replace function public.end_plan(p_plan_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_plan private.training_plans := private.own_active_plan(p_plan_id);
begin
  update private.training_plans
     set status = case when private.plan_today(v_plan) >= v_plan.end_date then 'completed' else 'ended' end,
         ended_at = now(), updated_at = now()
   where id = v_plan.id;
  return jsonb_build_object('plan', private.plan_json(v_plan.id));
end
$$;

-- One tap after a session: how it felt, and an optional pain flag (Part B point 5).
create or replace function public.set_session_feedback(p_plan_id uuid, p_session_id text, p_feedback text, p_pain boolean)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_plan private.training_plans := private.own_active_plan(p_plan_id);
begin
  if p_feedback is not null and p_feedback not in ('easy', 'about_right', 'hard', 'too_hard') then
    perform private.fail('invalid_input', 'feedback');
  end if;
  update private.plan_sessions
     set feedback = p_feedback, pain = coalesce(p_pain, false), feedback_at = now()
   where plan_id = v_plan.id and session_id = p_session_id;
  if not found then
    perform private.fail('not_found');
  end if;
  return private.plan_json(v_plan.id);
end
$$;

-- The runner says which session a run was, or that none of their runs was this session.
create or replace function public.match_plan_session(p_plan_id uuid, p_session_id text, p_run_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_plan private.training_plans := private.own_active_plan(p_plan_id);
  v_run public.runs;
begin
  if not exists (select 1 from private.plan_sessions where plan_id = v_plan.id and session_id = p_session_id) then
    perform private.fail('not_found');
  end if;
  if p_run_id is not null then
    select * into v_run from public.runs where id = p_run_id and owner_id = v_plan.user_id;
    if not found or not private.run_counts_for_plan(v_run) then
      perform private.fail('not_found');
    end if;
    update private.plan_sessions set run_id = null, matched_by = null
    where plan_id = v_plan.id and run_id = p_run_id and session_id <> p_session_id;
  end if;
  update private.plan_sessions set run_id = p_run_id, matched_by = 'runner'
  where plan_id = v_plan.id and session_id = p_session_id;
  return private.plan_json(v_plan.id);
end
$$;

-- ---------------------------------------------------------------------------------------
-- Export (format 3 plus plans) and deletion. Plans go with the account: both tables cascade
-- from auth.users, which private.purge_user_data deletes last.
-- ---------------------------------------------------------------------------------------
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
                                from private.training_plans p where p.user_id = p_uid), '[]'::jsonb)
  );
end
$$;

select private.apply_function_grants();
