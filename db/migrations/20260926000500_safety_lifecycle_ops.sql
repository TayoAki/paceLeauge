-- Safety (REQ-011), privacy/export/deletion (REQ-010), minimized telemetry (REQ-015)
-- and operator controls (kill switches, run review resolution).

-- ---------------------------------------------------------------------------------------
-- Blocks and reports
-- ---------------------------------------------------------------------------------------
-- A member of the caller's current league (the only people a runner can see).
create or replace function private.league_peer(p_user uuid, p_member_id uuid)
returns public.league_members
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_mine public.league_members := private.active_membership(p_user);
  v_target public.league_members;
begin
  if v_mine.id is null then
    perform private.fail('not_in_league');
  end if;
  select * into v_target from public.league_members
  where id = p_member_id and league_id = v_mine.league_id and left_at is null;
  if not found then
    perform private.fail('not_found');
  end if;
  if v_target.user_id = p_user then
    perform private.fail('cannot_target_self');
  end if;
  return v_target;
end
$$;

create or replace function public.block_member(p_member_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_target public.league_members := private.league_peer(v_uid, p_member_id);
begin
  perform private.check_rate_limit('block:' || v_uid, 30, interval '1 day');
  insert into public.blocks (blocker_id, blocked_id, blocked_alias_snapshot)
  select v_uid, v_target.user_id, p.alias from public.profiles p where p.user_id = v_target.user_id
  on conflict (blocker_id, blocked_id) do nothing;
  return jsonb_build_object('blocked', true);
end
$$;

create or replace function public.list_blocks()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'block_id', b.id, 'alias', b.blocked_alias_snapshot, 'created_at_ms', private.ts_to_ms(b.created_at))
         order by b.created_at desc), '[]'::jsonb)
  from public.blocks b
  where b.blocker_id = private.require_user()
$$;

create or replace function public.unblock(p_block_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
begin
  delete from public.blocks where id = p_block_id and blocker_id = v_uid;
  return jsonb_build_object('unblocked', found);
end
$$;

-- Reason codes only: no unrestricted text upload.
create or replace function public.submit_report(p_target_kind text, p_member_id uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_mine public.league_members := private.active_membership(v_uid);
  v_target public.league_members;
  v_league public.leagues;
  v_alias text;
  v_id uuid;
begin
  if p_reason is null or p_reason not in ('offensive_name', 'harassment', 'impersonation', 'cheating', 'spam', 'other') then
    perform private.fail('invalid_input', 'reason');
  end if;
  if v_mine.id is null then
    perform private.fail('not_in_league');
  end if;
  perform private.check_rate_limit('report:' || v_uid, 20, interval '1 day');
  select * into v_league from public.leagues where id = v_mine.league_id;

  if p_target_kind = 'member' then
    v_target := private.league_peer(v_uid, p_member_id);
    select alias into v_alias from public.profiles where user_id = v_target.user_id;
    insert into private.reports (reporter_id, target_kind, target_user_id, target_league_id, reason_code, content_snapshot)
    values (v_uid, 'member', v_target.user_id, v_league.id, p_reason,
            jsonb_build_object('alias', v_alias, 'league_name', v_league.name))
    returning id into v_id;
  elsif p_target_kind = 'league' then
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
-- Moderation (restricted staff roles; every action audited; no route access)
-- ---------------------------------------------------------------------------------------
create or replace function private.require_staff(p_role text)
returns uuid
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_role text;
begin
  select role into v_role from private.staff_roles where user_id = v_uid;
  if v_role is null or (p_role = 'operator' and v_role <> 'operator') then
    perform private.fail('not_staff');
  end if;
  return v_uid;
end
$$;

create or replace function public.mod_list_reports(p_status text default 'open', p_limit integer default 50)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_staff('moderator');
begin
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
             'report_id', r.id, 'target_kind', r.target_kind, 'reason_code', r.reason_code,
             'content_snapshot', r.content_snapshot, 'status', r.status,
             'created_at_ms', private.ts_to_ms(r.created_at), 'resolution', r.resolution)
           order by r.created_at), '[]'::jsonb)
    from (select * from private.reports where status = coalesce(p_status, 'open')
          order by created_at limit least(greatest(coalesce(p_limit, 50), 1), 200)) r
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
  elsif p_action <> 'dismiss' then
    perform private.fail('invalid_input', 'action');
  end if;

  update private.reports
     set status = case when p_action = 'dismiss' then 'dismissed' else 'actioned' end,
         resolved_at = now(), resolved_by = v_uid, resolution = p_action
   where id = p_report_id;
  insert into private.moderation_actions (report_id, moderator_id, action, reason, target_user_id, target_league_id)
  values (p_report_id, v_uid, p_action, btrim(p_reason), v_report.target_user_id, v_report.target_league_id);
  return jsonb_build_object('report_id', p_report_id, 'status', case when p_action = 'dismiss' then 'dismissed' else 'actioned' end);
