# PaceLeague — Factory PRD

## Document control

Status: **DRAFT for implementation planning**. Product: a private running competition app. Decision owner: founder/user; engineering and design approvers: unassigned. No human approval of the proposed product decisions is recorded. Related files: DISCOVERY_PACKET.md, TECHNICAL_SPEC.md, PROTOTYPE_BRIEF.md, EVAL_PLAN.md, and PLAN.md. Version 1.0, 2026-09-26 UTC.

## Problem and evidence

Help an adult recreational runner turn a recorded run into understandable progress and a small-group reason to return. The category pattern is documented by Runify [E-001, E-002]; unmet need and willingness to pay remain hypotheses [E-010]. Build an original interface and original rules. Runify is a reference, not an affiliation or a specification to reproduce.

**Promise:** “Track your runs. Build your rank. Find your crew.” Proposed difference: rank does not decay with inactivity; only the best three daily scores determine each weekly competition; routes never appear to league members in V1.

## Goals and success measures

| Goal | Metric | Baseline | Initial threshold | Window / instrumentation |
|---|---|---|---|---|
| First useful outcome | Seven-day activation | Not measured | 60% with at least 30 accounts | Account creation to first accepted run; server events |
| Useful repetition | Week-four running retention | Not measured | 40%, directional | Matured 28-day activation cohort |
| Viable social loop | Crews with three active members in week four | Not measured | Half of at least eight pilot crews | Weekly membership/run aggregates |
| Preserve effort | Completed-run save reliability | Not measured | No confirmed lost completed runs | Device test and pilot operational receipts |
| Earn revenue later | Verified purchase contribution | Not measured | Positive before acquisition, then below bounded CAC ceiling | Separate V1.1 paid experiment |

These are test rules, not forecasts. The discovery packet defines denominators, exclusions, and owners.

## Non-goals

V1 excludes public feeds, comments, direct messages, global/country leaderboards, pace races, cash prizes, wagering, route discovery, navigation, automatic pause, live location sharing, training plans, medical advice, AI coaching, wearable apps, HealthKit imports, Strava imports, Garmin sync, treadmill distance estimation, and Android launch. No paid feature changes XP or ranking. Short runs and incomplete recordings can still be saved as personal history.

## Release scope

| Capability | Free pilot / V1 | V1.1 after retention | Later, conditional |
|---|---|---|---|
| Phone GPS recording, pause, resume, offline save | Build | Improve from real evidence | Android recorder |
| Lifetime ranks and personal history | Build | Advanced trend comparisons | Further achievements |
| One private league, 20 people, invite link/code | Build | Keep free | Additional leagues only after demand |
| Stats-only share image | One template | Optional premium styles | Privacy-reviewed route sharing |
| Account/export/deletion, moderation, support | Build | Maintain | Market-specific adaptations |
| Billing | Free pilot; no paywall | Annual Pro with working premium features | Additional offers after evidence |
| Watch/provider imports | Exclude | Separate feasibility decision | Explicit rights, provenance, deduplication, device verification |

## Users, jobs, and permissions

| Actor | Allowed | Prohibited |
|---|---|---|
| Visitor | View welcome, terms, privacy, limited invite preview | Read members, runs, or coordinates |
| Runner | Record; view/edit own title; delete/export own records; see own league standings | Modify distance/time after acceptance; write own score or entitlement |
| League owner | Runner actions; invite, rename, remove members, rotate invite | Access routes, email addresses, or other users' private history |
| Moderator | Review reported alias/league name; resolve conduct reports with audit trail | Browse raw routes as a routine moderation tool |
| Privileged operator | Restore service, investigate tightly scoped incidents, reconcile data | Unlogged casual access or granting score/payment from the client |
| Billing service (V1.1) | Reconcile verified entitlements | Change runs or competitive XP |

Identity comes from verified authentication, membership from current server records, and paid access from verified purchase state. They are separate checks.

## Proposed behavior

The new runner signs in, chooses an alias, units and an optional one-to-three-day weekly goal, then reaches Today. “Start run” opens preflight and requests location in context. After a GPS fix and the needed permission, a cancellable three-second countdown starts recording. Pause freezes active elapsed time and distance accumulation; resume creates a new segment. Finish is available from paused state and saves locally before networking. The summary displays provisional XP until accepted by the server. League points update only after acceptance. “Done” returns to Today; sharing uses a separate stats-only preview and the system share sheet.

