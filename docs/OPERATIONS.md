# Operations

How to deploy, run and support the PaceLeague backend on Railway. The backend is one Railway
project, `paceleague`, with two services per environment:

| Service | What it is |
|---|---|
| `api` | The PaceLeague API (`server/`), built from `server/Dockerfile`: email + password sign-in (emailed codes when enabled), Sign in with Apple, sessions, the RPC endpoint the app calls, and the Privacy Policy and Terms pages. It also runs the scheduled jobs. |
| `Postgres` | Railway's PostgreSQL 18 template with a 50 GB volume, reachable only on the private network (no public TCP proxy). Every rule — validation, scoring, leagues, access control — lives here. |

Everything operational is a PostgreSQL function in the `private` schema. The app's roles cannot
call them; run them as the database owner through `railway connect` (below).

## Environments

| Environment | Where | App profile (`eas.json`) | Notes |
|---|---|---|---|
| Local | `npm run dev:backend` (the same `server/` code in development mode, over a local Postgres) | web preview / simulator | Seeded runners use the password `run-with-the-crew`; in code mode every address accepts `123456` — never deploy |
| Staging | Railway environment `staging` — `https://api-staging-753f.up.railway.app` | `pilot` (already pointed here), `development` | Device protocol, load checks, beta; `competition_enabled` on; email + password sign-in |
| Production | Railway environment `production` (not created yet — see below) | `production` | Only after the STATUS.md gates pass |

Each environment has its own database, keys and accounts; nothing is shared. Telemetry events
carry the environment, and staff/test accounts are excluded from pilot metrics.

## How a deploy works

1. A push to the branch the `api` service follows (staging: `claude/eager-johnson-glz1cu` —
   switch it to `main` in *api → Settings → Source* once merged) starts a build. Only changes
   under `server/`, `db/platform/`, `db/migrations/`, `db/templates/` or `legal/` redeploy;
   app-only commits don't.
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
| `EMAIL_PROVIDER` | `log` | `resend` or `postmark` (required) | Only emailed codes use it, and the beta signs in with passwords; `log` writes codes to the private deploy logs |
| `EMAIL_API_KEY` | — | provider key | Secret: set it only in Railway, as a sealed variable |
| `EMAIL_FROM` | — | e.g. `PaceLeague <codes@your-domain>` | Must be on a domain verified with the provider |
| `EMAIL_REPLY_TO` | optional | support address | |
| `APPLE_AUDIENCES` | `com.example.paceleague.dev` (placeholder) | production bundle id | Comma-separated iOS bundle identifiers; **replace the placeholder** with the real ones |
| `CORS_ORIGINS` | `*` | unset | Only the web preview needs CORS; the iPhone app doesn't |
| `BOOTSTRAP_ENABLE_COMPETITION` | `true` | unset | Applied once per database; refused in production |
| `PORT` | `8080` | `8080` | The public domain targets this port |

Optional: `PASSWORD_SIGN_IN` (true; false turns off sign-up, password sign-in and password
changes), `JWT_SECRET` (≥ 32 characters; otherwise one is generated on first boot and kept in
`platform.settings`), `ACCESS_TOKEN_TTL_SECONDS` (3600), `REFRESH_TOKEN_TTL_DAYS` (60),
`CODE_TTL_SECONDS` (600), `CODE_MAX_ATTEMPTS` (5), `CODE_RESEND_COOLDOWN_SECONDS` (60),
`CODE_MAX_PER_EMAIL_PER_HOUR` (5), `REVIEW_ACCOUNT_EMAIL` + `REVIEW_ACCOUNT_CODE` (one address
with a fixed code, for App Review), `DATABASE_POOL_MAX` (10), `RUN_JOBS` (true), `TRUST_PROXY`
(on automatically on Railway).

The service will not start in production with log-only email, a development sign-in code, the
competition bootstrap, a short `JWT_SECRET`, a missing `PUBLIC_API_KEY`, or only half of the
review account — the deploy fails instead.

## Passwords

During the beta, runners create an account with their email address and a password, or use Sign
in with Apple. No email service is involved.

- Passwords are stored only as salted scrypt hashes. They must be 8–128 characters and not
  trivially guessable; sign-up is limited per IP address, and sign-in attempts per address and per
  IP address (ten tries per address every 15 minutes).
- Changing a password (Profile → Privacy → Change password) needs a sign-in in the last 10
  minutes, like export and deletion, and signs the account out on every other device.
- A new account's address is **unverified**: nothing proved the person owns it. If the owner of
  the address later proves it — an emailed code, or Sign in with Apple with the same verified
  email — the account becomes theirs: the unproven password is cleared and its sessions end. So
  registering someone else's address can't lock them out or give access to their data later. (If
  the same person signed up with a password and then uses Apple with that address, they can set a
  new password in Profile.)

**Forgotten password.** There is no reset email yet. Once you've confirmed who is asking (for
example, a message from the address on the account):

```bash
railway link                                  # project paceleague, environment staging
railway ssh --service api                     # a shell in the running API container
node dist/admin.js set-password runner@example.com
```

It prints a temporary password once and signs the account out everywhere. Send it to the runner
over a channel you trust; they can change it in Profile → Privacy → Change password.

## Privacy Policy and Terms

