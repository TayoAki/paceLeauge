# Implementation decisions

Choices made while building V1 from the packet, including every deliberate difference from it.
The packet (`docs/packet/`) remains the source of truth; where this file and the packet disagree,
the reason is stated here.

## Architecture

| Decision | Why | Consequence |
|---|---|---|
| All authority in PostgreSQL: RLS + SECURITY DEFINER RPCs, no Edge Functions | Validation, allocation, scoring and ledger writes happen in one transaction under a per-user advisory lock, so concurrency and idempotency are provable with a real database; no service-role key exists anywhere in the system | Business rules live in SQL migrations; the TypeScript validator mirrors them for live estimates and is held equal by the parity suite |
| XP is always recomputed from day allocations, and the ledger stores deltas | Re-scoring after a delete, a review decision or a paused competition converges on the same totals; "splitting runs to beat the cap" is impossible by construction | Scoring is O(affected days), not O(history) |
| Standings computed at read time, with week revisions recorded after settlement | Corrections (deleted runs, review decisions) can't leave stale materialized ranks; revisions make later changes visible instead of silent | League reads do a bounded aggregation (≤ 20 members × 7 days) |
| `competition_enabled` ships **off** | The packet: keep ranking disabled until accepted-run validation and concurrency pass in staging | Recording, history and uploads work regardless; the dev backend and test suites turn it on |
| Join/invite failures are returned as values, not raised | A raised error rolls back the rate-limit counter, which would make invite-code guessing unlimited — found and fixed during testing | The client converts `{error}` values back into typed errors |
| Invite codes: 8 Crockford base32 characters, stored as SHA-256 hashes, 7-day expiry, ≤ 10 live per league | Short enough to read aloud, ambiguity-free (I/L→1, O→0), useless if the table leaks | Rotation revokes all live codes |
| One encrypted journal per account, plus a pinned "recording account" | Account B can never read or claim A's queue (AC-REQ-001-02), and the headless background task always writes to the account that started the run | Sign-out waits for an active run to be finished or discarded |
| Telemetry stored in the project's own database (`log_events`), allowlisted and enumerated | Minimization (REQ-015) without a third-party analytics SDK or new data processor | Dashboards read `private.operational_events`; retention 14 days |
| Email one-time **codes**, not magic links | Links opening the wrong app/browser are a common mobile failure; codes work across devices | Template in `supabase/templates/sign-in-code.html` |

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

## Deferred or out of scope (by the packet)

- **REQ-013 / S17 Pro purchase** — V1.1 (F10). No purchase UI, entitlement checks or simulated
  paywall exist; nothing in V1 depends on billing.
- The packet's V1 non-goals — public feeds, comments, messages, global leaderboards, route
  discovery or sharing, automatic pause, live location sharing, training plans, wearable/HealthKit/
  Strava/Garmin imports, and an Android launch — are not built.

## Development environment

| Decision | Why | Limitation |
|---|---|---|
| A small Node server (`scripts/dev-backend`) emulates Supabase Auth (email codes, refresh rotation) and PostgREST RPC over the real migrations | This environment has no Docker daemon for the Supabase CLI stack; the app still runs end to end against the production SQL | Not a replacement for a staging Supabase project: GoTrue specifics (email delivery, Apple, rate limits) are exercised only there |
| Web preview kept runnable | Enables the browser walkthrough and fast UI review | Unencrypted SQLite, no background location/share sheet/notifications — never a product target |
| Browser walkthrough uses a scripted Geolocation API and Playwright's clock | Reproduces the packet's exact run (5.24 km in 31:28) deterministically | Proves flows and integration only — not GPS quality (see DEVICE_TEST_PROTOCOL.md) |
