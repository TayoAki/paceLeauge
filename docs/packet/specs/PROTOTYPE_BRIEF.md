# PaceLeague — Design and prototype brief

## Learning objective

Can a new runner understand how to record, save, earn progress, and join a private crew without confusing lifetime rank, weekly score, or route visibility? The three generated boards establish an original visual direction and nine key screens. They are raster concepts with fictional fixtures, not editable Figma components, an interactive prototype, or real app screenshots.

## Context and inputs

Use FACTORY_PRD.md as behavior authority, TECHNICAL_SPEC.md as score/data authority, and design-tokens.json as token authority. The app name is provisional. The target design canvas is a 390×844-pt iPhone, with explicit review on the smallest supported device and at 200% Dynamic Type. The final minimum iOS version follows the verified SDK matrix at kickoff.

### Concept boards

| File | Screens | Purpose |
|---|---|---|
| designs/01-run-loop.png | Today, active recording, saved-run summary | Core value loop and large workout metrics |
| designs/02-league-progress-share.png | Weekly league, progress, share preview | Competition, visible growth, and a location-free share artifact |
| designs/03-onboarding-privacy.png | Welcome, GPS preflight, privacy | Contextual permissions and personal-data controls |

Images were generated with the built-in image-generation tool. IMAGE_PROMPTS.md records the actual prompts and correction prompts. The maps are fictional illustrations; real map providers require appropriate attribution and must retain their controls/labels.

## Design direction

**Editorial sports utility.** Dark surfaces make large numeric data the focal point. Electric lime is reserved for the primary action, earned progress, and selected state. Ivory typography and quiet gray labels maintain hierarchy. Use a simple track-lane motif as supporting identity, not expensive 3D assets or a complex badge universe.

Voice: calm, direct, encouraging. “Run saved.” “Rest days keep your rank.” “Saved on this phone. We’ll sync when you’re online.” Avoid guilt, injury/health claims, and claims of certified GPS accuracy. “Week complete” means the user's chosen activity goal is complete; it does not prescribe a training schedule.

### Core tokens

| Role | Value | Use |
|---|---|---|
| Background | #101315 | Main app shell |
| Surface | #1B2024 | Cards and grouped settings |
| Elevated surface | #272E33 | Selected segments and sheets |
| Primary text | #F5F3EA | Headlines, metrics, body |
| Secondary text | #AAB2B8 | Supporting copy with measured contrast |
| Accent | #D5FF45 | Primary actions and earned progress |
| On-accent text | #101315 | Always dark text on lime buttons |
| Danger | #FF9A85 | Destructive controls with icon and explicit label |
| Meaningful outline | #70808C | Input/control boundaries; verify contrast in context |
| Decorative divider | #354047 | Separation only; not sole control affordance |
| Type | System sans; native SF on iOS | Avoid font-download dependency in V1 |
| Type sizes | Hero 64, workout 72, title 32, section 22, body 17, label 15, caption 13 pt | Dynamic Type scaling; tabular numerals for metrics |
| Spacing | 4, 8, 12, 16, 24, 32, 48 pt | Screen horizontal padding 20; card padding 20 |
| Corners | Card 24, button 16, small control 12 pt | Native continuous corners where supported |
| Controls | Primary button at least 56 pt high; running Pause at least 72 pt | Minimum tap target 44×44 pt |
| Motion | 160–220 ms standard; optional 400-ms tier reveal | Reduced Motion removes celebratory transforms |

Ship the documented dark theme first and test outdoor legibility. Respect system text, reduced-motion, and accessibility settings. A light theme is a later design task, not a promise made by these boards.

### Reusable components

MetricBlock (value/unit/accessible label), TierCard (tier/XP/next threshold), WeeklyGoal (completed/target/day markers), PrimaryButton, SecondaryButton, GPSStatus, RecordingControls, RunRow, LeagueRow, EmptyState, InlineStatus, PermissionExplainer, PrivateRoutePreview, SharePoster, DestructiveConfirmSheet, and AccountMenu. Every component needs disabled/loading/error semantics where relevant. Rank and GPS state use text plus shape/icon; color alone is insufficient.

## Navigation and screens