Drafts live in [`legal/privacy-policy.md`](../legal/privacy-policy.md) and
[`legal/terms.md`](../legal/terms.md), written from what the app actually collects and keeps. The
API serves them at `/legal/privacy` and `/legal/terms`, and the `pilot` build links to the staging
copies. Until every `[placeholder]` is filled in (operator name, mailing address, contact email,
state, county, effective date), each page carries a **Draft** banner.

To publish: fill in the placeholders, have someone qualified review both documents, commit and
push (the service redeploys), and check that the banner is gone. External TestFlight testing and
the App Store need the privacy page's URL.

## Email delivery

Not needed for the beta. You need an email provider to turn emailed sign-in codes back on
(build the app with `EXPO_PUBLIC_EMAIL_SIGN_IN=code`) or, later, for password-reset emails.
Railway blocks outbound SMTP below the Pro plan, so email goes through an email API over HTTPS.
With Resend:

1. Create a Resend account, add your sending domain and create the DNS records it shows.
2. Create an API key with sending access only.
3. In Railway → `api` → *Variables* (per environment): `EMAIL_PROVIDER=resend`,
   `EMAIL_API_KEY=<key>` (sealed), `EMAIL_FROM=PaceLeague <codes@your-domain>`, and optionally
   `EMAIL_REPLY_TO`. Deploy the staged change.
4. Sign in with a real inbox, or run the smoke test's code mode with `SMOKE_EMAILS` (below).

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
npm run smoke:api
```

It creates two throwaway `@example.com` accounts with passwords and checks health and HSTS,
refusal of a wrong key and a forged token, the legal pages, wrong-password / duplicate / weak
sign-ups being refused, a password change, profile save, a full run upload (+77 XP), that neither
account can read the other's run, that private functions are hidden, refresh rotation and logout,
then requests deletion of both accounts; the job loop logs `frequent jobs` with
`deletions_completed` within a minute.

For emailed codes: `npm run smoke:api -- send`, then `npm run smoke:api -- verify <codeA>
<codeB>`. With `EMAIL_PROVIDER=log` the codes are in *api → Deployments → Logs* (search
`sign-in code`, in the order the addresses were printed); with real email, set
`SMOKE_EMAILS=a@…,b@…` to two inboxes you can read.

## iPhone builds for testers (TestFlight)

The `pilot` profile in `eas.json` already points at staging: the API URL, its public key and the
legal pages. One-time setup:

1. Join the Apple Developer Program and create an Expo account.
2. Pick the app's bundle identifier (for example `com.yourname.paceleague`). Add it to the
   `pilot` profile's `env` in `eas.json` as `IOS_BUNDLE_IDENTIFIER`, and to `APPLE_AUDIENCES` on
   Railway so Sign in with Apple works.
3. `npm i -g eas-cli && eas login`, then `eas init` in the repository. Add the project ID it
   prints to the `pilot` profile's `env` as `EAS_PROJECT_ID` (the app config is dynamic, so EAS
   can't write it for you).

Each build:

```bash
eas build --platform ios --profile pilot       # EAS creates and manages the signing credentials
eas submit --platform ios --profile pilot --latest
```

`eas submit` uploads the build to App Store Connect (creating the app there the first time). When
it has processed, open App Store Connect → TestFlight, add yourself (and up to 100 people on your
App Store Connect team) to an internal testing group, and install through the TestFlight app — no
review needed. For testers outside your team, create an external group, fill in the Test
Information (feedback email, description, and the published privacy page's URL) and submit the
build for Beta App Review. The build declares no non-exempt encryption; the app encrypts its local
database with SQLCipher, so confirm that declaration against Apple's export-compliance guidance
before external testing.

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
duration — never emails, passwords, tokens, codes (outside `log` mode), bodies or coordinates. Alert on
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
5. Put the URL and key in the `production` build profile's `env` (`EXPO_PUBLIC_API_URL`,
   `EXPO_PUBLIC_API_KEY`), plus `EXPO_PUBLIC_SUPPORT_EMAIL`, and `EXPO_PUBLIC_TERMS_URL` /
   `EXPO_PUBLIC_PRIVACY_URL` pointing at the production `/legal/terms` and `/legal/privacy`. Nothing privileged ever goes into the app; `npm run check:secrets`
   fails CI if it does.

## Incident playbook

| Situation | First action |
|---|---|
| Scoring bug or suspicious standings | `competition_enabled` off (recording continues), fix, deploy a new migration, turn back on — pending runs are rescored |
| Invite spam or abusive league names | `invites_enabled` off; moderate reports; rotate affected invites |
| Sign-up abuse | `registration_enabled` off (new accounts can't finish onboarding); per-IP sign-up limits apply meanwhile, or set `PASSWORD_SIGN_IN=false` to stop new password accounts |
| Bad API deploy | Roll back the `api` deployment in Railway (the schema stays; migrations are forward-only) |
| Bad app release | Roll back JavaScript only with a tested compatible runtime; native changes need a new build |
| Suspected token or key exposure | Set a new `JWT_SECRET` and redeploy (every existing access token stops working at once); revoke sessions with `update auth.sessions set revoked_at = now() where revoked_at is null` (refreshing then fails, so everyone signs in again); rotate `EMAIL_API_KEY` at the provider; review `private.audit_log`; follow the privacy notice's breach process |
