# PaceLeague — Discovery packet

## Readiness

**READY WITH ASSUMPTIONS for design review, technical estimation, and a GPS feasibility prototype. BLOCKED for public release and claims of validated demand.** This is a completed planning and visual-design deliverable, not a built application. No interviews, purchases, device tests, or production deployments were performed.

Prepared 2026-09-26 UTC (2026-09-25 in the user's timezone). Working name: **PaceLeague**; name, domain, and trademark availability have not been checked. Decision owner: the founder/user. Proposed engineering, design, and support owners must be assigned before a pilot.

Confirmed request: a mobile app inspired by Runify, a comprehensive packet, generated images, a Markdown file, build scope, and technical direction. Assumptions: the reference is Runify: Running Tracker by OneDegree Labs; an original product; adult recreational runners; English; a US iPhone pilot; Android after the core loop is reliable. No existing repository or supplied research was available in this workspace.

## Executive recommendation

Build a private running competition app around one loop: **start a run → save it reliably → earn visible progress → see your weekly crew standing → return for another run.** Position it around attainable consistency: permanent lifetime ranks, weekly competition based on the best three active days, and private routes.

The first engineering investment should prove locked-screen recording, recovery, and synchronization on physical iPhones. The first product investment should test whether a small crew actually returns. Do not make watch integrations, AI coaching, public feeds, or a global leaderboard prerequisites for this proof.

This is a recommendation, not a proven market opportunity. Runify's first-party descriptions establish an existing product pattern [E-001, E-002]; they do not establish demand for PaceLeague. GPS feasibility constraints come from current Expo documentation [E-003]. The proposed differentiation is a hypothesis [E-010].

## Problem

**Hypothesized user:** an adult who runs recreationally one to four times per week, sometimes with friends, and likes visible progress without needing a formal training plan.

**Hypothesized problem:** activity trackers preserve statistics, but those statistics may provide little reason to come back. A global speed contest can feel unattainable, while a small private crew offers a more relevant comparison. Frequency, severity, and willingness to switch are not yet measured.

**Proposed job:** “After I run, show me that the effort counted, and give my friends and me a simple reason to keep showing up.” The first success is a saved run with understandable rewards. Repeat success is a second useful run and a league that stays active.

**Business hypothesis:** a free social core can create repeated use; some retained users will buy deeper personal insights and share-card customization. No revenue, market size, acquisition cost, or retention has been established.

## Hypotheses and alternatives

| Option | Benefit | Tradeoff | Recommendation |
|---|---|---|---|
| Use an existing tracker and a group chat | Little new software; fastest way to observe group behavior | Manual standings; no original product revenue | Use as a discovery comparison |
| Private challenge app with manually entered runs | Fast and cheap prototype | Easy to falsify; cannot prove GPS reliability | Suitable only for a clearly labeled concept test |
| Import-only leaderboard | Reuses runners' hardware | Platform permissions, duplicates, API restrictions, and rights to display imported data | Defer; not a dependable foundation |
| Own GPS recorder plus one private league | Delivers the complete proposed loop | Recording and offline recovery require real engineering | Recommended MVP |
| Full fitness platform with AI plans and watch apps | Broad feature range | Multiple unproven products and native integrations | Exclude from initial release |

H1: at least 60% of eligible invited pilot users save their first run within seven days. H2: at least 40% of activated users complete an eligible run in their fourth week. H3: at least half of pilot crews retain three active members in week four. These are **provisional decision thresholds**, not industry benchmarks or forecasts.

## Evidence synthesis

| Evidence | What it establishes | What it does not establish |
|---|---|---|
| E-001 / S01: Runify's website | Advertised GPS tracking, XP, ranks, competition, and recaps | Accuracy, retention, revenue, or demand for this concept |
| E-002 / S02: Runify App Store listing | Advertised clubs and social functionality | A requirement to copy every feature or visual treatment |
| E-003 / S03: Expo Location | Background tracking has platform constraints and needs an appropriate native build | Reliability on the eventual target devices |
| E-004 / S04: Supabase RLS | Database policies can restrict access by authenticated identity | Complete application security without correct policies and tests |
| E-005 / S05: Apple review guidance | Relevant review areas include UGC, payments, privacy, and original experiences | Store acceptance or legal compliance |
| E-006 / S06: Apple deletion guidance | Account deletion needs an explicit lifecycle | Automatic subscription cancellation when an app account is deleted |
| E-007 / S07: RevenueCat Expo guide | A supported Expo integration path exists | A configured, tested billing implementation |
| E-008 / S12: Strava API agreement | Material restrictions on competing functionality and cross-user data display | Approval for this app or a workaround around the agreement |
| E-009 / S08: Expo SQLite | A persistent local database and optional SQLCipher integration are available | A secure background key lifecycle or a tested recovery system |
| E-010: product hypothesis | Our proposed reason to choose PaceLeague | Observed user behavior |

## Contradictions and evidence gaps

Runify's website and regional store page display different review totals. No adoption, rating, or GPS-accuracy number is used to size this opportunity. Marketing statements about watch imports do not resolve the rights or technical feasibility of implementing those integrations ourselves.

No customer interviews, support records, cohort data, or purchase receipts were provided. We have not installed or exercised Runify. The research is a first-party feature/documentation review, not a hands-on competitor audit.

The Expo UI skill's broad Expo Go guidance is narrowed by current Expo Location documentation: this app's background recording requires a development build for meaningful verification. Static mockups are not evidence of a functioning recorder.

## Outcome and measurement contract

All current baselines are **not measured**. Founder owns product outcomes; engineering owns operational denominators. Exclude staff, seeded design fixtures, bots, and test purchases. Segment by app version, acquisition cohort, and permission outcome; never send coordinates to analytics.

| Metric | Definition / source | Window | Provisional decision rule |
|---|---|---|---|
| Activation | New eligible accounts with a first server-accepted GPS run / new eligible accounts; onboarding and run events | Seven days from account creation | Investigate onboarding if below 60% with at least 30 eligible accounts |
| Week-four running retention | Activated users with an accepted run on days 22–28 after first accepted run / activated users with complete 28-day observation | Matured activation cohort | Expand only directionally at 40% or more; inspect sample size and reasons |
| Crew viability | Pilot leagues with at least three distinct members each recording a run in week four / pilot leagues that began with at least five members | Four weeks | Seek at least 50% across at least eight leagues; small-sample evidence |
| Save reliability | Finished sessions durably saved locally / sessions for which finish was requested; local operational receipt | Every pilot week | Any confirmed lost completed run blocks expansion |
| Sync reliability | Online saved runs reaching accepted or explained review state within 60 seconds / online saved runs | Every pilot week | Initial target 99%; report network conditions and sample size |
| Purchase conversion | Verified first purchasers / eligible users shown the same priced offer | Separate paid experiment | Judge against contribution and refund data, not installs alone |

“Accepted” means passed the specified checks; it does not certify that an activity was genuine. Personal-only short or incomplete activities remain useful history but are outside ranked-run outcome metrics. Record them separately to detect unfair exclusion.

## Research and validation plan

1. Interview 12 adults: four irregular runners, four consistent runners, and four people who stopped using a fitness app. Include people outside the founder's friend group. Ask about their last three actual runs, existing tracker, skipped runs, sharing habits, and what they already pay for. Avoid asking only whether they like the idea.
2. Test five representative tasks with six participants: start recording, recover a paused run, explain XP, join a private league, and find export/deletion. Record unaided completion and confusion. The generated boards support a walkthrough; a later clickable prototype is needed for interaction timing.
3. Recruit eight crews of five to ten adults for a four-week TestFlight pilot after the device gate. Provide the same onboarding and disclose pilot limitations. Recruitment messages and spending are prepared work only; none have been sent or spent.
4. Compare perceived motivation and actual return behavior with the prior tracker/group-chat routine. This is observational unless cohorts are randomly assigned; do not claim causality.
5. Run the paid experiment only when premium capabilities work. Use real transactions and refund records. Signups and stated willingness to pay are separate evidence.

## Gate results

| Gate | Status | Evidence needed next |
|---|---|---|
| Problem | Hypothesis | Interviews and observed workarounds |
| Evidence | Partial | Primary documentation collected; customer evidence absent |
| Decision | Draft | Founder confirms segment, platform order, spending range |
| Specification | Prepared | Engineering review of GPS, scoring, and data lifecycle |
| Prototype | Visual concepts complete | Interactive usability and assistive-technology checks |
| Agent/action | Not applicable | No autonomous agent or AI coach in V1 |
| Release | Not started | Real builds, store configuration, operator facts, and verification |

The next bounded action is F01 in PLAN.md: a local GPS recorder feasibility slice on two physical iPhones. Public release remains a later decision; this packet does not claim that it happened.

## Source links

[S01]: https://www.runifyapp.com/
[S02]: https://apps.apple.com/us/app/runify-running-tracker/id6746146450
[S03]: https://docs.expo.dev/versions/latest/sdk/location/
[S04]: https://supabase.com/docs/guides/database/postgres/row-level-security
[S05]: https://developer.apple.com/app-store/review/guidelines/
[S06]: https://developer.apple.com/support/offering-account-deletion-in-your-app/
[S07]: https://www.revenuecat.com/docs/getting-started/installation/expo
[S08]: https://docs.expo.dev/versions/latest/sdk/sqlite/
[S12]: https://www.strava.com/legal/api

[Full source register](../SOURCES.md).
