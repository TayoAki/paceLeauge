-- PaceLeague core schema (V1).
--
-- Trust model: the mobile app holds only the anon key. Every mutation goes through a
-- SECURITY DEFINER function in `public` that derives the caller from auth.uid(), checks
-- current object access, and performs the canonical domain operation. Tables in `public`
-- have RLS with owner-only SELECT policies as defense in depth and no client write policies.
-- Tables in `private` are not exposed by the API at all.

create schema if not exists private;
revoke all on schema private from public;

-- PostgreSQL grants EXECUTE to PUBLIC on new functions by default. Remove that for both
-- schemas; private.apply_function_grants() then grants exactly what each RPC needs.
alter default privileges in schema private revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from public;

-- ---------------------------------------------------------------------------------------
-- Profiles and derived stats
-- ---------------------------------------------------------------------------------------
create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  alias text not null,
  units text not null default 'metric' check (units in ('metric', 'imperial')),
  goal_days smallint check (goal_days between 1 and 3),
  notification_tz text check (notification_tz is null or char_length(notification_tz) <= 64),
  eligibility_ack_at timestamptz not null,
  status text not null default 'active' check (status in ('active', 'deleting')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_alias_length check (char_length(alias) between 2 and 24)
);
create unique index profiles_alias_key on public.profiles (lower(alias));

create table private.profile_stats (
  user_id uuid primary key references auth.users (id) on delete cascade,
  lifetime_xp integer not null default 0 check (lifetime_xp >= 0),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------------------
-- Runs, routes and scoring
-- ---------------------------------------------------------------------------------------
create table public.runs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  client_run_id uuid not null,
  -- sha256 of the canonical upload request; a changed body with the same key is a conflict.
  request_hash text not null,
  source text not null default 'phone_gps' check (source in ('phone_gps')),
  title text not null check (char_length(title) <= 60),
  started_at timestamptz not null,
  ended_at timestamptz not null,
  segments jsonb not null,
  client_distance_m double precision not null check (client_distance_m >= 0),
  client_active_ms bigint not null check (client_active_ms >= 0),
  expected_points integer not null check (expected_points between 0 and 50000),
  expected_chunks integer not null check (expected_chunks between 0 and 100),
  interrupted boolean not null default false,
  status text not null default 'uploading'
    check (status in ('uploading', 'accepted', 'personal_only', 'review')),
  reason_codes text[] not null default '{}',
  distance_cm bigint check (distance_cm >= 0),
  active_ms bigint check (active_ms >= 0),
  coverage numeric(6, 5),
  diagnostics jsonb,
  validator_version smallint,
  rule_version smallint,
  -- none: not eligible · pending: accepted while competition scoring is paused · applied
  scoring_state text not null default 'none' check (scoring_state in ('none', 'pending', 'applied')),
  -- XP this run added when it was credited (per competition day), for an idempotent summary.
  xp_award jsonb,
  version integer not null default 1,
  first_received_at timestamptz not null default now(),
  finalized_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint runs_client_run_key unique (owner_id, client_run_id)
);
create index runs_owner_history_idx on public.runs (owner_id, started_at desc, id desc) where deleted_at is null;
create index runs_staged_idx on public.runs (first_received_at) where status = 'uploading';

create table private.route_chunks (
  run_id uuid not null references public.runs (id) on delete cascade,
  seq integer not null check (seq >= 0),
  checksum text not null,
  point_count integer not null check (point_count between 1 and 500),
  points jsonb not null,
  created_at timestamptz not null default now(),
  primary key (run_id, seq)
);

