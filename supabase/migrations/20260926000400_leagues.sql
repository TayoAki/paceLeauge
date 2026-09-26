-- Private weekly leagues (REQ-007): one active league per runner, at most 20 members.
--
-- * Weekly league XP = sum of the member's three best *league* daily scores, computed only
--   from segments that started at/after the start of their current membership period, from
--   runs received before the week's settlement deadline (week end + 24 h).
-- * Standings expose alias, tier and weekly XP only. Blocked members (either direction) stay
--   in the ranking as hidden rows so the standings are not falsified.
-- * Invite codes are random, shown once, stored as SHA-256 hashes, and expire after 7 days.

create or replace function private.normalize_invite_code(p_code text)
returns text
language sql immutable
as $$
  -- Crockford base32 reading: case-insensitive, ignores separators, I/L→1, O→0.
  select translate(upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g')), 'ILO', '110')
$$;

create or replace function private.invite_hash(p_code text)
returns text
language sql immutable
as $$
  select encode(sha256(convert_to('pl-invite-v1:' || private.normalize_invite_code(p_code), 'UTF8')), 'hex')
$$;

-- 8 Crockford base32 characters (40 random bits) from the random bytes of a v4 UUID.
create or replace function private.generate_invite_code()
returns text
language plpgsql volatile
as $$
declare
  c_alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  c_positions constant integer[] := array[0, 1, 2, 3, 4, 5, 10, 11];
  v_bytes bytea := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
  v_code text := '';
  v_i integer;
begin
  for v_i in 1 .. 8 loop
    v_code := v_code || substr(c_alphabet, (get_byte(v_bytes, c_positions[v_i]) % 32) + 1, 1);
  end loop;
  return v_code;
end
$$;

create or replace function private.active_membership(p_user uuid)
returns public.league_members
language sql stable security definer set search_path = ''
as $$
  select * from public.league_members where user_id = p_user and left_at is null
$$;

create or replace function private.are_blocked(p_a uuid, p_b uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.blocks
    where (blocker_id = p_a and blocked_id = p_b) or (blocker_id = p_b and blocked_id = p_a)
  )
$$;

create or replace function private.league_standings(p_league_id uuid, p_week date, p_viewer uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  with members as (
    select m.id as member_id, m.user_id, m.role, m.joined_at, p.alias,
           coalesce(ps.lifetime_xp, 0) as lifetime_xp
    from public.league_members m
    join public.profiles p on p.user_id = m.user_id and p.status = 'active'
    left join private.profile_stats ps on ps.user_id = m.user_id
    where m.league_id = p_league_id and m.left_at is null
  ),
  day_totals as (
    select mb.member_id, a.competition_date,
           sum(a.distance_cm)::bigint as distance_cm, sum(a.active_ms)::bigint as active_ms
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
    select s.*, rank() over (order by s.weekly_xp desc) as place from scored s
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'member_id', r.member_id,
           'rank', r.place,
           'alias', case when r.hidden then null else r.alias end,
           'tier', case when r.hidden then null else private.tier_name(r.lifetime_xp) end,
           'weekly_xp', r.weekly_xp,
           'is_me', r.user_id = p_viewer,
           'is_owner', r.role = 'owner',
           'hidden', r.hidden)
         order by r.weekly_xp desc, lower(r.alias) collate "C", r.member_id), '[]'::jsonb)
  from ranked r
$$;

create or replace function private.league_view(p_user uuid, p_week_offset integer)
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
  v_member := private.active_membership(p_user);
  if v_member.id is null then
    return jsonb_build_object('league', null, 'competition_enabled', private.flag_enabled('competition_enabled'));
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
      'member_count', v_count,
      'capacity', v_league.capacity,
      'is_owner', v_member.role = 'owner',
      'calendar_zone', v_league.calendar_zone,
      'created_at_ms', private.ts_to_ms(v_league.created_at),
      'joined_at_ms', private.ts_to_ms(v_member.joined_at)),
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

create or replace function public.get_my_league(p_week_offset integer default 0)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
begin
  return private.league_view(v_uid, p_week_offset);
end
$$;

create or replace function private.require_league_owner(p_user uuid)
returns public.league_members
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_member public.league_members := private.active_membership(p_user);
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

create or replace function public.create_league(p_name text)
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
  if (private.active_membership(v_uid)).id is not null then
    perform private.fail('already_in_league');
  end if;
  perform private.check_rate_limit('league_create:' || v_uid, 5, interval '1 day');

  insert into public.leagues (name, owner_id) values (v_name, v_uid) returning id into v_league_id;
  begin
    insert into public.league_members (league_id, user_id, role) values (v_league_id, v_uid, 'owner');
  exception when unique_violation then
    perform private.fail('already_in_league');
  end;
  return private.league_view(v_uid, 0);
end
$$;

