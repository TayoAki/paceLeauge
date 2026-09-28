-- Global and regional leaderboards (docs/ROADMAP.md 4.7, decision 7): weekly boards by tier
-- (Seed to Elite) and by country, scored with the capped best-three-days XP.
--
--   * Opt-in. Runners are invited at natural moments (after winning their league's week, or after
--     their first full league week) and join in one tap. They can leave at any time, and leaving
--     takes them off every board, past ones included.
--   * Boards show a runner's name, tier and weekly score, never a route.
--   * Only accepted GPS runs count: no indoor runs (nothing to check), nothing held for review,
--     nothing typed in, and nothing the server first had more than a day after the week closed.
--   * New accounts appear once they have two weeks of runs and are at least 14 days old.
--   * Results are provisional until 48 hours after the week closes (a day longer than leagues).
--     The top ten of every board get extra checks: a route with exactly the same GPS points as
--     another run at another time (replayed or copied), a pace under 3:00/km over 5 km or more,
--     and any run the validator held for its speed that week. A result that fails is held off the
--     board and goes to the moderation queue; it never becomes final unless a moderator releases it.
--   * Anyone signed in can report a result.
-- Boards are worked out by the frequent job every minute into private.leaderboard_results, so
-- reading one is a single indexed query.

-- ---------------------------------------------------------------------------------------
-- Countries (ISO 3166-1 alpha-2)
-- ---------------------------------------------------------------------------------------
create or replace function private.country_codes()
returns text[]
language sql immutable
as $$
  select array[
    'AD','AE','AF','AG','AI','AL','AM','AO','AQ','AR','AS','AT','AU','AW','AX','AZ','BA','BB','BD','BE','BF','BG','BH','BI',
    'BJ','BL','BM','BN','BO','BQ','BR','BS','BT','BV','BW','BY','BZ','CA','CC','CD','CF','CG','CH','CI','CK','CL','CM','CN',
    'CO','CR','CU','CV','CW','CX','CY','CZ','DE','DJ','DK','DM','DO','DZ','EC','EE','EG','EH','ER','ES','ET','FI','FJ','FK',
    'FM','FO','FR','GA','GB','GD','GE','GF','GG','GH','GI','GL','GM','GN','GP','GQ','GR','GS','GT','GU','GW','GY','HK','HM',
    'HN','HR','HT','HU','ID','IE','IL','IM','IN','IO','IQ','IR','IS','IT','JE','JM','JO','JP','KE','KG','KH','KI','KM','KN',
    'KP','KR','KW','KY','KZ','LA','LB','LC','LI','LK','LR','LS','LT','LU','LV','LY','MA','MC','MD','ME','MF','MG','MH','MK',
    'ML','MM','MN','MO','MP','MQ','MR','MS','MT','MU','MV','MW','MX','MY','MZ','NA','NC','NE','NF','NG','NI','NL','NO','NP',
    'NR','NU','NZ','OM','PA','PE','PF','PG','PH','PK','PL','PM','PN','PR','PS','PT','PW','PY','QA','RE','RO','RS','RU','RW',
    'SA','SB','SC','SD','SE','SG','SH','SI','SJ','SK','SL','SM','SN','SO','SR','SS','ST','SV','SX','SY','SZ','TC','TD','TF',
    'TG','TH','TJ','TK','TL','TM','TN','TO','TR','TT','TV','TW','TZ','UA','UG','UM','US','UY','UZ','VA','VC','VE','VG','VI',
    'VN','VU','WF','WS','YE','YT','ZA','ZM','ZW']::text[]
$$;

create or replace function private.tier_names()
returns text[]
language sql immutable
as $$ select array['Seed', 'Stride', 'Tempo', 'Surge', 'Elite']::text[] $$;

-- ---------------------------------------------------------------------------------------
-- Who's on the boards, and each week's results
-- ---------------------------------------------------------------------------------------
create table private.leaderboard_members (
  user_id uuid primary key references auth.users (id) on delete cascade,
  country text check (country is null or country ~ '^[A-Z]{2}$'),
  -- Null until the runner first joins; the row can exist just to remember a dismissed invite.
  joined_at timestamptz,
  left_at timestamptz,
  -- A moderator took the runner off the boards for good.
  banned_at timestamptz,
  invite_dismissed_at timestamptz,
  updated_at timestamptz not null default now()
);

