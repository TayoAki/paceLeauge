-- Leagues 2.0 (docs/ROADMAP.md 4.1): up to five leagues per runner (lifting D-008), league kinds
-- with a family template, four-week seasons with a champion, one-on-one weekly duels, a weekly
-- recap, group runs with RSVPs, and a group-chat link only members see.
--
-- Standings are unchanged and computed per league: each league counts a runner's segments from
-- when they joined that league, capped at the best three days of the week.
--
-- Every league RPC takes an optional league id. Without one it acts on the runner's first league
-- (the one they joined earliest), so an app from before this change keeps working.

-- ---------------------------------------------------------------------------------------
-- More than one league
-- ---------------------------------------------------------------------------------------
drop index public.league_members_one_active_league;
create unique index league_members_active_once on public.league_members (league_id, user_id) where left_at is null;
create index league_members_active_by_user on public.league_members (user_id) where left_at is null;

alter table public.leagues add column kind text not null default 'friends' check (kind in ('friends', 'family', 'work'));
-- The crew's existing group chat (WhatsApp, Discord, Signal, Telegram, GroupMe or Messenger);
-- there is no chat in the app (decision 6). Shown to members only.
alter table public.leagues add column chat_url text check (chat_url is null or char_length(chat_url) <= 200);

create or replace function private.max_leagues()
returns integer
language sql immutable
as $$ select 5 $$;

-- The runner's first league: what an app from before Leagues 2.0 sees.
create or replace function private.active_membership(p_user uuid)
returns public.league_members
language sql stable security definer set search_path = ''
as $$
  select * from public.league_members where user_id = p_user and left_at is null order by joined_at, id limit 1
$$;

-- The runner's membership in a league: the one given, or their first when none is.
create or replace function private.membership_in(p_user uuid, p_league_id uuid)
returns public.league_members
language sql stable security definer set search_path = ''
as $$
  select * from public.league_members
  where user_id = p_user and left_at is null and (p_league_id is null or league_id = p_league_id)
  order by joined_at, id limit 1
$$;

create or replace function private.require_membership(p_user uuid, p_league_id uuid)
returns public.league_members
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_member public.league_members := private.membership_in(p_user, p_league_id);
begin
  if v_member.id is null then
    perform private.fail('not_in_league');
  end if;
  return v_member;
end
$$;

create or replace function private.league_count(p_user uuid)
returns integer
language sql stable security definer set search_path = ''
as $$
  select count(*)::integer from public.league_members where user_id = p_user and left_at is null
$$;

drop function private.require_league_owner(uuid);
create or replace function private.require_league_owner(p_user uuid, p_league_id uuid)
returns public.league_members
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_member public.league_members := private.membership_in(p_user, p_league_id);
begin
  if v_member.id is null then
    perform private.fail('not_in_league');
  end if;
  if v_member.role <> 'owner' then
    perform private.fail('not_league_owner');
  end if;
  return v_member;
end
$$;

-- The leagues a runner is in, for the switcher.
create or replace function private.my_leagues_json(p_user uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', l.id,
           'name', l.name,
           'kind', l.kind,
           'is_owner', m.role = 'owner',
           'member_count', (select count(*) from public.league_members x where x.league_id = l.id and x.left_at is null),
           'joined_at_ms', private.ts_to_ms(m.joined_at))
         order by m.joined_at, m.id), '[]'::jsonb)
  from public.league_members m
  join public.leagues l on l.id = m.league_id
  where m.user_id = p_user and m.left_at is null
$$;

