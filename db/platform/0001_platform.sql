-- Platform layer: the pieces a hosted Supabase project would otherwise provide. Applied before
-- db/migrations by the API service's migrator (server/src/migrate.ts).
--
--   • API roles. The API connects as the database owner and runs every request in a transaction
--     with `role` switched to anon or authenticated (as PostgREST does), so grants and row-level
--     security apply to the caller — never to the owner.
--   • The auth schema: accounts, sign-in identities, sessions, refresh tokens, one-time codes and
--     auth rate limits, plus auth.uid() / auth.role() / auth.jwt() / auth.email(), which read the
--     request's verified JWT claims.
--
-- Strict by design: unlike a Supabase project, API roles get no default privileges on new
-- objects. Every migration grants exactly what it needs (private.apply_function_grants()).

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  -- Nothing logs in as service_role; it exists so grants written for Supabase stay valid.
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

create schema if not exists auth;
revoke all on schema auth from public;

create table auth.users (
  id uuid primary key default gen_random_uuid(),
  -- Null for a Sign in with Apple account that did not share an email address.
  email text unique check (email is null or email = lower(email)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_sign_in_at timestamptz,
  raw_app_meta_data jsonb not null default '{}'::jsonb,
  raw_user_meta_data jsonb not null default '{}'::jsonb
);

-- How an account signs in: its email address, or Apple's stable user identifier (`sub`).
create table auth.identities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null check (provider in ('email', 'apple')),
  provider_id text not null,
  email text,
  created_at timestamptz not null default now(),
  last_sign_in_at timestamptz,
  unique (provider, provider_id)
);
create index identities_user on auth.identities (user_id);

-- One sign-in on one device. `signed_in_at` becomes the JWT `amr` timestamp that the recent
-- sign-in checks (export, account deletion) read; refreshing never moves it.
create table auth.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  method text not null check (method in ('otp', 'apple')),
  signed_in_at timestamptz not null default now(),
  refreshed_at timestamptz,
  revoked_at timestamptz
);
create index sessions_user_active on auth.sessions (user_id) where revoked_at is null;

-- Refresh tokens are opaque random values; only their SHA-256 is stored. Each use rotates the
-- token; reusing a rotated one outside a short grace window ends the whole session.
create table auth.refresh_tokens (
  token_hash text primary key,
  session_id uuid not null references auth.sessions (id) on delete cascade,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index refresh_tokens_session on auth.refresh_tokens (session_id);

-- The latest emailed code per address, stored as an HMAC keyed by a server secret (a leaked
-- table can't be brute-forced offline). Single use, expiring, with a failed-attempt limit.
create table auth.one_time_codes (
  email text primary key check (email = lower(email)),
  code_hmac text not null,
  expires_at timestamptz not null,
  sent_at timestamptz not null default now(),
  attempts integer not null default 0
);

-- Fixed-window counters for sign-in endpoints. Unlike private.rate_limits, these are written
-- in their own statement so a failed attempt still counts.
create table auth.rate_limits (
  bucket text not null,
  window_start timestamptz not null,
  hits integer not null default 0,
  primary key (bucket, window_start)
);

create or replace function auth.jwt() returns jsonb
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;

create or replace function auth.uid() returns uuid
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

create or replace function auth.role() returns text
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;

create or replace function auth.email() returns text
language sql stable
as $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email'
$$;

-- API roles may read their own claims (row-level security policies call auth.uid()), and
-- nothing else in this schema.
grant usage on schema auth to anon, authenticated, service_role;
revoke all on all tables in schema auth from anon, authenticated, service_role;
grant execute on function auth.jwt(), auth.uid(), auth.role(), auth.email() to anon, authenticated, service_role;

-- Service state kept with the data. The migrator creates the `platform` schema (and its
-- schema_migrations ledger) before this file runs, with no access for API roles.
create table platform.settings (
  key text primary key,
  value text not null,
  created_at timestamptz not null default now()
);

create table platform.bootstrap_actions (
  name text primary key,
  applied_at timestamptz not null default now()
);
