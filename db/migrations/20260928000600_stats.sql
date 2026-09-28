-- Stats and trends (docs/ROADMAP.md 1.7): totals by week, month or year over any range up to ten
-- years, with the same range a year earlier for comparison. Saved runs of every outcome count
-- (this is the runner's own history, not the league); deleted runs don't.

create or replace function public.get_stats(
  p_from date,
  p_to date,
  p_bucket text default 'month',
  p_activity text default 'run'
)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_first date;
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 3660 then
    perform private.fail('invalid_input', 'range');
  end if;
  if p_bucket is null or p_bucket not in ('week', 'month', 'year') then
    perform private.fail('invalid_input', 'bucket');
  end if;
  if p_activity is null or p_activity not in ('run', 'walk', 'hike', 'ride', 'other', 'all') then
    perform private.fail('invalid_input', 'activity');
  end if;
  v_first := case p_bucket
               when 'week' then private.week_start(p_from)
               when 'month' then date_trunc('month', p_from)::date
               else date_trunc('year', p_from)::date end;

  return (
    with runs as (
      select private.competition_date(r.started_at) as day,
             coalesce(r.distance_cm / 100.0, r.client_distance_m::numeric) as distance_m,
             coalesce(r.active_ms, r.client_active_ms) as active_ms
      from public.runs r
      where r.owner_id = v_uid and r.deleted_at is null and r.status in ('accepted', 'review', 'personal_only')
        and (p_activity = 'all' or r.activity_type = p_activity)
        and private.competition_date(r.started_at) between (p_from - interval '1 year')::date and p_to
    ),
    buckets as (
      select b::date as bucket_start,
             (case p_bucket when 'week' then b + interval '7 days' when 'month' then b + interval '1 month'
                            else b + interval '1 year' end)::date as bucket_end
      from generate_series(v_first, p_to,
                           case p_bucket when 'week' then interval '7 days' when 'month' then interval '1 month'
                                         else interval '1 year' end) b
    ),
    current_range as (select * from runs where day between p_from and p_to),
    previous_range as (select * from runs where day between (p_from - interval '1 year')::date and (p_to - interval '1 year')::date)
    select jsonb_build_object(
      'from', p_from,
      'to', p_to,
      'bucket', p_bucket,
      'activity', p_activity,
      'buckets', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'start', b.bucket_start,
                 'runs', (select count(*) from current_range c where c.day >= b.bucket_start and c.day < b.bucket_end),
                 'days', (select count(distinct c.day) from current_range c where c.day >= b.bucket_start and c.day < b.bucket_end),
                 'distance_m', (select coalesce(sum(c.distance_m), 0) from current_range c
                                where c.day >= b.bucket_start and c.day < b.bucket_end),
                 'active_ms', (select coalesce(sum(c.active_ms), 0) from current_range c
                               where c.day >= b.bucket_start and c.day < b.bucket_end))
               order by b.bucket_start)
        from buckets b), '[]'::jsonb),
      'total', (select jsonb_build_object('runs', count(*), 'days', count(distinct day),
                                          'distance_m', coalesce(sum(distance_m), 0), 'active_ms', coalesce(sum(active_ms), 0),
                                          'longest_m', coalesce(max(distance_m), 0))
                from current_range),
      'previous_year', (select jsonb_build_object('runs', count(*), 'days', count(distinct day),
                                                  'distance_m', coalesce(sum(distance_m), 0), 'active_ms', coalesce(sum(active_ms), 0),
                                                  'longest_m', coalesce(max(distance_m), 0))
                        from previous_range)
    )
  );
end
$$;

select private.apply_function_grants();
