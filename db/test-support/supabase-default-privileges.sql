-- TEST ONLY — never applied by the API service.
--
-- Reproduces the permissive defaults of a hosted Supabase database: API roles receive ALL on
-- every new table, function and sequence in `public`. The backend suite runs once on the strict
-- platform (what Railway runs) and once with this file applied between the platform layer and the
-- migrations, to prove that row-level security and explicit revokes — not missing grants — are
-- what protect the data.

grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
