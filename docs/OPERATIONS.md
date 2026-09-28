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
| `APPLE_AUDIENCES` | `com.tayoaki.paceleague,com.tayoaki.paceleague.dev` | `com.tayoaki.paceleague` | Comma-separated iOS bundle identifiers that may use Sign in with Apple |
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

Push notifications (roadmap 4.9): `PUSH_ENABLED` (false; `true` sends them through Expo's push
service), `EXPO_ACCESS_TOKEN` (only if the Expo project turns on "enhanced security for push
notifications"; a sealed variable) and `EXPO_PUSH_URL` (Expo's API; https only outside
development). See [Push notifications](#push-notifications-49).

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

## Age assurance

PaceLeague is for adults. At sign-up the app asks the App Store (Declared Age Range, iOS 26+) or
Google Play (Age Signals) for the runner's age range where the platform provides one, using
`expo-age-range` (`src/features/account/age-check.ts`). Where the platform says age rules don't
apply, or has no answer outside a regulated region, the runner's own adult declaration stands. The
profile records the outcome (`age_signal`: `adult`, `not_required` or `minor`), how it was declared
and when; never a birth date.

- **Under 18 at sign-up:** no profile is created.
- **Under 18 for an existing account** (checked at launch, only where the platform confirms age
  rules apply): the account is locked for uploads, leagues and reports, and removed from its league
  at once. Its holder can still read and export their data and delete the account.
- **Regulated region, no answer:** the app asks the runner to share their age range (or verify it
  with Google Play) and can't be used until they do.

The iOS entitlement `com.apple.developer.declared-age-range` is set in `app.config.ts`; EAS enables
the capability on the App ID during the build. Test on a real iPhone: the simulator has no age
answer.

A store signal can be wrong (for example, a family sharing one Apple Account). After checking the
holder's age another way, a staff operator clears the lock:

```sql
select private.clear_age_restriction('<user uuid>', 'Checked ID by email, ticket 123', 'ops:alex');
```

The action is recorded in `private.audit_log`. The runner rejoins a league with a new invite.

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
legal pages. `app.config.ts` holds the app's identity: bundle identifier `com.tayoaki.paceleague`
(development builds use `com.tayoaki.paceleague.dev`, so they install alongside it) in the Expo
project `@tayom/paceleague`; staging's `APPLE_AUDIENCES` lists both identifiers. You need an Apple
Developer Program membership and the Expo account, then from the repository (a Codespace works —
the build itself runs on Expo's servers):

```bash
npm ci
npm i -g eas-cli && eas login
eas build --platform ios --profile pilot --auto-submit
```

The first build asks you to sign in to your Apple Developer account and offers to create the
signing certificate, provisioning profile and an App Store Connect API key — accept. After the
build, EAS uploads it to App Store Connect, creating the app there the first time (to resubmit a
finished build: `eas submit --platform ios --profile pilot --latest`). When it has processed, open App Store Connect → TestFlight, add yourself (and up to 100 people on your
App Store Connect team) to an internal testing group, and install through the TestFlight app — no
review needed. For testers outside your team, create an external group, fill in the Test
Information (feedback email, description, and the published privacy page's URL) and submit the
build for Beta App Review. The build declares no non-exempt encryption; the app encrypts its local
database with SQLCipher, so confirm that declaration against Apple's export-compliance guidance
before external testing.

### Native extras (Phase 1)

The app has three native pieces beyond V1, all in this repository and switched on by default:

- **Voice cues** (`modules/voice-cue`, Swift and Kotlin): speaks run cues while lowering other
  audio. It needs the `audio` background mode, which `app.config.ts` adds.
- **Widget extension** (`targets/widgets`, built by `@bacons/apple-targets`) with the run Live
  Activity (`modules/run-activity`) and the "this week" widget. It adds the App Group
  `group.<bundle id>` to the app and the extension, and an extension bundle id `<bundle id>.widgets`.
  EAS creates its provisioning profile on the next build; if Apple asks, register the App Group
  for both identifiers in the developer portal.
- **Apple Health** (`@kingstinct/react-native-healthkit`): adds the HealthKit capability to the
  app. Runners switch it on in Run settings.

If a build fails in one of them, leave it out while you look into it: `PL_WIDGETS=0` or
`PL_HEALTHKIT=0` in the build profile's `env` (the app hides what isn't built in). For local
Xcode builds of the widget, set `APPLE_TEAM_ID`.

**App Store privacy (updated for Phase 2).** Apple Health import reads workouts, their routes, heart
rate and steps, and uploads the runs it brings in, with their provenance and heart-rate averages.
So App Store Connect's questionnaire must now declare "Health & Fitness" and "Precise Location" as
collected, linked to the runner, used for app functionality, and not used for tracking. App Review
expects the HealthKit use in the privacy policy (`legal/privacy-policy.md`, "Apple Health and
Apple Watch"). HealthKit background delivery (imports that sync without opening the app) needs
the `com.apple.developer.healthkit.background-delivery` entitlement, which the HealthKit plugin
adds with `background: true`.

### Phase 2 native pieces

- **Treadmill runs** use the step counter (`expo-sensors`), with `NSMotionUsageDescription` in
  `app.config.ts`.
- **Apple Watch app** (`targets/watch`, `targets/watch-complication`, `modules/watch-link`): off
  unless the build sets `PL_WATCH=1`, until its first build has run on a watch. It adds the bundle
  ids `<bundle id>.watchkitapp` and `<bundle id>.watchkitapp.complication`, HealthKit for the watch
  app, and the App Group on both. EAS creates the profiles; watchOS 10 is the minimum. Test the
  generated Xcode project early (the roadmap notes an open `@bacons/apple-targets` issue about
  embedding watch apps); `npx expo prebuild` with `PL_WATCH=1` already produces both targets.
- **Connections** use `expo-web-browser`'s sign-in sheet and return to `paceleague://strava` or
  `paceleague://garmin`.

### Phase 3 native pieces

- **Pro purchases** use `react-native-purchases` (RevenueCat), a native module: it works only in
  builds made with EAS or Xcode, never in Expo Go. Without `EXPO_PUBLIC_REVENUECAT_IOS_KEY` in the
  build's environment the Pro screen says subscriptions aren't available, and nothing else changes.
- **Apple Health reads** grow: heart rate for zones on each run, and resting heart rate, heart
  rate variability, VO2 max and sleep for Pro's health trends. Each is asked for only when the
  runner switches it on. `NSHealthShareUsageDescription` in `app.config.ts` names them. Zones and
  trends are worked out on the phone and never uploaded.
- **Heat** is entered by the runner (temperature and humidity). The roadmap's forecast from Apple
  WeatherKit needs the WeatherKit capability on the App ID and a WeatherKit key in the Apple
  developer account; it isn't built.

**App Store privacy (Phase 3).** Training plans store the setup answers (including "coming back
from an injury") and after-session feedback (including "something hurt") on the server, linked to
the runner, for app functionality. Declare them under "Health & Fitness". Purchases: declare
"Purchases" (purchase history, through RevenueCat), linked to the runner, for app functionality.
Zones and health trends stay on the phone, so they aren't "collected".

### Phase 4 native pieces

- **Remote notifications** (4.9) use the `expo-notifications` plugin already in the build: it adds
  the Push Notifications capability (`aps-environment`), and Android shows them in their own
  channel, "Friends and league", which runners can tune in Settings. Credentials are in
  [Push notifications](#push-notifications-49).

**App Store and Google Play privacy (Phase 4).** Add "Other User Content" (comments) linked to the
runner, for app functionality, and push tokens as "Device ID", linked, for app functionality.
Location stays as declared: shared maps come from the runner's own routes, cut on the server.
Nothing reads the address book. Apple's guideline 1.2 for user-generated content is met by the
comment filter, reporting on runners, runs and comments, blocking, the 24-hour response target and
the published contact (Staff roles and moderation).

## Android builds for testers (Google Play, P.1)

The same `pilot` profile builds the Android app against staging. The package is
`com.tayoaki.paceleague` (development builds `com.tayoaki.paceleague.dev`), set in
`app.config.ts`. You need a Google Play developer account; the first upload creates nothing by
itself, so create the app in the Play Console first (name, default language, free).

```bash
eas build --platform android --profile pilot          # an .aab for Google Play
eas submit --platform android --profile pilot --latest # needs a Play service-account key the first time
```

Put the build on the **internal testing** track and add testers by email. What the Play Console
asks before any testing track reaches people:

- **Foreground service declaration** (App content › Foreground service permissions): the app
  uses `FOREGROUND_SERVICE_LOCATION` for *user-initiated location tracking*: a run the runner
  starts and ends. Record a short video of starting a run, locking the phone and finishing.
- **No background location.** The manifest removes `ACCESS_BACKGROUND_LOCATION`; the run's
  foreground service works on "while in use" access, so there's no background-location
  declaration to make.
- **Health apps declaration** (App content › Health apps): the Health Connect data types and why:
  exercise, exercise routes, distance, steps and heart rate read to import workouts and show
  heart-rate zones; resting heart rate, heart rate variability, VO2 max, sleep and history read
  for Pro's training trends; exercise, exercise routes and distance written to save runs. Google
  reviews this before Health Connect access works in a release build (allow about two weeks).
  Health Connect's permission screen links to the Privacy Policy, which the app opens.
- **Data safety:** the same answers as the App Store privacy questionnaire (above): location,
  health and fitness, and purchases, collected for app functionality, linked to the runner, not
  shared for advertising; encrypted in transit; deletion available in the app.
- **Photo and video permissions:** none; the manifest removes them (share images are only saved).
- **Age signals:** Play Age Signals needs no declaration beyond the app's target audience (adults).
- **Pro on Google Play:** create the two subscriptions in the Play Console (yearly $29.99 with a
  7-day free trial offer, monthly $4.99), connect Google Play to the RevenueCat project with a
  service-account key, attach both products to the `pro` entitlement and the current offering,
  and set `EXPO_PUBLIC_REVENUECAT_ANDROID_KEY` (RevenueCat's public Google key) in the build's
  environment. Test with the Play Console's license testers.

Native pieces on Android: the location foreground service (`expo-location`), voice cues
(`modules/voice-cue`, Kotlin), Health Connect (`react-native-health-connect`, minSdk 26), the
launch-intent module that answers Health Connect's privacy-policy link (`modules/launch-intent`),
and purchases. The Live Activity, widget and watch app are iPhone only. Treadmill runs on Android
take the distance the runner types in; step counting there waits for a device test.

## Web app (P.2)

The web app is the same code base, built for the browser: history, runs and their routes,
league standings, plans, stats, records, the Pro analytics, settings, export and account deletion.
It doesn't record runs (a browser can't keep GPS going in a pocket; *Start run* explains that
recording is in the phone app), sell Pro, or read Apple Health or Health Connect.

**Deploy it as a second Railway service** in the same project and environment:

1. New service → from the repository; Settings › Build › Dockerfile path `web/Dockerfile`
   (or the variable `RAILWAY_DOCKERFILE_PATH=web/Dockerfile`). Its build context is the repository
   root with `web/Dockerfile.dockerignore`.
2. Variables (used at build time; all public):

| Variable | Value |
|---|---|
| `EXPO_PUBLIC_API_URL` | The API's public URL (staging: `https://api-staging-753f.up.railway.app`) |
| `EXPO_PUBLIC_API_KEY` | The API's `PUBLIC_API_KEY` for that environment |
| `EXPO_PUBLIC_APP_ENV` | `staging` or `production` |
| `EXPO_PUBLIC_PRIVACY_URL`, `EXPO_PUBLIC_TERMS_URL`, `EXPO_PUBLIC_SUPPORT_EMAIL` | As for the app builds |
| `API_ORIGIN` | The API's origin again (no path), used at run time for the Content-Security-Policy |

3. Generate a domain (or add the operator's, for example `app.` next to `api.`), then add that
   origin to the **API's** `CORS_ORIGINS` (comma-separated, no trailing slash) and deploy the API.
   Without it, the browser refuses every call.
4. Health check path: `/healthz`.

`scripts/web/serve.mjs` serves the build: the app's page for every route, hashed bundles cached
for a year, and strict headers: a Content-Security-Policy that allows only the app's own scripts
and the API (plus WebAssembly for the browser's SQLite), no framing, HSTS, and a
Permissions-Policy that turns off location, motion, camera and microphone. The browser keeps the
session in local storage like any single-page app, which is why the CSP matters; signing out
removes the account's local copy from the browser unless something hasn't synced.

Check a build locally against the development backend:

```bash
EXPO_PUBLIC_API_URL=http://127.0.0.1:54400 EXPO_PUBLIC_API_KEY=pl_dev_public_key npm run build:web
API_ORIGIN=http://127.0.0.1:54400 PORT=8090 npm run serve:web &
npm run e2e:web-app      # signs in, opens 13 screens at phone and desktop widths, fails on any
                         # browser or CSP error and on serious axe-core accessibility findings
```

## Integrations (Phase 2)

Both are off until their variables are set on the `api` service. Nothing about them is in the app.

### Strava export (2.3)

1. Create an API application at <https://www.strava.com/settings/api>. Set the *Authorization
   Callback Domain* to the API's domain (for example `api.paceleague.app`, no scheme or path).
2. Set, as sealed variables:

| Variable | Value |
|---|---|
| `STRAVA_CLIENT_ID` | The application's client id (a number) |
| `STRAVA_CLIENT_SECRET` | Its client secret |
| `STRAVA_TOKEN_KEY` | `openssl rand -base64 32`. Encrypts runners' tokens in the database; changing it disconnects everyone |
| `PUBLIC_URL` | The API's public URL, `https://…`. Strava sends runners to `${PUBLIC_URL}/integrations/strava/callback` |
| `STRAVA_WEBHOOK_VERIFY_TOKEN` | Any random string, for the webhook subscription below |
| `APP_RETURN_URLS` | Optional; defaults to `paceleague://`. Where the callback may send runners back (the web app's origins from `CORS_ORIGINS` are added) |

3. Subscribe to Strava's webhook once per environment, so a runner who revokes PaceLeague on
   Strava is disconnected:
   `curl -X POST https://www.strava.com/api/v3/push_subscriptions -F client_id=… -F client_secret=… -F callback_url=${PUBLIC_URL}/integrations/strava/webhook -F verify_token=…`
4. New applications may upload only for their own athlete until Strava reviews them; request a
   higher athlete capacity before the beta. Strava's limits are 200 requests per 15 minutes and
   2,000 a day by default; uploads wait for the next window when limited.

The service posts accepted runs recorded with PaceLeague (phone or watch) once a minute, and
revokes grants after a disconnect or account deletion (`oauth/revoke`). Logs: `strava jobs`,
`strava connect`, `strava upload retry`, `strava grant revoked`.

### Garmin through Terra (2.4)

Switch on when decision 1's trigger is met (about 50 active runners, or 15% of weekly active
runners, use Garmin), after confirming the Terra plan includes GPS samples and its terms allow
league scoring.

1. In Terra's dashboard, enable Garmin, and add a webhook destination
   `${PUBLIC_URL}/integrations/garmin/webhook` for the auth, deauth and activity events.
2. Set, as sealed variables: `TERRA_DEV_ID`, `TERRA_API_KEY` and `TERRA_WEBHOOK_SECRET` (the
   destination's signing secret). All three are required together.

Terra signs each event (`terra-signature`); unsigned, forged or older-than-five-minute events get
401. Activities are queued and uploaded as the runner once a minute with source `garmin`, through
the same validation as a phone run; the Apple Health copy of the same workout becomes a duplicate.
A disconnect or account deletion deauthorizes the Terra user. Logs: `garmin jobs`, `garmin
connect`, `garmin activity refused`, `garmin deauth retry`.

## Pro subscriptions (3.6)

Pro is sold through the App Store with RevenueCat. Until the variables below are set, the webhook
answers 404 and nobody has Pro except through `grant-pro` (below). Everything here needs the
operator's App Store Connect and RevenueCat accounts; nothing is created by the code.

1. **App Store Connect:** create a subscription group (for example "PaceLeague Pro") with two
   auto-renewable subscriptions: yearly at $29.99 with a 7-day free trial as its introductory
   offer, and monthly at $4.99 with no trial (decision 4). Add the review screenshot and the
   subscription's display name and description. The paid-apps agreement must be active.
2. **RevenueCat:** create a project and its iOS app (bundle id `com.tayoaki.paceleague`) with the
   App Store Connect in-app purchase key. Create the entitlement **`pro`**, attach both products,
   and make the *current* offering hold them as the `$rc_annual` and `$rc_monthly` packages (the
   app shows those two).
3. **Webhook:** in RevenueCat → Integrations → Webhooks, send events to
   `${PUBLIC_URL}/integrations/revenuecat/webhook`, with an *Authorization header value* you
   generate (`openssl rand -base64 32`). Send sandbox and production events; the service records
   which environment each came from.
4. **Variables on `api`** (sealed):

| Variable | Value |
|---|---|
| `REVENUECAT_WEBHOOK_AUTH` | The same Authorization value as the webhook, at least 24 characters. Events without it get 401 |
| `REVENUECAT_SECRET_KEY` | Optional: a RevenueCat secret API key (`sk_…`). With it, the service asks RevenueCat for the runner's current state after each event instead of trusting the event alone |
| `REVENUECAT_ENTITLEMENT` | Optional; defaults to `pro` |

5. **App build:** put the RevenueCat **public** iOS SDK key in the EAS environment as
   `EXPO_PUBLIC_REVENUECAT_IOS_KEY` (`EXPO_PUBLIC_REVENUECAT_ANDROID_KEY` later for Android). It
   is a public key; the secret key never goes in the app.

Events are applied in the order they happened (a late, older event never undoes a newer one), and
each event id is processed once. The app signs purchases in as the runner's account id, so a
purchase follows the account, not the device. Deleting an account removes its Pro state and keeps
the event log for 60 days without the link to the account; it doesn't cancel the store
subscription, which the delete screen says.

**Trial reminders.** Two days before a free trial converts, the service emails the runner (in
production only, through the email provider in [Email delivery](#email-delivery)), once per trial.

**Support and testers.** Give an account Pro without a purchase (for TestFlight testers, or to
make good a problem), from a shell in the API container:

```bash
node dist/admin.js grant-pro runner@example.com 30    # days; 0 ends a grant
```

A grant never replaces a store subscription that's still running (the command says so), and the
store's next event replaces a grant. Logs: `revenuecat event`, `billing jobs`,
`trial reminder failed`.

**Before launch** (roadmap 3.6), test in the App Store sandbox with a sandbox Apple ID: purchase
(each plan), restore on a second device, expiry, a refund (from the sandbox's transaction
history), the trial reminder (sandbox trials last minutes; point a staging account at a real
inbox), and account deletion with an active subscription.

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
| `private.run_frequent_jobs()` | every minute | Processes account-deletion jobs (retrying with backoff, `failed` after 8 attempts), applies pending scoring, and once a league week is final (Tuesday 00:00 Chicago) queues each member's week-results push. Logs `frequent jobs` when it did something |
| Strava uploads and revocations | every minute, when Strava is configured | Queues accepted runs of connected runners, uploads them, follows processing, refreshes tokens, confirms webhook deauthorizations, revokes ended grants. Logs `strava jobs` |
| Garmin events | every minute, when Terra is configured | Uploads queued Garmin activities as their runners, deauthorizes ended links, keeps processed events a week. Logs `garmin jobs` |
| Pro billing | hourly | Sends trial reminders (production), and removes store events older than 60 days. Logs `billing jobs` |
| Push notifications | every 15 s, when `PUSH_ENABLED=true` | Sends due pushes from `private.push_outbox` through Expo, retries failures with backoff (dropped after 5 tries), checks Expo's receipts after 15 minutes and forgets devices whose app was uninstalled. Logs `push jobs` |
| `private.purge_expired()` + sign-in cleanup | hourly, and 5 s after each start | Removes uploads never finalized after 7 days (the phone keeps its copy), expired exports, operational events after 14 days, rate-limit windows after 2 days, resolved reports after 90 days, dead invites after 30 days, completed deletion records after 30 days, pushes sent or dropped after 7 days (and their repeat guards after 30), expired sign-in codes, and revoked sessions after 30 days. Logs `hourly retention` |

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
| `overdue_reports` | > 0 | A report is past its 24-hour response target: moderate it now (below) |
| `push_backlog` | > 0 for 15 minutes | Pushes aren't going out: look for `push send failed` or `push receipt error` in the logs, and check Expo's status page and the push credentials (below) |

The service logs one JSON line per event. Request lines carry the method, route, status and
duration — never emails, passwords, tokens, codes (outside `log` mode), bodies or coordinates. Alert on
`level: error` lines, on the HTTP 5xx rate and on failed health checks (Railway's service metrics
and observability tools), and wire `health_report()` into the same place before the pilot
(EV-015). Recording and history never depend on analytics or these jobs.

## Staff roles and moderation

```sql
select private.grant_staff_role('<user uuid>', 'moderator', 'Pilot moderation rota', 'ops:alex');
```

A moderator signs in to the app normally and gets **Profile › Moderation** (roadmap 4.9): the
queue ordered by due time, each report's snapshot (the reported name, run title and numbers, or
comment text — never routes, emails or who reported it), how many open reports concern the same
thing, and the actions that fit it. Every action needs a note and is recorded with the moderator,
reason and target in `private.moderation_actions`.

| Reported | Actions |
|---|---|
| League member | `dismiss`, `reset_alias`, `remove_from_league` |
| League | `dismiss`, `rename_league` |
| Runner | `dismiss`, `reset_alias` |
| Run | `dismiss`, `hide_run` (only the runner sees it until they share it again; their data stays), `reset_alias` |
| Comment | `dismiss`, `remove_comment`, `reset_alias` |

Removing a comment or hiding a run closes every open report about it. What runners see:

- A runner who reports a run or a comment stops seeing it at once.
- Three open reports from different runners hold a comment: only its author sees it until a
  moderator decides. Dismissing the last open report puts it back.
- Comments are filtered before they're saved: at most 500 characters, no links, no hidden or
  control characters, and no whole word from `private.blocked_terms` (add terms in lower case:
  `insert into private.blocked_terms (term) values ('…');`). Eight comments a minute and 100 a
  day per runner at most.

**Response target: 24 hours.** Each report's `due_at` is 24 hours after it arrives. The queue
shows what's due next and what's overdue; `mod_queue_health` (the card at the top of the screen)
counts open, overdue and, over the last 7 days, reports resolved within the target; and the health
report's `overdue_reports` alerts on anything past due.

**Drill** (before launch, then monthly): from a test account, report a comment and a run on a
staging account; as a moderator, open Profile › Moderation, confirm both appear with "Due in 24
hours", remove the comment and hide the run with a note, and confirm: the card counts them as
resolved within the target, the comment is gone for everyone, the run left the other account's
feed, and both actions are in `private.moderation_actions`. `tests/backend/feed.test.ts`
("acts on reports within the response target in a drill") runs the same drill against the
database on every test run.

Before launch (REQ-011): publish a real reviewer/support contact (`EXPO_PUBLIC_SUPPORT_EMAIL`,
shown after every report) and name a moderation rota that covers the 24-hour target.

## Push notifications (4.9)

Kudos, comments and replies, follows (requests, new followers, accepted requests), league cheers
and week results. The database decides what to send (`private.notify`): nothing a runner switched
off, nothing between 22:00 and 07:00 in their time zone (it waits until 07:00), nothing across a
block, and nothing about a run or comment deleted since. Kudos wait two minutes so a burst
arrives as one push ("Maya and 2 others gave you kudos"). The `api` service sends what's due
through Expo's push service, which hands it to Apple (APNs) or Google (FCM).

To turn them on:

1. **Apple:** EAS manages the APNs key: `eas credentials -p ios` → Push Notifications → set up
   a key (or upload one from the Apple Developer account, Keys → Apple Push Notifications
   service). Store builds use Apple's production service (`app.config.ts` sets it from
   `EXPO_PUBLIC_APP_ENV`).
2. **Google:** create a Firebase project for `com.tayoaki.paceleague`, then upload its FCM V1
   service-account key with `eas credentials -p android` → FCM V1. The key stays with EAS; it
   never goes in the repository.
3. **Server:** set `PUSH_ENABLED=true` on the `api` service. If the Expo project enables enhanced
   push security, also set `EXPO_ACCESS_TOKEN` (an Expo access token, sealed). The app offers
   the switches under Profile › Notifications only while the server sends pushes.
4. Check with two test accounts on phones: allow notifications on one, give its run kudos from
   the other, and the push arrives within about three minutes; tapping it opens the run.

Pushes that fail are retried with backoff and dropped after 5 tries; Expo's receipts tell the
service when an app was uninstalled, and that device is forgotten. A phone's token is removed
when the runner signs out. `select * from private.push_outbox order by id desc limit 20;` shows
recent pushes (`sent_at`, `dropped_at`, `last_error`).

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