The runner can create or join one league after the first run, or use an invitation during onboarding. Joining is optional; the recorder and personal progress remain useful alone. The invite flow requires an explicit join action, restores the intended destination after sign-in, and never uploads contacts.

## Requirements and acceptance criteria

### REQ-001 — Account and onboarding

- Rationale: D-001, D-009; account lifecycle evidence E-006.
- Actor/precondition: visitor with network access for first sign-in.
- Behavior: Apple sign-in and email OTP; alias, units, adult-pilot eligibility acknowledgement, and optional weekly goal. Alias is 2–24 characters; no contact discovery or public searchable profiles. Default units follow locale; metric is used in design fixtures.
- Recovery: cancellation returns to welcome; expired OTP can be requested again with rate limits; session expiry prompts reauthentication while keeping the local run associated with its original account.
- AC-REQ-001-01: Each provider independently restores the same account after cold restart; a used or expired OTP does not authenticate.
- AC-REQ-001-02: Account B cannot read account A's local queue after sign-out or login; unfinished uploads cannot silently transfer ownership.
- Verification: EV-001, provider/device tests and cross-account integration tests.

### REQ-002 — Permission and preflight

- Rationale: E-003, D-012.
- Behavior: describe why location is needed before native prompts; obtain foreground/precise location and background permission for screen-locked recording using the chosen version's native APIs. Preflight may request a short-lived current fix; leaving preflight stops that request.
- Recovery: denied/restricted or approximate-only location explains the limitation and offers Settings or “Not now.” The full ranked recorder is disabled until precise/background requirements are met; history and league remain accessible. Do not mislabel foreground-only recording as locked-screen capable.
- AC-REQ-002-01: “Ready” appears only when observed permission state and a fresh fix meet configured criteria; revoked permission changes the visible state.
- AC-REQ-002-02: “Allow Once,” permanent denial, no GPS fix, and permission revoked mid-run each have an exercised recovery path; no repeat prompt loop.
- Verification: EV-002 on physical devices, not a web preview.

### REQ-003 — Record, pause, resume, and recover

- Rationale: E-003, E-009, D-002.
- Behavior: one active run per device; persist points and state through a single recording service; record with screen locked; show distance, active elapsed time, average pace, GPS quality, pause, and touch lock. Touch lock is an accidental-tap safeguard, not device security. No automatic pause in V1.
- Recovery: signal gaps remain gaps; never draw invented connecting distance. After process termination, offer the last durable partial run on next launch and label it interrupted; do not promise tracking while force-quit.
- AC-REQ-003-01: A 30-minute locked-screen route, manual pause/resume, phone call interruption, and offline interval produce one durable session with pause intervals excluded.
- AC-REQ-003-02: Killing the app yields a recoverable checkpoint after relaunch and no claim of uninterrupted tracking; starting a second run requires resolving the first.
- Verification: EV-003, device trace and known-distance comparison.

### REQ-004 — Finish and preserve the result

- Rationale: D-002; avoiding lost effort.
- Behavior: paused screen offers Resume, Finish, and Discard. Finish durably commits the local session and summary before “Run saved.” Discard is a destructive confirmation. Saving a short or incomplete run is allowed even if it earns no ranked XP.
- AC-REQ-004-01: Finishing offline and reopening the app preserves distance, active elapsed time, segments, and pending-sync status.
- AC-REQ-004-02: Repeated Finish taps create one session; a failed local write cannot show success and retains the active session for retry.
- Verification: EV-004, disk failure injection and app relaunch.

### REQ-005 — Idempotent synchronization

- Rationale: E-004, D-003.
- Behavior: account-scoped durable outbox; batch route chunks; authoritative server validation; upload/retry/finalize status. Never require a network response to stop a run. Reauthentication retains the queue. An older duplicate reply cannot overwrite a newer result.
- AC-REQ-005-01: Ten concurrent finalize requests for the same run revision yield one accepted result and one set of daily-score effects.
- AC-REQ-005-02: A disconnected upload resumes missing chunks; conflicting contents at an existing sequence number fail with a recoverable conflict, not double credit.
- Verification: EV-005, network fault and concurrency tests.

### REQ-006 — Transparent XP and ranks

