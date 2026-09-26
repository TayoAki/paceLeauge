-- Retention and background work (TECHNICAL_SPEC.md "Data lifecycle and operational boundaries").
-- Periods are the spec's proposed defaults; confirm them before collecting real user data.

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
  return jsonb_build_object('staged_uploads', v_staged, 'export_jobs', v_exports, 'events', v_events,
    'rate_limits', v_limits, 'reports', v_reports, 'invites', v_invites, 'deletion_jobs', v_jobs);
end
$$;

-- Frequent work: account deletion cleanup and scoring deferred while competition was paused.
create or replace function private.run_frequent_jobs()
returns jsonb
language plpgsql security definer set search_path = ''
as $$
begin
  return jsonb_build_object(
    'deletions_completed', private.process_deletion_jobs(20),
    'pending_scored', private.apply_pending_scoring(500));
end
$$;

-- Alert surface: open work that has waited too long (see docs/OPERATIONS.md).
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
    'runs_in_review', (select count(*) from public.runs where status = 'review' and deleted_at is null),
    'pending_scoring', (select count(*) from public.runs where scoring_state = 'pending' and deleted_at is null),
    'flags', (select jsonb_object_agg(key, enabled) from private.app_flags)
  )
$$;

-- pg_cron is available on Supabase (it must be preloaded). Elsewhere, call
-- private.run_frequent_jobs() every minute and private.purge_expired() hourly from any scheduler.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('paceleague-frequent', '* * * * *', 'select private.run_frequent_jobs()');
    perform cron.schedule('paceleague-retention', '17 * * * *', 'select private.purge_expired()');
  end if;
exception when others then
  raise notice 'pg_cron schedules not created (%): run private.run_frequent_jobs() and private.purge_expired() from a scheduler', sqlerrm;
end
$$;

select private.apply_function_grants();