create or replace function private.issue_invite(p_league_id uuid, p_creator uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_code text;
  v_expires timestamptz := now() + interval '7 days';
  v_attempt integer := 0;
begin
  -- Keep at most 10 live invites per league; the oldest are revoked first.
  update private.league_invites set revoked_at = now()
  where id in (
    select id from private.league_invites
    where league_id = p_league_id and revoked_at is null and expires_at > now()
    order by created_at desc offset 9
  );
  loop
    v_attempt := v_attempt + 1;
    v_code := private.generate_invite_code();
    begin
      insert into private.league_invites (league_id, code_hash, created_by, expires_at)
      values (p_league_id, private.invite_hash(v_code), p_creator, v_expires);
      exit;
    exception when unique_violation then
      if v_attempt >= 5 then
        raise;
      end if;
    end;
  end loop;
  return jsonb_build_object('code', v_code, 'expires_at_ms', private.ts_to_ms(v_expires));
end
$$;

create or replace function public.create_league_invite()
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_member public.league_members := private.require_league_owner(v_uid);
begin
  if not private.flag_enabled('invites_enabled') then
    perform private.fail('invites_paused');
  end if;
  perform private.check_rate_limit('invite_create:' || v_uid, 30, interval '1 day');
  return private.issue_invite(v_member.league_id, v_uid);
end
$$;

create or replace function public.rotate_league_invites()
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_member public.league_members := private.require_league_owner(v_uid);
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

-- Limited preview for visitors and runners: league name and size only, and only while the
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
  v_member public.league_members;
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
    v_member := private.active_membership(v_uid);
    if v_member.league_id = v_league.id then
      v_status := 'already_member';
    elsif v_member.id is not null then
      v_status := case when v_status = 'full' then 'full' else 'in_other_league' end;
    end if;
  end if;
  return jsonb_build_object(
    'status', v_status,
    'league_name', v_league.name,
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
  v_member public.league_members;
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

  v_member := private.active_membership(v_uid);
  if v_member.league_id = v_league.id then
    return private.league_view(v_uid, 0);
  elsif v_member.id is not null then
    return jsonb_build_object('error', 'already_in_league');
  end if;
  if exists (select 1 from private.league_bans where league_id = v_league.id and user_id = v_uid)
     or private.are_blocked(v_uid, v_league.owner_id) then
    return jsonb_build_object('error', 'invite_unavailable');
  end if;
  select count(*) into v_count from public.league_members where league_id = v_league.id and left_at is null;
  if v_count >= v_league.capacity then
    return jsonb_build_object('error', 'league_full');
  end if;

  begin
    insert into public.league_members (league_id, user_id, role) values (v_league.id, v_uid, 'member');
  exception when unique_violation then
    return jsonb_build_object('error', 'already_in_league');
  end;
  perform private.log_server_event('league_joined', v_uid, '{}'::jsonb);
  return private.league_view(v_uid, 0);
end
$$;

create or replace function public.leave_league()
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_member public.league_members;
begin
  select * into v_member from public.league_members where user_id = v_uid and left_at is null for update;
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

create or replace function private.target_member(p_owner public.league_members, p_member_id uuid)
returns public.league_members
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_target public.league_members;
begin
  select * into v_target from public.league_members
  where id = p_member_id and league_id = p_owner.league_id and left_at is null;
  if not found then
    perform private.fail('not_found');
  end if;
  if v_target.user_id = p_owner.user_id then
    perform private.fail('cannot_target_self');
  end if;
  return v_target;
end
$$;

create or replace function public.transfer_league_ownership(p_member_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_owner public.league_members := private.require_league_owner(v_uid);
  v_target public.league_members;
begin
  perform 1 from public.leagues where id = v_owner.league_id for update;
  v_target := private.target_member(v_owner, p_member_id);
  update public.league_members set role = 'member' where id = v_owner.id;
  update public.league_members set role = 'owner' where id = v_target.id;
  update public.leagues set owner_id = v_target.user_id, updated_at = now() where id = v_owner.league_id;
  return private.league_view(v_uid, 0);
end
$$;

create or replace function public.remove_league_member(p_member_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_owner public.league_members := private.require_league_owner(v_uid);
  v_target public.league_members;
begin
  perform 1 from public.leagues where id = v_owner.league_id for update;
  v_target := private.target_member(v_owner, p_member_id);
  update public.league_members set left_at = now(), left_reason = 'removed' where id = v_target.id;
  insert into private.league_bans (league_id, user_id) values (v_owner.league_id, v_target.user_id)
  on conflict do nothing;
  return private.league_view(v_uid, 0);
end
$$;

create or replace function public.rename_league(p_name text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_owner public.league_members := private.require_league_owner(v_uid);
  v_name text := private.normalize_name(p_name);
  v_problem text := private.name_problem(v_name, 3, 32);
begin
  if v_problem = 'invalid' then
    perform private.fail('league_name_invalid');
  elsif v_problem = 'not_allowed' then
    perform private.fail('league_name_not_allowed');
  end if;
  update public.leagues set name = v_name, updated_at = now() where id = v_owner.league_id;
  return private.league_view(v_uid, 0);
end
$$;

select private.apply_function_grants();
