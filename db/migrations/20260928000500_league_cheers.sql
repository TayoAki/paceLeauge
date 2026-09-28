-- League cheers (docs/ROADMAP.md 1.9): once a week, cheer a league-mate. Kudos inside the league
-- with nothing to moderate: no text, just who cheered whom. Blocked runners can't cheer each other
-- and never see each other's cheers.

create table private.cheers (
  id bigint generated always as identity primary key,
  league_id uuid not null references public.leagues (id) on delete cascade,
  from_user uuid not null references auth.users (id) on delete cascade,
  to_user uuid not null references auth.users (id) on delete cascade,
  week_start date not null,
  created_at timestamptz not null default now(),
  constraint cheers_not_self check (from_user <> to_user),
  constraint cheers_once_per_week unique (from_user, to_user, week_start)
);
create index cheers_to_idx on private.cheers (to_user, week_start);
create index cheers_league_week_idx on private.cheers (league_id, week_start);

create or replace function private.league_cheers(p_user uuid, p_week date)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_member public.league_members := private.active_membership(p_user);
begin
  if v_member.id is null then
    return jsonb_build_object('week_start', p_week, 'league_id', null, 'received', '[]'::jsonb, 'mine', '[]'::jsonb,
                              'cheered_me', '[]'::jsonb);
  end if;
  return jsonb_build_object(
    'week_start', p_week,
    'league_id', v_member.league_id,
    -- Cheers each current member received this week from other current members.
    'received', coalesce((
      select jsonb_agg(jsonb_build_object('member_id', m.id, 'count', c.n) order by m.id)
      from public.league_members m
      join lateral (
        select count(*) as n from private.cheers ch
        join public.league_members f on f.user_id = ch.from_user and f.league_id = v_member.league_id and f.left_at is null
        where ch.league_id = v_member.league_id and ch.week_start = p_week and ch.to_user = m.user_id
          and not private.are_blocked(p_user, ch.from_user)
      ) c on c.n > 0
      where m.league_id = v_member.league_id and m.left_at is null
        and (m.user_id = p_user or not private.are_blocked(p_user, m.user_id))), '[]'::jsonb),
    'mine', coalesce((
      select jsonb_agg(m.id order by m.id)
      from private.cheers ch
      join public.league_members m on m.user_id = ch.to_user and m.league_id = v_member.league_id and m.left_at is null
      where ch.league_id = v_member.league_id and ch.week_start = p_week and ch.from_user = p_user), '[]'::jsonb),
    'cheered_me', coalesce((
      select jsonb_agg(p.alias order by ch.created_at)
      from private.cheers ch
      join public.league_members f on f.user_id = ch.from_user and f.league_id = v_member.league_id and f.left_at is null
      join public.profiles p on p.user_id = ch.from_user and p.status = 'active'
      where ch.league_id = v_member.league_id and ch.week_start = p_week and ch.to_user = p_user
        and not private.are_blocked(p_user, ch.from_user)), '[]'::jsonb)
  );
end
$$;

create or replace function public.cheer_member(p_member_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_me public.league_members := private.active_membership(v_uid);
  v_target public.league_members;
  v_week date := private.current_week_start();
begin
  if v_me.id is null then
    perform private.fail('not_in_league');
  end if;
  select * into v_target from public.league_members
  where id = p_member_id and league_id = v_me.league_id and left_at is null;
  if not found or private.are_blocked(v_uid, v_target.user_id) then
    perform private.fail('not_found');
  end if;
  if v_target.user_id = v_uid then
    perform private.fail('invalid_input', 'self');
  end if;
  perform private.check_rate_limit('cheer:' || v_uid, 60, interval '1 day');
  insert into private.cheers (league_id, from_user, to_user, week_start)
  values (v_me.league_id, v_uid, v_target.user_id, v_week)
  on conflict on constraint cheers_once_per_week do nothing;
  return private.league_cheers(v_uid, v_week);
end
$$;

create or replace function public.get_league_cheers(p_week_offset integer default 0)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
begin
  return private.league_cheers(v_uid, private.current_week_start() + case when p_week_offset = -1 then -7 else 0 end);
end
$$;

select private.apply_function_grants();
