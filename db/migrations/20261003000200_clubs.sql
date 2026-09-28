-- Clubs (docs/ROADMAP.md 4.5): larger groups (up to 500) with a club page, a weekly club board
-- scored like leagues (best three days), group runs with RSVPs and a group-chat link. Clubs are
-- public (found by name, joined in one tap) or invite-only (joined with a code). The owner and
-- admins can edit the page, remove members and remove group runs; anyone can report a club or a
-- group run to the moderation queue. There is no chat in the app (decision 6).

-- ---------------------------------------------------------------------------------------
-- Clubs and members
-- ---------------------------------------------------------------------------------------
create table private.clubs (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 3 and 40),
  description text check (description is null or char_length(description) <= 280),
  visibility text not null default 'invite_only' check (visibility in ('public', 'invite_only')),
  capacity smallint not null default 500 check (capacity between 2 and 1000),
  chat_url text check (chat_url is null or char_length(chat_url) <= 200),
  created_by uuid references auth.users (id) on delete set null,
  status text not null default 'active' check (status in ('active', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index clubs_public_name_idx on private.clubs (lower(name)) where status = 'active' and visibility = 'public';

create table private.club_members (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references private.clubs (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'admin', 'member')),
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  left_reason text check (left_reason in ('left', 'removed', 'club_closed', 'account_deleted', 'age_restricted')),
  constraint club_members_left_consistent check ((left_at is null) = (left_reason is null))
);
create unique index club_members_active_once on private.club_members (club_id, user_id) where left_at is null;
create index club_members_active_by_user on private.club_members (user_id) where left_at is null;
create index club_members_active_by_club on private.club_members (club_id) where left_at is null;

create table private.club_bans (
  club_id uuid not null references private.clubs (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (club_id, user_id)
);

create table private.club_invites (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references private.clubs (id) on delete cascade,
  code_hash text not null unique,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);

create or replace function private.max_clubs()
returns integer
language sql immutable
as $$ select 10 $$;

create or replace function private.club_invite_hash(p_code text)
returns text
language sql immutable
as $$
  select encode(sha256(convert_to('pl-club-invite-v1:' || private.normalize_invite_code(p_code), 'UTF8')), 'hex')
$$;

create or replace function private.club_membership(p_user uuid, p_club_id uuid)
returns private.club_members
language sql stable security definer set search_path = ''
as $$
  select * from private.club_members where user_id = p_user and club_id = p_club_id and left_at is null
$$;

create or replace function private.require_club_member(p_user uuid, p_club_id uuid)
returns private.club_members
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_member private.club_members := private.club_membership(p_user, p_club_id);
begin
  if v_member.id is null then
    perform private.fail('not_in_club');
  end if;
  return v_member;
end
$$;

-- The owner and admins run the club.
create or replace function private.require_club_admin(p_user uuid, p_club_id uuid)
returns private.club_members
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_member private.club_members := private.require_club_member(p_user, p_club_id);
begin
  if v_member.role not in ('owner', 'admin') then
    perform private.fail('not_club_admin');
  end if;
  return v_member;
end
$$;

create or replace function private.club_count(p_user uuid)
returns integer
language sql stable security definer set search_path = ''
as $$
  select count(*)::integer from private.club_members where user_id = p_user and left_at is null
$$;

create or replace function private.club_member_count(p_club_id uuid)
returns integer
language sql stable security definer set search_path = ''
as $$
  select count(*)::integer from private.club_members m
  join public.profiles p on p.user_id = m.user_id and p.status = 'active'
  where m.club_id = p_club_id and m.left_at is null
$$;

-- Name, description and link: the same rules as league names, and comments' rules for the rest.
create or replace function private.club_text_problem(p_name text, p_description text)
returns text
language plpgsql stable security definer set search_path = ''
as $$
begin
  return coalesce(private.name_problem(p_name, 3, 40),
                  case when p_description is null then null
                       when char_length(p_description) > 280 then 'invalid'
                       else private.comment_problem(p_description) end);
end
$$;

-- ---------------------------------------------------------------------------------------
-- The club board: this week's XP of every member, scored like leagues (best three days, from
-- when they joined), members only
-- ---------------------------------------------------------------------------------------
create or replace function private.club_board(p_club_id uuid, p_week date, p_viewer uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  with members as (
    select m.id as member_id, m.user_id, m.role, m.joined_at, p.alias,
           coalesce(ps.lifetime_xp, 0) as lifetime_xp
    from private.club_members m
    join public.profiles p on p.user_id = m.user_id and p.status = 'active'
    left join private.profile_stats ps on ps.user_id = m.user_id
    where m.club_id = p_club_id and m.left_at is null
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
    select s.*, rank() over (order by s.weekly_xp desc) as place,
           row_number() over (order by s.weekly_xp desc, lower(s.alias) collate "C", s.member_id) as n
    from scored s
  ),
  shown as (
    select jsonb_build_object(
             'member_id', r.member_id,
             'rank', r.place,
             'alias', case when r.hidden then null else r.alias end,
             'tier', case when r.hidden then null else private.tier_name(r.lifetime_xp) end,
             'weekly_xp', r.weekly_xp,
             'role', r.role,
             'is_me', r.user_id = p_viewer,
             'hidden', r.hidden) as j,
           r.n, r.user_id
    from ranked r
  )
  select jsonb_build_object(
    'week_start', p_week,
    'members', (select count(*) from members),
    'rows', coalesce((select jsonb_agg(s.j order by s.n) from shown s where s.n <= 100), '[]'::jsonb),
    'me', (select s.j from shown s where s.user_id = p_viewer))
$$;

-- ---------------------------------------------------------------------------------------
-- The club page
-- ---------------------------------------------------------------------------------------
create or replace function private.club_json(p_club private.clubs, p_viewer uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'id', p_club.id,
    'name', p_club.name,
    'description', p_club.description,
    'visibility', p_club.visibility,
    'status', p_club.status,
    'member_count', private.club_member_count(p_club.id),
    'capacity', p_club.capacity,
    'my_role', m.role,
    'is_member', m.id is not null,
    -- Members only.
    'chat_url', case when m.id is not null then p_club.chat_url end,
    'admins', coalesce((select jsonb_agg(jsonb_build_object('alias', p.alias, 'role', a.role) order by a.role = 'owner' desc, a.joined_at)
                        from private.club_members a join public.profiles p on p.user_id = a.user_id and p.status = 'active'
                        where a.club_id = p_club.id and a.left_at is null and a.role in ('owner', 'admin')
                          and not private.are_blocked(p_viewer, a.user_id)), '[]'::jsonb),
    'can_join', m.id is null and p_club.status = 'active' and p_club.visibility = 'public'
                and not exists (select 1 from private.club_bans b where b.club_id = p_club.id and b.user_id = p_viewer)
                and private.club_member_count(p_club.id) < p_club.capacity,
    'created_at_ms', private.ts_to_ms(p_club.created_at))
  from (select 1) one
  left join private.club_members m on m.club_id = p_club.id and m.user_id = p_viewer and m.left_at is null
$$;

-- A club as the caller may see it: public clubs to anyone signed in, invite-only clubs to members.
create or replace function private.visible_club(p_viewer uuid, p_club_id uuid)
returns private.clubs
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_club private.clubs;
begin
  select * into v_club from private.clubs where id = p_club_id;
  if not found or v_club.status <> 'active'
     or (v_club.visibility <> 'public' and private.club_membership(p_viewer, v_club.id) is null) then
    perform private.fail('not_found');
  end if;
  return v_club;
end
$$;

create or replace function public.get_club(p_club_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_club private.clubs := private.visible_club(v_uid, p_club_id);
begin
  return private.club_json(v_club, v_uid);
end
$$;

create or replace function public.list_my_clubs()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(private.club_json(c, private.require_profile()) order by m.joined_at), '[]'::jsonb)
  from private.club_members m
  join private.clubs c on c.id = m.club_id and c.status = 'active'
  where m.user_id = private.require_profile() and m.left_at is null
$$;

-- Public clubs by name (at least three letters).
create or replace function public.search_clubs(p_query text)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_query text := lower(btrim(coalesce(p_query, '')));
begin
  if char_length(v_query) < 3 then
    return '[]'::jsonb;
  end if;
  return coalesce((
    select jsonb_agg(private.club_json(c, v_uid) order by lower(c.name) = v_query desc, private.club_member_count(c.id) desc, lower(c.name))
    from (select x.id from private.clubs x
          where x.status = 'active' and x.visibility = 'public'
            and position(v_query in lower(x.name)) > 0
          order by lower(x.name)
          limit 20) pick
    join private.clubs c on c.id = pick.id), '[]'::jsonb);
end
$$;

create or replace function public.create_club(p_name text, p_description text default null, p_visibility text default 'invite_only')
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_name text := private.normalize_name(p_name);
  v_description text := nullif(private.normalize_comment(p_description), '');
  v_problem text := private.club_text_problem(private.normalize_name(p_name), nullif(private.normalize_comment(p_description), ''));
  v_club private.clubs;
begin
  if v_problem = 'invalid' then
    perform private.fail('club_invalid');
  elsif v_problem = 'not_allowed' then
    perform private.fail('club_not_allowed');
  end if;
  if coalesce(p_visibility, '') not in ('public', 'invite_only') then
    perform private.fail('invalid_input', 'visibility');
  end if;
  perform pg_advisory_xact_lock(hashtext('clubs:' || v_uid));
  if private.club_count(v_uid) >= private.max_clubs() then
    perform private.fail('club_limit');
  end if;
  perform private.check_rate_limit('club_create:' || v_uid, 3, interval '1 day');
  insert into private.clubs (name, description, visibility, created_by) values (v_name, v_description, p_visibility, v_uid)
  returning * into v_club;
  insert into private.club_members (club_id, user_id, role) values (v_club.id, v_uid, 'owner');
  return private.club_json(v_club, v_uid);
end
$$;

create or replace function public.update_club(p_club_id uuid, p_name text, p_description text, p_visibility text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_me private.club_members := private.require_club_admin(v_uid, p_club_id);
  v_club private.clubs;
  v_name text := private.normalize_name(p_name);
  v_description text := nullif(private.normalize_comment(p_description), '');
  v_problem text := private.club_text_problem(private.normalize_name(p_name), nullif(private.normalize_comment(p_description), ''));
begin
  select * into v_club from private.clubs where id = p_club_id for update;
  if v_problem = 'invalid' then
    perform private.fail('club_invalid');
  elsif v_problem = 'not_allowed' then
    perform private.fail('club_not_allowed');
  end if;
  if coalesce(p_visibility, '') not in ('public', 'invite_only') then
    perform private.fail('invalid_input', 'visibility');
  end if;
  -- Admins edit the description; the name and who can find the club are the owner's.
  if v_me.role <> 'owner' and (v_name <> v_club.name or p_visibility <> v_club.visibility) then
    perform private.fail('not_club_owner');
  end if;
  update private.clubs set name = v_name, description = v_description, visibility = p_visibility, updated_at = now()
  where id = v_club.id returning * into v_club;
  return private.club_json(v_club, v_uid);
end
$$;

create or replace function public.set_club_chat_link(p_club_id uuid, p_url text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_me private.club_members := private.require_club_admin(v_uid, p_club_id);
  v_url text := nullif(btrim(coalesce(p_url, '')), '');
  v_club private.clubs;
begin
  if v_url is not null and not private.chat_link_ok(v_url) then
    perform private.fail('invalid_input', 'chat_url');
  end if;
  update private.clubs set chat_url = v_url, updated_at = now() where id = v_me.club_id returning * into v_club;
  return private.club_json(v_club, v_uid);
end
$$;

-- ---------------------------------------------------------------------------------------
-- Joining and leaving
-- ---------------------------------------------------------------------------------------
create or replace function private.join_club_as(p_user uuid, p_club private.clubs)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
begin
  if exists (select 1 from private.club_members where club_id = p_club.id and user_id = p_user and left_at is null) then
    return private.club_json(p_club, p_user);
  end if;
  if exists (select 1 from private.club_bans where club_id = p_club.id and user_id = p_user) then
    perform private.fail('club_unavailable');
  end if;
  if private.club_member_count(p_club.id) >= p_club.capacity then
    perform private.fail('club_full');
  end if;
  perform pg_advisory_xact_lock(hashtext('clubs:' || p_user));
  if private.club_count(p_user) >= private.max_clubs() then
    perform private.fail('club_limit');
  end if;
  begin
    insert into private.club_members (club_id, user_id, role) values (p_club.id, p_user, 'member');
  exception when unique_violation then
    null;
  end;
  return private.club_json(p_club, p_user);
end
$$;

-- Public clubs: one tap.
create or replace function public.join_club(p_club_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_club private.clubs;
begin
  perform private.check_rate_limit('club_join:' || v_uid, 30, interval '1 day');
  select * into v_club from private.clubs where id = p_club_id and status = 'active' for update;
  if not found or v_club.visibility <> 'public' then
    perform private.fail('not_found');
  end if;
  return private.join_club_as(v_uid, v_club);
end
$$;

-- Any club with a code from its owner or an admin. Unknown codes answer like unusable ones.
create or replace function public.join_club_by_code(p_code text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_invite private.club_invites;
  v_club private.clubs;
begin
  perform private.check_rate_limit('club_join:' || v_uid, 30, interval '1 day');
  perform private.check_rate_limit('club_code:' || v_uid, 5, interval '1 minute');
  select * into v_invite from private.club_invites where code_hash = private.club_invite_hash(p_code);
  if not found or v_invite.revoked_at is not null or v_invite.expires_at <= now() then
    perform private.fail('club_invite_invalid');
  end if;
  select * into v_club from private.clubs where id = v_invite.club_id and status = 'active' for update;
  if not found then
    perform private.fail('club_invite_invalid');
  end if;
  return private.join_club_as(v_uid, v_club);
end
$$;

create or replace function public.create_club_invite(p_club_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_me private.club_members := private.require_club_admin(v_uid, p_club_id);
  v_code text;
  v_expires timestamptz := now() + interval '14 days';
begin
  perform private.check_rate_limit('club_invite:' || v_uid, 30, interval '1 day');
  -- Ten live codes per club at most; the oldest go first.
  update private.club_invites set revoked_at = now()
  where id in (select id from private.club_invites where club_id = v_me.club_id and revoked_at is null and expires_at > now()
               order by created_at desc offset 9);
  loop
    v_code := private.generate_invite_code();
    begin
      insert into private.club_invites (club_id, code_hash, created_by, expires_at)
      values (v_me.club_id, private.club_invite_hash(v_code), v_uid, v_expires);
      exit;
    exception when unique_violation then
      null;
    end;
  end loop;
  return jsonb_build_object('code', v_code, 'expires_at_ms', private.ts_to_ms(v_expires));
end
$$;

-- The owner hands over or, alone, closes the club.
create or replace function public.leave_club(p_club_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_me private.club_members := private.require_club_member(v_uid, p_club_id);
begin
  perform 1 from private.clubs where id = p_club_id for update;
  if v_me.role = 'owner' then
    if exists (select 1 from private.club_members where club_id = p_club_id and left_at is null and id <> v_me.id) then
      perform private.fail('owner_must_transfer');
    end if;
    update private.clubs set status = 'closed', updated_at = now() where id = p_club_id;
    update private.club_invites set revoked_at = now() where club_id = p_club_id and revoked_at is null;
    update private.club_members set left_at = now(), left_reason = 'club_closed' where id = v_me.id;
  else
    update private.club_members set left_at = now(), left_reason = 'left' where id = v_me.id;
  end if;
  return jsonb_build_object('left', true, 'club_id', p_club_id);
end
$$;

-- ---------------------------------------------------------------------------------------
-- Running the club: members, roles and removal
-- ---------------------------------------------------------------------------------------
create or replace function public.list_club_members(p_club_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_me private.club_members := private.require_club_member(v_uid, p_club_id);
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'member_id', m.id,
             'alias', case when private.are_blocked(v_uid, m.user_id) then null else p.alias end,
             'public_id', case when private.are_blocked(v_uid, m.user_id) then null else p.public_id end,
             'role', m.role,
             'is_me', m.user_id = v_uid,
             'hidden', m.user_id <> v_uid and private.are_blocked(v_uid, m.user_id),
             'joined_at_ms', private.ts_to_ms(m.joined_at))
           order by case m.role when 'owner' then 0 when 'admin' then 1 else 2 end, lower(p.alias), m.id)
    from private.club_members m join public.profiles p on p.user_id = m.user_id and p.status = 'active'
    where m.club_id = v_me.club_id and m.left_at is null), '[]'::jsonb);
end
$$;

-- The owner makes a member an admin, or an admin a member again. (Two calls rather than a role
-- argument, so no RPC takes a role from the caller.)
create or replace function private.set_club_admin(p_club_id uuid, p_member_id uuid, p_admin boolean)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_me private.club_members := private.require_club_admin(v_uid, p_club_id);
  v_target private.club_members;
begin
  if v_me.role <> 'owner' then
    perform private.fail('not_club_owner');
  end if;
  select * into v_target from private.club_members where id = p_member_id and club_id = p_club_id and left_at is null for update;
  if not found or v_target.user_id = v_uid then
    perform private.fail('not_found');
  end if;
  update private.club_members set role = case when p_admin then 'admin' else 'member' end where id = v_target.id;
  return public.list_club_members(p_club_id);
end
$$;

create or replace function public.promote_club_admin(p_club_id uuid, p_member_id uuid)
returns jsonb
language sql security definer set search_path = ''
as $$
  select private.set_club_admin(p_club_id, p_member_id, true)
$$;

create or replace function public.demote_club_admin(p_club_id uuid, p_member_id uuid)
returns jsonb
language sql security definer set search_path = ''
as $$
  select private.set_club_admin(p_club_id, p_member_id, false)
$$;

create or replace function public.transfer_club_ownership(p_club_id uuid, p_member_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_me private.club_members := private.require_club_admin(v_uid, p_club_id);
  v_target private.club_members;
begin
  if v_me.role <> 'owner' then
    perform private.fail('not_club_owner');
  end if;
  perform 1 from private.clubs where id = p_club_id for update;
  select * into v_target from private.club_members where id = p_member_id and club_id = p_club_id and left_at is null for update;
  if not found or v_target.user_id = v_uid then
    perform private.fail('not_found');
  end if;
  update private.club_members set role = 'admin' where id = v_me.id;
  update private.club_members set role = 'owner' where id = v_target.id;
  return public.list_club_members(p_club_id);
end
$$;

-- Admins remove members (not other admins or the owner); a removed member can't rejoin.
create or replace function public.remove_club_member(p_club_id uuid, p_member_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_me private.club_members := private.require_club_admin(v_uid, p_club_id);
  v_target private.club_members;
begin
  select * into v_target from private.club_members where id = p_member_id and club_id = p_club_id and left_at is null for update;
  if not found or v_target.user_id = v_uid then
    perform private.fail('not_found');
  end if;
  if v_target.role = 'owner' or (v_target.role = 'admin' and v_me.role <> 'owner') then
    perform private.fail('not_club_owner');
  end if;
  update private.club_members set left_at = now(), left_reason = 'removed' where id = v_target.id;
  insert into private.club_bans (club_id, user_id) values (p_club_id, v_target.user_id) on conflict do nothing;
  insert into private.moderation_actions (moderator_id, action, reason, target_user_id)
  values (v_uid, 'club_remove_member', 'Removed by a club admin', v_target.user_id);
  return public.list_club_members(p_club_id);
end
$$;

create or replace function public.get_club_board(p_club_id uuid, p_week_offset integer default 0)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_me private.club_members := private.require_club_member(v_uid, p_club_id);
  v_week date := private.current_week_start() + case when p_week_offset = -1 then -7 else 0 end;
begin
  return private.club_board(v_me.club_id, v_week, v_uid) || jsonb_build_object(
    'state', case when now() < private.day_start(v_week + 7) then 'in_progress'
                  when now() < private.day_start(v_week + 7) + interval '24 hours' then 'settling' else 'final' end);
end
$$;

-- ---------------------------------------------------------------------------------------
-- Group runs in clubs
-- ---------------------------------------------------------------------------------------
alter table private.group_runs add column club_id uuid references private.clubs (id) on delete cascade;
alter table private.group_runs drop constraint group_runs_has_group;
alter table private.group_runs add constraint group_runs_one_group check ((league_id is null) <> (club_id is null));
create index group_runs_club_idx on private.group_runs (club_id, starts_at) where club_id is not null;

create or replace function private.in_group_of(p_user uuid, p_run private.group_runs)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select case
    when p_run.league_id is not null then
      exists (select 1 from public.league_members m where m.user_id = p_user and m.league_id = p_run.league_id and m.left_at is null)
    else
      exists (select 1 from private.club_members m where m.user_id = p_user and m.club_id = p_run.club_id and m.left_at is null)
  end
$$;

create or replace function private.can_edit_group_run(p_user uuid, p_run private.group_runs)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select p_run.created_by = p_user
      or exists (select 1 from public.league_members m
                 where p_run.league_id is not null and m.user_id = p_user and m.league_id = p_run.league_id and m.left_at is null and m.role = 'owner')
      or exists (select 1 from private.club_members m
                 where p_run.club_id is not null and m.user_id = p_user and m.club_id = p_run.club_id and m.left_at is null
                   and m.role in ('owner', 'admin'))
$$;

create or replace function private.group_run_json(p_run private.group_runs, p_viewer uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'id', p_run.id,
    'league_id', p_run.league_id,
    'club_id', p_run.club_id,
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

drop function public.list_group_runs(uuid);
create or replace function public.list_group_runs(p_league_id uuid default null, p_club_id uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_league uuid;
begin
  if p_club_id is not null then
    perform private.require_club_member(v_uid, p_club_id);
  else
    v_league := (private.require_membership(v_uid, p_league_id)).league_id;
  end if;
  return coalesce((
    select jsonb_agg(private.group_run_json(g, v_uid) order by g.starts_at)
    from private.group_runs g
    where (case when p_club_id is not null then g.club_id = p_club_id else g.league_id = v_league end)
      and g.starts_at > now() - interval '3 hours'
      and (g.cancelled_at is null or g.cancelled_at > now() - interval '1 day')), '[]'::jsonb);
end
$$;

-- Members of a league hear about a new group run; a club can be hundreds of people, so club
-- members see it on the club page instead.
drop function public.create_group_run(text, bigint, text, text, uuid);
create or replace function public.create_group_run(
  p_title text,
  p_starts_at_ms bigint,
  p_meeting_point text,
  p_notes text default null,
  p_league_id uuid default null,
  p_club_id uuid default null
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_league uuid;
  v_title text := private.normalize_name(p_title);
  v_meeting text := private.normalize_name(p_meeting_point);
  v_notes text := nullif(private.normalize_comment(p_notes), '');
  v_starts timestamptz := private.ms_to_ts(p_starts_at_ms);
  v_problem text;
  v_run private.group_runs;
  v_alias text;
  v_league_name text;
  v_to record;
begin
  if p_club_id is not null then
    perform private.require_club_member(v_uid, p_club_id);
  else
    v_league := (private.require_membership(v_uid, p_league_id)).league_id;
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
  perform private.check_rate_limit('group_run:' || v_uid, 10, interval '1 day');
  insert into private.group_runs (league_id, club_id, created_by, title, starts_at, meeting_point, notes)
  values (v_league, p_club_id, v_uid, v_title, v_starts, v_meeting, v_notes)
  returning * into v_run;
  insert into private.group_run_rsvps (group_run_id, user_id, status) values (v_run.id, v_uid, 'going');

  if v_league is not null then
    select alias into v_alias from public.profiles where user_id = v_uid;
    select name into v_league_name from public.leagues where id = v_league;
    for v_to in select m.user_id from public.league_members m where m.league_id = v_league and m.left_at is null and m.user_id <> v_uid loop
      perform private.notify(v_to.user_id, v_uid, 'league', 'Group run in ' || v_league_name,
        v_alias || ' planned “' || v_title || '”, ' || private.local_when(v_to.user_id, v_starts) || ' at ' || v_meeting || '. Are you in?',
        '/league', 'group_run:' || v_run.id || ':' || v_to.user_id);
    end loop;
  end if;
  return private.group_run_json(v_run, v_uid);
end
$$;

-- Removing, not just cancelling: for a club's admins (and the league's owner) to take down a
-- group run that shouldn't be there. Whoever said they'd come is told it's off.
create or replace function public.remove_group_run(p_group_run_id uuid)
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
  if v_run.cancelled_at is null and v_run.starts_at > now() then
    for v_to in select r.user_id from private.group_run_rsvps r where r.group_run_id = v_run.id and r.status in ('going', 'maybe') and r.user_id <> v_uid loop
      perform private.notify(v_to.user_id, v_uid, 'league', 'Group run cancelled',
        '“' || v_run.title || '” on ' || private.local_when(v_to.user_id, v_run.starts_at) || ' is cancelled.', '/league',
        'group_run_cancelled:' || v_run.id || ':' || v_to.user_id);
    end loop;
  end if;
  if v_run.created_by is distinct from v_uid then
    insert into private.moderation_actions (moderator_id, action, reason, target_user_id)
    values (v_uid, 'group_run_removed', 'Removed by the group''s admins', v_run.created_by);
  end if;
  delete from private.group_runs where id = v_run.id;
  return jsonb_build_object('removed', true);
end
$$;

-- ---------------------------------------------------------------------------------------
-- Reports on clubs and group runs reach the moderation queue
-- ---------------------------------------------------------------------------------------
alter table private.reports drop constraint reports_target_kind_check;
alter table private.reports add constraint reports_target_kind_check
  check (target_kind in ('member', 'league', 'runner', 'run', 'comment', 'club', 'group_run'));
alter table private.reports add column target_club_id uuid references private.clubs (id) on delete set null;
alter table private.reports add column target_group_run_id uuid references private.group_runs (id) on delete set null;
alter table private.moderation_actions add column target_club_id uuid references private.clubs (id) on delete set null;

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
  else
    perform private.fail('invalid_input', 'kind');
  end if;
  perform private.check_rate_limit('report:' || v_uid, 20, interval '1 day');
  insert into private.reports (reporter_id, target_kind, target_user_id, target_run_id, target_comment_id, target_club_id,
                               target_group_run_id, reason_code, content_snapshot)
  values (v_uid, p_kind, v_other, case when p_kind in ('run', 'comment') then v_run.id end,
          case when p_kind = 'comment' then v_comment.id end,
          case when p_kind = 'club' then v_club.id when p_kind = 'group_run' then v_group_run.club_id end,
          case when p_kind = 'group_run' then v_group_run.id end, p_reason, v_snapshot)
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
  end if;

  update private.reports
     set status = v_status, resolved_at = now(), resolved_by = v_uid, resolution = p_action
   where id = p_report_id;
  -- Taking something down settles every open report about it.
  if p_action in ('remove_comment', 'hide_run', 'reset_club', 'close_club', 'remove_group_run') then
    update private.reports o
       set status = 'actioned', resolved_at = now(), resolved_by = v_uid, resolution = p_action
     where o.status = 'open' and o.id <> v_report.id and private.same_target(o, v_report);
    get diagnostics v_also = row_count;
  end if;
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
-- Leaving everything at once also leaves clubs: an owner's club passes to its longest-standing
-- admin, then member, or closes
-- ---------------------------------------------------------------------------------------
create or replace function private.detach_from_clubs(p_user uuid, p_reason text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_member private.club_members;
  v_successor private.club_members;
begin
  for v_member in
    select * from private.club_members where user_id = p_user and left_at is null order by joined_at, id for update
  loop
    perform 1 from private.clubs where id = v_member.club_id for update;
    if v_member.role = 'owner' then
      select * into v_successor from private.club_members
      where club_id = v_member.club_id and left_at is null and id <> v_member.id
      order by (role = 'admin') desc, joined_at, id limit 1;
      if found then
        update private.club_members set role = 'owner' where id = v_successor.id;
      else
        update private.clubs set status = 'closed', updated_at = now() where id = v_member.club_id;
        update private.club_invites set revoked_at = now() where club_id = v_member.club_id and revoked_at is null;
      end if;
    end if;
    update private.club_members set left_at = now(), left_reason = p_reason, role = 'member' where id = v_member.id;
  end loop;
  update private.club_invites set revoked_at = now() where created_by = p_user and revoked_at is null;
end
$$;

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
  -- Clubs too (docs/ROADMAP.md 4.5).
  perform private.detach_from_clubs(p_user, p_reason);
end
$$;

-- ---------------------------------------------------------------------------------------
-- Export: the runner's clubs
-- ---------------------------------------------------------------------------------------
create or replace function private.club_export(p_uid uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('club', c.name, 'role', m.role, 'joined_at_ms', private.ts_to_ms(m.joined_at),
                                               'left_at_ms', case when m.left_at is null then null else private.ts_to_ms(m.left_at) end)
                            order by m.joined_at), '[]'::jsonb)
  from private.club_members m join private.clubs c on c.id = m.club_id
  where m.user_id = p_uid
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
    'clubs', private.club_export(p_uid)
  );
end
$$;

select private.apply_function_grants();