create table private.leaderboard_results (
  id uuid primary key default gen_random_uuid(),
  week_start date not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  -- The runner's tier when the week began, so nobody changes division mid-week.
  tier text not null,
  country text not null,
  score integer not null check (score >= 0),
  -- provisional: on this week's board · held: failed a check, off the board until a moderator
  -- decides · final: on the final board · removed: taken off by a moderator
  status text not null default 'provisional' check (status in ('provisional', 'held', 'final', 'removed')),
  flags text[] not null default '{}',
  checked_at timestamptz,
  -- A moderator looked and released it; checks run again only if the score changes.
  cleared_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint leaderboard_results_once unique (week_start, user_id)
);
create index leaderboard_results_tier_idx on private.leaderboard_results (week_start, tier, status, score desc);
create index leaderboard_results_country_idx on private.leaderboard_results (week_start, country, status, score desc);
create index leaderboard_results_user_idx on private.leaderboard_results (user_id, week_start);

-- Weeks whose boards are final.
create table private.leaderboard_weeks (
  week_start date primary key,
  finalized_at timestamptz not null default now()
);

create or replace function private.leaderboard_final_at(p_week date)
returns timestamptz
language sql stable
as $$
  select private.day_start(p_week + 7) + interval '48 hours'
$$;

create or replace function private.leaderboard_member(p_user uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from private.leaderboard_members m
                 where m.user_id = p_user and m.joined_at is not null and m.left_at is null and m.banned_at is null)
$$;

-- ---------------------------------------------------------------------------------------
-- Route fingerprints: the GPS points of a route without their times, to spot a route replayed
-- with new times or copied from someone else
-- ---------------------------------------------------------------------------------------
create table private.route_fingerprints (
  run_id uuid primary key references private.run_routes (run_id) on delete cascade,
  fingerprint text not null
);
create index route_fingerprints_value_idx on private.route_fingerprints (fingerprint);

-- Coordinates rounded to 5 decimals (about a metre), in order. Short routes aren't fingerprinted.
create or replace function private.route_fingerprint(p_points jsonb)
returns text
language sql immutable
as $$
  select case when count(*) < 30 then null
              else md5(string_agg(round((e ->> 2)::numeric, 5)::text || ',' || round((e ->> 3)::numeric, 5)::text, ';' order by ord)) end
  from jsonb_array_elements(coalesce(p_points, '[]'::jsonb)) with ordinality as x(e, ord)
$$;

create or replace function private.on_route_saved()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_fingerprint text := private.route_fingerprint(new.points);
begin
  if v_fingerprint is null then
    delete from private.route_fingerprints where run_id = new.run_id;
  else
    insert into private.route_fingerprints (run_id, fingerprint) values (new.run_id, v_fingerprint)
    on conflict (run_id) do update set fingerprint = excluded.fingerprint;
  end if;
  return null;
end
$$;

create trigger run_routes_fingerprint after insert or update of points on private.run_routes
  for each row execute function private.on_route_saved();

insert into private.route_fingerprints (run_id, fingerprint)
select rr.run_id, fp.v from private.run_routes rr
cross join lateral (select private.route_fingerprint(rr.points) as v) fp
where fp.v is not null;

-- ---------------------------------------------------------------------------------------
-- Scores, tiers and who may appear
-- ---------------------------------------------------------------------------------------
create or replace function private.lifetime_xp_before(p_user uuid, p_date date)
returns integer
language sql stable security definer set search_path = ''
as $$
  select coalesce(sum(s.xp), 0)::integer from public.daily_scores s
  where s.owner_id = p_user and s.rule_version = 1 and s.competition_date < p_date
$$;

