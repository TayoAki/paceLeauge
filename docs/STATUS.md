# Status and evidence

Snapshot: 26 September 2026 · rule version 1 · validator version 1.

**Summary.** Every V1 requirement except the deferred Pro purchase (REQ-013) is implemented, and
every screen S01–S16 exists and has been exercised in a browser against the real SQL backend. The
server-side rules (scoring, validation, leagues, access control, lifecycle) are proven by
automated tests against PostgreSQL. What is **not** proven yet is anything that needs a physical
iPhone: locked-screen GPS recording, real-world distance accuracy and battery, SQLCipher on
device, Sign in with Apple, notifications, the native share sheet, VoiceOver and 200 % text.
Those checks are specified in [DEVICE_TEST_PROTOCOL.md](DEVICE_TEST_PROTOCOL.md) and remain
**not run**. Per the packet, public release stays blocked until they pass.

## Evidence sources

| Source | How to run | What it proves | Last result |
|---|---|---|---|
| Unit tests | `npm test` | Domain rules (golden fixtures, validator, calendar/DST, allocation, splits, formatting), recorder service and state machine against a real SQLite journal, XP-panel states (saved ≠ synced ≠ accepted), API error mapping and backoff, preflight readiness, reminders, design tokens and contrast, export packaging | 15 suites, 111 tests passing |
| Backend integration | `npm run test:db` | All migrations applied to PostgreSQL 16 with Supabase's permissive default grants; RLS and grants across the whole catalog; upload protocol, idempotency and concurrency; scoring in SQL; leagues; export/deletion/moderation lifecycle; TypeScript ↔ SQL validator parity on 40 adversarial routes; the real client recorder + sync engine against real SQL | 6 suites, 80 tests passing |
| Browser walkthrough | `npm run e2e:web` | The real app (web build) against the development backend: email sign-in, preflight with a scripted GPS feed, a 31:28 recording with pause, finish, sync and the server's +77 XP, offline finish synced later (+4 XP as a same-day delta), a too-short personal-only run, share poster, league standings, invite preview and explicit join by a second identity, export, and account deletion | All steps passing (43 screenshots; the only console errors are the expected network failures during the deliberate offline step) — contact sheets in [evidence/web](evidence/README.md) |
| Physical iPhone | [DEVICE_TEST_PROTOCOL.md](DEVICE_TEST_PROTOCOL.md) | Background location, accuracy, battery, encryption at rest, Apple sign-in, notifications, share sheet, accessibility | **Not run** — no device available to this build |

The development backend emulates the two Supabase surfaces the app uses (Auth email codes and
PostgREST RPC) over the same migrations; it is not a substitute for a staging Supabase project,
which has not been provisioned yet (see [OPERATIONS.md](OPERATIONS.md)).

## Requirements

Status key: **Verified** — acceptance criteria covered by passing automated evidence and nothing
device-specific remains · **Implemented, device pending** — logic verified automatically; the
acceptance criteria also need the device checks listed · **Deferred** — intentionally not built.

| Req | Scope | Status | Automated evidence | Still required |
|---|---|---|---|---|
| REQ-001 | Account and onboarding | Implemented, device pending | Email code sign-in, onboarding and profile validation in the walkthrough; alias rules and case-insensitive uniqueness (`access.test.ts`); per-account journals and "another account cannot see or claim this run" (`client-sync.test.ts`) | Sign in with Apple on device; cold-restart session restore; used/expired code against real Supabase Auth (EV-001) |
| REQ-002 | Permission and preflight | Implemented, device pending | Readiness only with permission + fresh accurate fix, each blocker in order (`preflight.test.ts`); prompt → grant → "GPS good" → countdown in the walkthrough | Allow Once, permanent denial, approximate location, revocation mid-run on iOS (EV-002) |
| REQ-003 | Record, pause, resume, recover | Implemented, device pending | 15 recorder-service and 7 state-machine tests: pause excluded, one active run, recovery after process death ends at last evidence, permission loss interrupts, point limit; 31:28 with pause in the walkthrough | **F01**: locked-screen 30-minute run, phone call, force-quit/reboot, distance error (NFR-002) and battery (NFR-003) on two iPhones (EV-003) |
| REQ-004 | Finish and preserve | Implemented, device pending | Repeated Finish → one run; failed local write never reports success and keeps the session (`recorder.test.ts`); offline finish shows "saved on this phone" and syncs later (walkthrough, `client-sync.test.ts`) | Relaunch after offline finish and crash-during-save on device; NFR-004 timings (EV-004) |
| REQ-005 | Idempotent sync | Verified (logic) · load test pending | Ten concurrent finalizes → one result and one set of score effects; resumable uploads; conflicting chunk and manifest rejection; idempotency key reuse/conflict (`runs.test.ts`); interrupted upload credited once, waits for auth instead of failing (`client-sync.test.ts`) | NFR-005 latency and NFR-009 scale (1,000 accounts, 25 concurrent finalizations) on staging |
| REQ-006 | XP and ranks | **Verified** | Golden fixtures in TS and SQL (77 XP; 820 → 897; 603 to Tempo; 39.7 %); split runs can't beat the cap; midnight and DST allocation; phone time zone ignored; future timestamps; deletion reverses XP; two devices on one day → one bonus; 40-route parity | — |
| REQ-007 | Private weekly league | **Verified** | Preview + explicit join; unknown/revoked/expired/full/closed invites; 25 parallel joins never exceed 20; best three days; ties; post-join segments only; settlement deadline; fall-back week; removal denies reads immediately and blocks old invites; blocked members stay hidden rows (`leagues.test.ts`); second identity joins via invite in the walkthrough | — |
| REQ-008 | Progress and history | Implemented, device pending | Keyset pagination, rename (title only, versioned), delete with tombstone and XP reversal (`runs.test.ts`); miles without changing stored metres (`format-codec.test.ts`); empty/offline states in the walkthrough | History after app relaunch on device (EV-008) |
| REQ-009 | Safe share card | Implemented, device pending | Poster is a separate stats-only composition (no map component can be captured); rendered and exported in the walkthrough; accessible text summary on the preview | Inspect the exported PNG for metadata; share-sheet cancellation; Photos permission denied (EV-009) |
| REQ-010 | Privacy, export, deletion | **Verified** (server) · device pending (local) | Other users, league owners and anonymous callers can't read routes or exports, including guessed IDs; recent sign-in required; 3 exports/day; deletion hides immediately, hands over or closes the league, retries an interrupted cleanup and completes (`lifecycle.test.ts`, `access.test.ts`); export and deletion flows in the walkthrough | Local journal and key removal on device; provider backup retention setting (NFR-010) |
| REQ-011 | Abuse controls | **Verified** (server) · ops pending | Name filter; report queue with snapshot, staff-only, audited moderator action; blocked/removed users can't bypass via cached invite or direct API (`leagues.test.ts`, `lifecycle.test.ts`) | Real reviewer contact and moderation rota before launch (OPERATIONS.md) |
| REQ-012 | Optional reminders | Implemented, device pending | One identifier replaced on every change (never duplicated), cancelled on opt-out and sign-out, restored after sign-in only when enabled and permitted, changes applied strictly in order (`reminders.test.ts`); calm copy; web preview disables it | Permission denial, DST and sign-out on device (EV-012) |
| REQ-013 | Pro purchase | **Deferred (V1.1)** | No purchase UI, no "Manage subscription" row, no simulated paywall; nothing in V1 depends on it | F10 per the packet |
| REQ-014 | Accessible native UX | Implemented, device pending | Every control labelled (no icon-only actions without labels); text alternatives for charts and the poster; token contrast ratios asserted (`design-tokens.test.ts`); font-scaling caps per text style; ≥ 44 pt targets; no rank-up animation to reduce | VoiceOver full journey, 200 % text on the smallest iPhone, sunlight review (EV-014) |
| REQ-015 | Telemetry and operations | Implemented, ops pending | Allowlisted events with enumerated properties, deduplicated (`lifecycle.test.ts`); environment tag on every event; recording and history keep working with competition disabled (`runs.test.ts`); `private.health_report()` for backlog checks | Non-production dashboard, alert routing and on-call before pilot (EV-015) |

