-- Social foundations (docs/ROADMAP.md Phase 4): privacy zones and per-run visibility (4.2), then
-- follows between runners (4.3). They ship before the feed, clubs and boards because this is
-- where other people start seeing more than a name and a number.
--
-- * Runners are referred to by a random public id, never their account id.
-- * Every run is visible to only its owner unless the runner chooses otherwise, and its map is
--   hidden unless turned on for that run. A shared map is trimmed on the server: no point inside
--   one of the owner's privacy zones, and never the first or last 200 m.
-- * Follows need the other runner's approval by default. Runners are found through their follow
--   link (or its QR code) and, only if they opt in, by name. There's no contact-book upload.
-- * A block hides both runners from each other everywhere: search, profiles, follows and runs,
--   including through an old link.

-- ---------------------------------------------------------------------------------------
-- Profiles: a public handle and sharing defaults
-- ---------------------------------------------------------------------------------------
alter table public.profiles
  add column public_id uuid not null default gen_random_uuid(),
  add column default_visibility text not null default 'only_me'
    check (default_visibility in ('only_me', 'leagues', 'followers', 'everyone')),
  add column default_map_shared boolean not null default false,
  add column follow_approval boolean not null default true,
  add column discoverable boolean not null default false;
create unique index profiles_public_id_key on public.profiles (public_id);

alter table public.runs
  add column visibility text not null default 'only_me' check (visibility in ('only_me', 'leagues', 'followers', 'everyone')),
  add column map_shared boolean not null default false;

-- New runs start with the runner's defaults (the upload RPCs don't need to know about sharing).
create or replace function private.runs_default_sharing()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_visibility text;
  v_map boolean;
begin
  select p.default_visibility, p.default_map_shared into v_visibility, v_map from public.profiles p where p.user_id = new.owner_id;
  new.visibility := coalesce(v_visibility, 'only_me');
  new.map_shared := coalesce(v_map, false);
  return new;
end
$$;
create trigger runs_default_sharing before insert on public.runs
  for each row execute function private.runs_default_sharing();

-- ---------------------------------------------------------------------------------------
-- Privacy zones (4.2)
-- ---------------------------------------------------------------------------------------
create table private.privacy_zones (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  label text not null check (char_length(label) between 1 and 32),
  lat double precision not null check (lat between -90 and 90),
  lon double precision not null check (lon between -180 and 180),
  radius_m integer not null check (radius_m between 100 and 1000),
  created_at timestamptz not null default now()
);
create index privacy_zones_user_idx on private.privacy_zones (user_id);

-- Every shared map drops this much from each end, even outside a zone.
create or replace function private.shared_trim_m()
returns double precision
language sql immutable
as $$ select 200::double precision $$;

-- The route other people may see, as lines of [lat, lon] (at most about 400 points): no point
-- inside the owner's privacy zones or within the first or last 200 m, split wherever points were
-- left out so no line is drawn across a zone. Null when there's nothing left to show.
create or replace function private.shared_route(p_run public.runs)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  -- Coordinates are rounded to 5 decimals (about a metre) before anything is checked, so the
  -- points shown are exactly the points tested against the zones.
  with raw as (
    select round((e ->> 2)::numeric, 5)::double precision as lat, round((e ->> 3)::numeric, 5)::double precision as lon,
           coalesce((e ->> 5)::integer, 0) as seg, ord
    from private.run_routes rr, jsonb_array_elements(rr.points) with ordinality as x(e, ord)
    where rr.run_id = p_run.id
  ),
  steps as (
    select r.*, coalesce(private.haversine_m(lag(r.lat) over w, lag(r.lon) over w, r.lat, r.lon), 0) as step
    from raw r window w as (order by r.ord)
  ),
  cum as (
    select s.*, sum(s.step) over (order by s.ord) as d from steps s
  ),
  total as (
    select coalesce(max(d), 0) as total_m, count(*) as n from cum
  ),
  kept as (
    select c.* from cum c, total t
    where c.d >= private.shared_trim_m() and c.d <= t.total_m - private.shared_trim_m()
      and not exists (
        select 1 from private.privacy_zones z
        where z.user_id = p_run.owner_id and private.haversine_m(z.lat, z.lon, c.lat, c.lon) <= z.radius_m)
  ),
  breaks as (
    select k.*,
           case when lag(k.ord) over w is null or k.ord - lag(k.ord) over w > 1 or k.seg <> lag(k.seg) over w then 1 else 0 end as brk
    from kept k window w as (order by k.ord)
  ),
  lines as (
    select b.*, sum(b.brk) over (order by b.ord) as line,
           greatest(1, ceil((select count(*) from kept) / 400.0))::integer as stride
    from breaks b
  ),
  numbered as (
    select l.*, row_number() over (partition by l.line order by l.ord) as i,
           count(*) over (partition by l.line) as line_n
    from lines l
  ),
  sampled as (
    select * from numbered n where n.line_n > 1 and ((n.i - 1) % n.stride = 0 or n.i = n.line_n)
  ),
  per_line as (
    select line, jsonb_agg(jsonb_build_array(lat, lon) order by ord) as pts
    from sampled group by line
  )
  select case when count(*) = 0 then null else jsonb_agg(pts order by line) end from per_line