-- The first week a runner can appear: after two weeks with an accepted run, and starting at
-- least 14 days after the account was made.
create or replace function private.leaderboard_eligible_from(p_user uuid)
returns date
language sql stable security definer set search_path = ''
as $$
  with weeks as (
    select distinct private.week_start(a.competition_date) as week
    from private.run_day_allocations a
    join public.runs r on r.id = a.run_id
    where a.owner_id = p_user and r.status = 'accepted' and r.scoring_state = 'applied' and r.deleted_at is null
  )
  select greatest(second.week + 7, private.week_start(private.competition_date(p.created_at) + 14 + 6))
  from public.profiles p
  cross join (select w.week from weeks w order by w.week offset 1 limit 1) second
  where p.user_id = p_user
$$;

-- Each runner's score for the week: the best three days of XP, from accepted GPS runs the
-- server had by a day after the week closed.
create or replace function private.leaderboard_week_scores(p_week date, p_users uuid[])
returns table (user_id uuid, score integer)
language sql stable security definer set search_path = ''
as $$
  with day_totals as (
    select a.owner_id, a.competition_date, sum(a.distance_cm)::bigint as distance_cm, sum(a.active_ms)::bigint as active_ms
    from private.run_day_allocations a
    join public.runs r on r.id = a.run_id
    where a.owner_id = any (p_users) and a.competition_date >= p_week and a.competition_date < p_week + 7
      and r.status = 'accepted' and r.scoring_state = 'applied' and r.deleted_at is null and not r.indoor
      and r.first_received_at <= private.day_start(p_week + 7) + interval '24 hours'
    group by a.owner_id, a.competition_date
  ),
  day_xp as (
    select t.owner_id, x.xp from day_totals t cross join lateral private.daily_xp(t.distance_cm, t.active_ms) x
  ),
  ranked as (
    select d.owner_id, d.xp, row_number() over (partition by d.owner_id order by d.xp desc) as rn from day_xp d
  )
  select r.owner_id, (sum(r.xp) filter (where r.rn <= 3))::integer from ranked r group by r.owner_id
$$;

-- The extra checks for the top of a board.
create or replace function private.leaderboard_flags(p_user uuid, p_week date)
returns text[]
language sql stable security definer set search_path = ''
as $$
  with week_runs as (
    select r.* from public.runs r
    where r.owner_id = p_user and r.deleted_at is null and r.activity_type = 'run'
      and r.started_at < private.day_start(p_week + 7) and r.ended_at >= private.day_start(p_week)
  )
  select array_remove(array[
    -- The same GPS points as another run at another time: a route replayed with new times, or
    -- copied from someone else. The same run imported twice overlaps itself in time, so it's not counted.
    case when exists (
      select 1 from week_runs w
      join private.route_fingerprints f on f.run_id = w.id
      join private.route_fingerprints o on o.fingerprint = f.fingerprint and o.run_id <> f.run_id
      join public.runs x on x.id = o.run_id and x.deleted_at is null
      where w.status = 'accepted'
        and not (x.owner_id = w.owner_id and x.started_at < w.ended_at and w.started_at < x.ended_at)
    ) then 'replayed_route' end,
    -- Faster than 3:00/km over 5 km or more: world-class, so a person looks first.
    case when exists (select 1 from week_runs w
                      where w.status = 'accepted' and w.distance_cm >= 500000 and w.active_ms > 0
                        and w.distance_cm / 100.0 / (w.active_ms / 1000.0) >= 5.6) then 'elite_pace' end,
    -- A run the validator held for its speed this week, whatever became of it.
    case when exists (select 1 from week_runs w where 'speed_anomaly' = any (w.reason_codes)) then 'speed_flags' end
  ]::text[], null)
$$;

-- ---------------------------------------------------------------------------------------
-- Working out a week's boards
-- ---------------------------------------------------------------------------------------
alter table private.reports drop constraint reports_target_kind_check;
alter table private.reports add constraint reports_target_kind_check
  check (target_kind in ('member', 'league', 'runner', 'run', 'comment', 'club', 'group_run', 'challenge', 'leaderboard'));
alter table private.reports add column target_result_id uuid references private.leaderboard_results (id) on delete set null;

