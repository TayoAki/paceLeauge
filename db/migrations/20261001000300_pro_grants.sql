-- Staff grants of Pro (admin CLI) never touch a store subscription that's still running: a grant
-- would otherwise replace it until the store's next event, and ending a grant would end a paid
-- subscription. Grants apply to accounts without Pro from the store, and ending one ends only a
-- grant.
create or replace function private.grant_pro(p_user uuid, p_until timestamptz)
returns void
language sql security definer set search_path = ''
as $$
  insert into private.entitlements as e (user_id, active, expires_at, period_type, source, updated_at)
  values (p_user, true, p_until, 'promotional', 'grant', now())
  on conflict (user_id) do update
    set active = true, expires_at = p_until, period_type = 'promotional', source = 'grant', updated_at = now()
    where e.source = 'grant' or not e.active or (e.expires_at is not null and e.expires_at <= now())
$$;

select private.apply_function_grants();
