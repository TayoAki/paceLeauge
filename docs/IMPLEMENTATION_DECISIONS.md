# Implementation decisions

Choices made while building V1 from the packet, including every deliberate difference from it.
The packet (`docs/packet/`) remains the source of truth; where this file and the packet disagree,
the reason is stated here.

## Architecture

| Decision | Why | Consequence |
|---|---|---|
| All authority in PostgreSQL: RLS + SECURITY DEFINER RPCs behind a thin API | Validation, allocation, scoring and ledger writes happen in one transaction under a per-user advisory lock, so concurrency and idempotency are provable with a real database; no privileged API key exists — the API only ever acts as `anon` or the signed-in runner | Business rules live in SQL migrations; the TypeScript validator mirrors them for live estimates and is held equal by the parity suite |
| XP is always recomputed from day allocations, and the ledger stores deltas | Re-scoring after a delete, a review decision or a paused competition converges on the same totals; "splitting runs to beat the cap" is impossible by construction | Scoring is O(affected days), not O(history) |
| Standings computed at read time, with week revisions recorded after settlement | Corrections (deleted runs, review decisions) can't leave stale materialized ranks; revisions make later changes visible instead of silent | League reads do a bounded aggregation (≤ 20 members × 7 days) |
| `competition_enabled` ships **off** | The packet: keep ranking disabled until accepted-run validation and concurrency pass in staging | Recording, history and uploads work regardless; the dev backend and test suites turn it on, and staging turns it on once at its first deploy |
| Join/invite failures are returned as values, not raised | A raised error rolls back the rate-limit counter, which would make invite-code guessing unlimited — found and fixed during testing | The client converts `{error}` values back into typed errors |
| Invite codes: 8 Crockford base32 characters, stored as SHA-256 hashes, 7-day expiry, ≤ 10 live per league | Short enough to read aloud, ambiguity-free (I/L→1, O→0), useless if the table leaks | Rotation revokes all live codes |
| One encrypted journal per account, plus a pinned "recording account" | Account B can never read or claim A's queue (AC-REQ-001-02), and the headless background task always writes to the account that started the run | Sign-out waits for an active run to be finished or discarded |
| Telemetry stored in the project's own database (`log_events`), allowlisted and enumerated | Minimization (REQ-015) without a third-party analytics SDK or new data processor | Dashboards read `private.operational_events`; retention 14 days |
| Beta sign-in is email + **password** (plus Apple) instead of the packet's emailed codes | The founder's call: the beta can start without an email service or a verified sending domain | Passwords are scrypt hashes with per-address and per-IP limits. No self-service reset yet: an operator sets a temporary password (OPERATIONS.md). An address is unverified until someone proves it (a code, or Apple's verified email), and that proof reclaims the account — clearing the unproven password and its sessions. As with Supabase, access tokens already issued stay valid until they expire (at most an hour) |
| When codes are on: email one-time **codes**, not magic links | Links opening the wrong app/browser are a common mobile failure; codes work across devices | Built and tested; enabled in the app with `EXPO_PUBLIC_EMAIL_SIGN_IN=code` once an email provider is set up. Template in `db/templates/sign-in-code.html` |

## Backend hosting: Railway instead of Supabase

The packet assumes Supabase; the backend runs on Railway instead — one API service next to a
Railway Postgres. The data model, RLS policies and RPCs are unchanged; what Supabase's platform
did is now done by the pieces below.

| Decision | Why | Consequence |
|---|---|---|
| The API (`server/`) implements the parts of Supabase Auth and PostgREST the app uses: email codes, Apple identity tokens, refresh, logout, current user, and RPC | The app keeps its client (supabase-js) and every rule stays in SQL, so neither had to be rewritten | We own the sign-in code Supabase used to run; it is covered by the API suite (24 tests) and the staging smoke test |
| Email codes go through Resend or Postmark over HTTPS | Railway blocks outbound SMTP below the Pro plan | Needs a provider key and a verified sending domain; until then staging writes codes to its private logs |
| Codes are stored as an HMAC keyed by the server secret; limits per address and per IP live in Postgres | A leaked table can't be used to sign in; limits hold across restarts and replicas | Expired codes and old rate-limit windows are purged hourly |
| 1-hour HS256 access tokens plus opaque rotating refresh tokens with reuse detection | Access tokens are checked without a database round trip; a refresh token can be revoked, and a stolen one is caught when reused | As with Supabase, an access token stays valid until it expires after logout |
| Apple identity tokens are verified against Apple's published keys | Native Sign in with Apple needs no client secret; the audience is the bundle identifier | `APPLE_AUDIENCES` must list the real bundle identifiers |
| An own forward-only migrator, run as Railway's pre-deploy step | Checksummed ledger and advisory lock; a failing migration fails the deploy and the previous version keeps serving | Never edit an applied migration — add one |
| Scheduled jobs run inside the API under advisory locks | Railway's Postgres has no `pg_cron` | One instance runs each job at a time, however many replicas |
| `db/platform` recreates the roles and auth schema Supabase provided, with no default privileges | Nothing is reachable unless a migration grants it | The suite also runs with Supabase-style permissive grants, proving RLS alone protects the data |

## Client

| Decision | Why |
|---|---|
| Expo Router stable JS tabs (`expo-router/js-tabs`), not native tabs | The packet: "avoid unstable tab APIs unless deliberately validated" |
| Distance floors to 0.01 (never overstated); pace rounds; split times round to whole seconds | A runner is never told they ran further than measured; a 5:59.9 split reads 6:00 in both the time and pace columns |
| Live distance uses the same segment rules as the server validator | The number on the live screen is the number the server will most likely accept |
| Units default from the device region (US, Liberia, Myanmar → miles) and only change display | Stored values are always metres and milliseconds (AC-REQ-008-01) |
| Run titles default to "Friday morning" style from the start time | Matches the packet's fixtures; titles are the only editable field |
| The XP panel never shows an estimate as awarded XP | Saved ≠ synced ≠ accepted: offline shows "saved on this phone", pending shows "checking", only the server's award is shown as "+N XP" |
| Apple Maps via `react-native-maps` (provider attribution kept) | No API key or extra data processor; the boards' fictional maps omit attribution, which the packet says real maps must show |
| Tab labels at the iOS default 10 pt | Matches a native tab bar and fits the standard 49 pt bar; larger labels clipped |

## Differences from the design boards

| Board element | Implementation | Reason |
|---|---|---|
| "Continue with Apple" on Welcome | iOS only | Sign in with Apple is native; the web preview offers email only |
| "Manage subscription" on Privacy (board 03) | Hidden | The packet: hide it in the free pilot unless a subscription exists |
| Subscription notice on account deletion | Omitted | S16 requires it "if applicable"; nothing is sold in V1 |
| Unlabelled distance bars (board 02) | Bars show their values | AC-REQ-014-02 asks for chart values in text; an empty week shows "–" |
| League rows show only alias and XP | Rows also show the runner's tier | Tier is already part of the league-visible profile (alias, tier, weekly XP) |
| Tier bar on board 02 is illustrative | Exact 39.7 % within Stride at 897 XP | The packet: implement the numeric contract, not the raster |
| Fictional park map on preflight | Plain dark grid on web; Apple Maps on device | No fabricated map data |

## Direction after V1

On 28 September 2026 the founder widened the product beyond V1: watch and Apple Health imports,
training plans and guided runs, health data, and the social and map features the packet left out
(follows, feed, global leaderboards, live location, segments, heatmaps). V1 is unchanged. The
phased plan, and the packet decisions it supersedes (D-002, D-006, D-008, D-010, D-011 and the V1
non-goals), are in [ROADMAP.md](ROADMAP.md#scope-changes-this-plan-makes). The section below still
describes V1.

## Deferred or out of scope (by the packet)

- **REQ-013 / S17 Pro purchase** — V1.1 (F10). No purchase UI, entitlement checks or simulated
  paywall exist; nothing in V1 depends on billing.
- The packet's V1 non-goals — public feeds, comments, messages, global leaderboards, route
  discovery or sharing, automatic pause, live location sharing, training plans, wearable/HealthKit/
  Strava/Garmin imports, and an Android launch — are not built.

## Development environment

| Decision | Why | Limitation |
|---|---|---|
| `npm run dev:backend` runs the production API service in development mode (seeded runners share a demo password, `123456` works for every address in code mode, competition on) over a local Postgres | The app runs end to end against the same code as staging and production, without Docker | Email delivery and Sign in with Apple are exercised only on staging and a device |
| Web preview kept runnable | Enables the browser walkthrough and fast UI review | Unencrypted SQLite, no background location/share sheet/notifications — never a product target |
| Browser walkthrough uses a scripted Geolocation API and Playwright's clock | Reproduces the packet's exact run (5.24 km in 31:28) deterministically | Proves flows and integration only — not GPS quality (see DEVICE_TEST_PROTOCOL.md) |
