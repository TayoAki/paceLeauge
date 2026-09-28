-- Weekly streaks and badges (docs/ROADMAP.md 1.8, decision 2).
--
-- A week meets the goal when the runner has at least `goal_days` active days (1 km and 5 minutes of
-- accepted running on a day, the same rule as the daily bonus), or at least one if they set no goal.
-- The streak is the number of weeks in a row that met the goal; the current week only adds once it
-- is met, so an unfinished week never breaks anything. There are no daily streaks.
--   * Days come from each run's own time, so a late sync or import never breaks a streak. A run held
--     only because it arrived late (late_upload) still counts.
--   * Each week keeps the goal it had, so changing the goal later doesn't rewrite history.
--   * A frozen week (a paused plan, Phase 3) neither breaks nor extends the streak.
-- Badges are derived from the runner's data and recomputed whenever it changes, so deleting the run
-- that earned one takes it away. Badges never award XP.

create table private.streak_weeks (
  user_id uuid not null references auth.users (id) on delete cascade,
  week_start date not null,
  goal_days smallint check (goal_days is null or goal_days between 1 and 7),
  active_days smallint not null default 0 check (active_days between 0 and 7),
  met boolean not null default false,
  frozen boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, week_start)
);

create table private.user_badges (
  user_id uuid not null references auth.users (id) on delete cascade,
  badge text not null check (char_length(badge) between 1 and 40),
  earned_at timestamptz not null,
  primary key (user_id, badge)
);

-- Runs that count toward streaks: accepted runs, and runs held only for arriving late.
create or replace function private.streak_counts_run(r public.runs)
returns boolean
language sql immutable
as $$
  select r.activity_type = 'run' and r.deleted_at is null
     and (r.status = 'accepted' or (r.status = 'review' and r.reason_codes = array['late_upload']::text[]))
$$;

create or replace function private.week_active_days(p_user uuid, p_week date)
returns integer
language sql stable security definer set search_path = ''
as $$
  select count(*)::integer from (
    select a.competition_date
    from private.run_day_allocations a
    join public.runs r on r.id = a.run_id
    where a.owner_id = p_user and a.competition_date >= p_week and a.competition_date < p_week + 7
      and private.streak_counts_run(r)
    group by a.competition_date
    having sum(a.distance_cm) >= 100000 and sum(a.active_ms) >= 300000
  ) d
$$;

create or replace function private.has_active_profile(p_user uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.profiles where user_id = p_user and status = 'active')
$$;

create or replace function private.refresh_streak_week(p_user uuid, p_week date)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_days integer;
  v_goal smallint;
  v_row private.streak_weeks;
  v_current boolean := p_week >= private.current_week_start();
begin
  if p_week is null or not private.has_active_profile(p_user) then
    return;
  end if;
  v_days := private.week_active_days(p_user, p_week);
  select * into v_row from private.streak_weeks where user_id = p_user and week_start = p_week for update;
  if not found and v_days = 0 then
    return;
  end if;
  -- The current week follows the runner's goal; a past week keeps the goal it had.
  if v_current or v_row.user_id is null then
    select goal_days into v_goal from public.profiles where user_id = p_user;
  else
    v_goal := v_row.goal_days;
  end if;
  insert into private.streak_weeks (user_id, week_start, goal_days, active_days, met)
  values (p_user, p_week, v_goal, v_days, v_days >= coalesce(v_goal, 1))
  on conflict (user_id, week_start) do update
    set goal_days = excluded.goal_days, active_days = excluded.active_days, met = excluded.met, updated_at = now();
end
$$;

