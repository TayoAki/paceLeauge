# Architecture

PaceLeague has one rule that shapes everything else: **the phone records, the server decides**.
The app captures GPS evidence durably and shows provisional numbers; PostgreSQL validates runs,
allocates them to competition days and awards XP. No XP, rank or membership is ever written by
the client.

```
 iPhone                                                  Railway
┌───────────────────────────────────────────────┐        ┌──────────────────────────────────────┐
│ Background location task (expo-task-manager)  │        │ api — server/ (Node 22)              │
│   └─▶ RecorderService ──▶ Journal (SQLCipher) │        │   /auth/v1      passwords, Apple,    │
│          │  live metrics      │ outbox        │        │                 sessions (codes)     │
│          ▼                    ▼               │  HTTPS │   /rest/v1/rpc  per request: role,   │
│      Screens (Expo Router) ◀─ SyncEngine ─────│ ─────▶ │                 claims, 15 s limit   │
│          ▲                                    │ ◀───── │   jobs · migrator · /legal pages     │
│   TanStack Query cache + offline snapshots    │  JSON  └───────────────────┬──────────────────┘
└───────────────────────────────────────────────┘                            │ SQL
                                                         ┌───────────────────▼──────────────────┐
                                                         │ PostgreSQL 18 (private network)      │
                                                         │   public RPCs (SECURITY DEFINER,     │
                                                         │     search_path = '', role checks)   │
                                                         │   finalize_run ─▶ validate_run (SQL) │
                                                         │   ─▶ day allocations ─▶ daily_scores │
                                                         │   ─▶ xp_ledger ─▶ profile_stats      │
                                                         │   RLS: owner-only reads, no writes   │
                                                         └──────────────────────────────────────┘
```

## Layers

| Layer | Where | Responsibility |
|---|---|---|
| Domain | `src/domain/` | Pure TypeScript, no React/Expo imports: validator v1, score contract v1, competition calendar (America/Chicago, DST-correct), recorder state machine, formatting, route codec, splits. Mirrored in SQL and proven equal by `tests/backend/parity.test.ts`. |
| Local data | `src/db/` | One encrypted SQLite journal per account: active session, track points, session events, saved runs, upload outbox, telemetry queue, small key-value store. Every write is a transaction serialized through a mutex. |
| Services | `src/features/` | `RecorderService` (recording lifecycle), `SyncEngine` (outbox → server), account runtime (opens/closes per-account resources), telemetry, reminders, export, leagues. |
| API client | `src/api/` | `PaceApi`: one typed method per RPC, every response parsed with Zod, failures mapped to stable `ApiError` codes (retryable / auth / permanent). The transport is pluggable: supabase-js against the PaceLeague API in the app, direct SQL in integration tests. |
| UI | `src/app/`, `src/components/`, `src/design/` | Expo Router screens, design-system components built on the packet's tokens. |
| API service | `server/` | Sign-in (email + password, emailed codes, Sign in with Apple), sessions, the RPC endpoint, the migrator, the scheduled jobs and the legal pages. Holds no business rules. |
| Database | `db/` | `platform/`: roles and the auth schema. `migrations/`: schema, RLS, RPCs, SQL validator and scoring, leagues, safety/lifecycle, maintenance jobs. |

## Backend service

The API (`server/`, deployed on Railway) is deliberately thin. It speaks the two protocols the
app's client library (supabase-js) already uses, so the app's API client and every SQL rule carried
over unchanged when the backend moved off Supabase:

- **`/auth/v1`** — email + password accounts for the beta (scrypt hashes, per-address and per-IP
  attempt limits; changing a password needs a recent sign-in and ends other sessions; proving the
  address later — a code or Apple's verified email — reclaims an account registered without proof);
  email one-time codes, off in the app for the beta (6 digits, stored only as an HMAC, single use,
  10 minutes, 5 guesses, resend cooldown and hourly caps per address and per IP, delivered through
  Resend or Postmark over HTTPS); Sign in with Apple (identity token checked against Apple's keys: issuer,
  audience, expiry, hashed nonce); sessions as 1-hour HS256 access tokens plus opaque rotating
  refresh tokens with reuse detection. The token's sign-in time (`amr`) never moves on refresh, so
  "recent sign-in" checks for export and deletion keep their meaning.
- **`/rest/v1/rpc/<function>`** — each call runs in its own transaction as `anon` or
  `authenticated`, with the verified claims in `request.jwt.claims` (read by `auth.uid()`), a
  15-second statement timeout and only `public` functions reachable. Errors keep PostgREST's shape.
- **Migrator** — forward-only, checksummed and advisory-locked; Railway runs it before each deploy.
- **Jobs** — the minute and hourly maintenance functions, each under an advisory lock (Railway's
  Postgres has no `pg_cron`).
- **Legal pages** — the Privacy Policy and Terms from `legal/`, served as HTML at `/legal/privacy`
  and `/legal/terms` (marked as drafts while placeholders remain).

Configuration is validated at boot, and production refuses unsafe settings (log-only email, a
development code, the competition bootstrap). The API holds the database connection and the
token signing secret; the app holds only the API URL and a public key.

## Recording pipeline (REQ-002 – REQ-004)

1. **Preflight** (`src/app/run/preflight.tsx`) asks for location in context, only when the runner
   taps Start, and watches a short-lived fix while the screen is visible. "Ready" requires granted
   permission, precise location (iOS), a fix at most 15 s old and ≤ 50 m accuracy. A three-second
   cancellable countdown follows.
2. **Start** begins location updates *before* creating the session, so a permission failure
   never leaves an orphaned run. The session row and a heartbeat checkpoint (every 5 s) live in
   the journal.
3. **Samples** arrive through the top-level background task (`src/features/recording/location-task.ts`),
   which resolves the recording account headlessly and calls `RecorderService.ingest`. Points are
   normalized (1e-7°, 0.1 m), appended in one transaction, and fed to an incremental
   `SegmentTrack` that applies the same rules as the server validator for the live distance.
4. **Pause/resume** close and open segments; paused time and movement never count.
5. **Interruption**: after a crash or kill, the first delivery or launch checks liveness. If the
   last durable evidence is older than the 15 s gap threshold, the session becomes *interrupted*
   and its open segment ends at the last evidence — never at relaunch time. The runner can resume
   (new segment), save the partial run, or discard.
6. **Finish** writes the saved run *and* its upload outbox item in the same transaction, with a
   provisional XP estimate. Repeated taps return the same saved run; a failed write keeps the
   session for retry and never shows success.

## Sync (REQ-005)

`SyncEngine` drains the outbox one run at a time (single flight), triggered on finish, sign-in,
reconnect and foreground:

1. `start_run_upload` — idempotent on `(owner, client_run_id)` plus a canonical request hash;
   an identical retry reuses the upload, a changed body with the same key is rejected.
2. `put_route_chunk` — ≤ 500 points / 128 KiB each with a SHA-256 checksum; resending the same
   chunk is accepted, conflicting content at an existing sequence number is rejected.
3. `finalize_run` — the manifest must match the stored chunks. The server takes a per-user
   advisory lock, validates the route with the SQL validator, allocates active segments to
   competition days, recomputes the affected daily scores, and writes the XP *delta* to the
   ledger. Ten concurrent finalizes produce one result and one set of score effects.

Retryable failures back off exponentially with jitter (capped at 15 minutes); an expired session
pauses the queue until the runner signs in again; permanent errors mark the run *needs attention*
while keeping it on the phone. Renames and deletions of synced runs also go through the outbox, so
they work offline.

## Scoring (REQ-006) — score contract v1

All in integer centimetres and milliseconds, computed in SQL (`private.daily_xp`,
`private.recompute_daily_scores`):

- Daily XP = `min(100, floor(distance_cm / 10,000))` + 25 active-day bonus when the day has
  ≥ 1 km **and** ≥ 5 min, capped at 125. Multiple runs on one day combine *before* the formula,
  so splitting a run can never beat the cap.
- Lifetime XP is the sum of accepted daily XP; tiers at 0 / 500 / 1,500 / 4,000 / 10,000.
- Weekly league XP = the best three days of the competition week (Monday–Sunday,
  America/Chicago, including the 167 h and 169 h DST weeks).
- Runs are *accepted*, *personal only* (too short, low GPS coverage, invalid timestamps) or held
  for *review* (implausible speed, uploaded more than 72 h after it ended). Only accepted runs earn
  XP; the reason is shown to the runner.
- With the `competition_enabled` flag off, runs are still recorded, validated and kept; scoring
  is deferred and applied when the flag is turned on.

The fixture run (5,240 m in 31:28 on Friday) earns 52 + 25 = 77 XP and takes lifetime XP from
820 to 897 — asserted in TypeScript, in SQL, through the real client against Postgres, and in
the browser walkthrough.

## Leagues (REQ-007)

Private leagues of up to 20 runners, one league per runner. Invites are 8-character Crockford
codes stored only as SHA-256 hashes, valid for 7 days, and joining is always an explicit action
after a preview. Standings are computed at read time from each member's day allocations *after
they joined*, rank ties together, and keep blocked members as hidden rows so places are never
falsified. A week settles 24 hours after it closes; runs first received after the deadline don't
change it, and later corrections are recorded as revisions. Owners can rename, rotate invites,
remove (and ban) members and transfer ownership; parallel joins cannot exceed capacity.

## Privacy and security (REQ-010, REQ-011, REQ-014/15)

- **Access control lives in the database.** Every public table has RLS with owner-only SELECT
  policies and no write grants; all mutations are SECURITY DEFINER functions that derive the
  caller from `auth.uid()` and pin `search_path`. Anonymous callers can execute exactly three
  functions (app config, invite preview, and a live-location link's page). `tests/backend/access.test.ts` checks this across the
  whole catalog both with the strict platform layer that runs on Railway and with Supabase-style
  permissive default grants (`db/test-support/`), so RLS and explicit revokes — not missing
  grants — are what protect the data.
- **Routes are private unless the runner shares them**: stored in the `private` schema and
  returned by owner-checked functions. A runner can share a run's map with the people they
  choose (roadmap 4.2); a shared map never shows the first or last 200 m or anything inside the
  runner's privacy zones, and that same trimmed track is the only input to segment matching (5.3)
  and the heatmap (5.4), which publishes a map cell only once 5 different contributors ran
  through it. Planned routes (5.1) are visible only to their owner. League views expose alias,
  tier and weekly XP — nothing else. The share poster is a separate composition with statistics
  only, so no map or coordinates can be captured.
- **Export** (recent sign-in required, 3 per day) returns the runner's data as JSON plus one GPX
  per route. **Account deletion** (recent sign-in required) hides the runner immediately, hands
  league ownership to the longest-standing member (or closes the league), then a retrying job
  removes every owned record and finally the auth user. The app deletes the account's journal and
  its key from the phone.
- **On the phone** each account has its own journal file and SQLCipher key (Keychain,
  `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`); signing out closes it, and another account can never
  read or claim it. Refresh tokens live in SecureStore, never AsyncStorage.
- **Abuse controls**: alias/league-name filter, reports with snapshots into a staff-only queue,
  audited moderator actions, blocks, removals with bans, and per-user rate limits on alias
  checks, uploads, league creation, invites, join attempts, blocks, reports, exports and telemetry.
- **Telemetry** is an allowlist of events with enumerated properties (no free text, no IDs of
  other people, no locations), queued locally and never blocking the recorder.

## Accounts and runtime

`AuthProvider` owns the auth session (supabase-js against the API's `/auth/v1`: email and password,
or an emailed code when `EXPO_PUBLIC_EMAIL_SIGN_IN=code`; Sign in with Apple with a hashed nonce). `AccountProvider` opens an `AccountRuntime` for the signed-in user — journal, recorder,
telemetry, sync engine — and closes it on sign-out. A run in progress pins its account, so the
background task keeps writing to the right journal even if the UI signs out; sign-out waits for
the run to be finished or discarded.

## Offline behaviour

Reads use TanStack Query with snapshots in the journal: screens show the last known data with an
"offline — showing saved …" notice. Recording, finishing, renaming and deleting all work offline;
the XP panel says *saved on this phone* until the server answers, and never presents an estimate
as awarded XP.
