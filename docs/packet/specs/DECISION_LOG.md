# PaceLeague — Decision log

## Decisions

Only D-000 is confirmed by the user. Other entries are **proposed defaults for this planning packet**, not recorded founder approvals. Artifact author: assistant; decision owner: founder/user. Date: 2026-09-26 UTC.

| ID | Status | Choice and rationale | Alternative / consequence |
|---|---|---|---|
| D-000 | Confirmed request | Produce Markdown planning packet and generated app designs | No app implementation requested in this scope |
| D-001 | Proposed | Adults, English, US iPhone pilot; Android follows | Simultaneous platforms extend device coverage and QA |
| D-002 | Proposed | Own GPS recording plus private league is the MVP | Import-only depends on external access and rights |
| D-003 | Proposed | Expo/React Native/TypeScript, SQLite, Supabase | Native iOS is the fallback if the GPS spike fails materially |
| D-004 | Proposed | Permanent XP ranks; weekly best-three-day competition; no pace bonus | Rank decay and uncapped mileage may weaken the intended positioning |
| D-005 | Proposed | Pilot competition calendar uses America/Chicago for everyone | A single advertised calendar avoids timezone manipulation and inconsistent standings |
| D-006 | Proposed | Routes owner-only; social API returns alias, tier, and weekly XP | Public maps add a different privacy and moderation problem |
| D-007 | Proposed | Free beta; optional annual Pro test after useful retention | Hard paywall before first run risks obstructing crew formation |
| D-008 | Proposed | One private league per account, up to 20 people | Multiple leagues and large clubs increase scope |
| D-009 | Proposed | Sign in with Apple and email OTP; no Google login in iOS V1 | Fewer provider paths to verify |
| D-010 | Proposed | No AI coach, autonomous actions, or medical claims | Training recommendations require separate expertise and evaluations |
| D-011 | Proposed | No Strava import without explicit suitability and provider review | Current API agreement creates material constraints (S12) |
| D-012 | Proposed | Location previews only in preflight; continuous location only during an active run | Prevents unnecessary tracking outside the relevant user action |

## Pending decisions

| Decision | Recommended default | Owner / validation point | Material effect |
|---|---|---|---|
| Is the referenced product the ranked Runify? | Use the researched OneDegree Labs app | Founder, before estimation | A race-directory app would require a different brief |
| Is watch sync essential at launch? | Phone GPS first | Founder, before F01 | Essential HealthKit/watch support changes scope and staffing |
| Budget and team | Obtain estimates against this backlog | Founder, before contract | Determines platform and release sequence |
| Operator, support address, launch markets | Supply real business facts | Founder, before closed external pilot | Needed for privacy/support text and account ownership |
| Data retention and provider region | Use proposed lifecycle in technical spec; confirm configuration | Founder + engineer, before real user data | Affects operations and disclosures |
| Brand availability | Treat PaceLeague as a working title | Founder, before store assets | Avoids committing to an uncleared name |
| Paid offer | Test one annual USD 29.99 offer only after Pro works | Founder, before payment configuration | No product or price has been created |

## Assumptions

| ID | Assumption | Evidence status | Review point / rollback |
|---|---|---|---|
| A01 | A private-crew consistency product is desirable | Untested E-010 | Interview review; narrow or abandon the proposed segment |
| A02 | Expo meets recorder reliability targets | Documentation supports feasibility, not results | End of F01; investigate native implementation if necessary |
| A03 | Three counting days is understandable and motivating | Untested rule | Four-week pilot; revise only between weeks with versioned rules |
| A04 | Users accept carrying a phone | Untested | Interviews; re-estimate HealthKit if this blocks adoption |
| A05 | US adult pilot is the intended first market | Unconfirmed | Before recruiting; adjust requirements for actual markets |
| A06 | Infra can fit the proposed pilot reserve | Budget assumption | Before provider purchases; use measured usage to resize |

Relative checkpoints are intentional because no start date was supplied. Assign calendar dates when a project starts. No approver, deadline, or agreement is fabricated.

## Source links

[S12]: https://www.strava.com/legal/api

[Full source register](../SOURCES.md).
