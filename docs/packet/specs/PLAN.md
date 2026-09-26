# PaceLeague — Build plan

Outcome: a runner can record and preserve a real run, understand their progress, and participate in one private weekly league. Target: iPhone internal prototype, then closed TestFlight pilot, then a limited public V1. Android and Pro are later increments. All features below are **planned**, not implemented.

## Feature backlog and order

| ID | Deliverable / outcome | Dependencies | Approximate effort | Observable completion |
|---|---|---|---|---|
| F00 | Confirm segment, brand placeholder, operator, platform order, owners; create repo and compatibility record | None | 2–4 person-days | Decision log updated; reproducible native dev build; no production credentials in repo |
| F01 | GPS feasibility slice: start/pause/resume/finish, locked screen, local journal, interruption recovery | F00 | 5–8 person-days | Two physical iPhones meet initial recorder gates; show raw evidence, not only simulator screens |
| F02 | Native shell, tokens, Apple/email auth, onboarding, account-scoped local storage | F00, F01 feasibility | 5–8 person-days | Both providers tested; Today route and cache boundaries work |
| F03 | Complete recorder and local summary UI with all permission/error/recovery states | F01, F02 | 8–12 person-days | REQ-002/003/004 pass; visual comparison recorded |
| F04 | Backend schema, RLS, chunk upload, durable jobs, validator, daily XP and tiers | F03 | 10–14 person-days | Repeat/concurrent saves award exactly once; other-user reads/writes fail |
| F05 | Private league create/join, invitation, standings, ties, rollover, member removal | F04 | 8–12 person-days | Two-account end-to-end flow and capacity/calendar tests pass |
| F06 | Progress/history, private details, rename/delete, stats share card | F04 | 5–8 person-days | Persistence, deletion recalculation, correct share without route |
| F07 | Export/account deletion, report/block/moderation, support and telemetry | F02, F04, F05 | 8–12 person-days | Lifecycle/abuse drills pass; redacted monitoring event observed |
| F08 | Accessibility, device regression, pilot configuration, store preparation | F03–F07 | 8–12 person-days | Critical EVAL_PLAN cases pass; real review package assembled |
| F09 | Four-week invited pilot; correct measured failures; go/no-go | F08 | 6–10 person-days spread over 4 weeks | Cohort report, incident closure, founder release decision |
| F10 | Advanced comparisons/share styles and optional Pro subscription | Retention decision after F09 | Separate 8–15 person-day estimate | Working features plus verified billing; never a simulated paywall |
| F11 | Android permission/foreground service/Google Play work | Stable iOS loop | Separate 15–25 person-day estimate | Named Android/OEM device matrix and store requirements pass |
| F12 | HealthKit/watch or other authorized imports | User evidence + integration rights | Estimate after feasibility | Proven provenance, deduplication, permissions and device support |

Effort figures are rough planning assumptions, not vendor quotes. F00–F09 totals 65–100 engineering/implementation person-days; design/research/release coordination add roughly 20–25 person-days. That is approximately **680–1,000 total hours** at eight hours per person-day. Calendar time is not the sum of isolated task ranges: a senior mobile engineer, part-time backend engineer and fractional design/QA support could target **10–14 weeks including the four-week pilot**, with overlapping work. Re-estimate after F01. A solo developer or unresolved GPS issues can take substantially longer.

## Milestone gates

1. **Feasibility:** F01 works on real devices. If it fails, resolve the recorder architecture before commissioning the rest.
2. **Complete private beta:** an authenticated user finishes offline, later receives one accepted score, and another authorized league member sees the permitted result. No raw route is exposed.
3. **Pilot readiness:** deletion, abuse handling, support, privacy, accessibility and operational checks are present, even though the cohort is small.
4. **Evidence to expand:** four-week behavior and reliability support a bounded next release. A pretty interface or many installs is not this gate.
5. **Paid readiness:** premium value exists and purchase-state tests pass before accepting money.

## First developer assignment

Build F01 only, using a disposable development configuration and synthetic/test route data. Deliver a native development build; start/pause/resume/finish UI; durable recording state and point journal; an interrupted-run recovery screen; two named-device test records; measured route error and battery observations; and a recommendation to continue with Expo or investigate a native recorder. This milestone does not require league screens, billing, watch imports, or a production backend.

## Implementation prompt

“Read this packet and the actual repository instructions. Implement feature F01 as the smallest complete start → record → pause → finish → recover flow. Verify the selected SDK documentation and dependencies. Use a native development build for background location. Preserve received data before rendering success. Exercise locked-screen, denied permission, lost GPS, offline, force-quit and relaunch cases on available physical devices. Record actual evidence and label every unavailable check as unverified. Do not mark a fixture or simulator-only result as a real outdoor run. Do not broaden into league, billing, or AI work.”

For each later feature, replace F01 with its ID, check dependencies, implement one user outcome, run the relevant EV cases, compare the real screen with the board, fix concrete differences, and update status/evidence. Suggested statuses: planned, in progress, implemented/unverified, verified, blocked, deferred. None is currently verified.

## Handoff checklist

Provide a builder the master Markdown, the specs directory, all three PNGs, design-tokens.json, sample-fixtures.json, and IMAGE_PROMPTS.md. Request an estimate against the feature IDs, an explicit native GPS plan, assumptions about provider costs, and ownership of the source repository/accounts. Signing, Supabase, stores, EAS, support domain/email, and later RevenueCat must belong to the founder's organization. Keep secret values out of chat and source control.
