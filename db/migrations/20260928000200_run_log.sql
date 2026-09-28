-- Run log extras (docs/ROADMAP.md 1.10): an activity type per run, private notes, shoes with
-- mileage and a replacement reminder, and a date-range query for the calendar view.
-- Only runs earn league XP; walks (and, from Phase 2, other imported workouts) are history.

alter table public.runs
  add column activity_type text not null default 'run'
    check (activity_type in ('run', 'walk', 'hike', 'ride', 'other')),
  add column notes text check (notes is null or char_length(notes) between 1 and 1000),
  add column shoe_id uuid,
  add column edited_at timestamptz;

create table private.shoes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  -- Remind the runner when the shoe reaches this distance.
  limit_km integer check (limit_km is null or limit_km between 50 and 5000),
  is_default boolean not null default false,
  retired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index shoes_owner_idx on private.shoes (owner_id);
create unique index shoes_one_default_idx on private.shoes (owner_id) where is_default and retired_at is null;

alter table public.runs
  add constraint runs_shoe_fk foreign key (shoe_id) references private.shoes (id) on delete set null;
create index runs_shoe_idx on public.runs (shoe_id) where shoe_id is not null;

-- New runs get the runner's default shoe.
create or replace function private.runs_default_shoe()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.shoe_id is null and new.activity_type = 'run' then
    select id into new.shoe_id from private.shoes
    where owner_id = new.owner_id and is_default and retired_at is null;
  end if;
  return new;
end
$$;

create trigger runs_default_shoe before insert on public.runs
  for each row execute function private.runs_default_shoe();

create or replace function private.run_json(r public.runs)
returns jsonb
language sql stable
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
    'edited_at_ms', case when r.edited_at is null then null else private.ts_to_ms(r.edited_at) end
  )
$$;

-- Distance of a shoe's non-deleted, saved runs.
create or replace function private.shoe_json(s private.shoes)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'id', s.id,
    'name', s.name,
    'limit_km', s.limit_km,
    'is_default', s.is_default,
    'retired', s.retired_at is not null,
    'created_at_ms', private.ts_to_ms(s.created_at),
    'runs', (select count(*) from public.runs r
             where r.shoe_id = s.id and r.deleted_at is null and r.status <> 'uploading'),
    'distance_m', coalesce((select sum(coalesce(r.distance_cm / 100.0, r.client_distance_m::numeric))
                            from public.runs r
                            where r.shoe_id = s.id and r.deleted_at is null and r.status <> 'uploading'), 0)
  )
$$;

create or replace function public.list_shoes()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
begin
  return coalesce((select jsonb_agg(private.shoe_json(s) order by s.retired_at nulls first, s.is_default desc, s.created_at)
                   from private.shoes s where s.owner_id = v_uid), '[]'::jsonb);
end
$$;

create or replace function public.save_shoe(
  p_name text,
  p_limit_km integer default null,
  p_is_default boolean default false,
  p_shoe_id uuid default null
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_name text := nullif(btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')), '');
  v_shoe private.shoes;
begin
  if v_name is null or char_length(v_name) > 40 then
    perform private.fail('invalid_input', 'name');
  end if;
  if p_limit_km is not null and p_limit_km not between 50 and 5000 then
    perform private.fail('invalid_input', 'limit_km');
  end if;
  if p_shoe_id is null then
    if (select count(*) from private.shoes where owner_id = v_uid and retired_at is null) >= 20 then
      perform private.fail('too_many_shoes');
    end if;
    insert into private.shoes (owner_id, name, limit_km) values (v_uid, v_name, p_limit_km) returning * into v_shoe;
  else
    update private.shoes set name = v_name, limit_km = p_limit_km, updated_at = now()
    where id = p_shoe_id and owner_id = v_uid returning * into v_shoe;
    if not found then
      perform private.fail('not_found');
    end if;
  end if;
  if coalesce(p_is_default, false) and v_shoe.retired_at is null then
    update private.shoes set is_default = false, updated_at = now() where owner_id = v_uid and is_default and id <> v_shoe.id;
    update private.shoes set is_default = true, updated_at = now() where id = v_shoe.id returning * into v_shoe;
  elsif not coalesce(p_is_default, false) and v_shoe.is_default then
    update private.shoes set is_default = false, updated_at = now() where id = v_shoe.id returning * into v_shoe;
  end if;
  return private.shoe_json(v_shoe);
end
$$;

create or replace function public.retire_shoe(p_shoe_id uuid, p_retired boolean default true)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_shoe private.shoes;
begin
  update private.shoes
     set retired_at = case when coalesce(p_retired, true) then coalesce(retired_at, now()) else null end,
         is_default = case when coalesce(p_retired, true) then false else is_default end,
         updated_at = now()
   where id = p_shoe_id and owner_id = v_uid
  returning * into v_shoe;
  if not found then
    perform private.fail('not_found');
  end if;
  return private.shoe_json(v_shoe);
end
$$;

-- Deleting a shoe keeps the runs; they just lose the link.
create or replace function public.delete_shoe(p_shoe_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
begin
  delete from private.shoes where id = p_shoe_id and owner_id = v_uid;
  if not found then
    perform private.fail('not_found');
  end if;
  return jsonb_build_object('deleted', true);
end
$$;

-- Notes and shoe for one run. Null leaves a field as it is; an empty note clears it, and
-- p_clear_shoe removes the shoe.
create or replace function public.update_run_details(
  p_run_id uuid,
  p_notes text default null,
  p_shoe_id uuid default null,
  p_clear_shoe boolean default false
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_run public.runs;
  v_notes text := case when p_notes is null then null else nullif(btrim(p_notes), '') end;
begin
  select * into v_run from public.runs where id = p_run_id and owner_id = v_uid for update;
  if not found or v_run.deleted_at is not null or v_run.status = 'uploading' then
    perform private.fail('not_found');
  end if;
  if v_notes is not null and char_length(v_notes) > 1000 then
    perform private.fail('invalid_input', 'notes');
  end if;
  if p_shoe_id is not null and not exists (select 1 from private.shoes where id = p_shoe_id and owner_id = v_uid) then
    perform private.fail('not_found', 'shoe');
  end if;
  update public.runs
     set notes = case when p_notes is null then notes else v_notes end,
         shoe_id = case when coalesce(p_clear_shoe, false) then null when p_shoe_id is not null then p_shoe_id else shoe_id end,
         updated_at = now()
   where id = p_run_id
  returning * into v_run;
  return private.run_json(v_run);
end
$$;

-- Runs that started inside a range (calendar months, filters). At most 400 days and 500 runs.
create or replace function public.list_my_runs_between(p_from_ms bigint, p_to_ms bigint, p_activity text default null)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
begin
  if p_from_ms is null or p_to_ms is null or p_to_ms <= p_from_ms or p_to_ms - p_from_ms > 400::bigint * 86400000 then
    perform private.fail('invalid_input', 'range');
  end if;
  if p_activity is not null and p_activity not in ('run', 'walk', 'hike', 'ride', 'other') then
    perform private.fail('invalid_input', 'activity');
  end if;
  return coalesce((
    select jsonb_agg(private.run_json(r) order by r.started_at desc, r.id desc)
    from (select * from public.runs r
          where r.owner_id = v_uid and r.deleted_at is null and r.status <> 'uploading'
            and r.started_at >= private.ms_to_ts(p_from_ms) and r.started_at < private.ms_to_ts(p_to_ms)
            and (p_activity is null or r.activity_type = p_activity)
          order by r.started_at desc, r.id desc
          limit 500) r), '[]'::jsonb);
end
$$;

select private.apply_function_grants();