-- A result held by the checks goes to the moderation queue, like a report nobody sent.
create or replace function private.report_held_result(p_result_id uuid)
returns void
language sql security definer set search_path = ''
as $$
  insert into private.reports (reporter_id, target_kind, target_user_id, target_result_id, reason_code, content_snapshot)
  select null, 'leaderboard', r.user_id, r.id, 'cheating',
         jsonb_build_object('alias', p.alias, 'week_start', r.week_start, 'score', r.score, 'tier', r.tier,
                            'country', r.country, 'flags', to_jsonb(r.flags), 'automatic', true)
  from private.leaderboard_results r
  join public.profiles p on p.user_id = r.user_id
  where r.id = p_result_id
    and not exists (select 1 from private.reports o where o.status = 'open' and o.target_result_id = p_result_id)
$$;

-- Recomputes a week's results (every member, or just the runners given), checks the top ten
-- of every board, and once the review window has passed makes the week final. Returns how many
-- results changed.
create or replace function private.refresh_leaderboard_week(p_week date, p_now timestamptz default now(), p_users uuid[] default null)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_final boolean := p_users is null and p_now >= private.leaderboard_final_at(p_week);
  v_members uuid[];
  v_ids uuid[];
  v_scores integer[];
  v_changed integer := 0;
  v_n integer;
  v_held integer;
  v_round integer := 0;
  v_candidate record;
  v_flags text[];
begin
  if exists (select 1 from private.leaderboard_weeks w where w.week_start = p_week) then
    return 0;
  end if;
  select coalesce(array_agg(m.user_id), '{}') into v_members
  from private.leaderboard_members m
  join public.profiles p on p.user_id = m.user_id and p.status = 'active'
  where m.joined_at is not null and m.left_at is null and m.banned_at is null
    and (p_users is null or m.user_id = any (p_users))
    and private.leaderboard_eligible_from(m.user_id) <= p_week;
  select coalesce(array_agg(s.user_id), '{}'), coalesce(array_agg(s.score), '{}') into v_ids, v_scores
  from private.leaderboard_week_scores(p_week, v_members) s
  where s.score > 0;

  insert into private.leaderboard_results as r (week_start, user_id, tier, country, score)
  select p_week, u.id, private.tier_name(private.lifetime_xp_before(u.id, p_week)), m.country, u.score
  from unnest(v_ids, v_scores) as u(id, score)
  join private.leaderboard_members m on m.user_id = u.id
  on conflict (week_start, user_id) do update
    set score = excluded.score, tier = excluded.tier, country = excluded.country, updated_at = now()
    where (r.score, r.tier, r.country) is distinct from (excluded.score, excluded.tier, excluded.country);
  get diagnostics v_n = row_count;
  v_changed := v_changed + v_n;
  -- Whoever isn't on this week's boards any more (no score, left, not yet eligible).
  delete from private.leaderboard_results r
  where r.week_start = p_week and r.status = 'provisional'
    and (p_users is null or r.user_id = any (p_users))
    and not (r.user_id = any (v_ids));
  get diagnostics v_n = row_count;
  v_changed := v_changed + v_n;

  -- The top ten of every tier and country board get the extra checks: new or changed results
  -- as the week goes, and all of them once more before the week is final. A result that fails
  -- is held, which moves someone else into the top ten, so repeat until nothing more is held.
  loop
    v_held := 0;
    for v_candidate in
      select x.id, x.user_id from (
        select r.*, rank() over (partition by r.tier order by r.score desc) as tier_rank,
                    rank() over (partition by r.country order by r.score desc) as country_rank
        from private.leaderboard_results r
        where r.week_start = p_week and r.status = 'provisional'
      ) x
      where (x.tier_rank <= 10 or x.country_rank <= 10)
        and (x.cleared_at is null or x.updated_at > x.cleared_at)
        and (v_final or x.checked_at is null or x.updated_at > x.checked_at)
    loop
      v_flags := private.leaderboard_flags(v_candidate.user_id, p_week);
      if cardinality(v_flags) > 0 then
        update private.leaderboard_results set status = 'held', flags = v_flags, checked_at = now() where id = v_candidate.id;
        perform private.report_held_result(v_candidate.id);
        v_held := v_held + 1;
      else
        update private.leaderboard_results set checked_at = now(), flags = '{}' where id = v_candidate.id;
      end if;
    end loop;
    v_changed := v_changed + v_held;
    v_round := v_round + 1;
    exit when v_held = 0 or v_round >= 20;
  end loop;

  if v_final then
    update private.leaderboard_results set status = 'final', updated_at = now() where week_start = p_week and status = 'provisional';
    insert into private.leaderboard_weeks (week_start, finalized_at) values (p_week, now());
    v_changed := v_changed + 1;
  end if;
  return v_changed;