$$;

-- ---------------------------------------------------------------------------------------
-- Follows (4.3)
-- ---------------------------------------------------------------------------------------
create table private.follows (
  follower_id uuid not null references auth.users (id) on delete cascade,
  followee_id uuid not null references auth.users (id) on delete cascade,
  status text not null check (status in ('pending', 'accepted')),
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  primary key (follower_id, followee_id),
  constraint follows_not_self check (follower_id <> followee_id)
);
create index follows_followee_idx on private.follows (followee_id, status);

-- A runner's follow link: /follow/<code>. The runner can replace it, which retires the old one.
create table private.follow_codes (
  user_id uuid primary key references auth.users (id) on delete cascade,
  code text not null unique,
  created_at timestamptz not null default now()
);

-- Muted runners' runs stay out of the feed; nothing else changes and they aren't told.
create table private.mutes (
  user_id uuid not null references auth.users (id) on delete cascade,
  muted_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, muted_id),
  constraint mutes_not_self check (user_id <> muted_id)
);

-- ---------------------------------------------------------------------------------------
-- Who can see what
-- ---------------------------------------------------------------------------------------
create or replace function private.follows_accepted(p_follower uuid, p_followee uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from private.follows f
                 where f.follower_id = p_follower and f.followee_id = p_followee and f.status = 'accepted')
$$;

create or replace function private.share_league(p_a uuid, p_b uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.league_members a
    join public.league_members b on b.league_id = a.league_id and b.left_at is null
    where a.user_id = p_a and a.left_at is null and b.user_id = p_b)
$$;

-- An active, visible profile (not deleting, not age-restricted).
create or replace function private.visible_profile(p_user uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.profiles p
                 where p.user_id = p_user and p.status = 'active' and coalesce(p.age_signal, '') <> 'minor')
$$;

-- Whether the viewer may see a run's card. The owner always can; nobody else sees a deleted run,
-- one still uploading, held for review or merged away, or anything across a block.
create or replace function private.can_view_run(p_viewer uuid, p_run public.runs)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select case
    when p_run.owner_id = p_viewer then p_run.deleted_at is null
    when p_run.deleted_at is not null or p_run.status not in ('accepted', 'personal_only') or p_run.duplicate_of is not null then false
    when not private.visible_profile(p_run.owner_id) then false
    when private.are_blocked(p_viewer, p_run.owner_id) then false
    when p_run.visibility = 'everyone' then private.visible_profile(p_viewer)
    when p_run.visibility = 'followers' then private.follows_accepted(p_viewer, p_run.owner_id) or private.share_league(p_viewer, p_run.owner_id)
    when p_run.visibility = 'leagues' then private.share_league(p_viewer, p_run.owner_id)
    else false
  end
$$;

create or replace function private.runner_card(p_user uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'public_id', p.public_id,
    'alias', p.alias,
    'tier', private.tier_name(coalesce(ps.lifetime_xp, 0)))
  from public.profiles p left join private.profile_stats ps on ps.user_id = p.user_id
  where p.user_id = p_user
$$;

