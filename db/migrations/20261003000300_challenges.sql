-- Challenges (docs/ROADMAP.md 4.6): monthly challenges for everyone, and challenges a league's
-- owner or a club's admins set for their group, each with a badge.
--
-- A challenge measures days or the capped score, never raw distance:
--   * active_days: days with at least 1 km and 5 minutes of accepted running (the rule for the
--     daily bonus and for streaks);
--   * capped_score: each week's best three days of XP inside the month, added up.
-- Runs are added up per day before anything is counted, and a day's XP stops at 125 (100 for
-- 10 km, plus 25 for the active day). One very long run is therefore one day and 125 points at
-- most, and splitting a day's running into many runs changes nothing.
-- Only accepted runs count, and only runs the server had by a day after the challenge ended (the
-- league board's rule), so a run typed in weeks later can't finish an old challenge. Progress is
-- worked out when it's read: deleting a run, or a review rejecting it, takes the badge back, as
-- with the other badges (1.8). Challenges never award XP.

-- ---------------------------------------------------------------------------------------
-- Challenges and who joined them
-- ---------------------------------------------------------------------------------------
create table private.challenges (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (scope in ('global', 'league', 'club')),
  league_id uuid references public.leagues (id) on delete cascade,
  club_id uuid references private.clubs (id) on delete cascade,
  metric text not null check (metric in ('active_days', 'capped_score')),
  target integer not null check (target between 1 and 5000),
  starts_on date not null,
  ends_on date not null,
  -- A name the group chose; otherwise one is made from the measure and the month.
  title text check (title is null or char_length(title) between 3 and 40),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint challenges_one_group check (
    (scope = 'global' and league_id is null and club_id is null)
    or (scope = 'league' and league_id is not null and club_id is null)
    or (scope = 'club' and club_id is not null and league_id is null)),
  constraint challenges_window check (ends_on >= starts_on and ends_on - starts_on < 31)
);
create unique index challenges_global_month on private.challenges (starts_on, metric) where scope = 'global';
create index challenges_league_idx on private.challenges (league_id, ends_on) where league_id is not null;
create index challenges_club_idx on private.challenges (club_id, ends_on) where club_id is not null;

create table private.challenge_entries (
  challenge_id uuid not null references private.challenges (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (challenge_id, user_id)
);
create index challenge_entries_user_idx on private.challenge_entries (user_id, joined_at);

-- The first day of this competition month (0) or the next (1), in the league time zone.
create or replace function private.challenge_month(p_offset integer)
returns date
language sql stable
as $$
  select (date_trunc('month', private.competition_date(now())::timestamp) + make_interval(months => p_offset))::date
$$;

create or replace function private.month_last_day(p_month date)
returns date
language sql immutable
as $$
  select (p_month::timestamp + interval '1 month')::date - 1
$$;

create or replace function private.challenge_title(p_challenge private.challenges)
returns text
language sql stable
as $$
  select coalesce(p_challenge.title,
    case p_challenge.metric
      when 'active_days' then 'Run ' || p_challenge.target || ' days in ' || to_char(p_challenge.starts_on::timestamp, 'FMMonth')
      else 'Score ' || p_challenge.target || ' in ' || to_char(p_challenge.starts_on::timestamp, 'FMMonth') end)
$$;

-- Runs the server first had after this don't count: the end of the day after the last day.
create or replace function private.challenge_cutoff(p_challenge private.challenges)
returns timestamptz
language sql stable
as $$
  select private.day_start(p_challenge.ends_on + 1) + interval '24 hours'
$$;

create or replace function private.challenge_state(p_challenge private.challenges)
returns text
language sql stable
as $$
  select case
    when private.competition_date(now()) < p_challenge.starts_on then 'upcoming'
    when private.competition_date(now()) <= p_challenge.ends_on then 'open'
    when now() < private.challenge_cutoff(p_challenge) then 'closing'
    else 'final' end
$$;

-- ---------------------------------------------------------------------------------------
-- Progress: each runner's days or capped score in the challenge, and the day they reached the
-- target. Per day: the league board's totals (accepted runs, the indoor cap), then the daily
-- cap. The score on any day is every earlier week's best three days plus this week's best
-- three so far.
-- ---------------------------------------------------------------------------------------
create or replace function private.challenge_results(p_challenge private.challenges, p_users uuid[])
returns table (user_id uuid, progress integer, reached_on date)
language sql stable security definer set search_path = ''
as $$
  with day_totals as (
    select a.owner_id, a.competition_date,
           private.credited_distance_cm(coalesce(sum(a.distance_cm) filter (where not r.indoor), 0)::bigint,
                                        coalesce(sum(a.distance_cm) filter (where r.indoor), 0)::bigint) as distance_cm,
           sum(a.active_ms)::bigint as active_ms
    from private.run_day_allocations a
    join public.runs r on r.id = a.run_id
    where a.owner_id = any (p_users)
      and a.competition_date between p_challenge.starts_on and p_challenge.ends_on
      and r.status = 'accepted' and r.scoring_state = 'applied' and r.deleted_at is null
      and r.first_received_at <= private.challenge_cutoff(p_challenge)
    group by a.owner_id, a.competition_date
  ),
  days as (
    select t.owner_id, t.competition_date, private.week_start(t.competition_date) as week, x.xp, x.active_day_bonus > 0 as active
    from day_totals t
    cross join lateral private.daily_xp(t.distance_cm, t.active_ms) x
  ),
  running as (
    select d.owner_id, d.competition_date, d.week,
           count(*) filter (where d.active) over (partition by d.owner_id order by d.competition_date) as days_so_far,
           array_agg(d.xp) over (partition by d.owner_id, d.week order by d.competition_date) as week_xp
    from days d
  ),
  week_so_far as (
    select r.owner_id, r.competition_date, r.week, r.days_so_far,
           (select coalesce(sum(v), 0) from (select v from unnest(r.week_xp) v order by v desc limit 3) top)::integer as week_score
    from running r
  ),
  earlier_weeks as (
    select w.owner_id, w.week,
           coalesce(sum(w.best) over (partition by w.owner_id order by w.week rows between unbounded preceding and 1 preceding), 0)::integer as earlier
    from (select s.owner_id, s.week, max(s.week_score) as best from week_so_far s group by s.owner_id, s.week) w
  ),
  as_of as (
    select s.owner_id, s.competition_date,
           case p_challenge.metric when 'active_days' then s.days_so_far::integer else e.earlier + s.week_score end as score
    from week_so_far s
    join earlier_weeks e on e.owner_id = s.owner_id and e.week = s.week
  ),
  totals as (
    select a.owner_id, max(a.score) as progress, min(a.competition_date) filter (where a.score >= p_challenge.target) as reached_on
    from as_of a
    group by a.owner_id
  )
  select u.id, coalesce(t.progress, 0), t.reached_on
  from unnest(p_users) as u(id)
  left join totals t on t.owner_id = u.id
$$;

-- ---------------------------------------------------------------------------------------
-- Who sees and runs a challenge
-- ---------------------------------------------------------------------------------------
create or replace function private.challenge_visible(p_user uuid, p_challenge private.challenges)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select case p_challenge.scope
    when 'global' then true
    when 'league' then exists (select 1 from public.league_members m join public.leagues l on l.id = m.league_id and l.status = 'active'
                               where m.league_id = p_challenge.league_id and m.user_id = p_user and m.left_at is null)
    else exists (select 1 from private.club_members m join private.clubs c on c.id = m.club_id and c.status = 'active'
                 where m.club_id = p_challenge.club_id and m.user_id = p_user and m.left_at is null)
  end
$$;

-- A league's owner, or a club's owner and admins.
create or replace function private.can_manage_challenge(p_user uuid, p_challenge private.challenges)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select case p_challenge.scope
    when 'league' then exists (select 1 from public.league_members m
                               where m.league_id = p_challenge.league_id and m.user_id = p_user and m.left_at is null and m.role = 'owner')
    when 'club' then exists (select 1 from private.club_members m
                             where m.club_id = p_challenge.club_id and m.user_id = p_user and m.left_at is null and m.role in ('owner', 'admin'))
    else false end
$$;

create or replace function private.visible_challenge(p_user uuid, p_challenge_id uuid)
returns private.challenges
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_challenge private.challenges;
begin
  select * into v_challenge from private.challenges where id = p_challenge_id;
  if not found or not private.challenge_visible(p_user, v_challenge) then
    perform private.fail('not_found');
  end if;
  return v_challenge;
end
$$;

-- Who's in a challenge: runners who joined and still have an account, and for a league's or a
-- club's challenge, are still in the group.
create or replace function private.challenge_people(p_challenge private.challenges)
returns table (user_id uuid, joined_at timestamptz)
language sql stable security definer set search_path = ''
as $$
  select e.user_id, e.joined_at
  from private.challenge_entries e
  join public.profiles p on p.user_id = e.user_id and p.status = 'active'
  where e.challenge_id = p_challenge.id
    and case p_challenge.scope
      when 'league' then exists (select 1 from public.league_members m
                                 where m.league_id = p_challenge.league_id and m.user_id = e.user_id and m.left_at is null)
      when 'club' then exists (select 1 from private.club_members m
                               where m.club_id = p_challenge.club_id and m.user_id = e.user_id and m.left_at is null)
      else true end
$$;

create or replace function private.challenge_json(p_challenge private.challenges, p_viewer uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'id', p_challenge.id,
    'scope', p_challenge.scope,
    'league_id', p_challenge.league_id,
    'club_id', p_challenge.club_id,
    'group_name', case p_challenge.scope
                    when 'league' then (select l.name from public.leagues l where l.id = p_challenge.league_id)
                    when 'club' then (select c.name from private.clubs c where c.id = p_challenge.club_id) end,
    'metric', p_challenge.metric,
    'target', p_challenge.target,
    'title', private.challenge_title(p_challenge),
    'custom_title', p_challenge.title is not null,
    'starts_on', p_challenge.starts_on,
    'ends_on', p_challenge.ends_on,
    'state', private.challenge_state(p_challenge),
    'joined', exists (select 1 from private.challenge_entries e where e.challenge_id = p_challenge.id and e.user_id = p_viewer),
    'participants', (select count(*) from private.challenge_people(p_challenge)),
    -- The viewer's own progress, joined or not ("you've run 5 days this month already").
    'progress', r.progress,
    'completed', r.reached_on is not null,
    'completed_on', r.reached_on,
    'can_manage', private.can_manage_challenge(p_viewer, p_challenge),
    'is_creator', coalesce(p_challenge.created_by = p_viewer, false),
    'created_by', case when p_challenge.created_by is null or private.are_blocked(p_viewer, p_challenge.created_by) then null
                       else (select p.alias from public.profiles p where p.user_id = p_challenge.created_by and p.status = 'active') end)
  from private.challenge_results(p_challenge, array[p_viewer]) r
$$;

-- A league's or club's challenge board: everyone who joined, most days (or points) first; a tie
-- goes to whoever reached the target first. Blocked runners stay on it without a name.
create or replace function private.challenge_board(p_challenge private.challenges, p_viewer uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  with people as (
    select pp.user_id, p.alias, coalesce(ps.lifetime_xp, 0) as lifetime_xp
    from private.challenge_people(p_challenge) pp
    join public.profiles p on p.user_id = pp.user_id
    left join private.profile_stats ps on ps.user_id = pp.user_id
  ),
  scored as (
    select pe.*, r.progress, r.reached_on,
           pe.user_id <> p_viewer and private.are_blocked(p_viewer, pe.user_id) as hidden
    from people pe
    join private.challenge_results(p_challenge, (select coalesce(array_agg(x.user_id), '{}'::uuid[]) from people x)) r
      on r.user_id = pe.user_id
  ),
  ranked as (
    select s.*, rank() over (order by s.progress desc) as place,
           row_number() over (order by s.progress desc, s.reached_on nulls last, lower(s.alias) collate "C", s.user_id) as n
    from scored s
  ),
  shown as (
    select jsonb_build_object(
             'position', r.n,
             'rank', r.place,
             'alias', case when r.hidden then null else r.alias end,
             'tier', case when r.hidden then null else private.tier_name(r.lifetime_xp) end,
             'progress', r.progress,
             'completed', r.reached_on is not null,
             'completed_on', r.reached_on,
             'is_me', r.user_id = p_viewer,
             'hidden', r.hidden) as j,
           r.n, r.user_id
    from ranked r
  )
  select jsonb_build_object(
    'rows', coalesce((select jsonb_agg(s.j order by s.n) from shown s where s.n <= 100), '[]'::jsonb),
    'me', (select s.j from shown s where s.user_id = p_viewer),
    'finished', (select count(*) from scored s where s.reached_on is not null))
$$;

-- ---------------------------------------------------------------------------------------
-- The monthly challenges everyone can join: 12 days, and 750 points from each week's best three
-- days (about three 4 km runs a week)
-- ---------------------------------------------------------------------------------------
create or replace function private.ensure_monthly_challenges(p_month date)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  insert into private.challenges (scope, metric, target, starts_on, ends_on)
  values ('global', 'active_days', 12, p_month, private.month_last_day(p_month)),
         ('global', 'capped_score', 750, p_month, private.month_last_day(p_month))
  on conflict (starts_on, metric) where scope = 'global' do nothing;
end
$$;

-- ---------------------------------------------------------------------------------------
-- Reading challenges
-- ---------------------------------------------------------------------------------------
-- Current: this month's challenges for everyone (next month's from a week before it starts),
-- and the challenges of the runner's leagues and clubs, until their results are final. Past:
-- the ones the runner joined, newest first.
create or replace function public.list_challenges()
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_today date := private.competition_date(now());
begin
  perform private.ensure_monthly_challenges(private.challenge_month(0));
  perform private.ensure_monthly_challenges(private.challenge_month(1));
  return jsonb_build_object(
    'current', coalesce((
      select jsonb_agg(private.challenge_json(c, v_uid)
                       order by c.starts_on, (c.scope = 'global') desc, c.ends_on, c.metric, c.created_at)
      from (select x.id from private.challenges x
            where x.scope = 'global' and x.ends_on >= v_today - 2 and x.starts_on <= v_today + 7
            union
            select x.id from private.challenges x
            join public.league_members m on m.league_id = x.league_id and m.user_id = v_uid and m.left_at is null
            where x.ends_on >= v_today - 2
            union
            select x.id from private.challenges x
            join private.club_members m on m.club_id = x.club_id and m.user_id = v_uid and m.left_at is null
            where x.ends_on >= v_today - 2) pick
      join private.challenges c on c.id = pick.id
      where now() < private.challenge_cutoff(c) and private.challenge_visible(v_uid, c)), '[]'::jsonb),
    'past', coalesce((
      select jsonb_agg(private.challenge_json(c, v_uid) order by c.ends_on desc, c.created_at desc)
      from (select x.id from private.challenges x
            join private.challenge_entries e on e.challenge_id = x.id and e.user_id = v_uid
            where now() >= private.challenge_cutoff(x) and private.challenge_visible(v_uid, x)
            order by x.ends_on desc, x.created_at desc
            limit 12) pick
      join private.challenges c on c.id = pick.id), '[]'::jsonb));
end
$$;

create or replace function public.get_challenge(p_challenge_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_challenge private.challenges := private.visible_challenge(v_uid, p_challenge_id);
begin
  return private.challenge_json(v_challenge, v_uid) || jsonb_build_object(
    'board', case when v_challenge.scope = 'global' then null else private.challenge_board(v_challenge, v_uid) end);
end
$$;

-- ---------------------------------------------------------------------------------------
-- Joining and leaving: open until the last day
-- ---------------------------------------------------------------------------------------
create or replace function public.join_challenge(p_challenge_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_challenge private.challenges := private.visible_challenge(v_uid, p_challenge_id);
begin
  if private.challenge_state(v_challenge) not in ('upcoming', 'open') then
    perform private.fail('challenge_closed');
  end if;
  insert into private.challenge_entries (challenge_id, user_id) values (v_challenge.id, v_uid) on conflict do nothing;
  return public.get_challenge(v_challenge.id);
end
$$;

create or replace function public.leave_challenge(p_challenge_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_challenge private.challenges := private.visible_challenge(v_uid, p_challenge_id);
begin
  if private.challenge_state(v_challenge) not in ('upcoming', 'open') then
    perform private.fail('challenge_closed');
  end if;
  delete from private.challenge_entries where challenge_id = v_challenge.id and user_id = v_uid;
  return jsonb_build_object('left', true, 'challenge_id', v_challenge.id);
end
$$;

-- ---------------------------------------------------------------------------------------
-- A league's owner or a club's admins set a challenge for this month or next: days (2 up to
-- every day of the month) or points (100–1,500, which every month's weeks can reach). Three at
-- a time per group. League members hear about it; a club sees it on the club page.
-- ---------------------------------------------------------------------------------------
create or replace function public.create_challenge(
  p_metric text,
  p_target integer,
  p_month_offset integer default 0,
  p_title text default null,
  p_league_id uuid default null,
  p_club_id uuid default null
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_title text := nullif(private.normalize_name(p_title), '');
  v_start date;
  v_end date;
  v_problem text;
  v_challenge private.challenges;
  v_alias text;
  v_league_name text;
  v_to record;
begin
  if (p_league_id is null) = (p_club_id is null) then
    perform private.fail('invalid_input', 'group');
  end if;
  if p_club_id is not null then
    perform private.require_club_admin(v_uid, p_club_id);
    perform 1 from private.clubs where id = p_club_id for update;
  else
    perform private.require_league_owner(v_uid, p_league_id);
    perform 1 from public.leagues where id = p_league_id for update;
  end if;
  if p_metric is null or p_metric not in ('active_days', 'capped_score') then
    perform private.fail('invalid_input', 'metric');
  end if;
  if p_month_offset is null or p_month_offset not in (0, 1) then
    perform private.fail('invalid_input', 'month');
  end if;
  v_start := private.challenge_month(p_month_offset);
  v_end := private.month_last_day(v_start);
  if p_target is null
     or (p_metric = 'active_days' and (p_target < 2 or p_target > v_end - v_start + 1))
     or (p_metric = 'capped_score' and (p_target < 100 or p_target > 1500)) then
    perform private.fail('invalid_input', 'target');
  end if;
  if v_title is not null then
    v_problem := private.name_problem(v_title, 3, 40);
    if v_problem = 'invalid' then
      perform private.fail('challenge_invalid');
    elsif v_problem = 'not_allowed' then
      perform private.fail('challenge_not_allowed');
    end if;
  end if;
  if (select count(*) from private.challenges c
      where (c.league_id = p_league_id or c.club_id = p_club_id) and c.ends_on >= private.competition_date(now())) >= 3 then
    perform private.fail('challenge_limit');
  end if;
  perform private.check_rate_limit('challenge:' || v_uid, 10, interval '1 day');

  insert into private.challenges (scope, league_id, club_id, metric, target, starts_on, ends_on, title, created_by)
  values (case when p_club_id is not null then 'club' else 'league' end, p_league_id, p_club_id, p_metric, p_target,
          v_start, v_end, v_title, v_uid)
  returning * into v_challenge;
  insert into private.challenge_entries (challenge_id, user_id) values (v_challenge.id, v_uid);

  if p_league_id is not null then
    select alias into v_alias from public.profiles where user_id = v_uid;
    select name into v_league_name from public.leagues where id = p_league_id;
    for v_to in select m.user_id from public.league_members m where m.league_id = p_league_id and m.left_at is null and m.user_id <> v_uid loop
      perform private.notify(v_to.user_id, v_uid, 'league', 'New challenge in ' || v_league_name,
        v_alias || ' started “' || private.challenge_title(v_challenge) || '”. Are you in?',
        '/league/challenges/' || v_challenge.id, 'challenge:' || v_challenge.id || ':' || v_to.user_id);
    end loop;
  end if;
  return public.get_challenge(v_challenge.id);
end
$$;

-- Taking a challenge down before it ends: the league's owner or the club's admins. Removing
-- someone else's is recorded like the other admin removals.
create or replace function public.remove_challenge(p_challenge_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_challenge private.challenges;
begin
  select * into v_challenge from private.challenges where id = p_challenge_id for update;
  if not found or v_challenge.scope = 'global' or not private.challenge_visible(v_uid, v_challenge) then
    perform private.fail('not_found');
  end if;
  if not private.can_manage_challenge(v_uid, v_challenge) then
    perform private.fail('not_allowed');
  end if;
  if private.challenge_state(v_challenge) not in ('upcoming', 'open') then
    perform private.fail('challenge_closed');
  end if;
  if v_challenge.created_by is distinct from v_uid then
    insert into private.moderation_actions (moderator_id, action, reason, target_user_id, target_league_id, target_club_id)
    values (v_uid, 'challenge_removed', 'Removed by the group''s admins', v_challenge.created_by, v_challenge.league_id, v_challenge.club_id);
  end if;
  delete from private.challenges where id = v_challenge.id;
  return jsonb_build_object('removed', true);
end
$$;

-- ---------------------------------------------------------------------------------------
-- Badges: one for each challenge finished, kept while the runs behind it stand
-- ---------------------------------------------------------------------------------------
create or replace function private.challenge_badges(p_user uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'challenge_id', c.id,
           'title', private.challenge_title(c),
           'scope', c.scope,
           'group_name', case c.scope
                           when 'league' then (select l.name from public.leagues l where l.id = c.league_id)
                           when 'club' then (select k.name from private.clubs k where k.id = c.club_id) end,
           'metric', c.metric,
           'target', c.target,
           'starts_on', c.starts_on,
           'ends_on', c.ends_on,
           'earned_on', r.reached_on)
         order by r.reached_on, c.created_at), '[]'::jsonb)
  from private.challenge_entries e
  join private.challenges c on c.id = e.challenge_id
  cross join lateral private.challenge_results(c, array[p_user]) r
  where e.user_id = p_user and r.reached_on is not null
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
    'challenges', private.challenge_badges(v_uid),
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

-- ---------------------------------------------------------------------------------------
-- Reports on challenges reach the moderation queue
-- ---------------------------------------------------------------------------------------
alter table private.reports drop constraint reports_target_kind_check;
alter table private.reports add constraint reports_target_kind_check
  check (target_kind in ('member', 'league', 'runner', 'run', 'comment', 'club', 'group_run', 'challenge'));
alter table private.reports add column target_challenge_id uuid references private.challenges (id) on delete set null;

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
  else
    perform private.fail('invalid_input', 'kind');
  end if;
  perform private.check_rate_limit('report:' || v_uid, 20, interval '1 day');
  insert into private.reports (reporter_id, target_kind, target_user_id, target_league_id, target_run_id, target_comment_id,
                               target_club_id, target_group_run_id, target_challenge_id, reason_code, content_snapshot)
  values (v_uid, p_kind, v_other, case when p_kind = 'challenge' then v_challenge.league_id end,
          case when p_kind in ('run', 'comment') then v_run.id end,
          case when p_kind = 'comment' then v_comment.id end,
          case when p_kind = 'club' then v_club.id when p_kind = 'group_run' then v_group_run.club_id
               when p_kind = 'challenge' then v_challenge.club_id end,
          case when p_kind = 'group_run' then v_group_run.id end,
          case when p_kind = 'challenge' then v_challenge.id end, p_reason, v_snapshot)
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

-- Other open reports about the same thing are settled before the action runs: removing a group
-- run or a challenge clears the reports' link to it, after which they'd no longer match.
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

  -- Taking something down settles every open report about it.
  if p_action in ('remove_comment', 'hide_run', 'reset_club', 'close_club', 'remove_group_run', 'reset_challenge_name', 'remove_challenge') then
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
-- Export: the runner's challenges
-- ---------------------------------------------------------------------------------------
create or replace function private.challenge_export(p_uid uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'title', private.challenge_title(c),
           'scope', c.scope,
           'metric', c.metric,
           'target', c.target,
           'starts_on', c.starts_on,
           'ends_on', c.ends_on,
           'joined_at_ms', private.ts_to_ms(e.joined_at),
           'progress', r.progress,
           'completed_on', r.reached_on)
         order by c.starts_on, e.joined_at), '[]'::jsonb)
  from private.challenge_entries e
  join private.challenges c on c.id = e.challenge_id
  cross join lateral private.challenge_results(c, array[p_uid]) r
  where e.user_id = p_uid
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
    'challenges', private.challenge_export(p_uid)
  );
end
$$;

select private.apply_function_grants();