- Rationale: D-004, D-005; motivation hypothesis E-010.
- Behavior: use the versioned scoring contract in TECHNICAL_SPEC.md. Show separate lifetime rank, daily earned XP, and weekly league score. Points are server-controlled; provisional local estimates are clearly labeled. Rank never decays due to inactivity; deletion or invalidation can reverse credited data.
- AC-REQ-006-01: The 5,240 m, 31:28 first eligible activity of a day earns 77 XP; lifetime 820 becomes 897; 603 remains to Tempo.
- AC-REQ-006-02: Splitting one distance into runs cannot evade the daily cap; duplicate upload, timezone change, pause, future timestamp, and deleted run cases follow the documented results.
- Verification: EV-006, golden scoring cases and transaction tests.

### REQ-007 — Private weekly league

- Rationale: E-002, E-010, D-005, D-008.
- Behavior: one league per runner, maximum 20 members including owner. Create/join/invite, current and prior week standings, own position, rules, exact local closing time, and provisional/final state. Member preview exposes alias, rank tier, weekly score only. Tie scores share a rank; alphabetical alias then member ID stabilizes display without awarding a better place.
- Recovery: expired/full/revoked invites are explicit; leaving removes current visibility and standings; moving between leagues requires leaving first. New members' current-week score starts from eligible segments at or after joining. Ownership must be transferred or the empty league closed before its owner leaves.
- AC-REQ-007-01: A valid invitation followed by explicit acceptance adds the user once and shows standings only after server membership exists.
- AC-REQ-007-02: Revoked membership denies reads immediately; parallel joins cannot exceed capacity; the weekly rollover uses the named timezone including daylight-saving changes.
- Verification: EV-007, two-user access, capacity race, and calendar tests.

### REQ-008 — Progress and personal history

- Rationale: D-002, E-010.
- Behavior: lifetime tier, weekly goal, four-week distance view, paginated history, and own run detail including a private route and splits. Rename title only; no edits to accepted distance, time, or raw points. Explain personal-only runs and review status.
- AC-REQ-008-01: History remains after restart, uses chosen distance units without changing stored meters, and supports empty/partial/offline states.
- AC-REQ-008-02: Deleting a run removes it and its route from all current views and recalculates affected totals; no paid gate blocks data access or export.
- Verification: EV-008, persistence, units, pagination, and deletion tests.

### REQ-009 — Safe share card

- Rationale: D-006.
- Behavior: render a separate 4:5 or 9:16 stats composition with distance, active elapsed time, pace, and app brand. No map, place label, precise start time, location metadata, email, or hidden coordinates. Preview before opening the system share sheet; user selects the destination.
- AC-REQ-009-01: Exported raster contains the displayed statistics and no route layer or location metadata; share cancellation creates no post.
- AC-REQ-009-02: The accessible preview has a text summary; missing photo-library permission does not block use of the share sheet.
- Verification: EV-009, image/metadata inspection and native sharing checks.

### REQ-010 — Privacy, export, and account deletion

- Rationale: E-004, E-006, D-006.
- Behavior: routes are owner-only. Export provides personal activity data and GPX/JSON through authenticated delivery. In-app deletion requires recent authentication, confirms consequences, immediately hides the profile/league presence, and queues retryable cleanup. Explain separate store billing management when relevant. Do not require subscription cancellation before accepting deletion.
- AC-REQ-010-01: A different user, league owner, and anonymous request cannot retrieve a route or export, including by guessed IDs and stale links.
- AC-REQ-010-02: A deletion job removes owned primary data and local caches under the proposed lifecycle, revokes sessions, retries interrupted steps, and records completion without retaining route data in logs.
- Verification: EV-010, multi-identity tests and disposable-account deletion drill.

### REQ-011 — Basic social abuse controls

- Rationale: E-005; aliases and league names are user-generated even without chat.
- Behavior: server-side name validation/filtering, report alias/league/member, block a user, leave a league, owner removal, moderator queue, and reachable support. Blocking removes mutual profile visibility and invitation capability; a hidden row retains aggregate rank gaps so standings are not falsified. Do not expose a blocked alias via notifications or exports.
- AC-REQ-011-01: A report reaches a restricted queue with its content snapshot; moderator action and reason are audited; reviewer contact instructions are real before launch.
- AC-REQ-011-02: A blocked or removed user cannot bypass restrictions through a cached invite or direct API request.
- Verification: EV-011, abuse flow and access tests.

### REQ-012 — Optional reminders