create table private.run_routes (
  run_id uuid primary key references public.runs (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  points jsonb not null,
  point_count integer not null,
  checksum text not null,
  created_at timestamptz not null default now()
);

create table private.run_day_allocations (
  run_id uuid not null references public.runs (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  segment_index integer not null,
  competition_date date not null,
  segment_start_at timestamptz not null,
  distance_cm bigint not null check (distance_cm >= 0),
  active_ms bigint not null check (active_ms >= 0),
  primary key (run_id, segment_index, competition_date)
);
create index run_day_allocations_owner_date_idx on private.run_day_allocations (owner_id, competition_date);

create table public.daily_scores (
  owner_id uuid not null references auth.users (id) on delete cascade,
  competition_date date not null,
  rule_version smallint not null,
  distance_cm bigint not null check (distance_cm >= 0),
  active_ms bigint not null check (active_ms >= 0),
  distance_xp smallint not null check (distance_xp between 0 and 100),
  active_day_bonus smallint not null check (active_day_bonus in (0, 25)),
  xp smallint not null check (xp between 0 and 125),
  revision integer not null check (revision >= 1),
  updated_at timestamptz not null default now(),
  primary key (owner_id, competition_date, rule_version)
);

create table private.xp_ledger (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  competition_date date not null,
  rule_version smallint not null,
  revision integer not null,
  delta integer not null,
  cause_kind text not null check (cause_kind in ('run_accepted', 'run_deleted', 'run_review_resolved', 'recompute')),
  cause_id uuid,
  created_at timestamptz not null default now(),
  constraint xp_ledger_revision_key unique (owner_id, competition_date, rule_version, revision)
);

-- ---------------------------------------------------------------------------------------
-- Leagues
-- ---------------------------------------------------------------------------------------
create table public.leagues (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 3 and 32),
  owner_id uuid references auth.users (id) on delete set null,
  calendar_zone text not null default 'America/Chicago' check (calendar_zone = 'America/Chicago'),
  capacity smallint not null default 20 check (capacity between 2 and 20),
  status text not null default 'active' check (status in ('active', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Each row is one membership period; leaving and rejoining creates a new period.
create table public.league_members (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references public.leagues (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  left_reason text check (left_reason in ('left', 'removed', 'league_closed', 'account_deleted')),
  constraint league_members_left_consistent check ((left_at is null) = (left_reason is null))
);
create unique index league_members_one_active_league on public.league_members (user_id) where left_at is null;
create index league_members_active_by_league on public.league_members (league_id) where left_at is null;

create table private.league_invites (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references public.leagues (id) on delete cascade,
  code_hash text not null unique,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index league_invites_active_idx on private.league_invites (league_id) where revoked_at is null;

-- Removed members cannot come back through an old invite (AC-REQ-011-02).
create table private.league_bans (
  league_id uuid not null references public.leagues (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (league_id, user_id)
);

-- A settled week whose standings changed afterwards (deletion/integrity correction).
create table private.league_week_revisions (
  league_id uuid not null references public.leagues (id) on delete cascade,
  week_start date not null,
  revision integer not null,
  reason text not null,
  created_at timestamptz not null default now(),
  primary key (league_id, week_start, revision)
);

-- ---------------------------------------------------------------------------------------
-- Safety: blocks, reports, moderation
-- ---------------------------------------------------------------------------------------
create table public.blocks (
  id uuid primary key default gen_random_uuid(),
  blocker_id uuid not null references auth.users (id) on delete cascade,
  blocked_id uuid not null references auth.users (id) on delete cascade,
  blocked_alias_snapshot text not null,
  created_at timestamptz not null default now(),
  constraint blocks_pair_key unique (blocker_id, blocked_id),
  constraint blocks_not_self check (blocker_id <> blocked_id)
);
create index blocks_blocked_idx on public.blocks (blocked_id);

create table private.staff_roles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role text not null check (role in ('moderator', 'operator')),
  granted_at timestamptz not null default now(),
  granted_reason text not null
);

create table private.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid references auth.users (id) on delete set null,
  target_kind text not null check (target_kind in ('member', 'league')),
  target_user_id uuid references auth.users (id) on delete set null,
  target_league_id uuid references public.leagues (id) on delete set null,
  reason_code text not null
    check (reason_code in ('offensive_name', 'harassment', 'impersonation', 'cheating', 'spam', 'other')),
  content_snapshot jsonb not null,
  status text not null default 'open' check (status in ('open', 'actioned', 'dismissed')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references auth.users (id) on delete set null,
  resolution text
);
create index reports_open_idx on private.reports (created_at) where status = 'open';

create table private.moderation_actions (
  id bigint generated always as identity primary key,
  report_id uuid references private.reports (id) on delete set null,
  moderator_id uuid references auth.users (id) on delete set null,
  action text not null,
  reason text not null,
  target_user_id uuid references auth.users (id) on delete set null,
  target_league_id uuid references public.leagues (id) on delete set null,
  created_at timestamptz not null default now()
);

create table private.blocked_terms (
  term text primary key check (term = lower(term) and char_length(term) >= 3)
);

-- ---------------------------------------------------------------------------------------
-- Data lifecycle
-- ---------------------------------------------------------------------------------------
create table private.deletion_jobs (
  id uuid primary key default gen_random_uuid(),
  -- No foreign key: the completion record must outlive the auth user it deleted.
  user_id uuid not null,
  requested_at timestamptz not null default now(),
  state text not null default 'queued' check (state in ('queued', 'running', 'retrying', 'completed', 'failed')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  completed_at timestamptz
);
create unique index deletion_jobs_one_open on private.deletion_jobs (user_id)
  where state in ('queued', 'running', 'retrying');

create table private.export_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  requested_at timestamptz not null default now(),
  expires_at timestamptz not null,
  fetch_count integer not null default 0
);
create index export_jobs_user_idx on private.export_jobs (user_id, requested_at desc);

-- ---------------------------------------------------------------------------------------
-- Operations
-- ---------------------------------------------------------------------------------------
create table private.operational_events (
  event_id uuid primary key,
  schema_version smallint not null,
  environment text not null check (environment in ('development', 'staging', 'production', 'test')),
  name text not null,
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  subject text,
  props jsonb not null default '{}'::jsonb
);
create index operational_events_received_idx on private.operational_events (received_at);

create table private.app_flags (
  key text primary key,
  enabled boolean not null,
  reason text not null,
  updated_at timestamptz not null default now()
);
-- Competition scoring starts disabled: enable it after the accepted-run validation and
-- concurrency suites pass in staging (FACTORY_PRD.md "Rollout and rollback").
insert into private.app_flags (key, enabled, reason) values
  ('competition_enabled', false, 'Enable after EV-005/EV-006 pass in staging'),
  ('invites_enabled', true, 'Default on; suspend independently of the recorder'),
  ('registration_enabled', true, 'Default on');

create table private.rate_limits (
  bucket text not null,
  window_start timestamptz not null,
  hits integer not null,
  primary key (bucket, window_start)
);

create table private.audit_log (
  id bigint generated always as identity primary key,
  actor text not null,
  action text not null,
  target text,
  reason text not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------------------
-- Row level security and grants
-- ---------------------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.runs enable row level security;
alter table public.daily_scores enable row level security;
alter table public.leagues enable row level security;
alter table public.league_members enable row level security;
alter table public.blocks enable row level security;

-- Clients never write tables directly; remove the platform's default write grants too.
revoke all on public.profiles, public.runs, public.daily_scores, public.leagues, public.league_members, public.blocks
  from anon, authenticated;
grant select on public.profiles, public.runs, public.daily_scores, public.leagues, public.league_members, public.blocks
  to authenticated;

create policy profiles_select_own on public.profiles
  for select to authenticated using (user_id = (select auth.uid()));

create policy runs_select_own on public.runs
  for select to authenticated using (owner_id = (select auth.uid()) and deleted_at is null);

create policy daily_scores_select_own on public.daily_scores
  for select to authenticated using (owner_id = (select auth.uid()));

create policy league_members_select_own on public.league_members
  for select to authenticated using (user_id = (select auth.uid()));

create policy blocks_select_own on public.blocks
  for select to authenticated using (blocker_id = (select auth.uid()));

-- Leagues are readable by their current members only (standings go through an RPC that
-- projects alias/tier/weekly XP; member rows never expose contact data).
create or replace function private.is_active_member(p_league_id uuid, p_user_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.league_members m
    where m.league_id = p_league_id and m.user_id = p_user_id and m.left_at is null
  )
$$;

create policy leagues_select_member on public.leagues
  for select to authenticated using (private.is_active_member(id, (select auth.uid())));

grant usage on schema private to authenticated;
revoke all on all tables in schema private from anon, authenticated;
revoke all on all functions in schema private from public, anon, authenticated;
grant execute on function private.is_active_member(uuid, uuid) to authenticated;