-- Current streak, best streak and this week's progress.
create or replace function private.streak_state(p_user uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_week date := private.current_week_start();
  v_this private.streak_weeks;
  v_cursor date;
  v_row private.streak_weeks;
  v_current integer := 0;
  v_best integer := 0;
  v_run integer := 0;
  v_expected date;
  v_goal smallint;
begin
  select goal_days into v_goal from public.profiles where user_id = p_user;
  select * into v_this from private.streak_weeks where user_id = p_user and week_start = v_week;
  if v_this.met and not v_this.frozen then
    v_current := 1;
  end if;
  v_cursor := v_week - 7;
  loop
    select * into v_row from private.streak_weeks where user_id = p_user and week_start = v_cursor;
    exit when not found;
    if v_row.frozen then
      v_cursor := v_cursor - 7;
      continue;
    end if;
    exit when not v_row.met;
    v_current := v_current + 1;
    v_cursor := v_cursor - 7;
  end loop;

  -- Best: the longest run of consecutive met weeks; a frozen week is skipped, a missing week breaks.
  for v_row in select * from private.streak_weeks where user_id = p_user order by week_start loop
    if v_row.frozen then
      v_expected := v_row.week_start + 7;
      continue;
    end if;
    if v_row.met and (v_expected is null or v_row.week_start = v_expected) then
      v_run := v_run + 1;
    elsif v_row.met then
      v_run := 1;
    else
      v_run := 0;
    end if;
    v_best := greatest(v_best, v_run);
    v_expected := v_row.week_start + 7;
  end loop;

  return jsonb_build_object(
    'current_weeks', v_current,
    'best_weeks', greatest(v_best, v_current),
    'this_week', jsonb_build_object(
      'week_start', v_week,
      'active_days', coalesce(v_this.active_days, 0),
      'goal_days', coalesce(v_this.goal_days, v_goal),
      'met', coalesce(v_this.met, false),
      'frozen', coalesce(v_this.frozen, false)),
    -- The streak is still alive while the current week can meet the goal.
    'at_stake', v_current > 0 and not coalesce(v_this.met, false)
  );
end
$$;

create or replace function private.refresh_badges(p_user uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_xp integer;
  v_best integer;
begin
  if not private.has_active_profile(p_user) then
    return;
  end if;
  v_xp := private.lifetime_xp(p_user);
  v_best := (private.streak_state(p_user) ->> 'best_weeks')::integer;

  -- One statement: the eligible set, then delete what is no longer earned and upsert the rest.
  -- Tier and streak badges keep the time they were first seen; run badges follow their run.
  with accepted as (
    select r.started_at,
           row_number() over (order by r.started_at, r.id) as n,
           sum(coalesce(r.distance_cm, 0)) over (order by r.started_at, r.id) as cum_cm
    from public.runs r
    where r.owner_id = p_user and r.status = 'accepted' and r.deleted_at is null and r.activity_type = 'run'
  ),
  eligible (badge, earned_at) as (
    select b.badge, a.started_at
    from (values ('first_run', 1), ('runs_10', 10), ('runs_50', 50), ('runs_100', 100), ('runs_250', 250)) b(badge, n)
    join accepted a on a.n = b.n
    union all
    select b.badge, (select min(a.started_at) from accepted a where a.cum_cm >= b.cm)
    from (values ('distance_100k', 10000000::numeric), ('distance_500k', 50000000), ('distance_1000k', 100000000),
                 ('distance_5000k', 500000000)) b(badge, cm)
    where exists (select 1 from accepted a where a.cum_cm >= b.cm)
    union all
    select 'first_' || x.effort, min(x.run_started_at)
    from private.record_efforts(p_user) x
    where x.effort in ('5k', '10k', 'half', 'marathon')
    group by x.effort
    union all
    select b.badge, now()
    from (values ('tier_stride', 500), ('tier_tempo', 1500), ('tier_surge', 4000), ('tier_elite', 10000)) b(badge, xp)
    where v_xp >= b.xp
    union all
    select b.badge, now()
    from (values ('streak_4', 4), ('streak_12', 12), ('streak_26', 26), ('streak_52', 52)) b(badge, weeks)
    where v_best >= b.weeks
  ),
  removed as (
    delete from private.user_badges u
    where u.user_id = p_user and not exists (select 1 from eligible e where e.badge = u.badge)
  )
  insert into private.user_badges (user_id, badge, earned_at)
  select p_user, e.badge, e.earned_at from eligible e
  on conflict (user_id, badge) do update
    set earned_at = case when excluded.badge like 'tier\_%' or excluded.badge like 'streak\_%'
                         then private.user_badges.earned_at else excluded.earned_at end;
end
$$;

-- True the first time a key is seen in this transaction.
create or replace function private.once_per_txn(p_key text)
returns boolean
language plpgsql
as $$
declare
  v_seen text := coalesce(current_setting('paceleague.once', true), '');
begin
  if position('|' || p_key || '|' in v_seen) > 0 then
    return false;
  end if;
  perform set_config('paceleague.once', v_seen || '|' || p_key || '|', true);
  return true;
end
$$;

-- Deferred to commit, so they see the finished state of finalize, deletion, edits and reviews.
create or replace function private.on_run_progress()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_week date;
begin
  if tg_op = 'UPDATE' and old.status is not distinct from new.status and old.deleted_at is not distinct from new.deleted_at
     and old.activity_type is not distinct from new.activity_type and old.distance_cm is not distinct from new.distance_cm
     and old.started_at is not distinct from new.started_at and old.reason_codes is not distinct from new.reason_codes
     and old.segments is not distinct from new.segments then
    return null;
  end if;
  for v_week in
    select distinct private.week_start(private.competition_date(t))
    from unnest(array[old.started_at, old.ended_at, new.started_at, new.ended_at]) t
    where t is not null
  loop
    if private.once_per_txn('week:' || new.owner_id || ':' || v_week) then
      perform private.refresh_streak_week(new.owner_id, v_week);
    end if;
  end loop;
  if private.once_per_txn('badges:' || new.owner_id) then
    perform private.refresh_badges(new.owner_id);
  end if;
  return null;
end
$$;

create constraint trigger runs_progress after update on public.runs
  deferrable initially deferred
  for each row execute function private.on_run_progress();

create or replace function private.on_xp_progress()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if private.once_per_txn('badges:' || new.user_id) then
    perform private.refresh_badges(new.user_id);
  end if;
  return null;
end
$$;

create constraint trigger profile_stats_progress after insert or update on private.profile_stats
  deferrable initially deferred
  for each row execute function private.on_xp_progress();

create or replace function private.on_goal_change()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if old.goal_days is distinct from new.goal_days then
    perform private.refresh_streak_week(new.user_id, private.current_week_start());
    perform private.refresh_badges(new.user_id);
  end if;
  return null;
end
$$;

create constraint trigger profiles_goal_progress after update on public.profiles
  deferrable initially deferred
  for each row execute function private.on_goal_change();

create or replace function public.get_streak()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
begin
  return private.streak_state(v_uid);
end
$$;

create or replace function public.get_badges()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
begin
  return jsonb_build_object(
    'earned', coalesce((select jsonb_agg(jsonb_build_object('badge', badge, 'earned_at_ms', private.ts_to_ms(earned_at))
                                         order by earned_at, badge)
                        from private.user_badges where user_id = v_uid), '[]'::jsonb),
    'progress', jsonb_build_object(
      'accepted_runs', (select count(*) from public.runs
                        where owner_id = v_uid and status = 'accepted' and deleted_at is null and activity_type = 'run'),
      'distance_m', coalesce((select sum(distance_cm) / 100.0 from public.runs
                              where owner_id = v_uid and status = 'accepted' and deleted_at is null and activity_type = 'run'), 0),
      'lifetime_xp', private.lifetime_xp(v_uid),
      'streak', private.streak_state(v_uid))
  );
end
$$;

-- Backfill for runners with saved runs.
do $$
declare
  v_user uuid;
  v_week date;
begin
  for v_user in select user_id from public.profiles where status = 'active' loop
    for v_week in
      select distinct private.week_start(a.competition_date) from private.run_day_allocations a where a.owner_id = v_user
    loop
      perform private.refresh_streak_week(v_user, v_week);
    end loop;
    perform private.refresh_badges(v_user);
  end loop;
end
$$;

select private.apply_function_grants();
