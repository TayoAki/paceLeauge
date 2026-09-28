-- Pro subscription (docs/ROADMAP.md 3.6, decision 4). The App Store sells Pro through RevenueCat;
-- RevenueCat tells the API service about each purchase, renewal, cancellation, refund and expiry
-- (server/src/revenuecat.ts), and the service keeps the runner's entitlement here. The app reads
-- it with get_entitlements. Nothing that changes XP or rank, no safety feature, and neither data
-- export nor account deletion ever depends on it.

-- ---------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------
create table private.entitlements (
  user_id uuid primary key references auth.users (id) on delete cascade,
  active boolean not null default false,
  -- Null only for a grant without an end.
  expires_at timestamptz,
  period_type text check (period_type in ('trial', 'intro', 'normal', 'promotional')),
  product_id text check (char_length(product_id) <= 100),
  store text check (char_length(store) <= 40),
  environment text check (environment in ('sandbox', 'production')),
  will_renew boolean not null default false,
  billing_issue boolean not null default false,
  -- revenuecat: from the store · grant: given by staff (support, testers)
  source text not null default 'revenuecat' check (source in ('revenuecat', 'grant')),
  -- The newest store event applied; older events arriving late change nothing.
  last_event_at timestamptz,
  trial_reminded_at timestamptz,
  updated_at timestamptz not null default now()
);
create index entitlements_trial_idx on private.entitlements (expires_at) where period_type = 'trial' and trial_reminded_at is null;

-- Store events already handled (RevenueCat retries until it hears 200), kept for 60 days.
create table private.billing_events (
  event_id text primary key check (char_length(event_id) <= 100),
  user_id uuid,
  type text not null check (char_length(type) <= 60),
  received_at timestamptz not null default now()
);
create index billing_events_received_idx on private.billing_events (received_at);
create index billing_events_user_idx on private.billing_events (user_id);

-- ---------------------------------------------------------------------------------------
-- Service functions (the API service only)
-- ---------------------------------------------------------------------------------------

-- Records a store event once; false when it was seen before.
create or replace function private.billing_event_seen(p_event_id text, p_user uuid, p_type text)
returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  insert into private.billing_events (event_id, user_id, type) values (p_event_id, p_user, left(p_type, 60));
  return false;
exception when unique_violation then
  return true;
end
$$;

-- Sets the runner's entitlement from the store's state at p_event_at. A state older than the one
-- already applied is ignored, so events arriving out of order can't undo a newer purchase.
create or replace function private.apply_entitlement(p_user uuid, p_state jsonb, p_event_at timestamptz)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_period text := p_state ->> 'period_type';
  v_env text := p_state ->> 'environment';
begin
  if not exists (select 1 from auth.users where id = p_user) then
    return false;
  end if;
  if v_period is not null and v_period not in ('trial', 'intro', 'normal', 'promotional') then
    v_period := 'normal';
  end if;
  if v_env is not null and v_env not in ('sandbox', 'production') then
    v_env := null;
  end if;
  insert into private.entitlements as e (user_id, active, expires_at, period_type, product_id, store, environment, will_renew,
                                         billing_issue, source, last_event_at, updated_at)
  values (p_user, coalesce((p_state ->> 'active')::boolean, false), (p_state ->> 'expires_at')::timestamptz, v_period,
          left(p_state ->> 'product_id', 100), left(p_state ->> 'store', 40), v_env,
          coalesce((p_state ->> 'will_renew')::boolean, false), coalesce((p_state ->> 'billing_issue')::boolean, false),
          'revenuecat', p_event_at, now())
  on conflict (user_id) do update
    set active = excluded.active, expires_at = excluded.expires_at, period_type = excluded.period_type,
        product_id = excluded.product_id, store = excluded.store, environment = excluded.environment,
        will_renew = excluded.will_renew, billing_issue = excluded.billing_issue, source = 'revenuecat',
        last_event_at = excluded.last_event_at, updated_at = now(),
        -- A new trial gets its own reminder.
        trial_reminded_at = case when excluded.period_type = 'trial' and e.expires_at is distinct from excluded.expires_at
                                 then null else e.trial_reminded_at end
    where e.last_event_at is null or e.last_event_at <= excluded.last_event_at;
  return true;
