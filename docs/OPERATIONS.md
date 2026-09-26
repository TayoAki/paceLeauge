# Operations

How to deploy, run and support the PaceLeague backend on Railway. The backend is one Railway
project, `paceleague`, with two services per environment:

| Service | What it is |
|---|---|
| `api` | The PaceLeague API (`server/`), built from `server/Dockerfile`: email sign-in codes, Sign in with Apple, sessions, and the RPC endpoint the app calls. It also runs the scheduled jobs. |
| `Postgres` | Railway's PostgreSQL 18 template with a 50 GB volume, reachable only on the private network (no public TCP proxy). Every rule — validation, scoring, leagues, access control — lives here. |

Everything operational is a PostgreSQL function in the `private` schema. The app's roles cannot
call them; run them as the database owner through `railway connect` (below).

## Environments

| Environment | Where | App profile (`eas.json`) | Notes |
|---|---|---|---|
| Local | `npm run dev:backend` (the same `server/` code in development mode, over a local Postgres) | web preview / simulator | Fixed code `123456` for every address, codes also printed in the terminal — never deploy |
| Staging | Railway environment `staging` — `https://api-staging-753f.up.railway.app` | `development`, `pilot` | Device protocol, load checks, pilot rehearsal; `competition_enabled` on; sign-in codes go to the service logs until an email key is added |
| Production | Railway environment `production` (not created yet — see below) | `production` | Only after the STATUS.md gates pass |

Each environment has its own database, keys and accounts; nothing is shared. Telemetry events
carry the environment, and staff/test accounts are excluded from pilot metrics.

## How a deploy works

1. A push to the branch the `api` service follows (staging: `claude/eager-johnson-glz1cu` —
   switch it to `main` in *api → Settings → Source* once merged) starts a build. Only changes
   under `server/`, `db/platform/`, `db/migrations/` or `db/templates/` redeploy; app-only commits
   don't.
2. Railway builds `server/Dockerfile` (Node 22, bundled with esbuild, runs as the `node` user).
3. **Pre-deploy** runs `node dist/migrate.js`: it applies new files from `db/platform/` and
   `db/migrations/` in order, each in its own transaction, under an advisory lock, and records a
   checksum for each in `platform.schema_migrations`. If an applied file was edited it refuses,
   the deploy fails, and the previous version keeps serving. On staging it also runs the one-time
   bootstrap that turns competition on (`BOOTSTRAP_ENABLE_COMPETITION`).
4. The new container must answer `GET /health` within 120 s before traffic moves to it. It
   restarts on failure (up to 5 times).

Turn on **Wait for CI** (*api → Settings → Source*) so a commit deploys only after its GitHub
Actions checks pass. To roll back, use *api → Deployments → ⋯ → Rollback*; migrations are
forward-only, so the older code runs against the newer schema — which is why every migration must
stay compatible with the previous app build **and** the previous API build. Never edit an applied
migration; add a new one.

## Variables (`api` service)

| Variable | Staging | Production | Notes |
|---|---|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | same | Private-network URL; `DATABASE_SSL` stays `disable` there |
| `APP_ENV` | `staging` | `production` | Production refuses unsafe settings at boot (below) |
| `PUBLIC_API_KEY` | random, ≥ 16 characters | a different random value | Identifies the app; **public by design** (it ships in the app as `EXPO_PUBLIC_API_KEY`). Changing it needs an app update |
| `EMAIL_PROVIDER` | `log` for now | `resend` or `postmark` (required) | `log` writes each code to the private deploy logs |
| `EMAIL_API_KEY` | — | provider key | Secret: set it only in Railway, as a sealed variable |
| `EMAIL_FROM` | — | e.g. `PaceLeague <codes@your-domain>` | Must be on a domain verified with the provider |
| `EMAIL_REPLY_TO` | optional | support address | |
| `APPLE_AUDIENCES` | `com.example.paceleague.dev` (placeholder) | production bundle id | Comma-separated iOS bundle identifiers; **replace the placeholder** with the real ones |
| `CORS_ORIGINS` | `*` | unset | Only the web preview needs CORS; the iPhone app doesn't |
| `BOOTSTRAP_ENABLE_COMPETITION` | `true` | unset | Applied once per database; refused in production |
| `PORT` | `8080` | `8080` | The public domain targets this port |

Optional: `JWT_SECRET` (≥ 32 characters; otherwise one is generated on first boot and kept in
`platform.settings`), `ACCESS_TOKEN_TTL_SECONDS` (3600), `REFRESH_TOKEN_TTL_DAYS` (60),
`CODE_TTL_SECONDS` (600), `CODE_MAX_ATTEMPTS` (5), `CODE_RESEND_COOLDOWN_SECONDS` (60),
`CODE_MAX_PER_EMAIL_PER_HOUR` (5), `REVIEW_ACCOUNT_EMAIL` + `REVIEW_ACCOUNT_CODE` (one address
with a fixed code, for App Review), `DATABASE_POOL_MAX` (10), `RUN_JOBS` (true), `TRUST_PROXY`
(on automatically on Railway).