end
$$;

-- This week, last week until it's final, and any older week a stopped server left behind.
create or replace function private.refresh_leaderboards(p_now timestamptz default now())
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_week date := private.week_start(private.competition_date(p_now));
  v_old date;
  v_n integer := 0;
begin
  for v_old in
    select distinct r.week_start from private.leaderboard_results r
    where r.week_start < v_week - 7
      and not exists (select 1 from private.leaderboard_weeks w where w.week_start = r.week_start)
    order by r.week_start
  loop
    v_n := v_n + private.refresh_leaderboard_week(v_old, p_now);
  end loop;
  v_n := v_n + private.refresh_leaderboard_week(v_week - 7, p_now);
  v_n := v_n + private.refresh_leaderboard_week(v_week, p_now);
  return v_n;
end
$$;

create or replace function private.run_frequent_jobs()
returns jsonb
language plpgsql security definer set search_path = ''
as $$
begin
  return jsonb_build_object(
    'deletions_completed', private.process_deletion_jobs(20),
    'pending_scored', private.apply_pending_scoring(500),
    'results_queued', private.enqueue_week_results(),
    'seasons_settled', private.settle_seasons(),
    'group_run_reminders', private.enqueue_group_run_reminders(),
    'leaderboard_changes', private.refresh_leaderboards());
end
$$;

-- ---------------------------------------------------------------------------------------
-- Joining, leaving and the invitation
-- ---------------------------------------------------------------------------------------
-- An invitation at a natural moment: the runner won a league's week (first, with XP, in a league
-- of two or more), or had a full week in a league. Once per runner who never joined, and again
-- four weeks after "Not now".
create or replace function private.leaderboard_invite(p_user uuid)
returns text
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_member private.leaderboard_members;
  v_last date := private.current_week_start() - 7;
  v_won boolean;
begin
  select * into v_member from private.leaderboard_members where user_id = p_user;
  if v_member.joined_at is not null or v_member.banned_at is not null
     or v_member.invite_dismissed_at > now() - interval '28 days' then
    return null;
  end if;
  if not exists (select 1 from public.league_members m
                 where m.user_id = p_user and m.left_at is null and m.joined_at <= private.day_start(v_last)) then
    return null;
  end if;
  select exists (
    select 1
    from public.league_members m
    cross join lateral (select private.league_standings(m.league_id, v_last, p_user) as standings) st
    cross join lateral jsonb_array_elements(st.standings) s
    where m.user_id = p_user and m.left_at is null and m.joined_at <= private.day_start(v_last)
      and (s ->> 'member_id')::uuid = m.id and (s ->> 'rank')::integer = 1 and (s ->> 'weekly_xp')::integer > 0
      and jsonb_array_length(st.standings) >= 2
  ) into v_won;
  return case when v_won then 'won_league' else 'full_week' end;
end
$$;

create or replace function private.leaderboard_status(p_user uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'joined', coalesce(m.joined_at is not null and m.left_at is null and m.banned_at is null, false),
    'country', m.country,
    'removed', m.banned_at is not null,
    'eligible_from', private.leaderboard_eligible_from(p_user),
    'eligible', coalesce(private.leaderboard_eligible_from(p_user) <= private.current_week_start(), false),
    'tier', private.tier_name(private.lifetime_xp_before(p_user, private.current_week_start())),
    'invite', private.leaderboard_invite(p_user))
  from (select 1) one
  left join private.leaderboard_members m on m.user_id = p_user
$$;

create or replace function public.get_leaderboard_status()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
begin
  return private.leaderboard_status(v_uid);
end
$$;