- Rationale: D-004, privacy/minimization decision.
- Behavior: one optional local reminder at a runner-selected time, opt-in after value is experienced. No rank-loss threats, pace pressure, or sensitive lock-screen copy. No remote social pushes in V1.
- AC-REQ-012-01: Opt-out or sign-out cancels scheduled reminders; timezone/daylight-saving handling does not duplicate them.
- AC-REQ-012-02: Notification denial leaves all core features usable.
- Verification: EV-012, device scheduling tests.

### REQ-013 — Optional Pro purchase (V1.1, not a V1 dependency)

- Rationale: E-007, D-007; business experiment, not validated demand.
- Behavior: native store purchase via RevenueCat, verified entitlement, restore, manage subscription, and clear localized price/period/renewal copy. Annual USD 29.99 is an unconfigured test hypothesis. Pro provides implemented advanced personal comparisons and premium share styles; core tracking, ranks, league membership, privacy, history, and export remain free.
- AC-REQ-013-01: Sandbox purchase, restore after reinstall, pending approval, cancellation-at-renewal, expiry, refund/revocation, and account switch produce documented entitlement states.
- AC-REQ-013-02: Forged, duplicate, delayed, or out-of-order billing events cannot grant or resurrect access; billing failure never blocks finishing a run.
- Verification: EV-013, purchase sandbox and webhook tests after premium features exist.

### REQ-014 — Accessible native UX

- Rationale: D-001, inclusive product design decision.
- Behavior: VoiceOver labels/order, scalable typography, non-color state indicators, reduced-motion support, safe areas, accessible pause/finish, and one-handed control sizes. Text-only summaries accompany charts and maps.
- AC-REQ-014-01: A VoiceOver user can start, pause, finish, find their result, and initiate deletion without unexplained icon-only actions.
- AC-REQ-014-02: 200% text on the smallest supported screen has no clipped primary action or overlapping metrics; chart values are available in text; reduced motion removes rank-up animation.
- Verification: EV-014, device accessibility and measured color checks.

### REQ-015 — Minimized telemetry and operations

- Rationale: D-006, reliable product measurement.
- Behavior: event allowlist; no coordinates, routes, tokens, email, run titles, or precise health statistics in crash/analytics payloads. Session replay disabled. Operational events record reason codes, latency buckets, build ID, and pseudonymous account/run IDs only when necessary.
- AC-REQ-015-01: Test events reach the intended non-production dashboard without sensitive fields; production and test cohorts remain distinct.
- AC-REQ-015-02: Loss of analytics does not block saving; outbox/backlog alarms and reporting failure have assigned responses before pilot expansion.
- Verification: EV-015, payload inspection and incident drill.

## Data, state, and interfaces

The technical spec owns the proposed schema, API contracts, recording states, scoring algorithm, and deletion lifecycle. Local SQLite is authoritative for an unsynced recording; the server is authoritative for accepted statistics, XP, membership, and entitlements. No client write can directly grant any of those authorities. Every privileged mutation checks current identity and object access, including jobs and billing handlers.

## Non-functional requirements

All thresholds are initial **acceptance targets to verify**, not demonstrated performance or guarantees. Linked requirements provide rationale and ownership.

| ID | Quality | Target / boundary | Verification |
|---|---|---|---|
| NFR-001 | Local durability | Checkpoint at most every 5 seconds while callbacks arrive; zero lost completed sessions in 50 deliberately interrupted test sessions | EV-003/004; OS-suppressed callbacks reported separately |
| NFR-002 | Distance | Median absolute error within 5% on ten measured 1–5 km open-sky routes across two iPhones | EV-003; include poor-signal cases without treating estimate as certified distance |
| NFR-003 | Battery | Initial goal: at most 8 percentage points per hour median, screen locked, on two named devices; compare with idle baseline | EV-003; report device, OS, battery health and settings |
| NFR-004 | Responsiveness | Pause feedback within 150 ms; local summary within 1 second at p95 on target device | EV-004; transitions must not wait for network |
| NFR-005 | Network | Online finalize p95 within 5 seconds at pilot load; retryable reads time out after 10 seconds | EV-005; separate route upload duration |
| NFR-006 | Access | All route/history/league mutations pass absent-user, other-user, stale-member, invalid-input tests | EV-007/010/011 |
| NFR-007 | Accessibility | Text contrast at least 4.5:1 for normal text; controls at least 44×44 pt on iOS, plan 48 dp on Android | EV-014; actual device/layout checks required |
| NFR-008 | Payload limits | 500 points or 128 KiB per upload chunk; maximum 50,000 points per run; bounded pagination | EV-005; oversized input has no partial unauthorized writes |
| NFR-009 | Pilot scale | Exercise 1,000 accounts, 50 leagues and 25 concurrent finalizations in staging | EV-005/007; a test load, not a user forecast |
| NFR-010 | Data lifecycle | Hide deleted account promptly; complete primary-data cleanup within 7 days; proposed backup expiry at most 30 days | EV-010; verify actual provider settings before promising this |
| NFR-011 | Maintainability | Versioned DB migrations and scoring, reproducible dependency lock, isolated environments | EV-015 and PLAN milestones |

