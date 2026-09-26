# Operations

How to stand up, run and support the PaceLeague backend. Everything operational is a
PostgreSQL function in the `private` schema: API roles cannot call them, only the database owner
(Supabase SQL editor, `psql` with the connection string, or a scheduler).

## Environments

| Environment | Supabase project | App profile (`eas.json`) | Notes |
|---|---|---|---|
| Local | `npm run dev:backend` (emulated Auth + RPC over local Postgres) | web preview / simulator | Fixed sign-in code, public JWT secret — never deploy |
| Staging | Separate project | `development`, `pilot` | Device protocol, load checks, pilot rehearsal; `competition_enabled` on |
| Production | Separate project | `production` | Only after the STATUS.md gates pass |

Keep projects fully separate (keys, auth users, storage). Telemetry events carry the environment,
and staff/test accounts are excluded from pilot metrics.

## Standing up a project

```bash
npx supabase login
npx supabase link --project-ref <ref>
npx supabase db push                 # applies supabase/migrations in order
```

Then, in the dashboard (or `supabase/config.toml` for local stacks):

1. **Auth → Email**: one-time codes (6 digits, 10 minutes). Use the template in
   `supabase/templates/sign-in-code.html` for the magic-link/OTP email so it shows the code, not a
   link. Configure a real SMTP sender before inviting anyone.
2. **Auth → Apple**: Services ID and secret (`SUPABASE_AUTH_EXTERNAL_APPLE_CLIENT_ID` /
   `_SECRET` locally). The app uses native Sign in with Apple with a hashed nonce, so add the app's
   bundle identifier to the client IDs.
3. **Extensions**: `pg_cron` must be enabled; migration `…000600_maintenance.sql` schedules the
   jobs below when it is available and otherwise leaves a notice.
4. **API**: expose only the `public` schema (the default). Nothing else is needed — there are no
   Edge Functions or Storage buckets.
5. **App configuration**: put the project URL and **anon** key in the EAS environment
   (`EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`), plus `EXPO_PUBLIC_SUPPORT_EMAIL`,
   `EXPO_PUBLIC_TERMS_URL` and `EXPO_PUBLIC_PRIVACY_URL`. The service-role key is never needed by
   the app; `npm run check:secrets` fails CI if one appears.
6. Run the integration suite against the new database before any device testing:
   `PG_TEST_URL=<admin connection string to a scratch database> npm run test:db`.

## Flags

Stored in `private.app_flags`; every change needs a reason and an actor and is audited.

```sql
select private.set_flag('competition_enabled', true, 'EV-005/EV-006 passed on staging', 'ops:alex');
select private.set_flag('invites_enabled', false, 'Invite abuse incident #12', 'ops:alex');
select private.set_flag('registration_enabled', false, 'Pilot cohort full', 'ops:alex');
```

| Flag | Default | Effect when off |
|---|---|---|
| `competition_enabled` | **off** | Runs are still recorded, uploaded, validated and kept; XP and standings are deferred (`scoring_state = 'pending'`). Turning it on applies pending scoring immediately. |
| `invites_enabled` | on | New invites and joins are refused; existing leagues keep working. |
| `registration_enabled` | on | New runners can't complete onboarding; existing runners are unaffected. |

## Scheduled jobs

| Job | Schedule | Does |
|---|---|---|
| `private.run_frequent_jobs()` | every minute (`paceleague-frequent`) | Processes account-deletion jobs (retrying with backoff, `failed` after 8 attempts) and applies pending scoring |
| `private.purge_expired()` | hourly at :17 (`paceleague-retention`) | Removes uploads never finalized after 7 days (the phone keeps its copy), expired exports, operational events after 14 days, rate-limit windows after 2 days, resolved reports after 90 days, dead invites after 30 days and completed deletion records after 30 days |

Without `pg_cron`, call both from any scheduler with the owner connection.

## Monitoring

`select private.health_report();` returns the alert surface:

| Field | Alert when | Response |
|---|---|---|
| `failed_deletion_jobs` | > 0 | Inspect `private.deletion_jobs.last_error`, fix, then reset `state = 'retrying'`; deletion must complete within 7 days (NFR-010) |
| `overdue_deletion_jobs` | > 0 | Same, urgently |
| `stale_staged_uploads` | growing for > 1 hour | Check client error reports and RPC error rates; uploads resume automatically |
| `pending_scoring` | > 0 while `competition_enabled` | Scoring job stalled — run `select private.run_frequent_jobs();` and check logs |
| `runs_in_review` | any, older than 48 h | Review (below) |
| `open_reports` / `oldest_open_report_hours` | any older than 24 h | Moderation (below) |

Wire this to your alerting before the pilot (EV-015). Recording and history never depend on
analytics or these jobs.

## Staff roles and moderation

```sql
select private.grant_staff_role('<user uuid>', 'moderator', 'Pilot moderation rota', 'ops:alex');
```

A moderator signs in to the app normally; the staff RPCs (`mod_list_reports`,
`mod_resolve_report`) are then available to their session — for example from a small internal
tool or the Supabase SQL editor using `set request.jwt.claims`. Actions: `dismiss`,
`reset_alias`, `rename_league`, `remove_from_league`. Reports keep a snapshot of the reported name, and every
action records the moderator, reason and target in `private.moderation_actions`.

Before launch (REQ-011): publish a real reviewer/support contact (`EXPO_PUBLIC_SUPPORT_EMAIL`),
name a moderation rota, and set a response target.

## Runs held for review

Runs with implausible speed or first received more than 72 hours after they ended are held with
status `review` and earn nothing until decided:

```sql
select private.resolve_run_review('<run uuid>', 'accept', 'Verified with runner: GPS glitch in tunnel', 'mod:sam');
select private.resolve_run_review('<run uuid>', 'keep_personal', 'Cycling segment', 'mod:sam');
```

`accept` queues the run for scoring (it then counts like any accepted run); `keep_personal`
keeps it as personal history.

## Data lifecycle

- Account deletion hides the runner at once, transfers league ownership to the longest-standing
  member (or closes a solo league), then removes all owned records and finally the auth user.
- Exports expire and are purged automatically.
- Set the provider's backup / point-in-time-recovery retention to ≤ 30 days before promising it
  (NFR-010), and document restores: a restored backup must re-run pending deletion jobs.
- Logs and telemetry never contain routes, coordinates, emails or free text.

## Incident playbook

| Situation | First action |
|---|---|
| Scoring bug or suspicious standings | `competition_enabled` off (recording continues), fix, redeploy the function, turn back on — pending runs are rescored |
| Invite spam or abusive league names | `invites_enabled` off; moderate reports; rotate affected invites |
| Sign-up abuse | `registration_enabled` off |
| Bad app release | Roll back JavaScript only with a tested compatible runtime; native changes need a new build |
| Suspected data exposure | Revoke keys, rotate the JWT secret, review `private.audit_log`, follow the privacy notice's breach process |

Migrations must stay backward compatible with the previous app build; never edit an applied
migration — add a new one.