Four tabs: Today, League, Progress, Profile. The active workout takes over the full screen; navigation away requires a visible return-to-run path. Bottom tabs are not part of live recording, preflight, summary, or share-preview screens. Use native stack headers and safe areas; show complex settings in pushed screens, not a maze of modals.

| ID / route | Main content | Actions / destination | Essential states | Requirement |
|---|---|---|---|---|
| S01 /welcome | Promise, Apple/email options, terms/privacy | Authenticate → onboarding | Cancel, provider error, network error | REQ-001 |
| S02 /onboarding | Alias, units, adult-pilot acknowledgement, optional 1–3-day goal | Continue → Today or saved invite | Alias conflict/filter, invalid input, skip goal | REQ-001 |
| S03 /(tabs)/today | Tier, weekly goal, Start run, latest run, crew teaser | Start → preflight; view progress/league | First run, offline, sync pending, interrupted-run banner | REQ-006/008 |
| S04 /run/preflight | Permission explanation/status, GPS quality, current fix | Enable, Settings, Start, Not now | Undetermined, denied, approximate, no fix, ready | REQ-002 |
| S05 /run/active | Large distance, elapsed time, average pace, optional map | Pause, lock/unlock | Recording, poor GPS, offline, touch locked | REQ-003 |
| S06 /run/paused | Frozen metrics, Resume, Finish, Discard | Resume or save; confirm discard | Recoverable interruption, local storage error | REQ-003/004 |
| S07 /run/summary/{id} | Saved stats, route, XP breakdown, weekly goal | Done → Today; Share → preview | Pending sync, accepted, personal-only, review | REQ-004/005/006 |
| S08 /(tabs)/league empty | Explanation, Create league, Join with code | Create/join | No crew, invitation expired/full | REQ-007 |
| S09 /league/{id} | Week selector, own XP/rank, member rows, rules | Invite, report/block, leave/owner management | Empty, updating, settled, tied, hidden member | REQ-007/011 |
| S10 /invite/{token} | Minimal league preview and explicit join | Sign in → return → confirm join | Revoked/full/expired; already in another league | REQ-001/007 |
| S11 /(tabs)/progress | Lifetime tier, goal, four-week chart, run list | Run detail; rules sheet | No runs, offline cache, pagination/error | REQ-008 |
| S12 /runs/{id} | Private route, active time, pace, splits, title | Rename title, Share, Delete | Incomplete route, pending, missing, deletion | REQ-008/010 |
| S13 /runs/{id}/share | Stats-only poster, privacy caption | System share, save image, close | Render failure, share canceled | REQ-009 |
| S14 /(tabs)/profile | Alias, units, goal, notifications, support | Settings, privacy, sign out | Unsynced-work warning, expired session | REQ-001/012 |
| S15 /settings/privacy | Route visibility, export, delete, billing management when applicable | Export job; deletion flow | Reauth required, offline, job in progress | REQ-010 |
| S16 /settings/delete | Consequences, subscription notice if applicable | Confirm → deletion status | Reauth failed, retrying cleanup, completed | REQ-010 |
| S17 /pro (V1.1) | Working benefits, sample, localized annual price/renewal | Purchase, Restore, Close | Pending, success, failure, current subscriber | REQ-013 |

S02, S06, S08, S10, S12, S14, S16, and S17 have written specifications but no separate generated screen. They reuse the established components and require interactive design during implementation. Nine generated concepts do not imply all screens are finished.

## Representative tasks

| Task | Success without prompting | Failure to investigate |
|---|---|---|
| Start the first run | Explain location need; reach recording; identify Pause | Permission confusion or accidental start |
| Finish during airplane mode | Save once and correctly explain pending sync | Belief that the run is lost or already ranked |
| Explain the two scores | Distinguish permanent XP from this week's top three days | Mistaking rest for XP loss or daily running obligation |
| Join Friday Crew | Preview, authenticate if needed, explicitly join | Accidental joining or inability to recover invitation |
| Share a result | Preview stats, identify that the route is absent | Assuming the app already posted to a network |
| Remove personal data | Find export and account deletion and explain consequences | Confusion between deleting a run, account, and subscription |

## Required states and canonical copy