## UX and content contract

Four tabs: Today, League, Progress, Profile. Run flow uses a full-screen stack above tabs to prevent accidental navigation. Native back, sheets, alerts, safe areas, and system share behavior take precedence over a raster concept. Screen specifications and tokens are in PROTOTYPE_BRIEF.md and design-tokens.json. Generated text or geometry never overrides this written behavior.

## Analytics and evaluation

Use account_created, onboarding_completed, permission_result, run_started, run_saved_local, run_sync_outcome, league_joined, league_week_participated, share_sheet_opened, deletion_requested, and deletion_completed. Paid stage adds offer_viewed, purchase_verified, entitlement_changed, and refund_observed. Deduplicate event IDs; record schema version and environment. Never infer a shared post from share-sheet opening. Definitions and post-launch decisions appear in EVAL_PLAN.md and BUSINESS_AND_LAUNCH.md.

## Dependencies, risks, and open decisions

The first blockers to public release are real device evidence, named operator/support facts, final account lifecycle settings, moderation coverage, store configuration, and user validation. The largest architecture risk is background GPS reliability. The largest commercial risk is a compelling-looking league that fails to retain crews. External imports are not dependencies for V1. All recommended services require actual setup and version compatibility review.

## Rollout and rollback

Progress from internal devices to eight invited TestFlight crews, then a limited public launch only after gates pass. Keep ranking disabled by a server flag until accepted-run validation and concurrency tests pass; maintain recording/history when competition is disabled. Roll back client JavaScript only through a tested compatible runtime. Native changes require a new build; store installations cannot be instantly rolled back. Use backward-compatible server changes, a preserved prior release, and an incident runbook. Suspend new invites or Pro sales independently of the recorder.

## Traceability matrix

| Claim / rationale | Requirement | Acceptance IDs | Evaluation | Current result |
|---|---|---|---|---|
| E-006, D-009 | REQ-001 | AC-REQ-001-01 / 02 | EV-001 | Not run |
| E-003, D-012 | REQ-002 | AC-REQ-002-01 / 02 | EV-002 | Not run |
| E-003, E-009 | REQ-003 | AC-REQ-003-01 / 02 | EV-003 | Not run |
| D-002 | REQ-004 | AC-REQ-004-01 / 02 | EV-004 | Not run |
| E-004, D-003 | REQ-005 | AC-REQ-005-01 / 02 | EV-005 | Not run |
| E-010, D-004 / 005 | REQ-006 | AC-REQ-006-01 / 02 | EV-006 | Not run |
| E-002, D-008 | REQ-007 | AC-REQ-007-01 / 02 | EV-007 | Not run |
| E-010, D-002 | REQ-008 | AC-REQ-008-01 / 02 | EV-008 | Not run |
| D-006 | REQ-009 | AC-REQ-009-01 / 02 | EV-009 | Not run |
| E-004, E-006 | REQ-010 | AC-REQ-010-01 / 02 | EV-010 | Not run |
| E-005 | REQ-011 | AC-REQ-011-01 / 02 | EV-011 | Not run |
| D-004 | REQ-012 | AC-REQ-012-01 / 02 | EV-012 | Not run |
| E-007, D-007 | REQ-013 | AC-REQ-013-01 / 02 | EV-013 | Deferred V1.1 |
| D-001 | REQ-014 | AC-REQ-014-01 / 02 | EV-014 | Not run |
| D-006 | REQ-015 | AC-REQ-015-01 / 02 | EV-015 | Not run |

## Approval gate

Planning packet complete; implementation evidence absent. Readiness: **READY WITH ASSUMPTIONS for estimation and the bounded technical prototype; BLOCKED for public release**. Founder approval, named delivery owners, device feasibility, and customer evidence must be recorded at the relevant next checkpoints. There is no requirement to approve this packet merely to view or use its design artifacts.