The service will not start in production with log-only email, a development sign-in code, the
competition bootstrap, a short `JWT_SECRET`, a missing `PUBLIC_API_KEY`, or only half of the
review account — the deploy fails instead.

## Email delivery

Railway blocks outbound SMTP below the Pro plan, so codes are sent through an email API over
HTTPS. With Resend:

1. Create a Resend account, add your sending domain and create the DNS records it shows.
2. Create an API key with sending access only.
3. In Railway → `api` → *Variables* (per environment): `EMAIL_PROVIDER=resend`,
   `EMAIL_API_KEY=<key>` (sealed), `EMAIL_FROM=PaceLeague <codes@your-domain>`, and optionally
   `EMAIL_REPLY_TO`. Deploy the staged change.
4. Sign in with a real inbox, or run the smoke test with `SMOKE_EMAILS` (below).

Postmark works the same way with `EMAIL_PROVIDER=postmark` and a server API token (messages use
the `outbound` stream). The email shows the code from `db/templates/sign-in-code.html`; codes
are 6 digits, valid 10 minutes, single use, 5 guesses, one resend per minute and 5 per hour per
address. Provider errors are logged without the provider's response body.

## Sign in with Apple

Native Sign in with Apple needs no client secret: the API checks Apple's identity token against
Apple's published keys (issuer, audience, expiry and the hashed nonce). Set `APPLE_AUDIENCES` to
the app's bundle identifier(s) and enable the capability for that App ID. An Apple sign-in joins
an existing account only when Apple has verified the same email address.

## Database access

```bash
npm i -g @railway/cli && railway login
railway link                               # project paceleague, environment staging
railway connect Postgres                   # psql over an SSH tunnel (the database has no public proxy)
```

Keep production's database off the public internet: don't add a TCP proxy to it.

## Smoke test

After a deploy, check the API end to end over HTTPS with the app's own client:

```bash
export SMOKE_API_URL=https://api-staging-753f.up.railway.app SMOKE_API_KEY=<staging PUBLIC_API_KEY>
npm run smoke:api -- send            # asks for codes for two throwaway @example.com accounts
npm run smoke:api -- verify <codeA> <codeB>
```

With `EMAIL_PROVIDER=log`, the codes are in *api → Deployments → Logs* (search `sign-in code`;
they appear in the order the addresses were printed). With real email, set
`SMOKE_EMAILS=a@…,b@…` to two inboxes you can read. The run checks health and HSTS, refusal of a
wrong key and a forged token, sign-in, profile save, a full run upload (+77 XP), that neither
account can read the other's run, that private functions are hidden, refresh rotation and logout,
then requests deletion of both accounts; the job loop logs `frequent jobs` with
`deletions_completed` within a minute.

## Flags

Stored in `private.app_flags`; every change needs a reason and an actor and is audited.

```sql
select private.set_flag('competition_enabled', true, 'EV-005/EV-006 passed on staging', 'ops:alex');
select private.set_flag('invites_enabled', false, 'Invite abuse incident #12', 'ops:alex');
select private.set_flag('registration_enabled', false, 'Pilot cohort full', 'ops:alex');
```

| Flag | Default | Effect when off |
|---|---|---|
| `competition_enabled` | **off** (staging: turned on once by the bootstrap) | Runs are still recorded, uploaded, validated and kept; XP and standings are deferred (`scoring_state = 'pending'`). Turning it on applies pending scoring immediately. |
| `invites_enabled` | on | New invites and joins are refused; existing leagues keep working. |
| `registration_enabled` | on | New runners can't complete onboarding; existing runners are unaffected. |

The bootstrap never runs twice, so a flag you change is never overridden by a later deploy.

## Scheduled jobs

Railway's Postgres has no `pg_cron`, so the `api` service runs the jobs itself. Each takes a
PostgreSQL advisory lock first, so only one instance runs a job at a time however many replicas
there are (`RUN_JOBS=false` opts an instance out).

| Job | Schedule | Does |
|---|---|---|
| `private.run_frequent_jobs()` | every minute | Processes account-deletion jobs (retrying with backoff, `failed` after 8 attempts) and applies pending scoring. Logs `frequent jobs` when it did something |
| `private.purge_expired()` + sign-in cleanup | hourly, and 5 s after each start | Removes uploads never finalized after 7 days (the phone keeps its copy), expired exports, operational events after 14 days, rate-limit windows after 2 days, resolved reports after 90 days, dead invites after 30 days, completed deletion records after 30 days, expired sign-in codes, and revoked sessions after 30 days. Logs `hourly retention` |

A failure logs `job failed` with the job name, and the job runs again on its next tick.

## Monitoring

`select private.health_report();` returns the alert surface:

| Field | Alert when | Response |
|---|---|---|
| `failed_deletion_jobs` | > 0 | Inspect `private.deletion_jobs.last_error`, fix, then reset `state = 'retrying'`; deletion must complete within 7 days (NFR-010) |
| `overdue_deletion_jobs` | > 0 | Same, urgently |
| `stale_staged_uploads` | growing for > 1 hour | Check client error reports and RPC error rates; uploads resume automatically |
| `pending_scoring` | > 0 while `competition_enabled` | Scoring job stalled — check for `job failed` in the logs, then run `select private.run_frequent_jobs();` |
| `runs_in_review` | any, older than 48 h | Review (below) |
| `open_reports` / `oldest_open_report_hours` | any older than 24 h | Moderation (below) |

The service logs one JSON line per event. Request lines carry the method, route, status and
duration — never emails, tokens, codes (outside `log` mode), bodies or coordinates. Alert on
`level: error` lines, on the HTTP 5xx rate and on failed health checks (Railway's service metrics
and observability tools), and wire `health_report()` into the same place before the pilot
(EV-015). Recording and history never depend on analytics or these jobs.

## Staff roles and moderation

```sql
select private.grant_staff_role('<user uuid>', 'moderator', 'Pilot moderation rota', 'ops:alex');
```

A moderator signs in to the app normally; the staff RPCs (`mod_list_reports`,
`mod_resolve_report`) are then available to their own session — for example from a small internal
tool that calls the API with that session. Actions: `dismiss`, `reset_alias`, `rename_league`,
`remove_from_league`. Reports keep a snapshot of the reported name, and every action records the
moderator, reason and target in `private.moderation_actions`.

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

## Backups and data lifecycle

- In *Postgres → Backups*, schedule **Daily** (kept 6 days) and **Weekly** (kept 27 days). Don't
  schedule **Monthly** (kept 89 days): deleted accounts would survive in backups longer than the
  30 days NFR-010 allows. If you enable point-in-time recovery, check its window stays within 30
  days too.
- A restore mounts the backup as a new volume and keeps the old one unmounted. Before reopening
  the app, redo every deletion completed after the backup was taken — list them on the old volume
  with `select user_id from private.deletion_jobs where completed_at > '<backup time>'`, then for
  each on the restored database:

  ```sql
  update public.profiles set status = 'deleting', updated_at = now() where user_id = '<uuid>';
  select private.detach_from_league('<uuid>', 'account_deleted');
  delete from public.blocks where blocker_id = '<uuid>' or blocked_id = '<uuid>';
  insert into private.deletion_jobs (user_id) values ('<uuid>');
  ```

  Deletions that were still queued at backup time resume on their own.
- Account deletion hides the runner at once, transfers league ownership to the longest-standing
  member (or closes a solo league), then removes all owned records and finally the auth user.
- Exports expire and are purged automatically.

## Creating production

1. In the `paceleague` project, create an environment `production` by duplicating `staging`. It
   copies the service settings and variables; its Postgres gets a new, empty volume. The changes
   are staged for review.
2. Before deploying, fix `api`'s variables: `APP_ENV=production`, a new `PUBLIC_API_KEY`, email
   delivery (above), the production `APPLE_AUDIENCES`, and remove `CORS_ORIGINS` and
   `BOOTSTRAP_ENABLE_COMPETITION` — the service refuses to start with staging's values.
3. Point the source at `main`, turn on Wait for CI, deploy, and add a custom domain
   (*api → Settings → Networking*).
4. Schedule backups, run the smoke test with real inboxes, and turn competition on with
   `private.set_flag` when the STATUS.md gates allow.
5. Put the URL and key in the EAS `production` environment (`EXPO_PUBLIC_API_URL`,
   `EXPO_PUBLIC_API_KEY`), plus `EXPO_PUBLIC_SUPPORT_EMAIL`, `EXPO_PUBLIC_TERMS_URL` and
   `EXPO_PUBLIC_PRIVACY_URL`. Nothing privileged ever goes into the app; `npm run check:secrets`
   fails CI if it does.

## Incident playbook

| Situation | First action |
|---|---|
| Scoring bug or suspicious standings | `competition_enabled` off (recording continues), fix, deploy a new migration, turn back on — pending runs are rescored |
| Invite spam or abusive league names | `invites_enabled` off; moderate reports; rotate affected invites |
| Sign-up abuse | `registration_enabled` off; the per-address and per-IP code limits apply meanwhile |
| Bad API deploy | Roll back the `api` deployment in Railway (the schema stays; migrations are forward-only) |
| Bad app release | Roll back JavaScript only with a tested compatible runtime; native changes need a new build |
| Suspected token or key exposure | Set a new `JWT_SECRET` and redeploy (every existing access token stops working at once); revoke sessions with `update auth.sessions set revoked_at = now() where revoked_at is null` (refreshing then fails, so everyone signs in again); rotate `EMAIL_API_KEY` at the provider; review `private.audit_log`; follow the privacy notice's breach process |