end
$$;

-- Staff grant Pro, for support or testers (admin CLI).
create or replace function private.grant_pro(p_user uuid, p_until timestamptz)
returns void
language sql security definer set search_path = ''
as $$
  insert into private.entitlements (user_id, active, expires_at, period_type, source, updated_at)
  values (p_user, true, p_until, 'promotional', 'grant', now())
  on conflict (user_id) do update
    set active = true, expires_at = p_until, period_type = 'promotional', source = 'grant', updated_at = now()
$$;

-- Trials ending in the next 48 hours without a reminder yet (decision 4: a reminder two days
-- before the trial converts, with a cancel link).
-- Store sandbox trials last minutes, so only real ones are reminded.
create or replace function private.trial_reminders_due()
returns table (user_id uuid, email text, expires_at timestamptz, store text, time_zone text)
language sql stable security definer set search_path = ''
as $$
  select e.user_id, u.email, e.expires_at, e.store, p.notification_tz
  from private.entitlements e
  join auth.users u on u.id = e.user_id
  left join public.profiles p on p.user_id = e.user_id
  where e.period_type = 'trial' and e.active and e.will_renew and e.trial_reminded_at is null
    and coalesce(e.environment, 'production') = 'production'
    and e.expires_at > now() and e.expires_at <= now() + interval '48 hours'
    and u.email is not null
  order by e.expires_at
  limit 200
$$;

create or replace function private.mark_trial_reminded(p_user uuid)
returns void
language sql security definer set search_path = ''
as $$
  update private.entitlements set trial_reminded_at = now() where user_id = p_user
$$;

create or replace function private.purge_billing_events()
returns integer
language sql security definer set search_path = ''
as $$
  with gone as (delete from private.billing_events where received_at < now() - interval '60 days' returning 1)
  select count(*)::integer from gone
$$;

-- ---------------------------------------------------------------------------------------
-- RPC
-- ---------------------------------------------------------------------------------------
create or replace function private.entitlements_json(p_user uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'pro', coalesce(e.active and (e.expires_at is null or e.expires_at > now()), false),
    'period', e.period_type,
    'source', e.source,
    'store', e.store,
    'expires_at_ms', case when e.expires_at is null then null else private.ts_to_ms(e.expires_at) end,
    'will_renew', coalesce(e.will_renew, false),
    'billing_issue', coalesce(e.billing_issue, false))
  from (select 1) one
  left join private.entitlements e on e.user_id = p_user
$$;

create or replace function public.get_entitlements()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select private.entitlements_json(private.require_user())
$$;

-- ---------------------------------------------------------------------------------------
-- Deletion and export. Entitlements cascade from auth.users; store events keep no account link.
-- Deleting an account never waits on a subscription (REQ-010): the store keeps billing until
-- the runner cancels there, which the app says before deletion.
-- ---------------------------------------------------------------------------------------
create or replace function private.purge_user_data(p_user uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  insert into private.strava_revocations (refresh_token_enc, access_token_enc)
  select c.refresh_token_enc, c.access_token_enc from private.strava_connections c where c.user_id = p_user;
  insert into private.aggregator_revocations (aggregator, aggregator_user_id)
  select l.aggregator, l.aggregator_user_id from private.aggregator_links l where l.user_id = p_user;
  delete from private.aggregator_inbox i
  where exists (select 1 from private.aggregator_links l
                where l.user_id = p_user and l.aggregator = i.aggregator and l.aggregator_user_id = i.aggregator_user_id);
  update private.billing_events set user_id = null where user_id = p_user;
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
    'subscription', private.entitlements_json(p_uid)
  );
end
$$;

select private.apply_function_grants();