-- A run as other people see it: stats always, the map only when the runner shared it.
create or replace function private.shared_run_json(p_run public.runs, p_viewer uuid, p_with_map boolean)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'run_id', p_run.id,
    'owner', private.runner_card(p_run.owner_id),
    'is_mine', p_run.owner_id = p_viewer,
    'title', p_run.title,
    'activity_type', p_run.activity_type,
    'started_at_ms', private.ts_to_ms(p_run.started_at),
    'distance_m', coalesce(p_run.distance_cm / 100.0, p_run.client_distance_m::numeric),
    'active_ms', coalesce(p_run.active_ms, p_run.client_active_ms),
    'visibility', p_run.visibility,
    'map_shared', p_run.map_shared,
    'route', case when p_with_map and p_run.map_shared then private.shared_route(p_run) else null end)
$$;

create or replace function private.runner_by_public_id(p_public_id uuid)
returns uuid
language sql stable security definer set search_path = ''
as $$
  select user_id from public.profiles where public_id = p_public_id
$$;

-- The other runner, if the caller may deal with them at all; 'not_found' otherwise (a block
-- looks the same as a runner who doesn't exist).
create or replace function private.require_other_runner(p_viewer uuid, p_public_id uuid)
returns uuid
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_other uuid := private.runner_by_public_id(p_public_id);
begin
  if v_other is null or v_other = p_viewer or not private.visible_profile(v_other) or private.are_blocked(p_viewer, v_other) then
    perform private.fail('not_found');
  end if;
  return v_other;
end
$$;

-- ---------------------------------------------------------------------------------------
-- RPC: sharing settings, privacy zones, per-run sharing
-- ---------------------------------------------------------------------------------------
create or replace function private.social_settings_json(p_uid uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'public_id', p.public_id,
    'default_visibility', p.default_visibility,
    'default_map_shared', p.default_map_shared,
    'follow_approval', p.follow_approval,
    'discoverable', p.discoverable,
    'zones', coalesce((select jsonb_agg(jsonb_build_object('id', z.id, 'label', z.label, 'lat', z.lat, 'lon', z.lon, 'radius_m', z.radius_m)
                                        order by z.created_at)
                       from private.privacy_zones z where z.user_id = p_uid), '[]'::jsonb))
  from public.profiles p where p.user_id = p_uid
$$;

create or replace function public.get_social_settings()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
begin
  return private.social_settings_json(v_uid);
end
$$;

create or replace function public.set_social_settings(
  p_default_visibility text default null,
  p_default_map_shared boolean default null,
  p_follow_approval boolean default null,
  p_discoverable boolean default null
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
begin
  if p_default_visibility is not null and p_default_visibility not in ('only_me', 'leagues', 'followers', 'everyone') then
    perform private.fail('invalid_input', 'default_visibility');
  end if;
  update public.profiles set
    default_visibility = coalesce(p_default_visibility, default_visibility),
    default_map_shared = coalesce(p_default_map_shared, default_map_shared),
    follow_approval = coalesce(p_follow_approval, follow_approval),
    discoverable = coalesce(p_discoverable, discoverable),
    updated_at = now()
  where user_id = v_uid;
  -- Turning approval off lets the people already waiting in.
  if p_follow_approval = false then
    update private.follows set status = 'accepted', accepted_at = now() where followee_id = v_uid and status = 'pending';
  end if;
  return private.social_settings_json(v_uid);
end
$$;

create or replace function public.save_privacy_zone(p_label text, p_lat double precision, p_lon double precision, p_radius_m integer, p_zone_id uuid default null)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_label text := private.normalize_name(p_label);
begin
  if char_length(v_label) < 1 or char_length(v_label) > 32 then
    perform private.fail('invalid_input', 'label');
  end if;
  if p_lat is null or p_lon is null or p_lat not between -90 and 90 or p_lon not between -180 and 180 then
    perform private.fail('invalid_input', 'location');
  end if;
  if p_radius_m is null or p_radius_m not between 100 and 1000 then
    perform private.fail('invalid_input', 'radius');
  end if;
  if p_zone_id is null then
    if (select count(*) from private.privacy_zones where user_id = v_uid) >= 5 then
      perform private.fail('too_many_zones');
    end if;
    insert into private.privacy_zones (user_id, label, lat, lon, radius_m)
    values (v_uid, v_label, round(p_lat::numeric, 6), round(p_lon::numeric, 6), p_radius_m);
  else
    update private.privacy_zones set label = v_label, lat = round(p_lat::numeric, 6), lon = round(p_lon::numeric, 6), radius_m = p_radius_m
    where id = p_zone_id and user_id = v_uid;
    if not found then
      perform private.fail('not_found');
    end if;
  end if;
  return private.social_settings_json(v_uid);
end
$$;

create or replace function public.delete_privacy_zone(p_zone_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
begin
  delete from private.privacy_zones where id = p_zone_id and user_id = v_uid;
  return private.social_settings_json(v_uid);
end
$$;

create or replace function public.set_run_sharing(p_run_id uuid, p_visibility text, p_map_shared boolean)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_run public.runs;
begin
  if p_visibility not in ('only_me', 'leagues', 'followers', 'everyone') or p_map_shared is null then
    perform private.fail('invalid_input', 'visibility');
  end if;
  update public.runs set visibility = p_visibility, map_shared = p_map_shared, updated_at = now()
  where id = p_run_id and owner_id = v_uid and deleted_at is null
  returning * into v_run;
  if not found then
    perform private.fail('not_found');
  end if;
  return private.shared_run_json(v_run, v_uid, true);
end
$$;

-- A run as the caller may see it, with its trimmed map when shared.
create or replace function public.get_shared_run(p_run_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_run public.runs;
begin
  select * into v_run from public.runs where id = p_run_id;
  if not found or not private.can_view_run(v_uid, v_run) then
    perform private.fail('not_found');
  end if;
  return private.shared_run_json(v_run, v_uid, true);
end
$$;

-- ---------------------------------------------------------------------------------------
-- RPC: follows, follow links, search, profiles, mutes and blocks
-- ---------------------------------------------------------------------------------------
create or replace function private.follow_state(p_viewer uuid, p_other uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'following', coalesce((select f.status from private.follows f where f.follower_id = p_viewer and f.followee_id = p_other), 'none'),
    'follows_me', coalesce((select f.status from private.follows f where f.follower_id = p_other and f.followee_id = p_viewer), 'none'),
    'muted', exists (select 1 from private.mutes m where m.user_id = p_viewer and m.muted_id = p_other))
$$;

create or replace function private.follow(p_viewer uuid, p_other uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_approval boolean;
begin
  perform private.check_rate_limit('follow:' || p_viewer, 60, interval '1 day');
  select follow_approval into v_approval from public.profiles where user_id = p_other;
  insert into private.follows (follower_id, followee_id, status, accepted_at)
  values (p_viewer, p_other, case when v_approval then 'pending' else 'accepted' end, case when v_approval then null else now() end)
  on conflict (follower_id, followee_id) do nothing;
  return private.runner_card(p_other) || jsonb_build_object('follow', private.follow_state(p_viewer, p_other));
end
$$;

create or replace function public.follow_runner(p_public_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
begin
  return private.follow(v_uid, private.require_other_runner(v_uid, p_public_id));
end
$$;

create or replace function public.get_follow_code(p_rotate boolean default false)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_code text;
begin
  if p_rotate then
    perform private.check_rate_limit('follow_code:' || v_uid, 10, interval '1 day');
    delete from private.follow_codes where user_id = v_uid;
  end if;
  select code into v_code from private.follow_codes where user_id = v_uid;
  if v_code is null then
    loop
      v_code := private.generate_invite_code();
      begin
        insert into private.follow_codes (user_id, code) values (v_uid, v_code);
        exit;
      exception when unique_violation then
        -- another runner has this code: draw again
      end;
    end loop;
  end if;
  return jsonb_build_object('code', v_code);
end
$$;

-- Who a follow link belongs to, so the app can show them before following.
create or replace function public.get_follow_link(p_code text)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_other uuid;
begin
  perform private.check_rate_limit('follow_link:' || v_uid, 60, interval '1 hour');
  select user_id into v_other from private.follow_codes where code = private.normalize_invite_code(p_code);
  if v_other is null or v_other = v_uid or not private.visible_profile(v_other) or private.are_blocked(v_uid, v_other) then
    perform private.fail('not_found');
  end if;
  return private.runner_card(v_other) || jsonb_build_object('follow', private.follow_state(v_uid, v_other));
end
$$;

create or replace function public.follow_by_code(p_code text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_other uuid;
begin
  perform private.check_rate_limit('follow_link:' || v_uid, 60, interval '1 hour');
  select user_id into v_other from private.follow_codes where code = private.normalize_invite_code(p_code);
  if v_other is null or v_other = v_uid or not private.visible_profile(v_other) or private.are_blocked(v_uid, v_other) then
    perform private.fail('not_found');
  end if;
  return private.follow(v_uid, v_other);
end
$$;

create or replace function public.respond_follow(p_public_id uuid, p_accept boolean)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_other uuid := private.require_other_runner(v_uid, p_public_id);
begin
  if p_accept then
    update private.follows set status = 'accepted', accepted_at = now()
    where follower_id = v_other and followee_id = v_uid and status = 'pending';
  else
    delete from private.follows where follower_id = v_other and followee_id = v_uid and status = 'pending';
  end if;
  return private.runner_card(v_other) || jsonb_build_object('follow', private.follow_state(v_uid, v_other));
end
$$;

create or replace function public.unfollow(p_public_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_other uuid := private.runner_by_public_id(p_public_id);
begin
  delete from private.follows where follower_id = v_uid and followee_id = v_other;
  return jsonb_build_object('following', 'none');
end
$$;

create or replace function public.remove_follower(p_public_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_other uuid := private.runner_by_public_id(p_public_id);
begin
  delete from private.follows where follower_id = v_other and followee_id = v_uid;
  return jsonb_build_object('follows_me', 'none');
end
$$;

-- followers | following | requests (people waiting for the caller's approval) | muted
create or replace function public.list_follows(p_kind text)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
begin
  if p_kind not in ('followers', 'following', 'requests', 'muted') then
    perform private.fail('invalid_input', 'kind');
  end if;
  return coalesce((
    select jsonb_agg(private.runner_card(x.other) || jsonb_build_object('status', x.status, 'since_ms', private.ts_to_ms(x.since))
                     order by x.since desc)
    from (
      select f.follower_id as other, f.status, f.created_at as since from private.follows f
      where p_kind = 'followers' and f.followee_id = v_uid and f.status = 'accepted'
      union all
      select f.followee_id, f.status, f.created_at from private.follows f
      where p_kind = 'following' and f.follower_id = v_uid
      union all
      select f.follower_id, f.status, f.created_at from private.follows f
      where p_kind = 'requests' and f.followee_id = v_uid and f.status = 'pending'
      union all
      select m.muted_id, 'muted', m.created_at from private.mutes m
      where p_kind = 'muted' and m.user_id = v_uid
    ) x
    where private.visible_profile(x.other) and not private.are_blocked(v_uid, x.other)
  ), '[]'::jsonb);
end
$$;

-- Opt-in name search: only runners who chose to be found, never anyone across a block.
create or replace function public.search_runners(p_query text)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_query text := lower(private.normalize_name(p_query));
begin
  if char_length(v_query) < 3 or char_length(v_query) > 24 then
    perform private.fail('invalid_input', 'query');
  end if;
  perform private.check_rate_limit('search:' || v_uid, 30, interval '1 minute');
  return coalesce((
    select jsonb_agg(private.runner_card(p.user_id) || jsonb_build_object('follow', private.follow_state(v_uid, p.user_id))
                     order by (lower(p.alias) = v_query) desc, lower(p.alias))
    from (select * from public.profiles p
          where p.discoverable and p.user_id <> v_uid and p.status = 'active' and coalesce(p.age_signal, '') <> 'minor'
            and position(v_query in lower(p.alias)) > 0
            and not private.are_blocked(v_uid, p.user_id)
          order by (lower(p.alias) = v_query) desc, lower(p.alias)
          limit 20) p
  ), '[]'::jsonb);
end
$$;

-- A runner's profile: who they are, the follow state and the runs the caller may see.
create or replace function public.get_runner_profile(p_public_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_other uuid := private.runner_by_public_id(p_public_id);
begin
  if v_other is null or not private.visible_profile(v_other) or (v_other <> v_uid and private.are_blocked(v_uid, v_other)) then
    perform private.fail('not_found');
  end if;
  return private.runner_card(v_other) || jsonb_build_object(
    'is_me', v_other = v_uid,
    'follow', private.follow_state(v_uid, v_other),
    'followers', (select count(*) from private.follows f where f.followee_id = v_other and f.status = 'accepted'
                  and private.visible_profile(f.follower_id)),
    'following', (select count(*) from private.follows f where f.follower_id = v_other and f.status = 'accepted'
                  and private.visible_profile(f.followee_id)),
    'runs', coalesce((
      select jsonb_agg(x.card order by x.started_at desc)
      from (select private.shared_run_json(r, v_uid, false) as card, r.started_at
            from public.runs r
            where r.owner_id = v_other and r.deleted_at is null and private.can_view_run(v_uid, r)
            order by r.started_at desc limit 20) x
    ), '[]'::jsonb));
end
$$;

create or replace function public.mute_runner(p_public_id uuid, p_muted boolean)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_other uuid := private.require_other_runner(v_uid, p_public_id);
begin
  if p_muted then
    insert into private.mutes (user_id, muted_id) values (v_uid, v_other) on conflict do nothing;
  else
    delete from private.mutes where user_id = v_uid and muted_id = v_other;
  end if;
  return private.follow_state(v_uid, v_other);
end
$$;

-- Blocking a runner seen anywhere (a profile, a comment, a board). Follows both ways end.
create or replace function public.block_runner(p_public_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_other uuid := private.runner_by_public_id(p_public_id);
  v_alias text;
begin
  if v_other is null or v_other = v_uid then
    perform private.fail('not_found');
  end if;
  select alias into v_alias from public.profiles where user_id = v_other;
  insert into public.blocks (blocker_id, blocked_id, blocked_alias_snapshot)
  values (v_uid, v_other, coalesce(v_alias, 'Runner'))
  on conflict (blocker_id, blocked_id) do nothing;
  perform private.end_social_ties(v_uid, v_other);
  return jsonb_build_object('blocked', true);
end
$$;

-- What a block (from any screen) ends between two runners.
create or replace function private.end_social_ties(p_a uuid, p_b uuid)
returns void
language sql security definer set search_path = ''
as $$
  delete from private.follows where (follower_id = p_a and followee_id = p_b) or (follower_id = p_b and followee_id = p_a);
  delete from private.mutes where (user_id = p_a and muted_id = p_b) or (user_id = p_b and muted_id = p_a);
$$;

-- Blocks made from the league screen end follows too.
create or replace function private.blocks_end_ties()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.end_social_ties(new.blocker_id, new.blocked_id);
  return new;
end
$$;
create trigger blocks_end_ties after insert on public.blocks
  for each row execute function private.blocks_end_ties();

-- ---------------------------------------------------------------------------------------
-- The owner's run JSON carries its sharing
-- ---------------------------------------------------------------------------------------
create or replace function private.run_json(r public.runs)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'id', r.id,
    'client_run_id', r.client_run_id,
    'title', r.title,
    'started_at_ms', private.ts_to_ms(r.started_at),
    'ended_at_ms', private.ts_to_ms(r.ended_at),
    'active_ms', coalesce(r.active_ms, r.client_active_ms),
    'distance_m', coalesce(r.distance_cm / 100.0, r.client_distance_m::numeric),
    'status', r.status,
    'reason_codes', to_jsonb(r.reason_codes),
    'coverage', r.coverage,
    'interrupted', r.interrupted,
    'scoring_state', r.scoring_state,
    'xp_award', r.xp_award,
    'version', r.version,
    'validator_version', r.validator_version,
    'rule_version', r.rule_version,
    'finalized_at_ms', private.ts_to_ms(r.finalized_at),
    'activity_type', r.activity_type,
    'source', r.source,
    'notes', r.notes,
    'shoe_id', r.shoe_id,
    'edited_at_ms', case when r.edited_at is null then null else private.ts_to_ms(r.edited_at) end,
    'source_app', r.source_app,
    'source_device', r.source_device,
    'manual_entry', r.manual_entry,
    'avg_heart_rate', r.avg_heart_rate,
    'max_heart_rate', r.max_heart_rate,
    'steps', r.steps,
    'duplicate_of', r.duplicate_of,
    'indoor', r.indoor,
    'visibility', r.visibility,
    'map_shared', r.map_shared
  )
$$;

-- ---------------------------------------------------------------------------------------
-- Export: zones, follows and sharing defaults go with the runner's data
-- ---------------------------------------------------------------------------------------
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
                           where f.followee_id = p_uid), '[]'::jsonb))
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
    'social', private.social_export(p_uid)
  );
end
$$;

select private.apply_function_grants();