end
$$;

-- ---------------------------------------------------------------------------------------
-- Export (recent sign-in required; owner-checked authenticated delivery; 24 h lifetime)
-- ---------------------------------------------------------------------------------------
create or replace function public.request_export()
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_job private.export_jobs;
begin
  if not private.has_recent_auth() then
    perform private.fail('recent_auth_required');
  end if;
  select * into v_job from private.export_jobs
  where user_id = v_uid and expires_at > now()
  order by requested_at desc limit 1;
  if found then
    return jsonb_build_object('export_id', v_job.id, 'expires_at_ms', private.ts_to_ms(v_job.expires_at), 'reused', true);
  end if;
  perform private.check_rate_limit('export:' || v_uid, 3, interval '1 day');
  insert into private.export_jobs (user_id, expires_at) values (v_uid, now() + interval '24 hours')
  returning * into v_job;
  return jsonb_build_object('export_id', v_job.id, 'expires_at_ms', private.ts_to_ms(v_job.expires_at), 'reused', false);
end
$$;

create or replace function private.require_export(p_user uuid, p_export_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  update private.export_jobs set fetch_count = fetch_count + 1
  where id = p_export_id and user_id = p_user and expires_at > now();
  if not found then
    perform private.fail('not_found');
  end if;
end
$$;

create or replace function public.get_export(p_export_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_profile public.profiles;
  v_email text;
begin
  perform private.require_export(v_uid, p_export_id);
  select * into v_profile from public.profiles where user_id = v_uid;
  select email into v_email from auth.users where id = v_uid;
  return jsonb_build_object(
    'format', 'paceleague-export',
    'format_version', 1,
    'generated_at_ms', private.ts_to_ms(now()),
    'account', jsonb_build_object('email', v_email, 'alias', v_profile.alias, 'units', v_profile.units,
      'goal_days', v_profile.goal_days, 'notification_tz', v_profile.notification_tz,
      'created_at_ms', private.ts_to_ms(v_profile.created_at),
      'eligibility_ack_at_ms', private.ts_to_ms(v_profile.eligibility_ack_at)),
    'lifetime_xp', private.lifetime_xp(v_uid),
    'tier', private.tier_name(private.lifetime_xp(v_uid)),
    'runs', coalesce((select jsonb_agg(private.run_json(r) || jsonb_build_object('segments', r.segments)
                                       order by r.started_at)
                      from public.runs r where r.owner_id = v_uid and r.deleted_at is null and r.status <> 'uploading'), '[]'::jsonb),
    'daily_scores', coalesce((select jsonb_agg(jsonb_build_object('date', d.competition_date, 'rule_version', d.rule_version,
                                'distance_cm', d.distance_cm, 'active_ms', d.active_ms, 'xp', d.xp, 'revision', d.revision)
                                order by d.competition_date)
                              from public.daily_scores d where d.owner_id = v_uid), '[]'::jsonb),
    'league_memberships', coalesce((select jsonb_agg(jsonb_build_object('league_name', l.name, 'role', m.role,
                                      'joined_at_ms', private.ts_to_ms(m.joined_at), 'left_at_ms', private.ts_to_ms(m.left_at),
                                      'left_reason', m.left_reason) order by m.joined_at)
                                    from public.league_members m join public.leagues l on l.id = m.league_id
                                    where m.user_id = v_uid), '[]'::jsonb),
    'blocked_count', (select count(*) from public.blocks where blocker_id = v_uid)
  );
end
$$;

create or replace function public.get_export_route(p_export_id uuid, p_run_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
begin
  perform private.require_export(v_uid, p_export_id);
  return public.get_my_run_route(p_run_id);
end
$$;

-- ---------------------------------------------------------------------------------------
-- Account deletion: immediate hiding, then a retrying cleanup job
-- ---------------------------------------------------------------------------------------
-- Ends the user's active membership now. An owner's league passes to its longest-standing
-- member, or closes when the owner was alone.
create or replace function private.detach_from_league(p_user uuid, p_reason text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_member public.league_members;
  v_successor public.league_members;
begin
  select * into v_member from public.league_members where user_id = p_user and left_at is null for update;
  if not found then
    return;
  end if;
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
  update private.league_invites set revoked_at = now() where created_by = p_user and revoked_at is null;
  update public.league_members set left_at = now(), left_reason = p_reason, role = 'member' where id = v_member.id;
end
$$;

create or replace function public.request_account_deletion()
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_job private.deletion_jobs;
begin
  if not private.has_recent_auth() then
    perform private.fail('recent_auth_required');
  end if;
  select * into v_job from private.deletion_jobs
  where user_id = v_uid and state in ('queued', 'running', 'retrying');
  if found then
    return jsonb_build_object('job_id', v_job.id, 'state', v_job.state, 'requested_at_ms', private.ts_to_ms(v_job.requested_at));
  end if;

  update public.profiles set status = 'deleting', updated_at = now() where user_id = v_uid;
  perform private.detach_from_league(v_uid, 'account_deleted');
  delete from public.blocks where blocker_id = v_uid or blocked_id = v_uid;
  insert into private.deletion_jobs (user_id) values (v_uid) returning * into v_job;
  perform private.log_server_event('deletion_requested', null, '{}'::jsonb);
  return jsonb_build_object('job_id', v_job.id, 'state', v_job.state, 'requested_at_ms', private.ts_to_ms(v_job.requested_at));
end
$$;

create or replace function public.get_account_deletion_status()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_job private.deletion_jobs;
begin
  select * into v_job from private.deletion_jobs where user_id = v_uid order by requested_at desc limit 1;
  if not found then
    return jsonb_build_object('state', 'none');
  end if;
  return jsonb_build_object('job_id', v_job.id, 'state', v_job.state, 'requested_at_ms', private.ts_to_ms(v_job.requested_at));
end
$$;

-- Removes every owned record and finally the identity itself (which revokes sessions).
create or replace function private.purge_user_data(p_user uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.detach_from_league(p_user, 'account_deleted');
  delete from public.runs where owner_id = p_user;
  delete from public.daily_scores where owner_id = p_user;
  delete from private.xp_ledger where owner_id = p_user;
  delete from private.profile_stats where user_id = p_user;
  delete from public.blocks where blocker_id = p_user or blocked_id = p_user;
  delete from private.export_jobs where user_id = p_user;
  delete from private.league_bans where user_id = p_user;
  delete from private.operational_events where subject = private.subject_ref(p_user);
  update private.reports set content_snapshot = '{}'::jsonb where target_user_id = p_user;
  delete from public.league_members where user_id = p_user;
  delete from private.staff_roles where user_id = p_user;
  delete from public.profiles where user_id = p_user;
  delete from auth.users where id = p_user;
end
$$;

create or replace function private.process_deletion_jobs(p_limit integer default 10)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_job private.deletion_jobs;
  v_done integer := 0;
  v_backoff constant interval[] := array[interval '1 minute', interval '5 minutes', interval '30 minutes',
                                         interval '2 hours', interval '6 hours', interval '12 hours', interval '24 hours'];
begin
  for v_job in
    select * from private.deletion_jobs
    where state in ('queued', 'retrying') and next_attempt_at <= now()
    order by requested_at
    limit p_limit
    for update skip locked
  loop
    update private.deletion_jobs set state = 'running', attempts = attempts + 1 where id = v_job.id;
    begin
      perform private.purge_user_data(v_job.user_id);
      update private.deletion_jobs set state = 'completed', completed_at = now(), last_error = null where id = v_job.id;
      perform private.log_server_event('deletion_completed', null, '{}'::jsonb);
      v_done := v_done + 1;
    exception when others then
      update private.deletion_jobs
         set state = case when attempts >= 8 then 'failed' else 'retrying' end,
             last_error = sqlstate,
             next_attempt_at = now() + v_backoff[least(attempts, array_length(v_backoff, 1))]
       where id = v_job.id;
      if (select state from private.deletion_jobs where id = v_job.id) = 'failed' then
        perform private.log_server_event('deletion_job_failed', null, jsonb_build_object('job', v_job.id::text));
      end if;
    end;
  end loop;
  return v_done;
end
$$;

-- ---------------------------------------------------------------------------------------
-- Telemetry: allowlisted events, enumerated string/boolean props only (no coordinates,
-- routes, tokens, email, titles or precise health statistics).
-- ---------------------------------------------------------------------------------------
create or replace function private.event_allowed_props(p_name text)
returns text[]
language sql immutable
as $$
  select case p_name
    when 'account_created' then '{}'::text[]
    when 'onboarding_completed' then array['goal_set', 'units']
    when 'permission_result' then array['permission', 'result', 'precise']
    when 'run_started' then '{}'::text[]
    when 'run_saved_local' then array['interrupted', 'duration_bucket', 'points_bucket']
    when 'run_sync_outcome' then array['outcome', 'latency_bucket', 'reason']
    when 'league_joined' then array['source']
    when 'league_week_participated' then '{}'::text[]
    when 'share_sheet_opened' then array['format']
    when 'deletion_requested' then '{}'::text[]
    when 'sync_retry' then array['reason', 'attempt_bucket']
    when 'outbox_backlog' then array['size_bucket', 'age_bucket']
    when 'recorder_interrupted' then array['reason']
    when 'app_error' then array['code', 'area']
    else null
  end
$$;

create or replace function public.log_events(p_events jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_event jsonb;
  v_allowed text[];
  v_props jsonb;
  v_key text;
  v_value jsonb;
  v_occurred timestamptz;
  v_accepted integer := 0;
  v_dropped integer := 0;
begin
  perform private.check_rate_limit('events:' || v_uid, 60, interval '1 minute');
  if jsonb_typeof(p_events) is distinct from 'array' or jsonb_array_length(p_events) > 50 then
    perform private.fail('invalid_input', 'events');
  end if;
  for v_event in select e from jsonb_array_elements(p_events) e loop
    v_allowed := private.event_allowed_props(v_event ->> 'name');
    if v_allowed is null
       or coalesce(v_event ->> 'event_id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or coalesce(v_event ->> 'environment', '') not in ('development', 'staging', 'production', 'test')
       or jsonb_typeof(v_event -> 'occurred_at_ms') is distinct from 'number' then
      v_dropped := v_dropped + 1;
      continue;
    end if;
    v_occurred := private.ms_to_ts((v_event ->> 'occurred_at_ms')::numeric::bigint);
    if v_occurred < now() - interval '7 days' or v_occurred > now() + interval '1 day' then
      v_dropped := v_dropped + 1;
      continue;
    end if;
    v_props := '{}'::jsonb;
    for v_key, v_value in select key, value from jsonb_each(coalesce(v_event -> 'props', '{}'::jsonb)) loop
      if v_key = any (v_allowed)
         and (jsonb_typeof(v_value) = 'boolean'
              or (jsonb_typeof(v_value) = 'string' and v_value #>> '{}' ~ '^[a-z0-9_]{1,32}$')) then
        v_props := v_props || jsonb_build_object(v_key, v_value);
      end if;
    end loop;
    insert into private.operational_events (event_id, schema_version, environment, name, occurred_at, subject, props)
    values ((v_event ->> 'event_id')::uuid, 1, v_event ->> 'environment', v_event ->> 'name', v_occurred,
            private.subject_ref(v_uid), v_props)
    on conflict (event_id) do nothing;
    v_accepted := v_accepted + 1;
  end loop;
  return jsonb_build_object('accepted', v_accepted, 'dropped', v_dropped);
end
$$;

-- ---------------------------------------------------------------------------------------
-- Operator controls (run from the SQL console by a named operator; always audited)
-- ---------------------------------------------------------------------------------------
create or replace function private.set_flag(p_key text, p_enabled boolean, p_reason text, p_actor text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if coalesce(char_length(btrim(p_reason)), 0) < 3 or coalesce(char_length(btrim(p_actor)), 0) < 2 then
    perform private.fail('invalid_input', 'reason and actor are required');
  end if;
  update private.app_flags set enabled = p_enabled, reason = p_reason, updated_at = now() where key = p_key;
  if not found then
    perform private.fail('not_found', p_key);
  end if;
  insert into private.audit_log (actor, action, target, reason)
  values (p_actor, case when p_enabled then 'flag_enabled' else 'flag_disabled' end, p_key, p_reason);
  if p_key = 'competition_enabled' and p_enabled then
    perform private.apply_pending_scoring();
  end if;
end
$$;

-- A documented human decision on a run held for review (speed anomaly or late upload).
create or replace function private.resolve_run_review(p_run_id uuid, p_decision text, p_reason text, p_actor text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_run public.runs;
begin
  if p_decision not in ('accept', 'keep_personal') or coalesce(char_length(btrim(p_reason)), 0) < 3
     or coalesce(char_length(btrim(p_actor)), 0) < 2 then
    perform private.fail('invalid_input');
  end if;
  select * into v_run from public.runs where id = p_run_id for update;
  if not found or v_run.deleted_at is not null or v_run.status <> 'review' then
    perform private.fail('not_found');
  end if;
  if p_decision = 'accept' then
    update public.runs set status = 'accepted', scoring_state = 'pending', reason_codes = '{}',
                           version = version + 1, updated_at = now()
    where id = p_run_id;
    if private.flag_enabled('competition_enabled') then
      perform private.apply_run_scoring(p_run_id);
    end if;
  else
    update public.runs set status = 'personal_only', version = version + 1, updated_at = now() where id = p_run_id;
  end if;
  insert into private.audit_log (actor, action, target, reason)
  values (p_actor, 'run_review_' || p_decision, p_run_id::text, p_reason);
  select * into v_run from public.runs where id = p_run_id;
  return private.run_json(v_run);
end
$$;

create or replace function private.grant_staff_role(p_user uuid, p_role text, p_reason text, p_actor text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if coalesce(char_length(btrim(p_reason)), 0) < 3 or coalesce(char_length(btrim(p_actor)), 0) < 2 then
    perform private.fail('invalid_input');
  end if;
  insert into private.staff_roles (user_id, role, granted_reason) values (p_user, p_role, p_reason)
  on conflict (user_id) do update set role = excluded.role, granted_reason = excluded.granted_reason, granted_at = now();
  insert into private.audit_log (actor, action, target, reason) values (p_actor, 'staff_role_' || p_role, p_user::text, p_reason);
end
$$;

select private.apply_function_grants();