-- ---------------------------------------------------------------------------------------
-- The league view, per league
-- ---------------------------------------------------------------------------------------
create or replace function private.league_view(p_user uuid, p_week_offset integer, p_league_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_member public.league_members;
  v_league public.leagues;
  v_week date := private.current_week_start() + case when p_week_offset = -1 then -7 else 0 end;
  v_week_end timestamptz := private.day_start(v_week + 7);
  v_standings jsonb;
  v_me jsonb;
  v_count integer;
  v_revision integer;
begin
  v_member := private.membership_in(p_user, p_league_id);
  if v_member.id is null then
    return jsonb_build_object('league', null, 'leagues', private.my_leagues_json(p_user), 'max_leagues', private.max_leagues(),
                              'competition_enabled', private.flag_enabled('competition_enabled'));
  end if;
  select * into v_league from public.leagues where id = v_member.league_id;
  select count(*) into v_count from public.league_members where league_id = v_league.id and left_at is null;
  v_standings := private.league_standings(v_league.id, v_week, p_user);
  select s into v_me from jsonb_array_elements(v_standings) s where (s ->> 'is_me')::boolean limit 1;
  select coalesce(max(revision), 0) into v_revision
  from private.league_week_revisions where league_id = v_league.id and week_start = v_week;

  return jsonb_build_object(
    'league', jsonb_build_object(
      'id', v_league.id,
      'name', v_league.name,
      'kind', v_league.kind,
      'member_count', v_count,
      'capacity', v_league.capacity,
      'is_owner', v_member.role = 'owner',
      'calendar_zone', v_league.calendar_zone,
      'chat_url', v_league.chat_url,
      'created_at_ms', private.ts_to_ms(v_league.created_at),
      'joined_at_ms', private.ts_to_ms(v_member.joined_at)),
    'leagues', private.my_leagues_json(p_user),
    'max_leagues', private.max_leagues(),
    'week', jsonb_build_object(
      'week_start', v_week,
      'offset', case when p_week_offset = -1 then -1 else 0 end,
      'starts_at_ms', private.ts_to_ms(private.day_start(v_week)),
      'ends_at_ms', private.ts_to_ms(v_week_end),
      'settles_at_ms', private.ts_to_ms(v_week_end + interval '24 hours'),
      'state', case
        when now() < v_week_end then 'in_progress'
        when now() < v_week_end + interval '24 hours' then 'settling'
        else 'final' end,
      'revision', v_revision),
    'standings', v_standings,
    'me', v_me,
    'competition_enabled', private.flag_enabled('competition_enabled')
  );
end
$$;

create or replace function private.league_view(p_user uuid, p_week_offset integer)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select private.league_view(p_user, p_week_offset, null::uuid)
$$;

drop function public.get_my_league(integer);
create or replace function public.get_my_league(p_week_offset integer default 0, p_league_id uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
begin
  return private.league_view(v_uid, p_week_offset, p_league_id);
end
$$;

-- ---------------------------------------------------------------------------------------
-- Creating, joining and leaving
-- ---------------------------------------------------------------------------------------
-- The family template is a league of kind 'family': the kind teens can join (4.10).
drop function public.create_league(text);
create or replace function public.create_league(p_name text, p_kind text default 'friends')
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_name text := private.normalize_name(p_name);
  v_problem text := private.name_problem(v_name, 3, 32);
  v_league_id uuid;
begin
  if v_problem = 'invalid' then
    perform private.fail('league_name_invalid');
  elsif v_problem = 'not_allowed' then
    perform private.fail('league_name_not_allowed');
  end if;
  if coalesce(p_kind, 'friends') not in ('friends', 'family', 'work') then
    perform private.fail('invalid_input', 'kind');
  end if;
  -- One runner's league changes happen one at a time, so the limit holds under concurrency.
  perform pg_advisory_xact_lock(hashtext('leagues:' || v_uid));
  if private.league_count(v_uid) >= private.max_leagues() then
    perform private.fail('league_limit');
  end if;
  perform private.check_rate_limit('league_create:' || v_uid, 5, interval '1 day');

  insert into public.leagues (name, owner_id, kind) values (v_name, v_uid, coalesce(p_kind, 'friends')) returning id into v_league_id;
  insert into public.league_members (league_id, user_id, role) values (v_league_id, v_uid, 'owner');
  return private.league_view(v_uid, 0, v_league_id);
end
$$;

drop function public.create_league_invite();
create or replace function public.create_league_invite(p_league_id uuid default null)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_member public.league_members := private.require_league_owner(v_uid, p_league_id);
begin
  if not private.flag_enabled('invites_enabled') then
    perform private.fail('invites_paused');
  end if;
  perform private.check_rate_limit('invite_create:' || v_uid, 30, interval '1 day');
  return private.issue_invite(v_member.league_id, v_uid);
end
$$;

drop function public.rotate_league_invites();
create or replace function public.rotate_league_invites(p_league_id uuid default null)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_member public.league_members := private.require_league_owner(v_uid, p_league_id);
begin
  if not private.flag_enabled('invites_enabled') then
    perform private.fail('invites_paused');
  end if;
  perform private.check_rate_limit('invite_create:' || v_uid, 30, interval '1 day');
  update private.league_invites set revoked_at = now()
  where league_id = v_member.league_id and revoked_at is null;
  return private.issue_invite(v_member.league_id, v_uid);
end
$$;

-- Limited preview for visitors and runners: league name, kind and size only, and only while the
-- invitation is usable. Never members, runs or routes.
create or replace function public.get_invite_preview(p_code text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_invite private.league_invites;
  v_league public.leagues;
  v_count integer;
  v_status text;
begin
  perform private.check_rate_limit(
    'invite_preview:' || coalesce(v_uid::text, 'anon:' || private.request_ip()), 20, interval '1 minute');
  select * into v_invite from private.league_invites where code_hash = private.invite_hash(p_code);
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  select * into v_league from public.leagues where id = v_invite.league_id;
  if v_league.status <> 'active' then
    return jsonb_build_object('status', 'closed');
  elsif v_invite.revoked_at is not null then
    return jsonb_build_object('status', 'revoked');
  elsif v_invite.expires_at <= now() then
    return jsonb_build_object('status', 'expired');
  end if;
  if v_uid is not null and (
       exists (select 1 from private.league_bans where league_id = v_league.id and user_id = v_uid)
       or private.are_blocked(v_uid, v_league.owner_id)) then
    return jsonb_build_object('status', 'unavailable');
  end if;

  select count(*) into v_count from public.league_members where league_id = v_league.id and left_at is null;
  v_status := case when v_count >= v_league.capacity then 'full' else 'valid' end;
  if v_uid is not null then
    if exists (select 1 from public.league_members where league_id = v_league.id and user_id = v_uid and left_at is null) then
      v_status := 'already_member';
    elsif v_status = 'valid' and private.league_count(v_uid) >= private.max_leagues() then
      v_status := 'league_limit';
    end if;
  end if;
  return jsonb_build_object(
    'status', v_status,
    'league_name', v_league.name,
    'kind', v_league.kind,
    'member_count', v_count,
    'capacity', v_league.capacity,
    'expires_at_ms', private.ts_to_ms(v_invite.expires_at));
end
$$;

-- Invite failures are returned as {"error": code} instead of raised: raising would roll back
-- the rate-limit increment, and code guessing must stay throttled.
create or replace function public.join_league(p_code text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_invite private.league_invites;
  v_league public.leagues;
  v_count integer;
begin
  perform private.check_rate_limit('invite_join:' || v_uid, 5, interval '1 minute');
  if not private.flag_enabled('invites_enabled') then
    return jsonb_build_object('error', 'invites_paused');
  end if;
  select * into v_invite from private.league_invites where code_hash = private.invite_hash(p_code);
  if not found then
    return jsonb_build_object('error', 'invite_not_found');
  end if;
  -- The league row lock serializes joins, so parallel joins cannot exceed capacity.
  select * into v_league from public.leagues where id = v_invite.league_id for update;
  if v_league.status <> 'active' then
    return jsonb_build_object('error', 'league_closed');
  elsif v_invite.revoked_at is not null then
    return jsonb_build_object('error', 'invite_revoked');
  elsif v_invite.expires_at <= now() then
    return jsonb_build_object('error', 'invite_expired');
  end if;

  if exists (select 1 from public.league_members where league_id = v_league.id and user_id = v_uid and left_at is null) then
    return private.league_view(v_uid, 0, v_league.id);
  end if;
  if exists (select 1 from private.league_bans where league_id = v_league.id and user_id = v_uid)
     or private.are_blocked(v_uid, v_league.owner_id) then
    return jsonb_build_object('error', 'invite_unavailable');
  end if;
  select count(*) into v_count from public.league_members where league_id = v_league.id and left_at is null;
  if v_count >= v_league.capacity then
    return jsonb_build_object('error', 'league_full');
  end if;
  perform pg_advisory_xact_lock(hashtext('leagues:' || v_uid));
  if private.league_count(v_uid) >= private.max_leagues() then
    return jsonb_build_object('error', 'league_limit');
  end if;

  begin
    insert into public.league_members (league_id, user_id, role) values (v_league.id, v_uid, 'member');
  exception when unique_violation then
    return private.league_view(v_uid, 0, v_league.id);
  end;
  perform private.log_server_event('league_joined', v_uid, '{}'::jsonb);
  return private.league_view(v_uid, 0, v_league.id);
end
$$;

drop function public.leave_league();
create or replace function public.leave_league(p_league_id uuid default null)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_member public.league_members;
begin
  select * into v_member from public.league_members
  where user_id = v_uid and left_at is null and (p_league_id is null or league_id = p_league_id)
  order by joined_at, id limit 1
  for update;
  if not found then
    perform private.fail('not_in_league');
  end if;
  perform 1 from public.leagues where id = v_member.league_id for update;
  if v_member.role = 'owner' then
    if exists (select 1 from public.league_members where league_id = v_member.league_id and left_at is null and id <> v_member.id) then
      perform private.fail('owner_must_transfer');
    end if;
    update public.leagues set status = 'closed', updated_at = now() where id = v_member.league_id;
    update private.league_invites set revoked_at = now() where league_id = v_member.league_id and revoked_at is null;
    update public.league_members set left_at = now(), left_reason = 'league_closed' where id = v_member.id;
  else
    update public.league_members set left_at = now(), left_reason = 'left' where id = v_member.id;
  end if;
  return jsonb_build_object('left', true, 'league_id', v_member.league_id);
end
$$;

-- Ownership and removal name a membership, which names its league.
create or replace function public.transfer_league_ownership(p_member_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_owner public.league_members := private.require_league_owner(v_uid, (select league_id from public.league_members where id = p_member_id));
  v_target public.league_members;
begin
  perform 1 from public.leagues where id = v_owner.league_id for update;
  v_target := private.target_member(v_owner, p_member_id);
  update public.league_members set role = 'member' where id = v_owner.id;
  update public.league_members set role = 'owner' where id = v_target.id;
  update public.leagues set owner_id = v_target.user_id, updated_at = now() where id = v_owner.league_id;
  return private.league_view(v_uid, 0, v_owner.league_id);
end
$$;

create or replace function public.remove_league_member(p_member_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_owner public.league_members := private.require_league_owner(v_uid, (select league_id from public.league_members where id = p_member_id));
  v_target public.league_members;
begin
  perform 1 from public.leagues where id = v_owner.league_id for update;
  v_target := private.target_member(v_owner, p_member_id);
  update public.league_members set left_at = now(), left_reason = 'removed' where id = v_target.id;
  insert into private.league_bans (league_id, user_id) values (v_owner.league_id, v_target.user_id)
  on conflict do nothing;
  return private.league_view(v_uid, 0, v_owner.league_id);
end
$$;

drop function public.rename_league(text);
create or replace function public.rename_league(p_name text, p_league_id uuid default null)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_owner public.league_members := private.require_league_owner(v_uid, p_league_id);
  v_name text := private.normalize_name(p_name);
  v_problem text := private.name_problem(v_name, 3, 32);
begin
  if v_problem = 'invalid' then
    perform private.fail('league_name_invalid');
  elsif v_problem = 'not_allowed' then
    perform private.fail('league_name_not_allowed');
  end if;
  update public.leagues set name = v_name, updated_at = now() where id = v_owner.league_id;
  return private.league_view(v_uid, 0, v_owner.league_id);
end
$$;

-- The group-chat link: only the invite links of the chat apps crews use, shown only to members.
create or replace function private.chat_link_ok(p_url text)
returns boolean
language sql immutable
as $$
  select p_url ~ ('^https://(chat\.whatsapp\.com/[A-Za-z0-9]{10,40}'
                  '|discord\.gg/[A-Za-z0-9-]{2,40}'
                  '|discord\.com/invite/[A-Za-z0-9-]{2,40}'
                  '|signal\.group/#[A-Za-z0-9_-]{10,200}'
                  '|t\.me/(\+|joinchat/)[A-Za-z0-9_-]{10,40}'
                  '|groupme\.com/join_group/[0-9]{3,20}/[A-Za-z0-9]{3,40}'
                  '|m\.me/j/[A-Za-z0-9_-]{5,60})/?$')
$$;

create or replace function public.set_league_chat_link(p_url text, p_league_id uuid default null)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_owner public.league_members := private.require_league_owner(v_uid, p_league_id);
  v_url text := nullif(btrim(coalesce(p_url, '')), '');
begin
  if v_url is not null and not private.chat_link_ok(v_url) then
    perform private.fail('invalid_input', 'chat_url');
  end if;
  update public.leagues set chat_url = v_url, updated_at = now() where id = v_owner.league_id;
  return private.league_view(v_uid, 0, v_owner.league_id);
end
$$;

-- ---------------------------------------------------------------------------------------
-- Safety across leagues: a member is reachable only from a league the caller is in
-- ---------------------------------------------------------------------------------------
create or replace function private.league_peer(p_user uuid, p_member_id uuid)
returns public.league_members
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_target public.league_members;
begin
  select * into v_target from public.league_members where id = p_member_id and left_at is null;
  if not found or not exists (select 1 from public.league_members m
                              where m.user_id = p_user and m.league_id = v_target.league_id and m.left_at is null) then
    if private.league_count(p_user) = 0 then
      perform private.fail('not_in_league');
    end if;
    perform private.fail('not_found');
  end if;
  if v_target.user_id = p_user then
    perform private.fail('cannot_target_self');
  end if;
  return v_target;
end
$$;

-- Reason codes only: no unrestricted text upload.
drop function public.submit_report(text, uuid, text);
create or replace function public.submit_report(p_target_kind text, p_member_id uuid, p_reason text, p_league_id uuid default null)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_mine public.league_members;
  v_target public.league_members;
  v_league public.leagues;
  v_alias text;
  v_id uuid;
begin
  if p_reason is null or p_reason not in ('offensive_name', 'harassment', 'impersonation', 'cheating', 'spam', 'other') then
    perform private.fail('invalid_input', 'reason');
  end if;
  if private.league_count(v_uid) = 0 then
    perform private.fail('not_in_league');
  end if;
  perform private.check_rate_limit('report:' || v_uid, 20, interval '1 day');

  if p_target_kind = 'member' then
    v_target := private.league_peer(v_uid, p_member_id);
    select * into v_league from public.leagues where id = v_target.league_id;
    select alias into v_alias from public.profiles where user_id = v_target.user_id;
    insert into private.reports (reporter_id, target_kind, target_user_id, target_league_id, reason_code, content_snapshot)
    values (v_uid, 'member', v_target.user_id, v_league.id, p_reason,
            jsonb_build_object('alias', v_alias, 'league_name', v_league.name))
    returning id into v_id;
  elsif p_target_kind = 'league' then
    v_mine := private.require_membership(v_uid, p_league_id);
    select * into v_league from public.leagues where id = v_mine.league_id;
    insert into private.reports (reporter_id, target_kind, target_league_id, reason_code, content_snapshot)
    values (v_uid, 'league', v_league.id, p_reason, jsonb_build_object('league_name', v_league.name))
    returning id into v_id;
  else
    perform private.fail('invalid_input', 'target_kind');
  end if;
  return jsonb_build_object('report_id', v_id, 'status', 'open');
end
$$;

-- ---------------------------------------------------------------------------------------
-- Cheers, per league
-- ---------------------------------------------------------------------------------------
drop function private.league_cheers(uuid, date);
create or replace function private.league_cheers(p_user uuid, p_week date, p_league_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_member public.league_members := private.membership_in(p_user, p_league_id);
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

-- A cheer names a membership, which names its league. Once a week per pair, whatever the league.
create or replace function public.cheer_member(p_member_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_target public.league_members;
  v_week date := private.current_week_start();
begin
  select * into v_target from public.league_members where id = p_member_id and left_at is null;
  if not found or not exists (select 1 from public.league_members m
                              where m.user_id = v_uid and m.league_id = v_target.league_id and m.left_at is null) then
    if private.league_count(v_uid) = 0 then
      perform private.fail('not_in_league');
    end if;
    perform private.fail('not_found');
  end if;
  if private.are_blocked(v_uid, v_target.user_id) then
    perform private.fail('not_found');
  end if;
  if v_target.user_id = v_uid then
    perform private.fail('invalid_input', 'self');
  end if;
  perform private.check_rate_limit('cheer:' || v_uid, 60, interval '1 day');
  insert into private.cheers (league_id, from_user, to_user, week_start)
  values (v_target.league_id, v_uid, v_target.user_id, v_week)
  on conflict on constraint cheers_once_per_week do nothing;
  return private.league_cheers(v_uid, v_week, v_target.league_id);
end
$$;

drop function public.get_league_cheers(integer);
create or replace function public.get_league_cheers(p_week_offset integer default 0, p_league_id uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
begin
  return private.league_cheers(v_uid, private.current_week_start() + case when p_week_offset = -1 then -7 else 0 end, p_league_id);
end
$$;

-- ---------------------------------------------------------------------------------------
-- Leaving everything at once (account deletion, age restriction), and revisions per league
-- ---------------------------------------------------------------------------------------
-- Ends every active membership now. An owner's league passes to its longest-standing member, or
-- closes when the owner was alone.
create or replace function private.detach_from_league(p_user uuid, p_reason text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_member public.league_members;
  v_successor public.league_members;
begin
  for v_member in
    select * from public.league_members where user_id = p_user and left_at is null order by joined_at, id for update
  loop
    perform 1 from public.leagues where id = v_member.league_id for update;
    if v_member.role = 'owner' then
      select * into v_successor from public.league_members
      where league_id = v_member.league_id and left_at is null and id <> v_member.id
      order by joined_at, id limit 1;
      if found then
        update public.league_members set role = 'owner' where id = v_successor.id;
        update public.leagues set owner_id = v_successor.user_id, updated_at = now() where id = v_member.league_id;
      else
        update public.leagues set status = 'closed', updated_at = now() where id = v_member.league_id;
        update private.league_invites set revoked_at = now() where league_id = v_member.league_id and revoked_at is null;
      end if;
    end if;
    update public.league_members set left_at = now(), left_reason = p_reason, role = 'member' where id = v_member.id;
  end loop;
  update private.league_invites set revoked_at = now() where created_by = p_user and revoked_at is null;
end
$$;

create or replace function private.record_league_revisions(p_owner uuid, p_dates date[], p_reason text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_member public.league_members;
  v_week date;
begin
  for v_member in select * from public.league_members where user_id = p_owner and left_at is null loop
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
  end loop;
end
$$;

-- ---------------------------------------------------------------------------------------
-- League pushes: duels, group runs and season champions
-- ---------------------------------------------------------------------------------------
alter table private.notification_prefs add column league boolean not null default true;
alter table private.push_outbox drop constraint push_outbox_kind_check;
alter table private.push_outbox add constraint push_outbox_kind_check
  check (kind in ('kudos', 'comments', 'follows', 'cheers', 'results', 'league'));

create or replace function private.push_wanted(p_user uuid, p_kind text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce((select case p_kind when 'kudos' then n.kudos when 'comments' then n.comments when 'follows' then n.follows
                                      when 'cheers' then n.cheers when 'results' then n.results when 'league' then n.league end
                   from private.notification_prefs n where n.user_id = p_user), true)
$$;

create or replace function private.notification_settings_json(p_uid uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'available', coalesce((select i.available from private.integrations i where i.name = 'push'), false),
    'prefs', jsonb_build_object(
      'kudos', private.push_wanted(p_uid, 'kudos'),
      'comments', private.push_wanted(p_uid, 'comments'),
      'follows', private.push_wanted(p_uid, 'follows'),
      'cheers', private.push_wanted(p_uid, 'cheers'),
      'results', private.push_wanted(p_uid, 'results'),
      'league', private.push_wanted(p_uid, 'league')),
    'devices', (select count(*) from private.push_tokens t where t.user_id = p_uid))
$$;

create or replace function public.set_notification_prefs(p_prefs jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_key text;
begin
  if p_prefs is null or jsonb_typeof(p_prefs) <> 'object' then
    perform private.fail('invalid_input', 'prefs');
  end if;
  for v_key in select jsonb_object_keys(p_prefs) loop
    if v_key not in ('kudos', 'comments', 'follows', 'cheers', 'results', 'league') or jsonb_typeof(p_prefs -> v_key) <> 'boolean' then
      perform private.fail('invalid_input', 'prefs');
    end if;
  end loop;
  insert into private.notification_prefs as n (user_id, kudos, comments, follows, cheers, results, league)
  values (v_uid, coalesce((p_prefs ->> 'kudos')::boolean, true), coalesce((p_prefs ->> 'comments')::boolean, true),
          coalesce((p_prefs ->> 'follows')::boolean, true), coalesce((p_prefs ->> 'cheers')::boolean, true),
          coalesce((p_prefs ->> 'results')::boolean, true), coalesce((p_prefs ->> 'league')::boolean, true))
  on conflict (user_id) do update set
    kudos = coalesce((p_prefs ->> 'kudos')::boolean, n.kudos),
    comments = coalesce((p_prefs ->> 'comments')::boolean, n.comments),
    follows = coalesce((p_prefs ->> 'follows')::boolean, n.follows),
    cheers = coalesce((p_prefs ->> 'cheers')::boolean, n.cheers),
    results = coalesce((p_prefs ->> 'results')::boolean, n.results),
    league = coalesce((p_prefs ->> 'league')::boolean, n.league),
    updated_at = now();
  return private.notification_settings_json(v_uid);
end
$$;

-- A group-run reminder an hour before the start can't wait for the morning, so it may ignore
-- quiet hours; everything else waits until 07:00.
drop function private.notify(uuid, uuid, text, text, text, text, text, uuid, uuid, text, text, interval);
create or replace function private.notify(
  p_user uuid,
  p_actor uuid,
  p_kind text,
  p_title text,
  p_body text,
  p_url text,
  p_dedupe text,
  p_run_id uuid default null,
  p_comment_id uuid default null,
  p_collapse text default null,
  p_many_body text default null,
  p_delay interval default interval '0',
  p_ignore_quiet boolean default false
)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_at timestamptz := now() + coalesce(p_delay, interval '0');
begin
  if p_user is null or p_user = p_actor or not private.visible_profile(p_user)
     or (p_actor is not null and private.are_blocked(p_user, p_actor))
     or not private.push_wanted(p_user, p_kind)
     or not exists (select 1 from private.push_tokens t where t.user_id = p_user) then
    return false;
  end if;
  if p_dedupe is not null then
    insert into private.push_dedupe (key) values (p_dedupe) on conflict do nothing;
    if not found then
      return false;
    end if;
  end if;
  if not coalesce(p_ignore_quiet, false) then
    v_at := private.push_send_after(p_user, v_at);
  end if;
  if p_collapse is null then
    insert into private.push_outbox (user_id, actor_id, kind, title, body, url, run_id, comment_id, send_after)
    values (p_user, p_actor, p_kind, left(p_title, 120), left(p_body, 240), p_url, p_run_id, p_comment_id, v_at);
  else
    insert into private.push_outbox as o (user_id, actor_id, kind, title, body, many_body, url, run_id, comment_id, collapse_key, send_after)
    values (p_user, p_actor, p_kind, left(p_title, 120), left(p_body, 240), left(p_many_body, 240), p_url, p_run_id, p_comment_id,
            p_user || ':' || p_collapse, v_at)
    on conflict (collapse_key) where sent_at is null and dropped_at is null and collapse_key is not null
    do update set actors = o.actors + 1, actor_id = excluded.actor_id, title = excluded.title, body = excluded.body,
                  many_body = excluded.many_body;
  end if;
  return true;
end
$$;

-- When something happens, in the runner's own time zone ("Sat 8:00 AM").
create or replace function private.local_when(p_user uuid, p_at timestamptz)
returns text
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_tz text;
begin
  select coalesce(p.notification_tz, 'America/Chicago') into v_tz from public.profiles p where p.user_id = p_user;
  begin
    return to_char(p_at at time zone coalesce(v_tz, 'America/Chicago'), 'Dy FMHH12:MI AM');
  exception when others then
    return to_char(p_at at time zone 'America/Chicago', 'Dy FMHH12:MI AM');
  end;
end
$$;

-- Several leagues' results the same week arrive as one push.
create or replace function private.enqueue_week_results(p_now timestamptz default now())
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_week date := private.week_start(private.competition_date(p_now)) - 7;
  v_final timestamptz := private.day_start(v_week + 7) + interval '24 hours';
  v_league record;
  v_row record;
  v_count integer := 0;
begin
  if p_now < v_final or p_now > v_final + interval '48 hours' then
    return 0;
  end if;
  for v_league in
    select l.id, l.name from public.leagues l
    where l.status = 'active'
      and not exists (select 1 from private.results_notified n where n.league_id = l.id and n.week_start = v_week)
    order by l.id
    limit 200
  loop
    insert into private.results_notified (league_id, week_start) values (v_league.id, v_week);
    for v_row in
      select m.user_id, (s ->> 'rank')::integer as place, (s ->> 'weekly_xp')::integer as xp, jsonb_array_length(st.standings) as size
      from (select private.league_standings(v_league.id, v_week, '00000000-0000-0000-0000-000000000000'::uuid) as standings) st
      cross join lateral jsonb_array_elements(st.standings) s
      join public.league_members m on m.id = (s ->> 'member_id')::uuid
    loop
      if v_row.xp > 0 and v_row.size >= 2 then
        if private.notify(v_row.user_id, null, 'results', 'Week results',
             'You finished ' || private.ordinal(v_row.place) || ' of ' || v_row.size || ' in ' || v_league.name || ' with ' || v_row.xp || ' XP. A new week has started.',
             '/league', 'results:' || v_league.id || ':' || v_week || ':' || v_row.user_id,
             p_collapse => 'results:' || v_week,
             p_many_body => 'Your results are in for ' || v_league.name || ' and {others}.') then
          v_count := v_count + 1;
        end if;
      end if;
    end loop;
  end loop;
  return v_count;
end
$$;

-- ---------------------------------------------------------------------------------------
-- Seasons: four weeks, a champion
-- ---------------------------------------------------------------------------------------
-- Seasons are four competition weeks, counted from Monday 5 January 2026 for every league, so
-- friends in several leagues see the same boundaries. Dates are competition-calendar dates, so
-- a season is the same four weeks whatever the clocks do.
create or replace function private.season_start(p_week date)
returns date
language sql immutable
as $$
  select date '2026-01-05' + 28 * floor((p_week - date '2026-01-05') / 28.0)::integer
$$;

-- A league's seasons are numbered from 1, starting with the one it was created in.
create or replace function private.season_number(p_league_created timestamptz, p_season date)
returns integer
language sql stable
as $$
  select ((p_season - private.season_start(private.week_start(private.competition_date(p_league_created)))) / 28) + 1
$$;

create table private.seasons_settled (
  league_id uuid not null references public.leagues (id) on delete cascade,
  season_start date not null,
  settled_at timestamptz not null default now(),
  primary key (league_id, season_start)
);

create table private.season_champions (
  league_id uuid not null references public.leagues (id) on delete cascade,
  season_start date not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  alias_snapshot text not null,
  season_xp integer not null,
  created_at timestamptz not null default now(),
  primary key (league_id, season_start, user_id)
);

-- Season standings: each current member's weekly XP (best three days, as every week) summed over
-- the season's weeks up to p_through.
create or replace function private.league_season(p_league_id uuid, p_season date, p_viewer uuid, p_through date)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  with weeks as (
    select p_season + 7 * i as w from generate_series(0, 3) i where p_season + 7 * i <= p_through
  ),
  weekly as (
    select (s ->> 'member_id')::uuid as member_id, s ->> 'alias' as alias, s ->> 'tier' as tier,
           (s ->> 'hidden')::boolean as hidden, (s ->> 'is_me')::boolean as is_me, (s ->> 'weekly_xp')::integer as xp
    from weeks cross join lateral jsonb_array_elements(private.league_standings(p_league_id, weeks.w, p_viewer)) s
  ),
  totals as (
    select member_id, max(alias) as alias, max(tier) as tier, bool_or(hidden) as hidden, bool_or(is_me) as is_me,
           sum(xp)::integer as season_xp
    from weekly group by member_id
  ),
  ranked as (
    select t.*, rank() over (order by t.season_xp desc) as place from totals t
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'member_id', r.member_id, 'rank', r.place, 'alias', r.alias, 'tier', r.tier,
           'season_xp', r.season_xp, 'is_me', r.is_me, 'hidden', r.hidden)
         order by r.season_xp desc, lower(r.alias) collate "C", r.member_id), '[]'::jsonb)
  from ranked r
$$;

create or replace function public.get_league_season(p_league_id uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_member public.league_members := private.require_membership(v_uid, p_league_id);
  v_league public.leagues;
  v_week date := private.current_week_start();
  v_season date := private.season_start(private.current_week_start());
begin
  select * into v_league from public.leagues where id = v_member.league_id;
  return jsonb_build_object(
    'league_id', v_league.id,
    'number', private.season_number(v_league.created_at, v_season),
    'starts_on', v_season,
    'ends_on', v_season + 27,
    'week', (v_week - v_season) / 7 + 1,
    'ends_at_ms', private.ts_to_ms(private.day_start(v_season + 28)),
    'standings', private.league_season(v_league.id, v_season, v_uid, v_week),
    'champions', coalesce((
      select jsonb_agg(jsonb_build_object(
               'season_start', c.season_start,
               'number', private.season_number(v_league.created_at, c.season_start),
               'alias', case when private.are_blocked(v_uid, c.user_id) then null
                             else coalesce((select p.alias from public.profiles p where p.user_id = c.user_id and p.status = 'active'), c.alias_snapshot) end,
               'season_xp', c.season_xp,
               'is_me', c.user_id = v_uid)
             order by c.season_start desc, c.season_xp desc)
      from (select * from private.season_champions x where x.league_id = v_league.id
            order by x.season_start desc limit 12) c), '[]'::jsonb));
end
$$;

-- Once a season's last week is final, its champions (the top season XP, ties shared, only if
-- they ran) are kept, and told.
create or replace function private.settle_seasons(p_now timestamptz default now())
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_season date := private.season_start(private.week_start(private.competition_date(p_now))) - 28;
  v_final timestamptz := private.day_start(v_season + 28) + interval '24 hours';
  v_league record;
  v_row record;
  v_number integer;
  v_count integer := 0;
begin
  if p_now < v_final then
    return 0;
  end if;
  for v_league in
    select l.id, l.name, l.created_at from public.leagues l
    where l.status = 'active' and l.created_at < private.day_start(v_season + 28)
      and not exists (select 1 from private.seasons_settled s where s.league_id = l.id and s.season_start = v_season)
    order by l.id
    limit 100
  loop
    insert into private.seasons_settled (league_id, season_start) values (v_league.id, v_season);
    v_number := private.season_number(v_league.created_at, v_season);
    for v_row in
      select m.user_id, s ->> 'alias' as alias, (s ->> 'season_xp')::integer as xp
      from jsonb_array_elements(private.league_season(v_league.id, v_season, '00000000-0000-0000-0000-000000000000'::uuid, v_season + 21)) s
      join public.league_members m on m.id = (s ->> 'member_id')::uuid
      where (s ->> 'rank')::integer = 1 and (s ->> 'season_xp')::integer > 0
    loop
      insert into private.season_champions (league_id, season_start, user_id, alias_snapshot, season_xp)
      values (v_league.id, v_season, v_row.user_id, coalesce(v_row.alias, 'Runner'), v_row.xp)
      on conflict do nothing;
      perform private.notify(v_row.user_id, null, 'league', 'Season champion',
        'You won season ' || v_number || ' of ' || v_league.name || ' with ' || v_row.xp || ' XP.', '/league',
        'champion:' || v_league.id || ':' || v_season || ':' || v_row.user_id);
      v_count := v_count + 1;
    end loop;
  end loop;
  return v_count;
end
$$;

-- ---------------------------------------------------------------------------------------
-- Duels: one-on-one for a week, scored like the league (best three days)
-- ---------------------------------------------------------------------------------------
create table private.duels (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references public.leagues (id) on delete cascade,
  week_start date not null,
  challenger_id uuid not null references auth.users (id) on delete cascade,
  opponent_id uuid not null references auth.users (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'cancelled')),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  constraint duels_not_self check (challenger_id <> opponent_id)
);
create unique index duels_open_pair on private.duels
  (league_id, week_start, least(challenger_id, opponent_id), greatest(challenger_id, opponent_id))
  where status in ('pending', 'accepted');
create index duels_challenger_week on private.duels (challenger_id, week_start);
create index duels_opponent_week on private.duels (opponent_id, week_start);

create or replace function private.duels_json(p_user uuid, p_league_id uuid, p_week date)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_standings jsonb := private.league_standings(p_league_id, p_week, p_user);
  v_final boolean := now() >= private.day_start(p_week + 7) + interval '24 hours';
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', d.id,
             'status', d.status,
             'i_challenged', d.challenger_id = p_user,
             'opponent', jsonb_build_object('member_id', o.member_id, 'alias', o.st ->> 'alias', 'tier', o.st ->> 'tier',
                                            'weekly_xp', (o.st ->> 'weekly_xp')::integer),
             'my_xp', (me.st ->> 'weekly_xp')::integer,
             'state', case when now() < private.day_start(p_week + 7) then 'in_progress'
                           when not v_final then 'settling' else 'final' end,
             'result', case when d.status <> 'accepted' or not v_final then null
                            when (me.st ->> 'weekly_xp')::integer > (o.st ->> 'weekly_xp')::integer then 'won'
                            when (me.st ->> 'weekly_xp')::integer < (o.st ->> 'weekly_xp')::integer then 'lost'
                            else 'tied' end)
           order by d.created_at)
    from private.duels d
    cross join lateral (
      select m.id as member_id, s as st
      from public.league_members m
      join jsonb_array_elements(v_standings) s on (s ->> 'member_id')::uuid = m.id
      where m.league_id = p_league_id and m.left_at is null
        and m.user_id = case when d.challenger_id = p_user then d.opponent_id else d.challenger_id end
    ) o
    cross join lateral (
      select s as st from jsonb_array_elements(v_standings) s where (s ->> 'is_me')::boolean
    ) me
    where d.league_id = p_league_id and d.week_start = p_week and p_user in (d.challenger_id, d.opponent_id)
      and d.status in ('pending', 'accepted')
      and not coalesce((o.st ->> 'hidden')::boolean, false)), '[]'::jsonb);
end
$$;

create or replace function public.list_duels(p_league_id uuid default null, p_week_offset integer default 0)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_member public.league_members := private.require_membership(v_uid, p_league_id);
begin
  return private.duels_json(v_uid, v_member.league_id,
                            private.current_week_start() + case when p_week_offset = -1 then -7 else 0 end);
end
$$;

-- This week's duel with a league-mate: they accept or decline; three open duels a week at most.
create or replace function public.challenge_duel(p_member_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_target public.league_members := private.league_peer(v_uid, p_member_id);
  v_week date := private.current_week_start();
  v_id uuid;
  v_alias text;
  v_league text;
begin
  if private.are_blocked(v_uid, v_target.user_id) then
    perform private.fail('not_found');
  end if;
  if (select count(*) from private.duels d
      where d.week_start = v_week and d.status in ('pending', 'accepted') and v_uid in (d.challenger_id, d.opponent_id)) >= 3 then
    perform private.fail('duel_limit');
  end if;
  perform private.check_rate_limit('duel:' || v_uid, 20, interval '1 day');
  begin
    insert into private.duels (league_id, week_start, challenger_id, opponent_id)
    values (v_target.league_id, v_week, v_uid, v_target.user_id)
    returning id into v_id;
  exception when unique_violation then
    perform private.fail('duel_exists');
  end;
  select alias into v_alias from public.profiles where user_id = v_uid;
  select name into v_league from public.leagues where id = v_target.league_id;
  perform private.notify(v_target.user_id, v_uid, 'league', 'Duel challenge',
    v_alias || ' challenged you to a duel this week in ' || v_league || '. Best three days wins.', '/league', 'duel:' || v_id);
  return private.duels_json(v_uid, v_target.league_id, v_week);
end
$$;

create or replace function public.respond_duel(p_duel_id uuid, p_accept boolean)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_duel private.duels;
  v_alias text;
begin
  select * into v_duel from private.duels where id = p_duel_id and opponent_id = v_uid for update;
  if not found or v_duel.status <> 'pending' or v_duel.week_start <> private.current_week_start()
     or not exists (select 1 from public.league_members m where m.user_id = v_uid and m.league_id = v_duel.league_id and m.left_at is null) then
    perform private.fail('not_found');
  end if;
  update private.duels set status = case when p_accept then 'accepted' else 'declined' end, responded_at = now() where id = v_duel.id;
  if p_accept then
    select alias into v_alias from public.profiles where user_id = v_uid;
    perform private.notify(v_duel.challenger_id, v_uid, 'league', 'Duel on', v_alias || ' accepted your duel. Good luck this week.',
      '/league', 'duel_accepted:' || v_duel.id);
  end if;
  return private.duels_json(v_uid, v_duel.league_id, v_duel.week_start);
end
$$;

create or replace function public.cancel_duel(p_duel_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_duel private.duels;
begin
  select * into v_duel from private.duels where id = p_duel_id and challenger_id = v_uid for update;
  if not found or v_duel.status <> 'pending' then
    perform private.fail('not_found');
  end if;
  update private.duels set status = 'cancelled', responded_at = now() where id = v_duel.id;
  return private.duels_json(v_uid, v_duel.league_id, v_duel.week_start);
end
$$;

-- ---------------------------------------------------------------------------------------
-- The week's recap (shown from Sunday), per league
-- ---------------------------------------------------------------------------------------
create or replace function public.get_week_recap(p_league_id uuid default null, p_week_offset integer default 0)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_member public.league_members := private.require_membership(v_uid, p_league_id);
  v_week date := private.current_week_start() + case when p_week_offset = -1 then -7 else 0 end;
  v_standings jsonb := private.league_standings(v_member.league_id, v_week, v_uid);
  v_me jsonb;
  v_top jsonb;
  v_duels jsonb := private.duels_json(v_uid, v_member.league_id, v_week);
begin
  select s into v_me from jsonb_array_elements(v_standings) s where (s ->> 'is_me')::boolean limit 1;
  select s into v_top from jsonb_array_elements(v_standings) s
  where not (s ->> 'hidden')::boolean and (s ->> 'weekly_xp')::integer > 0 order by (s ->> 'weekly_xp')::integer desc limit 1;
  return jsonb_build_object(
    'league_id', v_member.league_id,
    'week_start', v_week,
    'state', case when now() < private.day_start(v_week + 7) then 'in_progress'
                  when now() < private.day_start(v_week + 7) + interval '24 hours' then 'settling' else 'final' end,
    'league', (
      with members as (
        select m.user_id, m.joined_at from public.league_members m where m.league_id = v_member.league_id and m.left_at is null
      ),
      week_runs as (
        select r.owner_id, coalesce(r.distance_cm / 100.0, r.client_distance_m::numeric) as metres
        from public.runs r join members mb on mb.user_id = r.owner_id
        where r.deleted_at is null and r.status = 'accepted' and r.duplicate_of is null
          and r.started_at >= private.day_start(v_week) and r.started_at < private.day_start(v_week + 7)
          and r.started_at >= mb.joined_at
      )
      select jsonb_build_object(
        'members', (select count(*) from members),
        'runs', (select count(*) from week_runs),
        'distance_m', coalesce((select round(sum(metres)) from week_runs), 0),
        'active_runners', (select count(distinct owner_id) from week_runs),
        'top', case when v_top is null then null else jsonb_build_object('alias', v_top ->> 'alias', 'weekly_xp', (v_top ->> 'weekly_xp')::integer) end)),
    'me', jsonb_build_object(
      'runs', (select count(*) from public.runs r
               where r.owner_id = v_uid and r.deleted_at is null and r.status = 'accepted' and r.duplicate_of is null
                 and r.started_at >= private.day_start(v_week) and r.started_at < private.day_start(v_week + 7)),
      'distance_m', coalesce((select round(sum(coalesce(r.distance_cm / 100.0, r.client_distance_m::numeric))) from public.runs r
                              where r.owner_id = v_uid and r.deleted_at is null and r.status = 'accepted' and r.duplicate_of is null
                                and r.started_at >= private.day_start(v_week) and r.started_at < private.day_start(v_week + 7)), 0),
      'weekly_xp', coalesce((v_me ->> 'weekly_xp')::integer, 0),
      'rank', (v_me ->> 'rank')::integer,
      'cheers', (select count(*) from private.cheers ch
                 where ch.league_id = v_member.league_id and ch.week_start = v_week and ch.to_user = v_uid
                   and not private.are_blocked(v_uid, ch.from_user)),
      'duels', jsonb_build_object(
        'won', (select count(*) from jsonb_array_elements(v_duels) d where d ->> 'result' = 'won'),
        'lost', (select count(*) from jsonb_array_elements(v_duels) d where d ->> 'result' = 'lost'),
        'tied', (select count(*) from jsonb_array_elements(v_duels) d where d ->> 'result' = 'tied'),
        'open', (select count(*) from jsonb_array_elements(v_duels) d where d ->> 'result' is null))));
end
$$;

-- ---------------------------------------------------------------------------------------
-- Group runs: a time, a meeting point and RSVPs
-- ---------------------------------------------------------------------------------------
create table private.group_runs (
  id uuid primary key default gen_random_uuid(),
  league_id uuid references public.leagues (id) on delete cascade,
  created_by uuid references auth.users (id) on delete set null,
  title text not null check (char_length(title) between 3 and 60),
  starts_at timestamptz not null,
  meeting_point text not null check (char_length(meeting_point) between 3 and 80),
  notes text check (notes is null or char_length(notes) <= 280),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  cancelled_at timestamptz,
  reminded_at timestamptz,
  constraint group_runs_has_group check (league_id is not null)
);
create index group_runs_league_idx on private.group_runs (league_id, starts_at);
create index group_runs_due_idx on private.group_runs (starts_at) where cancelled_at is null and reminded_at is null;

create table private.group_run_rsvps (
  group_run_id uuid not null references private.group_runs (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  status text not null check (status in ('going', 'maybe', 'not_going')),
  updated_at timestamptz not null default now(),
  primary key (group_run_id, user_id)
);
create index group_run_rsvps_user_idx on private.group_run_rsvps (user_id);

-- Whether the runner belongs to the group a group run is for.
create or replace function private.in_group_of(p_user uuid, p_run private.group_runs)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.league_members m where m.user_id = p_user and m.league_id = p_run.league_id and m.left_at is null)
$$;

-- Whether the runner may change or cancel it: whoever planned it, or the group's owner.
create or replace function private.can_edit_group_run(p_user uuid, p_run private.group_runs)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select p_run.created_by = p_user
      or exists (select 1 from public.league_members m
                 where m.user_id = p_user and m.league_id = p_run.league_id and m.left_at is null and m.role = 'owner')
$$;

create or replace function private.group_run_json(p_run private.group_runs, p_viewer uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'id', p_run.id,
    'league_id', p_run.league_id,
    'title', p_run.title,
    'starts_at_ms', private.ts_to_ms(p_run.starts_at),
    'meeting_point', p_run.meeting_point,
    'notes', p_run.notes,
    'host', case when p_run.created_by is null or private.are_blocked(p_viewer, p_run.created_by) or not private.visible_profile(p_run.created_by)
                 then null else (select p.alias from public.profiles p where p.user_id = p_run.created_by) end,
    'is_host', p_run.created_by = p_viewer,
    'can_edit', private.can_edit_group_run(p_viewer, p_run),
    'cancelled', p_run.cancelled_at is not null,
    'my_rsvp', (select r.status from private.group_run_rsvps r where r.group_run_id = p_run.id and r.user_id = p_viewer),
    'going', coalesce((select jsonb_agg(p.alias order by r.updated_at)
                       from private.group_run_rsvps r join public.profiles p on p.user_id = r.user_id
                       where r.group_run_id = p_run.id and r.status = 'going' and private.visible_profile(r.user_id)
                         and not private.are_blocked(p_viewer, r.user_id)), '[]'::jsonb),
    'going_count', (select count(*) from private.group_run_rsvps r where r.group_run_id = p_run.id and r.status = 'going'
                    and private.visible_profile(r.user_id)),
    'maybe_count', (select count(*) from private.group_run_rsvps r where r.group_run_id = p_run.id and r.status = 'maybe'
                    and private.visible_profile(r.user_id)))
$$;

create or replace function private.group_run_text_problem(p_title text, p_meeting text, p_notes text)
returns text
language plpgsql stable security definer set search_path = ''
as $$
begin
  if char_length(coalesce(p_title, '')) < 3 or char_length(p_title) > 60
     or char_length(coalesce(p_meeting, '')) < 3 or char_length(p_meeting) > 80
     or (p_notes is not null and char_length(p_notes) > 280) then
    return 'invalid';
  end if;
  return coalesce(private.comment_problem(p_title), private.comment_problem(p_meeting),
                  case when p_notes is null then null else private.comment_problem(p_notes) end);
end
$$;

create or replace function public.list_group_runs(p_league_id uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_member public.league_members := private.require_membership(v_uid, p_league_id);
begin
  return coalesce((
    select jsonb_agg(private.group_run_json(g, v_uid) order by g.starts_at)
    from private.group_runs g
    where g.league_id = v_member.league_id
      and g.starts_at > now() - interval '3 hours'
      and (g.cancelled_at is null or g.cancelled_at > now() - interval '1 day')), '[]'::jsonb);
end
$$;

create or replace function public.create_group_run(
  p_title text,
  p_starts_at_ms bigint,
  p_meeting_point text,
  p_notes text default null,
  p_league_id uuid default null
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_member public.league_members := private.require_membership(v_uid, p_league_id);
  v_title text := private.normalize_name(p_title);
  v_meeting text := private.normalize_name(p_meeting_point);
  v_notes text := nullif(private.normalize_comment(p_notes), '');
  v_starts timestamptz := private.ms_to_ts(p_starts_at_ms);
  v_problem text;
  v_run private.group_runs;
  v_alias text;
  v_league text;
  v_to record;
begin
  if v_starts is null or v_starts < now() + interval '15 minutes' or v_starts > now() + interval '90 days' then
    perform private.fail('invalid_input', 'starts_at');
  end if;
  v_problem := private.group_run_text_problem(v_title, v_meeting, v_notes);
  if v_problem = 'invalid' then
    perform private.fail('invalid_input', 'text');
  elsif v_problem = 'not_allowed' then
    perform private.fail('comment_not_allowed');
  end if;
  perform private.check_rate_limit('group_run:' || v_uid, 10, interval '1 day');
  insert into private.group_runs (league_id, created_by, title, starts_at, meeting_point, notes)
  values (v_member.league_id, v_uid, v_title, v_starts, v_meeting, v_notes)
  returning * into v_run;
  insert into private.group_run_rsvps (group_run_id, user_id, status) values (v_run.id, v_uid, 'going');

  select alias into v_alias from public.profiles where user_id = v_uid;
  select name into v_league from public.leagues where id = v_member.league_id;
  for v_to in select m.user_id from public.league_members m where m.league_id = v_member.league_id and m.left_at is null and m.user_id <> v_uid loop
    perform private.notify(v_to.user_id, v_uid, 'league', 'Group run in ' || v_league,
      v_alias || ' planned “' || v_title || '”, ' || private.local_when(v_to.user_id, v_starts) || ' at ' || v_meeting || '. Are you in?',
      '/league', 'group_run:' || v_run.id || ':' || v_to.user_id);
  end loop;
  return private.group_run_json(v_run, v_uid);
end
$$;

create or replace function public.update_group_run(
  p_group_run_id uuid,
  p_title text,
  p_starts_at_ms bigint,
  p_meeting_point text,
  p_notes text default null
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_run private.group_runs;
  v_title text := private.normalize_name(p_title);
  v_meeting text := private.normalize_name(p_meeting_point);
  v_notes text := nullif(private.normalize_comment(p_notes), '');
  v_starts timestamptz := private.ms_to_ts(p_starts_at_ms);
  v_problem text;
  v_moved boolean;
  v_to record;
begin
  select * into v_run from private.group_runs where id = p_group_run_id for update;
  if not found or not private.in_group_of(v_uid, v_run) then
    perform private.fail('not_found');
  end if;
  if not private.can_edit_group_run(v_uid, v_run) then
    perform private.fail('not_allowed');
  end if;
  if v_run.cancelled_at is not null or v_run.starts_at < now() then
    perform private.fail('invalid_input', 'finished');
  end if;
  if v_starts is null or v_starts < now() + interval '15 minutes' or v_starts > now() + interval '90 days' then
    perform private.fail('invalid_input', 'starts_at');
  end if;
  v_problem := private.group_run_text_problem(v_title, v_meeting, v_notes);
  if v_problem = 'invalid' then
    perform private.fail('invalid_input', 'text');
  elsif v_problem = 'not_allowed' then
    perform private.fail('comment_not_allowed');
  end if;
  v_moved := v_starts <> v_run.starts_at or v_meeting <> v_run.meeting_point;
  update private.group_runs
     set title = v_title, meeting_point = v_meeting, notes = v_notes, starts_at = v_starts, updated_at = now(),
         reminded_at = case when v_starts <> v_run.starts_at then null else reminded_at end
   where id = v_run.id
  returning * into v_run;
  -- A new time or place is worth telling whoever said they might come.
  if v_moved then
    for v_to in select r.user_id from private.group_run_rsvps r where r.group_run_id = v_run.id and r.status in ('going', 'maybe') and r.user_id <> v_uid loop
      perform private.notify(v_to.user_id, v_uid, 'league', 'Group run changed',
        '“' || v_run.title || '” is now ' || private.local_when(v_to.user_id, v_run.starts_at) || ' at ' || v_run.meeting_point || '.',
        '/league', 'group_run_changed:' || v_run.id || ':' || v_to.user_id || ':' || private.ts_to_ms(v_run.updated_at));
    end loop;
  end if;
  return private.group_run_json(v_run, v_uid);
end
$$;

create or replace function public.cancel_group_run(p_group_run_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_run private.group_runs;
  v_to record;
begin
  select * into v_run from private.group_runs where id = p_group_run_id for update;
  if not found or not private.in_group_of(v_uid, v_run) then
    perform private.fail('not_found');
  end if;
  if not private.can_edit_group_run(v_uid, v_run) then
    perform private.fail('not_allowed');
  end if;
  if v_run.cancelled_at is null then
    update private.group_runs set cancelled_at = now(), updated_at = now() where id = v_run.id returning * into v_run;
    for v_to in select r.user_id from private.group_run_rsvps r where r.group_run_id = v_run.id and r.status in ('going', 'maybe') and r.user_id <> v_uid loop
      perform private.notify(v_to.user_id, v_uid, 'league', 'Group run cancelled',
        '“' || v_run.title || '” on ' || private.local_when(v_to.user_id, v_run.starts_at) || ' is cancelled.', '/league',
        'group_run_cancelled:' || v_run.id || ':' || v_to.user_id, p_ignore_quiet => v_run.starts_at < now() + interval '12 hours');
    end loop;
  end if;
  return private.group_run_json(v_run, v_uid);
end
$$;

create or replace function public.rsvp_group_run(p_group_run_id uuid, p_status text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_run private.group_runs;
begin
  if p_status is null or p_status not in ('going', 'maybe', 'not_going') then
    perform private.fail('invalid_input', 'status');
  end if;
  select * into v_run from private.group_runs where id = p_group_run_id;
  if not found or not private.in_group_of(v_uid, v_run) then
    perform private.fail('not_found');
  end if;
  if v_run.cancelled_at is not null or v_run.starts_at < now() - interval '1 hour' then
    perform private.fail('invalid_input', 'finished');
  end if;
  perform private.check_rate_limit('rsvp:' || v_uid, 100, interval '1 day');
  insert into private.group_run_rsvps as r (group_run_id, user_id, status) values (v_run.id, v_uid, p_status)
  on conflict (group_run_id, user_id) do update set status = excluded.status, updated_at = now();
  return private.group_run_json(v_run, v_uid);
end
$$;

-- An hour or so before the start, a reminder to everyone going (even early in the morning).
create or replace function private.enqueue_group_run_reminders(p_now timestamptz default now())
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_run private.group_runs;
  v_to record;
  v_count integer := 0;
begin
  for v_run in
    select * from private.group_runs g
    where g.cancelled_at is null and g.reminded_at is null
      and g.starts_at > p_now + interval '30 minutes' and g.starts_at <= p_now + interval '75 minutes'
    order by g.starts_at
    limit 200
    for update skip locked
  loop
    update private.group_runs set reminded_at = p_now where id = v_run.id;
    for v_to in
      select r.user_id from private.group_run_rsvps r
      where r.group_run_id = v_run.id and r.status = 'going' and private.in_group_of(r.user_id, v_run)
    loop
      if private.notify(v_to.user_id, null, 'league', 'Group run soon',
           '“' || v_run.title || '” starts at ' || private.local_when(v_to.user_id, v_run.starts_at) || ' at ' || v_run.meeting_point || '.',
           '/league', 'group_run_reminder:' || v_run.id || ':' || v_to.user_id || ':' || private.ts_to_ms(v_run.starts_at),
           p_ignore_quiet => true) then
        v_count := v_count + 1;
      end if;
    end loop;
  end loop;
  return v_count;
end
$$;

-- ---------------------------------------------------------------------------------------
-- Jobs and export
-- ---------------------------------------------------------------------------------------
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
    'group_run_reminders', private.enqueue_group_run_reminders());
end
$$;

-- Group runs (their meeting points included) go 30 days after they happened or were cancelled.
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
  v_jobs integer;
  v_push integer;
  v_group_runs integer;
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
  return jsonb_build_object('staged_uploads', v_staged, 'export_jobs', v_exports, 'events', v_events,
    'rate_limits', v_limits, 'reports', v_reports, 'invites', v_invites, 'deletion_jobs', v_jobs, 'pushes', v_push,
    'group_runs', v_group_runs);
end
$$;

create or replace function private.social_export(p_uid uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select private.social_settings_json(p_uid) || jsonb_build_object(
    'following', coalesce((select jsonb_agg(jsonb_build_object('alias', p.alias, 'status', f.status, 'since_ms', private.ts_to_ms(f.created_at)))
                           from private.follows f join public.profiles p on p.user_id = f.followee_id
                           where f.follower_id = p_uid), '[]'::jsonb),
    'followers', coalesce((select jsonb_agg(jsonb_build_object('alias', p.alias, 'status', f.status, 'since_ms', private.ts_to_ms(f.created_at)))
                           from private.follows f join public.profiles p on p.user_id = f.follower_id
                           where f.followee_id = p_uid), '[]'::jsonb),
    'comments', coalesce((select jsonb_agg(jsonb_build_object('run_id', c.run_id, 'reply', c.parent_id is not null, 'body', c.body,
                                                              'created_at_ms', private.ts_to_ms(c.created_at), 'removed_by', c.removed_by)
                                           order by c.created_at)
                          from private.comments c where c.author_id = p_uid), '[]'::jsonb),
    'kudos_given', coalesce((select jsonb_agg(jsonb_build_object('run_id', k.run_id, 'created_at_ms', private.ts_to_ms(k.created_at))
                                              order by k.created_at)
                             from private.kudos k where k.user_id = p_uid), '[]'::jsonb),
    'notifications', (private.notification_settings_json(p_uid) - 'available'),
    'duels', coalesce((select jsonb_agg(jsonb_build_object('league', l.name, 'week_start', d.week_start, 'status', d.status,
                                                           'i_challenged', d.challenger_id = p_uid)
                                        order by d.created_at)
                       from private.duels d join public.leagues l on l.id = d.league_id
                       where p_uid in (d.challenger_id, d.opponent_id)), '[]'::jsonb),
    'group_runs_planned', coalesce((select jsonb_agg(jsonb_build_object('title', g.title, 'starts_at_ms', private.ts_to_ms(g.starts_at),
                                                                        'meeting_point', g.meeting_point, 'notes', g.notes,
                                                                        'cancelled', g.cancelled_at is not null)
                                                     order by g.starts_at)
                                    from private.group_runs g where g.created_by = p_uid), '[]'::jsonb),
    'group_run_rsvps', coalesce((select jsonb_agg(jsonb_build_object('title', g.title, 'starts_at_ms', private.ts_to_ms(g.starts_at),
                                                                     'status', r.status)
                                                  order by g.starts_at)
                                 from private.group_run_rsvps r join private.group_runs g on g.id = r.group_run_id
                                 where r.user_id = p_uid), '[]'::jsonb),
    'season_titles', coalesce((select jsonb_agg(jsonb_build_object('league', l.name, 'season_start', c.season_start, 'season_xp', c.season_xp)
                                                order by c.season_start)
                               from private.season_champions c join public.leagues l on l.id = c.league_id
                               where c.user_id = p_uid), '[]'::jsonb))
$$;

select private.apply_function_grants();
