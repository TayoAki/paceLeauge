-- Weekly goal days (docs/ROADMAP.md 2.5 and Part A): a day counts toward the weekly goal when its
-- goal-counting runs reach the active-day minimum, whether or not they earned XP. Runs kept as
-- history (no route, indoor, typed in, a file) count for the goal and the streak, so the week
-- summary shows them as active days too, the same way the streak counts them.

create or replace function private.goal_days_in(p_user uuid, p_from date, p_to date)
returns table (competition_date date)
language sql stable security definer set search_path = ''
as $$
  select a.competition_date
  from private.run_day_allocations a
  join public.runs r on r.id = a.run_id
  where a.owner_id = p_user and a.competition_date >= p_from and a.competition_date < p_to
    and private.streak_counts_run(r)
  group by a.competition_date
  having sum(a.distance_cm) >= 100000 and sum(a.active_ms) >= 300000
$$;

create or replace function private.week_active_days(p_user uuid, p_week date)
returns integer
language sql stable security definer set search_path = ''
as $$
  select count(*)::integer from private.goal_days_in(p_user, p_week, p_week + 7)
$$;

create or replace function private.week_summary(p_user uuid, p_week date)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  with goal as (
    select competition_date from private.goal_days_in(p_user, p_week, p_week + 7)
  ),
  days as (
    select d::date as day, ds.xp, ds.distance_cm, ds.active_ms,
           coalesce(ds.active_day_bonus, 0) > 0 or exists (select 1 from goal g where g.competition_date = d::date) as active
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
                                                 'active', active,
                                                 'distance_cm', coalesce(distance_cm, 0),
                                                 'active_ms', coalesce(active_ms, 0)) order by day) from days),
    'active_days', (select count(*) from days where active),
    'weekly_xp', (select coalesce(sum(xp), 0) from (select xp from days where xp is not null order by xp desc limit 3) top3),
    'goal_days', (select goal_days from public.profiles where user_id = p_user)
  )
$$;

select private.apply_function_grants();
