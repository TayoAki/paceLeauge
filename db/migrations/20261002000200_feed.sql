-- Feed with kudos and comments (docs/ROADMAP.md 4.4), and push notifications and moderation at
-- scale (4.9).
--
-- The feed is pulled, not fanned out: runs from the runner, the people they follow and their
-- league-mates, filtered by the same can_view_run rule as every other shared view. Comments pass a
-- text filter and rate limits and can be reported; reporting hides the content from the reporter
-- straight away, three reports hold a comment for review, and every report carries a response
-- target (due_at) that the staff queue and the health report watch.
--
-- Pushes go through an outbox that the API service drains into Expo's push service. Every type can
-- be switched off, nothing is sent overnight in the runner's time zone, and a block, a deleted run
-- or comment, or a switched-off type drops a push that hasn't gone out yet.

-- ---------------------------------------------------------------------------------------
-- Kudos and comments
-- ---------------------------------------------------------------------------------------
create table private.kudos (
  run_id uuid not null references public.runs (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (run_id, user_id)
);
create index kudos_user_idx on private.kudos (user_id);

create table private.comments (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.runs (id) on delete cascade,
  author_id uuid not null references auth.users (id) on delete cascade,
  -- One level of replies: a reply always points at the thread's first comment.
  parent_id uuid references private.comments (id) on delete cascade,
  -- Removed comments keep their place (so replies keep their thread) but lose their text.
  body text,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  removed_by text check (removed_by in ('author', 'run_owner', 'moderator')),
  -- Held for review after enough reports: only the author still sees it.
  held_at timestamptz,
  constraint comments_body_present check ((deleted_at is null) = (body is not null)),
  constraint comments_body_length check (body is null or char_length(body) between 1 and 500)
);
create index comments_run_idx on private.comments (run_id, created_at);
create index comments_author_idx on private.comments (author_id);
create index comments_parent_idx on private.comments (parent_id) where parent_id is not null;

-- What a runner reported and no longer wants to see.
create table private.hidden_content (
  user_id uuid not null references auth.users (id) on delete cascade,
  target_kind text not null check (target_kind in ('run', 'comment')),
  target_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (user_id, target_kind, target_id)
);

-- ---------------------------------------------------------------------------------------
-- Reports on runners, runs and comments, with a response target
-- ---------------------------------------------------------------------------------------
create or replace function private.report_response_target()
returns interval
language sql immutable
as $$ select interval '24 hours' $$;

alter table private.reports drop constraint reports_target_kind_check;
alter table private.reports add constraint reports_target_kind_check
  check (target_kind in ('member', 'league', 'runner', 'run', 'comment'));
alter table private.reports drop constraint reports_reason_code_check;
alter table private.reports add constraint reports_reason_code_check
  check (reason_code in ('offensive_name', 'harassment', 'impersonation', 'cheating', 'spam', 'offensive_content', 'private_info', 'other'));
alter table private.reports add column target_run_id uuid references public.runs (id) on delete set null;
alter table private.reports add column target_comment_id uuid references private.comments (id) on delete set null;
alter table private.reports add column due_at timestamptz;
update private.reports set due_at = created_at + private.report_response_target() where due_at is null;
alter table private.reports alter column due_at set default now() + private.report_response_target();
alter table private.reports alter column due_at set not null;
create index reports_due_idx on private.reports (due_at) where status = 'open';
create index reports_comment_idx on private.reports (target_comment_id) where target_comment_id is not null;

alter table private.moderation_actions add column target_run_id uuid references public.runs (id) on delete set null;
alter table private.moderation_actions add column target_comment_id uuid references private.comments (id) on delete set null;

-- ---------------------------------------------------------------------------------------
-- Push notifications
-- ---------------------------------------------------------------------------------------
alter table private.integrations drop constraint integrations_name_check;
alter table private.integrations add constraint integrations_name_check check (name in ('strava', 'garmin', 'push'));
insert into private.integrations (name) values ('push');

create table private.push_tokens (
  token text primary key check (char_length(token) <= 200),
  user_id uuid not null references auth.users (id) on delete cascade,
  platform text not null check (platform in ('ios', 'android')),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index push_tokens_user_idx on private.push_tokens (user_id);

-- Every type is on once the runner allows notifications, and each can be switched off.
create table private.notification_prefs (
  user_id uuid primary key references auth.users (id) on delete cascade,
  kudos boolean not null default true,
  comments boolean not null default true,
  follows boolean not null default true,
  cheers boolean not null default true,
  results boolean not null default true,
  updated_at timestamptz not null default now()
);

create table private.push_outbox (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  -- Who caused it: a block between the two drops it.
  actor_id uuid references auth.users (id) on delete cascade,
  kind text not null check (kind in ('kudos', 'comments', 'follows', 'cheers', 'results')),
  title text not null,
  body text not null,
  -- Used instead of body once more than one runner is behind it: "{others}" becomes "2 others".
  many_body text,
  actors integer not null default 1,
  url text not null,
  -- What it's about: deleting either drops it.
  run_id uuid references public.runs (id) on delete cascade,
  comment_id uuid references private.comments (id) on delete cascade,
  -- Pushes with the same collapse key merge while they wait (kudos on one run).
  collapse_key text,
  created_at timestamptz not null default now(),
  send_after timestamptz not null default now(),
  attempts integer not null default 0,
  sent_at timestamptz,
  dropped_at timestamptz,
  last_error text
);
create index push_outbox_due_idx on private.push_outbox (send_after) where sent_at is null and dropped_at is null;
create unique index push_outbox_collapse_idx on private.push_outbox (collapse_key)
  where sent_at is null and dropped_at is null and collapse_key is not null;
create index push_outbox_user_idx on private.push_outbox (user_id);

-- One push per event, however often the event repeats (kudos off and on again, a re-follow).
create table private.push_dedupe (
  key text primary key,
  created_at timestamptz not null default now()
);

-- Expo's tickets, checked later for devices that were uninstalled.
create table private.push_receipts (
  ticket_id text primary key,
  token text not null,
  created_at timestamptz not null default now()
);

create table private.results_notified (
  league_id uuid not null references public.leagues (id) on delete cascade,
  week_start date not null,
  created_at timestamptz not null default now(),
  primary key (league_id, week_start)
);

-- Whether the runner wants this kind of push.
create or replace function private.push_wanted(p_user uuid, p_kind text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce((select case p_kind when 'kudos' then n.kudos when 'comments' then n.comments when 'follows' then n.follows
                                      when 'cheers' then n.cheers when 'results' then n.results end
                   from private.notification_prefs n where n.user_id = p_user), true)
$$;

-- Nothing arrives between 22:00 and 07:00 where the runner is: it waits until 07:00.
create or replace function private.push_send_after(p_user uuid, p_at timestamptz)
returns timestamptz
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_tz text;
  v_local timestamp;
begin
  select p.notification_tz into v_tz from public.profiles p where p.user_id = p_user;
  v_tz := coalesce(v_tz, 'America/Chicago');
  begin
    v_local := p_at at time zone v_tz;
  exception when others then
    v_tz := 'America/Chicago';
    v_local := p_at at time zone v_tz;
  end;
  if v_local::time >= time '22:00' then
    return ((v_local::date + 1) + time '07:00') at time zone v_tz;
  elsif v_local::time < time '07:00' then
    return (v_local::date + time '07:00') at time zone v_tz;
  end if;
  return p_at;
end
$$;

-- Queues a push for a runner, if they want it, have a device for it and aren't blocked from the
-- runner behind it. Returns whether anything was queued.
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
  p_delay interval default interval '0'
)
returns boolean
language plpgsql security definer set search_path = ''
as $$
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
  if p_collapse is null then
    insert into private.push_outbox (user_id, actor_id, kind, title, body, url, run_id, comment_id, send_after)
    values (p_user, p_actor, p_kind, left(p_title, 120), left(p_body, 240), p_url, p_run_id, p_comment_id,
            private.push_send_after(p_user, now() + coalesce(p_delay, interval '0')));
  else
    insert into private.push_outbox as o (user_id, actor_id, kind, title, body, many_body, url, run_id, comment_id, collapse_key, send_after)
    values (p_user, p_actor, p_kind, left(p_title, 120), left(p_body, 240), left(p_many_body, 240), p_url, p_run_id, p_comment_id,
            p_user || ':' || p_collapse, private.push_send_after(p_user, now() + coalesce(p_delay, interval '0')))
    on conflict (collapse_key) where sent_at is null and dropped_at is null and collapse_key is not null
    do update set actors = o.actors + 1, actor_id = excluded.actor_id, body = excluded.body, many_body = excluded.many_body;
  end if;
  return true;
end
$$;

-- ---------------------------------------------------------------------------------------
-- Who can see what: a run the viewer reported is gone for them
-- ---------------------------------------------------------------------------------------
create or replace function private.can_view_run(p_viewer uuid, p_run public.runs)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select case
    when p_run.owner_id = p_viewer then p_run.deleted_at is null
    when p_run.deleted_at is not null or p_run.status not in ('accepted', 'personal_only') or p_run.duplicate_of is not null then false
    when not private.visible_profile(p_run.owner_id) then false
    when private.are_blocked(p_viewer, p_run.owner_id) then false
    when exists (select 1 from private.hidden_content h
                 where h.user_id = p_viewer and h.target_kind = 'run' and h.target_id = p_run.id) then false
    when p_run.visibility = 'everyone' then private.visible_profile(p_viewer)
    when p_run.visibility = 'followers' then private.follows_accepted(p_viewer, p_run.owner_id) or private.share_league(p_viewer, p_run.owner_id)
    when p_run.visibility = 'leagues' then private.share_league(p_viewer, p_run.owner_id)
    else false
  end
$$;

-- Whether the viewer sees a comment (removal aside): its author is visible and not blocked either
-- way, the viewer didn't report it, and it isn't held for review (its author still sees it).
create or replace function private.comment_allowed(p_viewer uuid, p_comment_id uuid, p_author uuid, p_held_at timestamptz)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.visible_profile(p_author)
     and not private.are_blocked(p_viewer, p_author)
     and (p_held_at is null or p_author = p_viewer)
     and not exists (select 1 from private.hidden_content h
                     where h.user_id = p_viewer and h.target_kind = 'comment' and h.target_id = p_comment_id)
$$;

create or replace function private.kudos_count(p_run_id uuid, p_viewer uuid)
returns integer
language sql stable security definer set search_path = ''
as $$
  select count(*)::integer from private.kudos k
  where k.run_id = p_run_id and private.visible_profile(k.user_id) and not private.are_blocked(p_viewer, k.user_id)
$$;

-- Comments the viewer sees on a run, counted the way list_comments shows them.
create or replace function private.comment_count(p_run_id uuid, p_viewer uuid)
returns integer
language sql stable security definer set search_path = ''
as $$
  select count(*)::integer
  from private.comments c
  left join private.comments p on p.id = c.parent_id
  where c.run_id = p_run_id and c.deleted_at is null
    and private.comment_allowed(p_viewer, c.id, c.author_id, c.held_at)
    and (p.id is null or private.comment_allowed(p_viewer, p.id, p.author_id, p.held_at))
$$;

-- A run as a feed card: the shared card plus its kudos and comments.
create or replace function private.feed_item(p_run public.runs, p_viewer uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select private.shared_run_json(p_run, p_viewer, true) || jsonb_build_object(
    'kudos', private.kudos_count(p_run.id, p_viewer),
    'kudoed', exists (select 1 from private.kudos k where k.run_id = p_run.id and k.user_id = p_viewer),
    'comments', private.comment_count(p_run.id, p_viewer))
$$;

-- The threads on a run as the viewer sees them. A removed first comment stays as a placeholder
-- while its replies are shown; everything else the viewer shouldn't see is left out.
create or replace function private.comments_json(p_run public.runs, p_viewer uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  with c as (
    select c.id, c.parent_id, c.author_id, c.body, c.created_at, c.deleted_at,
           private.comment_allowed(p_viewer, c.id, c.author_id, c.held_at) as allowed
    from private.comments c
    where c.run_id = p_run.id
  ),
  shown as (
    select c.id, c.parent_id, c.created_at,
           jsonb_build_object(
             'id', c.id,
             'author', private.runner_card(c.author_id),
             'body', c.body,
             'created_at_ms', private.ts_to_ms(c.created_at),
             'is_mine', c.author_id = p_viewer,
             'can_delete', c.author_id = p_viewer or p_run.owner_id = p_viewer,
             'removed', false) as j
    from c where c.allowed and c.deleted_at is null
  ),
  replies as (
    select s.parent_id, jsonb_agg(s.j order by s.created_at, s.id) as items
    from shown s where s.parent_id is not null
    group by s.parent_id
  ),
  threads as (
    select t.id, t.created_at,
           coalesce((select s.j from shown s where s.id = t.id),
                    jsonb_build_object('id', t.id, 'author', null, 'body', null, 'created_at_ms', private.ts_to_ms(t.created_at),
                                       'is_mine', false, 'can_delete', false, 'removed', true)) as j,
           r.items
    from c t left join replies r on r.parent_id = t.id
    where t.parent_id is null and t.allowed and (t.deleted_at is null or r.items is not null)
  )
  select coalesce(jsonb_agg(t.j || jsonb_build_object('replies', coalesce(t.items, '[]'::jsonb)) order by t.created_at, t.id), '[]'::jsonb)
  from threads t
$$;

-- ---------------------------------------------------------------------------------------
-- The comment filter: length, characters, links and the blocked terms (whole words)
-- ---------------------------------------------------------------------------------------
create or replace function private.normalize_comment(p_body text)
returns text
language sql immutable
as $$
  select btrim(
    regexp_replace(
      regexp_replace(
        regexp_replace(replace(replace(coalesce(p_body, ''), E'\r\n', E'\n'), E'\r', E'\n'), '[ \t]+', ' ', 'g'),
        ' ?\n ?', E'\n', 'g'),
      '\n{3,}', E'\n\n', 'g'),
    E' \n')
$$;

-- Null when acceptable, else 'invalid' (length or characters) or 'not_allowed' (links, terms).
create or replace function private.comment_problem(p_body text)
returns text
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_words text := ' ' || btrim(regexp_replace(lower(coalesce(p_body, '')), '[^[:alnum:]]+', ' ', 'g')) || ' ';
begin
  if p_body is null or char_length(p_body) < 1 or char_length(p_body) > 500 then
    return 'invalid';
  end if;
  -- Control characters (newlines aside) and the invisible ones used to disguise text.
  if p_body ~ '[\x01-\x09\x0b-\x1f\x7f​-‏‪-‮⁦-⁩]' then
    return 'invalid';
  end if;
  if lower(p_body) ~ '(https?://|www\.|\m[a-z0-9-]+\.(com|net|org|io|ly|co|me|app|gg|xyz|info|biz|link|site|shop)\M)' then
    return 'not_allowed';
  end if;
  if exists (select 1 from private.blocked_terms t where position(' ' || t.term || ' ' in v_words) > 0) then
    return 'not_allowed';
  end if;
  return null;
end
$$;

-- ---------------------------------------------------------------------------------------
-- RPC: the feed
-- ---------------------------------------------------------------------------------------
-- Newest first, a page at a time: the caller's own runs, runs shared with followers or everyone by
-- people they follow, and runs shared with the league by league-mates. Muted runners are left out.
create or replace function public.get_feed(p_before_ms bigint default null, p_before_id uuid default null, p_limit integer default 20)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 30);
  v_before timestamptz := case when p_before_ms is null then 'infinity'::timestamptz else private.ms_to_ts(p_before_ms) end;
  v_before_id uuid := coalesce(p_before_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid);
  v_items jsonb;
  v_count integer;
  v_last_ms bigint;
  v_last_id uuid;
begin
  with people as (
    select v_uid as user_id
    union
    select f.followee_id from private.follows f where f.follower_id = v_uid and f.status = 'accepted'
    union
    select b.user_id from public.league_members a
    join public.league_members b on b.league_id = a.league_id and b.left_at is null
    where a.user_id = v_uid and a.left_at is null
  ),
  page as (
    select r.id, r.started_at
    from public.runs r
    join people p on p.user_id = r.owner_id
    where r.deleted_at is null and r.status in ('accepted', 'personal_only') and r.duplicate_of is null
      and (r.started_at, r.id) < (v_before, v_before_id)
      and (r.owner_id = v_uid or r.visibility <> 'only_me')
      and not exists (select 1 from private.mutes m where m.user_id = v_uid and m.muted_id = r.owner_id)
      and private.can_view_run(v_uid, r)
    order by r.started_at desc, r.id desc
    limit v_limit
  )
  select jsonb_agg(private.feed_item(r, v_uid) order by r.started_at desc, r.id desc), count(*)
  into v_items, v_count
  from page pg join public.runs r on r.id = pg.id;

  if v_count = v_limit then
    v_last_ms := (v_items -> -1 ->> 'started_at_ms')::bigint;
    v_last_id := (v_items -> -1 ->> 'run_id')::uuid;
  end if;
  return jsonb_build_object(
    'items', coalesce(v_items, '[]'::jsonb),
    'next', case when v_last_id is null then null else jsonb_build_object('before_ms', v_last_ms, 'before_id', v_last_id) end);
end
$$;

-- A run as the caller may see it, with its trimmed map when shared, kudos and comment counts.
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
  return private.feed_item(v_run, v_uid);
end
$$;

-- ---------------------------------------------------------------------------------------
-- RPC: kudos
-- ---------------------------------------------------------------------------------------
create or replace function public.set_kudos(p_run_id uuid, p_on boolean default true)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_run public.runs;
  v_alias text;
  v_title text;
begin
  select * into v_run from public.runs where id = p_run_id;
  if not found or not private.can_view_run(v_uid, v_run) then
    perform private.fail('not_found');
  end if;
  if v_run.owner_id = v_uid then
    perform private.fail('invalid_input', 'own_run');
  end if;
  if coalesce(p_on, true) then
    perform private.check_rate_limit('kudos:' || v_uid, 300, interval '1 day');
    insert into private.kudos (run_id, user_id) values (v_run.id, v_uid) on conflict do nothing;
    if found then
      select alias into v_alias from public.profiles where user_id = v_uid;
      v_title := coalesce(v_run.title, 'your run');
      -- Kudos wait two minutes so a burst arrives as one push.
      perform private.notify(v_run.owner_id, v_uid, 'kudos', 'Kudos',
        v_alias || ' gave you kudos for “' || v_title || '”.', '/shared/' || v_run.id,
        'kudos:' || v_run.id || ':' || v_uid,
        p_run_id => v_run.id,
        p_collapse => 'kudos:' || v_run.id,
        p_many_body => v_alias || ' and {others} gave you kudos for “' || v_title || '”.',
        p_delay => interval '2 minutes');
    end if;
  else
    delete from private.kudos where run_id = v_run.id and user_id = v_uid;
  end if;
  return jsonb_build_object('run_id', v_run.id, 'kudos', private.kudos_count(v_run.id, v_uid),
                            'kudoed', exists (select 1 from private.kudos k where k.run_id = v_run.id and k.user_id = v_uid));
end
$$;

create or replace function public.list_kudos(p_run_id uuid)
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
  return coalesce((
    select jsonb_agg(private.runner_card(k.user_id) || jsonb_build_object('is_me', k.user_id = v_uid) order by k.created_at desc)
    from private.kudos k
    where k.run_id = v_run.id and private.visible_profile(k.user_id) and not private.are_blocked(v_uid, k.user_id)), '[]'::jsonb);
end
$$;

-- ---------------------------------------------------------------------------------------
-- RPC: comments
-- ---------------------------------------------------------------------------------------
create or replace function public.list_comments(p_run_id uuid)
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
  return private.comments_json(v_run, v_uid);
end
$$;

create or replace function public.add_comment(p_run_id uuid, p_body text, p_parent_id uuid default null)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_run public.runs;
  v_parent private.comments;
  v_reply_to uuid;
  v_body text := private.normalize_comment(p_body);
  v_problem text := private.comment_problem(private.normalize_comment(p_body));
  v_id uuid;
  v_alias text;
  v_snippet text;
begin
  select * into v_run from public.runs where id = p_run_id;
  if not found or not private.can_view_run(v_uid, v_run) then
    perform private.fail('not_found');
  end if;
  if v_problem = 'invalid' then
    perform private.fail('invalid_input', 'body');
  elsif v_problem = 'not_allowed' then
    perform private.fail('comment_not_allowed');
  end if;
  if p_parent_id is not null then
    select * into v_parent from private.comments where id = p_parent_id and run_id = v_run.id;
    if not found or v_parent.deleted_at is not null
       or not private.comment_allowed(v_uid, v_parent.id, v_parent.author_id, v_parent.held_at) then
      perform private.fail('not_found');
    end if;
    v_reply_to := v_parent.author_id;
    -- Replies are one level deep: a reply to a reply joins the same thread.
    if v_parent.parent_id is not null then
      select * into v_parent from private.comments where id = v_parent.parent_id;
      if not private.comment_allowed(v_uid, v_parent.id, v_parent.author_id, v_parent.held_at) then
        perform private.fail('not_found');
      end if;
    end if;
  end if;
  perform private.check_rate_limit('comment_burst:' || v_uid, 8, interval '1 minute');
  perform private.check_rate_limit('comment:' || v_uid, 100, interval '1 day');
  insert into private.comments (run_id, author_id, parent_id, body)
  values (v_run.id, v_uid, v_parent.id, v_body)
  returning id into v_id;

  select alias into v_alias from public.profiles where user_id = v_uid;
  v_snippet := replace(case when char_length(v_body) > 90 then left(v_body, 89) || '…' else v_body end, E'\n', ' ');
  perform private.notify(v_run.owner_id, v_uid, 'comments', 'New comment on “' || coalesce(v_run.title, 'your run') || '”',
    v_alias || ': ' || v_snippet, '/shared/' || v_run.id, 'comment:' || v_id,
    p_run_id => v_run.id, p_comment_id => v_id);
  if v_reply_to is not null and v_reply_to <> v_run.owner_id and private.can_view_run(v_reply_to, v_run) then
    perform private.notify(v_reply_to, v_uid, 'comments', 'New reply', v_alias || ': ' || v_snippet,
      '/shared/' || v_run.id, 'reply:' || v_id, p_run_id => v_run.id, p_comment_id => v_id);
  end if;
  return private.comments_json(v_run, v_uid);
end
$$;

-- The author can delete their comment, and the runner can delete any comment on their run.
create or replace function public.delete_comment(p_comment_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_comment private.comments;
  v_run public.runs;
  v_by text;
begin
  select * into v_comment from private.comments where id = p_comment_id and deleted_at is null for update;
  if not found then
    perform private.fail('not_found');
  end if;
  select * into v_run from public.runs where id = v_comment.run_id;
  if v_comment.author_id = v_uid then
    v_by := 'author';
  elsif v_run.owner_id = v_uid then
    v_by := 'run_owner';
  else
    perform private.fail('not_found');
  end if;
  update private.comments set deleted_at = now(), body = null, removed_by = v_by, held_at = null where id = v_comment.id;
  return private.comments_json(v_run, v_uid);
end
$$;

-- ---------------------------------------------------------------------------------------
-- RPC: reporting a runner, a run or a comment
-- ---------------------------------------------------------------------------------------
-- Reason codes only. The reporter stops seeing a reported run or comment straight away; three
-- open reports from different runners hold a comment for review.
create or replace function public.report_content(p_kind text, p_id uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_run public.runs;
  v_comment private.comments;
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
  else
    perform private.fail('invalid_input', 'kind');
  end if;
  perform private.check_rate_limit('report:' || v_uid, 20, interval '1 day');
  insert into private.reports (reporter_id, target_kind, target_user_id, target_run_id, target_comment_id, reason_code, content_snapshot)
  values (v_uid, p_kind, v_other, case when p_kind in ('run', 'comment') then v_run.id end,
          case when p_kind = 'comment' then v_comment.id end, p_reason, v_snapshot)
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

-- ---------------------------------------------------------------------------------------
-- RPC: moderation (staff only; every action audited; no route access)
-- ---------------------------------------------------------------------------------------
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
  end if;

  update private.reports
     set status = v_status, resolved_at = now(), resolved_by = v_uid, resolution = p_action
   where id = p_report_id;
  -- Removing a comment or hiding a run settles every open report about it.
  if p_action in ('remove_comment', 'hide_run') then
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
  insert into private.moderation_actions (report_id, moderator_id, action, reason, target_user_id, target_league_id, target_run_id, target_comment_id)
  values (p_report_id, v_uid, p_action, btrim(p_reason), v_report.target_user_id, v_report.target_league_id,
          v_report.target_run_id, v_report.target_comment_id);
  return jsonb_build_object('report_id', p_report_id, 'status', v_status, 'also_resolved', v_also,
                            'within_target', now() <= v_report.due_at);
end
$$;

-- How the queue is doing against the response target.
create or replace function public.mod_queue_health()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_staff('moderator');
begin
  return jsonb_build_object(
    'response_target_hours', extract(epoch from private.report_response_target()) / 3600,
    'open', (select count(*) from private.reports where status = 'open'),
    'overdue', (select count(*) from private.reports where status = 'open' and due_at < now()),
    'next_due_at_ms', (select private.ts_to_ms(min(due_at)) from private.reports where status = 'open'),
    'resolved_7d', (select count(*) from private.reports where status <> 'open' and resolved_at > now() - interval '7 days'),
    'resolved_within_target_7d', (select count(*) from private.reports
                                  where status <> 'open' and resolved_at > now() - interval '7 days' and resolved_at <= due_at),
    'held_comments', (select count(*) from private.comments where held_at is not null and deleted_at is null));
end
$$;

-- ---------------------------------------------------------------------------------------
-- RPC: notification settings and devices
-- ---------------------------------------------------------------------------------------
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
      'results', private.push_wanted(p_uid, 'results')),
    'devices', (select count(*) from private.push_tokens t where t.user_id = p_uid))
$$;

create or replace function public.get_notification_settings()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
begin
  return private.notification_settings_json(v_uid);
end
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
    if v_key not in ('kudos', 'comments', 'follows', 'cheers', 'results') or jsonb_typeof(p_prefs -> v_key) <> 'boolean' then
      perform private.fail('invalid_input', 'prefs');
    end if;
  end loop;
  insert into private.notification_prefs as n (user_id, kudos, comments, follows, cheers, results)
  values (v_uid, coalesce((p_prefs ->> 'kudos')::boolean, true), coalesce((p_prefs ->> 'comments')::boolean, true),
          coalesce((p_prefs ->> 'follows')::boolean, true), coalesce((p_prefs ->> 'cheers')::boolean, true),
          coalesce((p_prefs ->> 'results')::boolean, true))
  on conflict (user_id) do update set
    kudos = coalesce((p_prefs ->> 'kudos')::boolean, n.kudos),
    comments = coalesce((p_prefs ->> 'comments')::boolean, n.comments),
    follows = coalesce((p_prefs ->> 'follows')::boolean, n.follows),
    cheers = coalesce((p_prefs ->> 'cheers')::boolean, n.cheers),
    results = coalesce((p_prefs ->> 'results')::boolean, n.results),
    updated_at = now();
  return private.notification_settings_json(v_uid);
end
$$;

-- A device's Expo push token. A token that moves to another account leaves the old one.
create or replace function public.register_push_token(p_token text, p_platform text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
begin
  if p_token is null or p_token !~ '^Expo(nent)?PushToken\[[A-Za-z0-9_-]{8,128}\]$' then
    perform private.fail('invalid_input', 'token');
  end if;
  if p_platform is null or p_platform not in ('ios', 'android') then
    perform private.fail('invalid_input', 'platform');
  end if;
  perform private.check_rate_limit('push_token:' || v_uid, 60, interval '1 day');
  insert into private.push_tokens (token, user_id, platform) values (p_token, v_uid, p_platform)
  on conflict (token) do update set user_id = excluded.user_id, platform = excluded.platform, last_seen_at = now();
  -- At most 10 devices: the longest unseen go first.
  delete from private.push_tokens t
  where t.user_id = v_uid
    and t.token in (select x.token from private.push_tokens x where x.user_id = v_uid order by x.last_seen_at desc offset 10);
  return private.notification_settings_json(v_uid);
end
$$;

create or replace function public.unregister_push_token(p_token text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
begin
  delete from private.push_tokens where token = p_token and user_id = v_uid;
  return jsonb_build_object('removed', found);
end
$$;

-- ---------------------------------------------------------------------------------------
-- What sends a push: follows, cheers and league results (kudos and comments above)
-- ---------------------------------------------------------------------------------------
create or replace function private.follows_notify()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_follower public.profiles;
  v_followee public.profiles;
begin
  select * into v_follower from public.profiles where user_id = new.follower_id;
  select * into v_followee from public.profiles where user_id = new.followee_id;
  if tg_op = 'INSERT' and new.status = 'pending' then
    perform private.notify(new.followee_id, new.follower_id, 'follows', 'Follow request',
      coalesce(v_follower.alias, 'A runner') || ' wants to follow you.', '/profile/people',
      'follow_request:' || new.follower_id || ':' || new.followee_id);
  elsif tg_op = 'INSERT' and new.status = 'accepted' then
    perform private.notify(new.followee_id, new.follower_id, 'follows', 'New follower',
      coalesce(v_follower.alias, 'A runner') || ' started following you.', '/runner/' || v_follower.public_id,
      'follow:' || new.follower_id || ':' || new.followee_id);
  elsif tg_op = 'UPDATE' and old.status = 'pending' and new.status = 'accepted' then
    perform private.notify(new.follower_id, new.followee_id, 'follows', 'Request accepted',
      coalesce(v_followee.alias, 'A runner') || ' accepted your follow request.', '/runner/' || v_followee.public_id,
      'follow_accepted:' || new.follower_id || ':' || new.followee_id);
  end if;
  return null;
end
$$;
create trigger follows_notify after insert or update of status on private.follows
  for each row execute function private.follows_notify();

create or replace function private.cheers_notify()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.notify(new.to_user, new.from_user, 'cheers', 'You got a cheer',
    coalesce((select alias from public.profiles where user_id = new.from_user), 'A league-mate') || ' cheered you on this week.',
    '/league', 'cheer:' || new.id);
  return null;
end
$$;
create trigger cheers_notify after insert on private.cheers
  for each row execute function private.cheers_notify();

create or replace function private.ordinal(p_n integer)
returns text
language sql immutable
as $$
  select p_n || case when p_n % 100 between 11 and 13 then 'th'
                     when p_n % 10 = 1 then 'st' when p_n % 10 = 2 then 'nd' when p_n % 10 = 3 then 'rd' else 'th' end
$$;

-- Once last week's standings are final (a day after it ends), each member who ran hears how their
-- week went. Runners with no XP get nothing: no nagging, and nothing about losing rank (REQ-012).
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
        if private.notify(v_row.user_id, null, 'results', 'Your week in ' || v_league.name,
             'You finished ' || private.ordinal(v_row.place) || ' of ' || v_row.size || ' with ' || v_row.xp || ' XP. A new week has started.',
             '/league', 'results:' || v_league.id || ':' || v_week || ':' || v_row.user_id) then
          v_count := v_count + 1;
        end if;
      end if;
    end loop;
  end loop;
  return v_count;
end
$$;

-- ---------------------------------------------------------------------------------------
-- The API service's side: claim, send, record (never over RPC)
-- ---------------------------------------------------------------------------------------
create or replace function private.set_push_integration(p_available boolean)
returns void
language sql security definer set search_path = ''
as $$
  update private.integrations set available = coalesce(p_available, false), updated_at = now() where name = 'push'
$$;

-- Due pushes, one row per device, leased so a crash retries them later. Pushes that should no
-- longer go out are dropped first.
create or replace function private.claim_push_batch(p_limit integer default 100)
returns table (outbox_id bigint, token text, platform text, title text, body text, url text, kind text)
language plpgsql security definer set search_path = ''
as $$
begin
  update private.push_outbox o
     set dropped_at = now(), last_error = coalesce(o.last_error, 'not_wanted')
   where o.sent_at is null and o.dropped_at is null and o.send_after <= now()
     and (o.attempts >= 5
          or not private.visible_profile(o.user_id)
          or not private.push_wanted(o.user_id, o.kind)
          or (o.actor_id is not null and private.are_blocked(o.user_id, o.actor_id))
          or (o.run_id is not null and not exists (select 1 from public.runs r where r.id = o.run_id and r.deleted_at is null))
          or (o.comment_id is not null and not exists (select 1 from private.comments c where c.id = o.comment_id and c.deleted_at is null))
          or not exists (select 1 from private.push_tokens t where t.user_id = o.user_id));

  return query
  with due as (
    select o.id from private.push_outbox o
    where o.sent_at is null and o.dropped_at is null and o.send_after <= now()
    order by o.send_after, o.id
    limit least(greatest(coalesce(p_limit, 100), 1), 500)
    for update skip locked
  ),
  leased as (
    update private.push_outbox o
       set attempts = o.attempts + 1,
           send_after = now() + least(interval '1 hour', interval '1 minute' * power(2, o.attempts))
      from due
     where o.id = due.id
    returning o.id, o.user_id, o.title, o.body, o.many_body, o.actors, o.url, o.kind
  )
  select l.id, t.token, t.platform, l.title,
         case when l.actors > 1 and l.many_body is not null
              then replace(l.many_body, '{others}', case when l.actors = 2 then '1 other' else (l.actors - 1)::text || ' others' end)
              else l.body end,
         l.url, l.kind
  from leased l join private.push_tokens t on t.user_id = l.user_id
  order by l.id, t.token;
end
$$;

-- Sent to at least one device: keep the tickets to check for uninstalled apps later.
create or replace function private.push_delivered(p_outbox_id bigint, p_tickets jsonb)
returns void
language sql security definer set search_path = ''
as $$
  update private.push_outbox set sent_at = now(), last_error = null where id = p_outbox_id;
  insert into private.push_receipts (ticket_id, token)
  select t ->> 'id', t ->> 'token' from jsonb_array_elements(coalesce(p_tickets, '[]'::jsonb)) t
  where t ->> 'id' is not null and t ->> 'token' is not null
  on conflict do nothing;
$$;

create or replace function private.push_failed(p_outbox_id bigint, p_error text)
returns void
language sql security definer set search_path = ''
as $$
  update private.push_outbox
     set last_error = left(p_error, 200), dropped_at = case when attempts >= 5 then now() end
   where id = p_outbox_id
$$;

-- The app was uninstalled or the token replaced: stop sending to it.
create or replace function private.push_token_gone(p_token text)
returns void
language sql security definer set search_path = ''
as $$
  delete from private.push_tokens where token = p_token;
  delete from private.push_receipts where token = p_token;
$$;

create or replace function private.push_receipts_due(p_limit integer default 300)
returns table (ticket_id text, token text)
language sql stable security definer set search_path = ''
as $$
  select r.ticket_id, r.token from private.push_receipts r
  where r.created_at < now() - interval '15 minutes'
  order by r.created_at
  limit least(greatest(coalesce(p_limit, 300), 1), 1000)
$$;

create or replace function private.push_receipts_checked(p_ticket_ids text[])
returns void
language sql security definer set search_path = ''
as $$
  delete from private.push_receipts where ticket_id = any (p_ticket_ids)
$$;

-- ---------------------------------------------------------------------------------------
-- Jobs, retention and the health report
-- ---------------------------------------------------------------------------------------
create or replace function private.run_frequent_jobs()
returns jsonb
language plpgsql security definer set search_path = ''
as $$
begin
  return jsonb_build_object(
    'deletions_completed', private.process_deletion_jobs(20),
    'pending_scored', private.apply_pending_scoring(500),
    'results_queued', private.enqueue_week_results());
end
$$;

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
  return jsonb_build_object('staged_uploads', v_staged, 'export_jobs', v_exports, 'events', v_events,
    'rate_limits', v_limits, 'reports', v_reports, 'invites', v_invites, 'deletion_jobs', v_jobs, 'pushes', v_push);
end
$$;

create or replace function private.health_report()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'stale_staged_uploads', (select count(*) from public.runs where status = 'uploading' and deleted_at is null
                              and first_received_at < now() - interval '15 minutes'),
    'failed_deletion_jobs', (select count(*) from private.deletion_jobs where state = 'failed'),
    'overdue_deletion_jobs', (select count(*) from private.deletion_jobs where state in ('queued', 'retrying', 'running')
                               and requested_at < now() - interval '7 days'),
    'open_reports', (select count(*) from private.reports where status = 'open'),
    'oldest_open_report_hours', (select floor(extract(epoch from now() - min(created_at)) / 3600) from private.reports where status = 'open'),
    'overdue_reports', (select count(*) from private.reports where status = 'open' and due_at < now()),
    'push_backlog', (select count(*) from private.push_outbox where sent_at is null and dropped_at is null
                      and send_after < now() - interval '10 minutes'),
    'runs_in_review', (select count(*) from public.runs where status = 'review' and deleted_at is null),
    'pending_scoring', (select count(*) from public.runs where scoring_state = 'pending' and deleted_at is null),
    'flags', (select jsonb_object_agg(key, enabled) from private.app_flags)
  )
$$;

-- ---------------------------------------------------------------------------------------
-- Export: the runner's comments, kudos and notification choices go with their data
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
                           where f.followee_id = p_uid), '[]'::jsonb),
    'comments', coalesce((select jsonb_agg(jsonb_build_object('run_id', c.run_id, 'reply', c.parent_id is not null, 'body', c.body,
                                                              'created_at_ms', private.ts_to_ms(c.created_at), 'removed_by', c.removed_by)
                                           order by c.created_at)
                          from private.comments c where c.author_id = p_uid), '[]'::jsonb),
    'kudos_given', coalesce((select jsonb_agg(jsonb_build_object('run_id', k.run_id, 'created_at_ms', private.ts_to_ms(k.created_at))
                                              order by k.created_at)
                             from private.kudos k where k.user_id = p_uid), '[]'::jsonb),
    'notifications', (private.notification_settings_json(p_uid) - 'available'))
$$;

select private.apply_function_grants();