| State | Copy | Action / behavior |
|---|---|---|
| No runs | “Your first run starts here.” | Start run |
| No crew | “A little friendly competition.” | Create league / Join with code |
| Location pre-prompt | “Use location to prepare and record your run, including while your screen is locked.” | Continue to native permission flow |
| Denied | “Location access is off.” | Open Settings / Not now; no endless re-prompt |
| Poor GPS | “GPS is weak. Distance may be incomplete.” | Continue recording received data; label quality |
| Offline saved | “Saved on this phone. We’ll sync when you’re online.” | Done / Retry when available |
| Pending score | “Checking your run. XP is pending.” | Never present an estimate as an accepted award |
| Personal-only | “Saved to your history. This run doesn’t qualify for league XP.” | Show the specific understandable reason |
| Interrupted | “Recording stopped. Your saved portion is here.” | Resume with new segment / Save partial / Discard |
| Delete run | “Delete this run and its route? Your XP may change.” | Cancel / Delete run |
| Share | “Stats only. No route or location.” | Open native share sheet after preview |
| Privacy | “Routes are visible only to you.” | Explain operator/provider processing in privacy details |

The core recorder never shows a paywall while running, pausing, saving, or recovering. A local save always precedes a celebratory reward. Visible copy must distinguish “saved” from “synced” and “accepted.”

## Design and accessibility review

Use logical reading order, explicit value/unit labels, and announcements for recording/paused/saved state; do not announce every GPS tick. VoiceOver activation provides an alternative to the hold gesture for touch unlock. A running control must remain reachable with large text; move supporting map/chart content below it when needed. Do not require precise swipe gestures for finishing or data deletion.

Charts include textual summaries and accessible values. Maps are optional supporting information during the run. Inputs label errors adjacent to their field and preserve entered content. The email keyboard should not cover the OTP submit action. Navigation focus returns predictably after sheets close. Measure contrast on actual rendered backgrounds, including disabled states and outdoor/high-brightness scenarios.

The final interface should use real native Apple sign-in controls and their presentation rules; a generated Apple symbol is not a production asset. Use a consistent icon set with platform-appropriate glyphs and accessible labels.

## Usability and feasibility evidence

Completed: original raster generation; visual inspection for primary hierarchy, readable key copy, complete phone frames, plausible fixtures; corrected the first board's active-day markers and the third board's permission/rest-day wording. Written requirements and sample scoring were cross-checked separately.

Not completed: native screen rendering, taps, keyboard behavior, VoiceOver, large-text behavior, sunlight checks, device GPS, user sessions, or Figma component construction. No usability pass is inferred from attractive images.

Known design variances to resolve in code: board 02's tier bar is illustrative; implement the exact 39.7% within-Stride progress from the numeric contract. Icon glyphs differ between boards; use one component set. Board 03 includes “Manage subscription” for future readiness; hide it in the free pilot unless a subscription actually exists. Native map attribution is absent from the fictional maps and must be present in real provider maps. Pixel colors and gradients in raster output may drift; exact tokens override them.

## Decision and next step

Use this visual direction for the bounded recorder prototype, with fixtures until the recorder works. Build the complete start/pause/save/recovery flow before polishing a league. Next, conduct the six-person comprehension study and adapt the interface from recorded failures. Do not advertise these concepts as screenshots of a shipped app.

## Source links

[S01]: https://www.runifyapp.com/
[S02]: https://apps.apple.com/us/app/runify-running-tracker/id6746146450
[S03]: https://docs.expo.dev/versions/latest/sdk/location/
[S04]: https://supabase.com/docs/guides/database/postgres/row-level-security
[S05]: https://developer.apple.com/app-store/review/guidelines/
[S06]: https://developer.apple.com/support/offering-account-deletion-in-your-app/
[S07]: https://www.revenuecat.com/docs/getting-started/installation/expo
[S08]: https://docs.expo.dev/versions/latest/sdk/sqlite/
[S09]: https://docs.expo.dev/versions/latest/sdk/map-view/
[S10]: https://developer.android.com/develop/sensors-and-location/location/background
[S11]: https://www.revenuecat.com/docs/integrations/webhooks
[S12]: https://www.strava.com/legal/api
[S13]: https://developer.garmin.com/gc-developer-program/overview/
[S14]: https://support.google.com/googleplay/android-developer/answer/13327111

[Full source register](../SOURCES.md).