create or replace function public.join_leaderboards(p_country text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_country text := upper(btrim(coalesce(p_country, '')));
  v_week date := private.current_week_start();
begin
  if not (v_country = any (private.country_codes())) then
    perform private.fail('invalid_input', 'country');
  end if;
  if exists (select 1 from private.leaderboard_members where user_id = v_uid and banned_at is not null) then
    perform private.fail('leaderboards_removed');
  end if;
  perform private.check_rate_limit('leaderboards:' || v_uid, 20, interval '1 day');
  insert into private.leaderboard_members as m (user_id, country, joined_at)
  values (v_uid, v_country, now())
  on conflict (user_id) do update
    set country = excluded.country,
        joined_at = case when m.joined_at is null or m.left_at is not null then now() else m.joined_at end,
        left_at = null, updated_at = now();
  -- A new country moves this week's result with it.
  update private.leaderboard_results set country = v_country, updated_at = now()
  where user_id = v_uid and week_start >= v_week - 7 and status in ('provisional', 'held');
  perform private.refresh_leaderboard_week(v_week, now(), array[v_uid]);
  perform private.refresh_leaderboard_week(v_week - 7, now(), array[v_uid]);
  return private.leaderboard_status(v_uid);
end
$$;

-- Leaving takes the runner off every board at once; final results come back only if they rejoin.
create or replace function public.leave_leaderboards()
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
begin
  update private.leaderboard_members set left_at = now(), updated_at = now()
  where user_id = v_uid and joined_at is not null and left_at is null;
  delete from private.leaderboard_results where user_id = v_uid and status in ('provisional', 'held');
  return private.leaderboard_status(v_uid);
end
$$;

create or replace function public.dismiss_leaderboard_invite()
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
begin
  insert into private.leaderboard_members as m (user_id, invite_dismissed_at) values (v_uid, now())
  on conflict (user_id) do update set invite_dismissed_at = now(), updated_at = now();
  return private.leaderboard_status(v_uid);
end
$$;

-- ---------------------------------------------------------------------------------------
-- Reading a board
-- ---------------------------------------------------------------------------------------
create or replace function private.leaderboard_board(p_week date, p_board text, p_key text, p_viewer uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  with week as (
    select exists (select 1 from private.leaderboard_weeks w where w.week_start = p_week) as final
  ),
  shown as (
    select r.id, r.user_id, r.score, r.tier, r.country, p.alias,
           r.user_id <> p_viewer and private.are_blocked(p_viewer, r.user_id) as hidden
    from private.leaderboard_results r
    join private.leaderboard_members m on m.user_id = r.user_id and m.joined_at is not null and m.left_at is null and m.banned_at is null
    join public.profiles p on p.user_id = r.user_id and p.status = 'active'
    cross join week
    where r.week_start = p_week
      and r.status = case when week.final then 'final' else 'provisional' end
      and case when p_board = 'tier' then r.tier = p_key else r.country = p_key end
  ),
  ranked as (
    select s.*, rank() over (order by s.score desc) as place,
           row_number() over (order by s.score desc, lower(s.alias) collate "C", s.id) as n
    from shown s
  ),
  board_rows as (
    select jsonb_build_object(
             'result_id', r.id,
             'rank', r.place,
             'alias', case when r.hidden then null else r.alias end,
             'tier', r.tier,
             'score', r.score,
             'is_me', r.user_id = p_viewer,
             'hidden', r.hidden) as j,
           r.n, r.user_id
    from ranked r
  )
  select jsonb_build_object(
    'week_start', p_week,
    'board', p_board,
    'key', p_key,
    'state', case when (select final from week) then 'final'
                  when p_week = private.current_week_start() then 'in_progress' else 'in_review' end,
    'final_at_ms', private.ts_to_ms(private.leaderboard_final_at(p_week)),
    'runners', (select count(*) from ranked),
    'rows', coalesce((select jsonb_agg(x.j order by x.n) from board_rows x where x.n <= 100), '[]'::jsonb),
    'me', (select x.j from board_rows x where x.user_id = p_viewer),
    -- Only the runner sees that their own result is being checked or was taken off.
    'my_status', (select r.status from private.leaderboard_results r where r.week_start = p_week and r.user_id = p_viewer))
$$;

-- Boards are open to anyone signed in; only runners who joined appear on them. The runner's own
-- tier and country board by default.
create or replace function public.get_leaderboard(p_board text default 'tier', p_key text default null, p_week_offset integer default 0)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_week date := private.current_week_start() + 7 * greatest(-8, least(0, coalesce(p_week_offset, 0)));
  v_key text;
begin
  if p_board is null or p_board not in ('tier', 'country') then
    perform private.fail('invalid_input', 'board');
  end if;
  if p_board = 'tier' then
    v_key := coalesce(p_key, (select r.tier from private.leaderboard_results r where r.week_start = v_week and r.user_id = v_uid),
                      private.tier_name(private.lifetime_xp_before(v_uid, v_week)));
    if not (v_key = any (private.tier_names())) then
      perform private.fail('invalid_input', 'key');
    end if;
  else
    v_key := upper(coalesce(p_key, (select m.country from private.leaderboard_members m where m.user_id = v_uid), 'US'));
    if not (v_key = any (private.country_codes())) then
      perform private.fail('invalid_input', 'key');
    end if;
  end if;
  return private.leaderboard_board(v_week, p_board, v_key, v_uid);
end
$$;

-- ---------------------------------------------------------------------------------------
-- Reports on results, and what moderators can do
-- ---------------------------------------------------------------------------------------
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
  v_result private.leaderboard_results;
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
                    when 'leaderboard' then r.target_result_id = p_id
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
  elsif p_kind = 'leaderboard' then
    -- A result on a board anyone signed in can see.
    select * into v_result from private.leaderboard_results where id = p_id;
    if not found or v_result.user_id = v_uid or v_result.status not in ('provisional', 'final')
       or not private.leaderboard_member(v_result.user_id) then
      perform private.fail('not_found');
    end if;
    v_other := v_result.user_id;
    v_snapshot := jsonb_build_object('alias', (select alias from public.profiles where user_id = v_other),
      'week_start', v_result.week_start, 'score', v_result.score, 'tier', v_result.tier, 'country', v_result.country);
  else
    perform private.fail('invalid_input', 'kind');
  end if;
  perform private.check_rate_limit('report:' || v_uid, 20, interval '1 day');
  insert into private.reports (reporter_id, target_kind, target_user_id, target_league_id, target_run_id, target_comment_id,
                               target_club_id, target_group_run_id, target_challenge_id, target_result_id, reason_code, content_snapshot)
  values (v_uid, p_kind, v_other, case when p_kind = 'challenge' then v_challenge.league_id end,
          case when p_kind in ('run', 'comment') then v_run.id end,
          case when p_kind = 'comment' then v_comment.id end,
          case when p_kind = 'club' then v_club.id when p_kind = 'group_run' then v_group_run.club_id
               when p_kind = 'challenge' then v_challenge.club_id end,
          case when p_kind = 'group_run' then v_group_run.id end,
          case when p_kind = 'challenge' then v_challenge.id end,
          case when p_kind = 'leaderboard' then v_result.id end, p_reason, v_snapshot)
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
    when 'leaderboard' then '["dismiss", "release_result", "remove_result", "remove_from_leaderboards", "reset_alias"]'::jsonb
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
     and a.target_result_id is not distinct from b.target_result_id
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
               when 'leaderboard' then jsonb_build_object(
                 'result_status', (select x.status from private.leaderboard_results x where x.id = r.target_result_id),
                 'flags', (select to_jsonb(x.flags) from private.leaderboard_results x where x.id = r.target_result_id),
                 'removed', coalesce((select x.status = 'removed' from private.leaderboard_results x where x.id = r.target_result_id), true))
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

  -- Taking something down (or deciding a held result) settles every open report about it.
  if p_action in ('remove_comment', 'hide_run', 'reset_club', 'close_club', 'remove_group_run', 'reset_challenge_name', 'remove_challenge',
                  'release_result', 'remove_result', 'remove_from_leaderboards') then
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
  elsif p_action = 'release_result' and v_report.target_result_id is not null then
    -- A person looked: back on the board, and not checked again unless the score changes.
    update private.leaderboard_results
       set status = case when exists (select 1 from private.leaderboard_weeks w where w.week_start = leaderboard_results.week_start)
                         then 'final' else 'provisional' end,
           cleared_at = now(), updated_at = now()
     where id = v_report.target_result_id and status in ('held', 'removed');
  elsif p_action = 'remove_result' and v_report.target_result_id is not null then
    update private.leaderboard_results set status = 'removed', updated_at = now() where id = v_report.target_result_id;
  elsif p_action = 'remove_from_leaderboards' and v_report.target_user_id is not null then
    update private.leaderboard_members set banned_at = now(), updated_at = now() where user_id = v_report.target_user_id;
    update private.leaderboard_results set status = 'removed', updated_at = now()
    where user_id = v_report.target_user_id and status <> 'removed';
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
-- Retention and export
-- ---------------------------------------------------------------------------------------
-- Board results go after a year; club invites join the other invites' 30 days.
create or replace function private.purge_expired()
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_staged integer;
  v_exports integer;
  v_events integer;
  v_limits integer;
  v_reports integer;
  v_invites integer;
  v_club_invites integer;
  v_jobs integer;
  v_push integer;
  v_group_runs integer;
  v_results integer;
begin
  -- Staged uploads that never finalized expire after 7 days (the device keeps its copy).
  delete from public.runs where status = 'uploading' and deleted_at is null and first_received_at < now() - interval '7 days';
  get diagnostics v_staged = row_count;
  delete from private.export_jobs where expires_at < now();
  get diagnostics v_exports = row_count;
  delete from private.operational_events where received_at < now() - interval '14 days';
  get diagnostics v_events = row_count;
  delete from private.rate_limits where window_start < now() - interval '2 days';
  get diagnostics v_limits = row_count;
  delete from private.reports where status <> 'open' and resolved_at < now() - interval '90 days';
  get diagnostics v_reports = row_count;
  delete from private.league_invites
  where expires_at < now() - interval '30 days' or revoked_at < now() - interval '30 days';
  get diagnostics v_invites = row_count;
  delete from private.club_invites
  where expires_at < now() - interval '30 days' or revoked_at < now() - interval '30 days';
  get diagnostics v_club_invites = row_count;
  delete from private.deletion_jobs where state = 'completed' and completed_at < now() - interval '30 days';
  get diagnostics v_jobs = row_count;
  -- Pushes: what was sent or dropped goes after 7 days, repeat guards after 30, tickets after 2.
  delete from private.push_outbox where created_at < now() - interval '7 days';
  get diagnostics v_push = row_count;
  delete from private.push_dedupe where created_at < now() - interval '30 days';
  delete from private.push_receipts where created_at < now() - interval '2 days';
  delete from private.results_notified where week_start < current_date - 90;
  delete from private.group_runs
  where starts_at < now() - interval '30 days' or cancelled_at < now() - interval '30 days';
  get diagnostics v_group_runs = row_count;
  delete from private.leaderboard_results where week_start < current_date - 364;
  get diagnostics v_results = row_count;
  delete from private.leaderboard_weeks where week_start < current_date - 364;
  return jsonb_build_object('staged_uploads', v_staged, 'export_jobs', v_exports, 'events', v_events,
    'rate_limits', v_limits, 'reports', v_reports, 'invites', v_invites + v_club_invites, 'deletion_jobs', v_jobs, 'pushes', v_push,
    'group_runs', v_group_runs, 'leaderboard_results', v_results);
end
$$;

create or replace function private.leaderboard_export(p_uid uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'joined', coalesce(m.joined_at is not null and m.left_at is null, false),
    'country', m.country,
    'joined_at_ms', case when m.joined_at is null then null else private.ts_to_ms(m.joined_at) end,
    'left_at_ms', case when m.left_at is null then null else private.ts_to_ms(m.left_at) end,
    'results', coalesce((select jsonb_agg(jsonb_build_object('week_start', r.week_start, 'tier', r.tier, 'country', r.country,
                                                             'score', r.score, 'status', r.status) order by r.week_start)
                         from private.leaderboard_results r where r.user_id = p_uid), '[]'::jsonb))
  from (select 1) one
  left join private.leaderboard_members m on m.user_id = p_uid
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
    'challenges', private.challenge_export(p_uid),
    'leaderboards', private.leaderboard_export(p_uid)
  );
end
$$;

select private.apply_function_grants();
