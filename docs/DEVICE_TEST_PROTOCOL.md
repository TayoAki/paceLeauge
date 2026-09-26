# Device test protocol

Everything the simulator, the web preview and the automated suites **cannot** prove. Run it on
real iPhones with a native development or pilot build. Record raw evidence; never mark a
simulator, fixture or synthetic route as a real outdoor run. Anything not run stays "not run" in
[STATUS.md](STATUS.md).

## Setup

| Item | Requirement |
|---|---|
| Devices | Two physical iPhones on different models and iOS versions (e.g. one current flagship, one ≥ 3 years old). Record model, iOS version, battery health, Low Power Mode, and Location Services settings. |
| Build | `eas build --profile development` (or `pilot`) pointing at a **staging** Supabase project with `competition_enabled` on. Never production. |
| Accounts | Two test accounts per provider (Apple, email). Staff/test accounts are excluded from pilot metrics. |
| Routes | At least ten measured open-sky routes of 1–5 km (a 400 m track counts laps; otherwise a surveyed course or a wheel-measured path), plus one poor-signal route (tall buildings or trees). Write down the reference distance before running. |
| Capture | Screen recordings for permission flows; the in-app export (JSON + GPX) after each run; iOS Settings → Battery screenshots before/after; a written log using the template below. |
| Storage | `docs/evidence/device/<YYYY-MM-DD>-<device>/` (export files, recordings, the filled log). Strip real home locations: start and end runs away from home, or crop GPX before committing. |

## F01 — recorder feasibility gate (first)

The packet's first gate. Continue with Expo's recorder only if both devices pass; otherwise
record the failure and evaluate a native recorder before building further.

| # | Case | Steps | Pass criteria |
|---|---|---|---|
| F01-1 | Locked-screen 30 min | Start, lock the phone, pocket it, run 30 min, unlock, finish | One session; distance within NFR-002; the live time matches wall time minus pauses; blue location indicator visible while locked |
| F01-2 | Pause / resume | Pause 2 min while walking 200 m, resume, finish | Paused time and movement excluded; two segments in the exported GPX |
| F01-3 | Phone call | Receive and answer a 1-minute call mid-run | Recording continues or resumes without a gap > 15 s being bridged; no duplicate session |
| F01-4 | Force quit | Swipe the app away mid-run, reopen after 1 min | "Recording stopped" recovery screen; the saved segment ends at the last checkpoint (≤ 5 s before the kill), never at relaunch; Resume starts a new segment |
| F01-5 | Reboot | Reboot mid-run, unlock, reopen | Same as F01-4; journal readable after first unlock (key accessibility `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`) |
| F01-6 | Offline | Airplane mode for the whole run, finish, reopen app, reconnect | Summary says saved on this phone; after reconnect the run syncs once and XP appears |
| F01-7 | Weak signal | Poor-signal route | Honest GPS state on screen; low coverage → "personal only" with the coverage reason rather than invented distance |
| F01-8 | Battery | Two 60-minute locked runs per device, plus a 60-minute idle baseline | Median drain ≤ 8 percentage points per hour over baseline (NFR-003) |
| F01-9 | Distance accuracy | The ten measured routes across both devices | Median absolute error ≤ 5 % (NFR-002); report every run, including failures |
| F01-10 | Durability | 50 deliberately interrupted sessions (kill, reboot, low battery shutdown, permission revoke) | Zero lost completed sessions; interrupted ones recoverable (NFR-001) |

## Evaluation cases requiring a device

| EV | Cases | Pass criteria |
|---|---|---|
| EV-001 | Sign in with Apple and email code on each device; cancel each; expired and reused codes; cold restart; sign out A → sign in B | Each provider restores the same account after cold restart; an expired/used code fails; B never sees A's local runs or queue |
| EV-002 | Fresh install permission; Allow Once; Don't Allow; approximate location; revoke in Settings mid-run; no fix indoors | The preflight copy matches the real permission state; every path has a recovery; no prompt loop; revocation mid-run interrupts cleanly |
| EV-004 | Double-tap Finish; kill the app during save; finish offline then relaunch | One saved run; no false success; pause feedback < 150 ms and summary < 1 s (NFR-004) |
| EV-008 | Relaunch after several runs; switch units; rename; delete | History, units and totals agree after relaunch; deleted runs vanish everywhere |
| EV-009 | Share post and story images; cancel the share sheet; deny Photos access and use Save image | Inspect exported PNGs (`exiftool`) for location or other metadata — none; cancel posts nothing; denial doesn't block sharing |
| EV-010 | Export on device; delete account; reinstall | Export files open (JSON, GPX); after deletion the local journal file and its Keychain key are gone and the account can't sign back into old data |
| EV-012 | Turn reminder on/off; deny notifications; sign out; change time zone; cross a DST change | Exactly one reminder or none; denial leaves the app fully usable; sign-out cancels |
| EV-014 | VoiceOver: start, pause, finish, find the result, initiate deletion; Larger Accessibility Sizes at the maximum on the smallest supported iPhone; Reduce Motion; bright sunlight | No unlabelled or unreachable control; no clipped primary action or overlapping metrics; values readable outdoors |

## Log template

```
Date / time (local):
Tester:
Device / iOS / battery health / Low Power Mode:
Build (profile, version, commit):
Case ID:
Reference distance (m) and how it was measured:
Recorded distance (m) / active time / status (accepted, personal only, review):
Battery before → after (%):
What happened (include anything unexpected):
Evidence files:
Result: PASS / FAIL / BLOCKED (reason)
```
