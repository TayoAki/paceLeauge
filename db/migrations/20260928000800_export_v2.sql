-- Export format 2 (docs/ROADMAP.md, "Phase 1 is done when … the new features are in the data
-- export"). Adds everything Phase 1 stores about the runner: the age check, shoes, record efforts,
-- badges, streak weeks, cheers given and received (counts only, no other runner's identity) and
-- what each edited run looked like before it was edited. Runs already carry notes, shoe, activity
-- type and edit time through private.run_json.

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
    'format_version', 2,
    'generated_at_ms', private.ts_to_ms(now()),
    'account', jsonb_build_object('email', v_email, 'alias', v_profile.alias, 'units', v_profile.units,
      'goal_days', v_profile.goal_days, 'notification_tz', v_profile.notification_tz,
      'created_at_ms', private.ts_to_ms(v_profile.created_at),
      'eligibility_ack_at_ms', private.ts_to_ms(v_profile.eligibility_ack_at),
      'age_signal', v_profile.age_signal, 'age_signal_source', v_profile.age_signal_source,
      'age_checked_at_ms', case when v_profile.age_checked_at is null then null else private.ts_to_ms(v_profile.age_checked_at) end),
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
    'blocked_count', (select count(*) from public.blocks where blocker_id = v_uid),
    'shoes', coalesce((select jsonb_agg(private.shoe_json(s) order by s.created_at)
                       from private.shoes s where s.owner_id = v_uid), '[]'::jsonb),
    'efforts', coalesce((select jsonb_agg(jsonb_build_object('run_id', e.run_id, 'effort', e.effort,
                                            'elapsed_ms', e.elapsed_ms, 'started_at_ms', private.ts_to_ms(e.started_at))
                                          order by r.started_at, r.id, c.sort)
                         from private.run_efforts e
                         join public.runs r on r.id = e.run_id and r.deleted_at is null
                         join private.effort_catalog() c on c.effort = e.effort
                         where e.owner_id = v_uid), '[]'::jsonb),
    'badges', coalesce((select jsonb_agg(jsonb_build_object('badge', b.badge, 'earned_at_ms', private.ts_to_ms(b.earned_at))
                                         order by b.earned_at, b.badge)
                        from private.user_badges b where b.user_id = v_uid), '[]'::jsonb),
    'streak_weeks', coalesce((select jsonb_agg(jsonb_build_object('week_start', w.week_start, 'goal_days', w.goal_days,
                                                'active_days', w.active_days, 'met', w.met, 'frozen', w.frozen)
                                              order by w.week_start)
                              from private.streak_weeks w where w.user_id = v_uid), '[]'::jsonb),
    'cheers', jsonb_build_object(
      'given', coalesce((select jsonb_agg(jsonb_build_object('week_start', g.week_start, 'count', g.n) order by g.week_start)
                         from (select c.week_start, count(*) as n from private.cheers c
                               where c.from_user = v_uid group by c.week_start) g), '[]'::jsonb),
      'received', coalesce((select jsonb_agg(jsonb_build_object('week_start', g.week_start, 'count', g.n) order by g.week_start)
                            from (select c.week_start, count(*) as n from private.cheers c
                                  where c.to_user = v_uid group by c.week_start) g), '[]'::jsonb)),
    'run_edits', coalesce((select jsonb_agg(jsonb_build_object(
                                    'run_id', o.run_id,
                                    'original_started_at_ms', private.ts_to_ms(o.started_at),
                                    'original_ended_at_ms', private.ts_to_ms(o.ended_at),
                                    'original_activity_type', o.activity_type,
                                    'original_status', o.status,
                                    'original_point_count', o.point_count,
                                    'original_segments', o.segments,
                                    'first_edited_at_ms', private.ts_to_ms(o.saved_at))
                                  order by o.saved_at)
                           from private.run_originals o
                           join public.runs r on r.id = o.run_id and r.deleted_at is null
                           where o.owner_id = v_uid), '[]'::jsonb)
  );
end
$$;

select private.apply_function_grants();