## Screens

| Screen | Route | Walkthrough screenshot(s) |
|---|---|---|
| S01 Welcome / sign-in | `/welcome`, `/sign-in` | `01-welcome`, `01b-sign-in-email`, `01c-sign-in-code` |
| S02 Onboarding | `/onboarding` | `02-onboarding`, `02b-onboarding-filled` |
| S03 Today | `/(tabs)` | `03-today`, `03b-today-after`, `03c-today-new-runner` |
| S04 Preflight | `/run/preflight` | `04a-preflight-permission`, `04-preflight-ready`, `04b-countdown` |
| S05 Live run | `/run/active` | `05a-running-early`, `05-running` |
| S06 Paused / interrupted | `/run/active` | `06-paused` (interrupted state: unit-tested; needs a device to trigger) |
| S07 Summary | `/run/summary/[id]` | `07-summary`, `07b-summary-offline`, `07c-summary-synced-later`, `07d-summary-personal-only` |
| S08 League — no crew | `/(tabs)/league` | `08-league-empty`, `08b-join-code` |
| S09 Weekly league | `/(tabs)/league` | `09-league`, `09b-invite-sheet`, `09c-league-rules`, `09d-league-last-week`, `09e-member-sheet`, `09f-manage-league` |
| S10 Invite | `/invite/[code]` | `10-invite`, `10b-joined-league` |
| S11 Progress | `/(tabs)/progress` | `11-progress`, `11b-progress-after` |
| S12 Run detail | `/(tabs)/progress/runs/[id]` | `12-run-detail`, `12b-run-detail-splits` |
| S13 Share | `/share/[id]` | `13-share` |
| S14 Profile / privacy | `/(tabs)/profile`, `/profile/privacy` | `14-profile`, `14b-privacy`, `14c-edit-profile`, `14d-notifications`, `14e-blocked`, `14f-support` |
| S15 Export | `/profile/privacy` | `15-export` |
| S16 Delete account | `/profile/delete-account` | `16-delete-account`, `16b-delete-confirm`, `16c-after-deletion` |
| S17 Pro | — | Deferred (REQ-013) |

Compared with the design boards, the screens match the packet's copy, numbers and hierarchy
(Today 820 → 897 XP, "2 of 3" → "3 of 3 active days", League 257 XP in 2nd place behind Maya's 289,
Summary "+77 XP · 52 distance + 25 active day", the stats-only poster). Intentional differences:
"Continue with Apple" appears only on iOS; "Manage subscription" is hidden in the free pilot (as the
packet instructs); the web preview draws routes on a plain grid instead of Apple Maps; League rows
also show each runner's tier.

## Known gaps before a pilot

1. **F01 on two physical iPhones** — the packet's first gate. Nothing about background GPS,
   distance accuracy or battery is claimed until it is run.
2. **Staging Supabase project** — apply the migrations with the Supabase CLI, configure email
   templates and Sign in with Apple, then rerun the integration suite against it and the load
   checks (NFR-005, NFR-009).
3. **Operations** — support/reviewer contacts, moderation rota, alerting on
   `private.health_report()`, backup retention, and legal pages (terms/privacy URLs).
4. **Human accessibility review** — VoiceOver, 200 % text and outdoor legibility on device.
