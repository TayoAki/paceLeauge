# Device test protocol

Everything the simulator, the web preview and the automated suites **cannot** prove. Run it on
real iPhones with a native development or pilot build. Record raw evidence; never mark a
simulator, fixture or synthetic route as a real outdoor run. Anything not run stays "not run" in
[STATUS.md](STATUS.md).

## Setup

| Item | Requirement |
|---|---|
| Devices | Two physical iPhones on different models and iOS versions (e.g. one current flagship, one ≥ 3 years old). Record model, iOS version, battery health, Low Power Mode, and Location Services settings. |
| Build | `eas build --profile development` (or `pilot`) pointing at the **staging** API on Railway (`EXPO_PUBLIC_API_URL` / `EXPO_PUBLIC_API_KEY`) with `competition_enabled` on. Never production. |
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

## Phase 1 device checks (docs/ROADMAP.md)

Run these on a build made from the `pilot` profile. None of them can be proven in the browser.

| Case | Steps | Pass criteria |
|---|---|---|
| P1-AUDIO | The Part C matrix: Apple Music, Spotify, YouTube Music, Apple Podcasts, Overcast and Audible; AirPods, other Bluetooth headphones and the phone speaker; screen locked, Low Power Mode, an incoming call, Siri, an alarm. Cues every ½ km and "Splits only". Pull the headphones out mid-run with "Use the speaker…" off, then on | Music back to full volume within 1 s of every cue; podcasts resume after every cue; no cue longer than 4 s in "Splits only"; no cue after the run ends; with the speaker option off, no cue plays from the speaker after the headphones come out; the first word isn't clipped on Bluetooth |
| P1-AUTOPAUSE | 10 runs with traffic-light stops; one run at a slow jog; stand still with the phone in hand for 2 minutes | Every stop pauses and resumes; no false pause while running or jogging; stopped time isn't in active time |
| P1-PACE | Track test: laps at two different paces | Current pace settles within 10 s of each pace change; lap pace and lap time restart at each kilometre (mile for imperial) |
| P1-LIVE | Start a run, lock the phone; pause and resume from the lock screen by opening the app; finish; discard a second run | The lock screen and Dynamic Island show distance, pace and a running clock that stops on pause; the saved numbers stay after finishing; a discarded run's activity disappears at once |
| P1-HEALTH | Switch on "Save runs to Apple Health" (allow, then deny on a second device); finish a run; fix it; delete it | Allow: the run appears in Fitness with its map exactly once; after the fix it shows the fixed distance; after deletion it's gone. Deny: the app explains how to allow it and saves nothing |
| P1-WIDGET | Add the small, medium and lock-screen widgets; finish and sync a run; wait for Monday | Each widget shows active days, weekly XP and league place, updates within 15 minutes of the sync, and resets when the week turns; signing out clears it |

## Phase 2 device checks (docs/ROADMAP.md)

Run these on a `pilot` build; the watch cases need a build with `PL_WATCH=1` and an Apple Watch on
watchOS 10 or later. Record each with the log template below.

| Case | Steps | Pass criteria |
|---|---|---|
| P2-HEALTH | Switch on "Import from Apple Health" with 30 days of Apple Watch Workout runs and one Garmin workout in Health; then record a new Workout-app run with the phone locked and the app closed | The backfill brings each workout in once (Garmin as history with the "no route" reason); the new run appears and syncs without opening the app within a few minutes (background delivery) |
| P2-WATCH | Start an outdoor run on the watch with the phone left at home, 60 minutes; pause with press-and-hold; end; bring the watch home | The pause needs the hold; the run is on the phone and synced within a minute of the watch reaching the phone; it counts once even though Apple Health also has it; battery used is recorded (Series 6 or later) |
| P2-WATCH-LIVE | Start a watch run with the phone nearby (iOS 17) | Today shows the run in progress with its distance and time; it disappears when the run ends |
| P2-INDOOR | Treadmill run on the phone for 20 minutes; correct the distance to the treadmill's; repeat the next day | Steps and an estimate show during the run; the saved run is history (goal and streak, no XP); the second estimate is closer to the treadmill after the correction |
| P2-STRAVA | Connect Strava (staging credentials), record a run, then disconnect and record another | The first run appears on Strava once, with its route; the second doesn't; Strava's "My Apps" no longer lists PaceLeague |
| P2-FILES | Import a GPX, a TCX and a FIT file from Profile › Imports and sync (the Files picker) | Each imports once as history with its route; importing the same file again says it's already there |

**Part A failure tests (all must pass before Phase 2 ships).** For each, finish the run, restore
the condition and wait for sync. Pass: the run ends *Synced* or *Needs attention* with a reason;
no run is lost; nothing counts twice in the standings.

| Case | Condition |
|---|---|
| A-AIRPLANE | Airplane mode for the whole run (phone, then watch) |
| A-PHONE-HOME | Phone left at home during a watch run |
| A-WATCH-BATTERY | Watch battery dies mid-run |
| A-FORCE-QUIT | App force-quit on the phone mid-run, and on the watch after finishing |
| A-RESTART | Phone restarted before sync |
| A-ACCOUNTS | Watch paired to a phone signed in to a different PaceLeague account than the one used before |
| A-HEALTH-OFF | Apple Health permission revoked before the import |
| A-STORAGE | Low storage on the phone (under 200 MB free) |
| A-TWICE | The same workout imported twice (Health and a file of it) |
| A-BOTH | The same run recorded on the phone and the watch |

Targets across the TestFlight round: zero lost runs, zero duplicates in standings, at least 99.5%
of runs synced without action, and a median under 60 seconds from finish to synced when the
phone is nearby.

## Phase 3 device checks (docs/ROADMAP.md)

| Case | Steps | Pass criteria |
|---|---|---|
| P3-WORKOUT | Start today's plan session from Home with the phone locked in a pocket, music playing; skip a step from the run screen | Each step is announced on time over the music; the skipped step moves on at once; the run is matched to the session afterwards |
| P3-GUIDED | A free and a Pro guided run in airplane mode, screen locked, over Spotify and Apple Music | Every coaching line plays at its point in the run and none plays more than 30 s late; music comes back after each |
| P3-HR | With an Apple Watch, record a run on the phone; turn on heart-rate zones; open the run | Zones appear within a few seconds and add up to the active time within a minute |
| P3-TRENDS | Pro, with 12 weeks of Apple Watch data: turn on health trends | Resting heart rate, HRV, VO2 max and sleep match Apple Health's weekly averages within rounding |
| P3-PRO | In the App Store sandbox: buy yearly (trial) and monthly, restore on a second device, let one expire, refund one, delete an account while subscribed (OPERATIONS.md, "Pro subscriptions") | Pro turns on within seconds of each purchase and off at expiry or refund; the trial email arrives two days before the end (staging with a real inbox); deletion works and says the subscription continues |

## Phase 4 device checks (docs/ROADMAP.md)

Two test accounts on two phones (A and B), on a server with `PUSH_ENABLED=true` and the push
credentials in EAS (OPERATIONS.md, "Push notifications"). Run each case on an iPhone and on an
Android phone.

| Case | Steps | Pass criteria |
|---|---|---|
| P4-PUSH | On A, open Profile › Notifications and tap "Turn on notifications"; allow. From B, follow A, give A's shared run kudos, and comment on it | The permission is asked once, only after the tap; A gets a follow push at once, one kudos push within about three minutes, and a comment push at once; tapping each opens the right screen (People, then the run); on Android they arrive on the "Friends and league" channel, silently |
| P4-PUSH-OFF | On A, switch "Kudos" off; from B, give another of A's runs kudos. Then switch everything back on and sign A out; from B, comment on A's run | No kudos push; after sign-out, no push reaches A's phone |
| P4-QUIET | Set A's phone and profile time zone to one where it's 23:00; from B, comment on A's run | Nothing arrives until 07:00 local time, then the comment push does |
| P4-FEED | B shares runs with the league (one with its map); A opens League › Feed and Today | B's runs appear newest first, the map only on the one shared with it and never near B's privacy zones; "From friends" on Today lists them |
| P4-REPORT | From A, report B's comment and B's run; as a moderator on a third phone, open Profile › Moderation | Both disappear for A at once; the moderator sees both with "Due in 24 hours" and can remove the comment and hide the run; B's run then leaves A's feed and the comment is gone for everyone |

## Android device checks (docs/ROADMAP.md P.1)

The Android version of this protocol. It passes when every case passes on three phones from
different makers, for example a Google Pixel, a Samsung Galaxy and a Motorola or Xiaomi, each on
Android 12 or later, with the maker's default battery settings (then again with "Unrestricted"
where a case fails only under battery saving). Use a build of the `pilot` profile for Android,
installed from Google Play's internal testing track.

| Case | Steps | Pass criteria |
|---|---|---|
| AND-F01 | The F01 runs above: a 45-minute run with the screen off in a pocket, a phone call during it, and the app swiped away from recent apps mid-run | The "Recording your run" notification shows throughout; the route has no gap longer than 60 s; swiping the app away doesn't stop recording; distance within the NFR-002 tolerance |
| AND-PERMISSION | First run with "While using the app", then "Only this time", then approximate location only; revoke location mid-run from quick settings | The app never asks for "Allow all the time"; approximate location is blocked with Android's own wording; revoking mid-run interrupts the run and keeps what was recorded |
| AND-BATTERY | Battery saver on; the maker's app-sleeping list with PaceLeague on it (Samsung "Deep sleeping apps", for example) | Either the run records in full, or the preflight tip leads to the setting that fixes it; no run is lost |
| AND-AUDIO | P1-AUDIO's matrix with Spotify, YouTube Music and Pocket Casts; Bluetooth headphones and the speaker | Music lowers for each cue and comes back; podcasts resume; no cue plays from the speaker after the headphones disconnect unless chosen |
| AND-HC-IMPORT | Turn on "Import runs from Health Connect" with runs from Google Fit (or Fitbit), Samsung Health and Garmin Connect in Health Connect; allow all exercise routes, then repeat on a second phone without routes | Each workout comes in once; with routes they're validated like phone runs, without routes they're history; the source app's name shows on the run |
| AND-HC-SAVE | Turn on "Save runs to Health Connect"; record, fix and delete a run | The run appears in Health Connect (and in Fit or Samsung Health) with its route and distance once; the fix replaces it; deletion removes it |
| AND-HC-ZONES | Record a run wearing a watch that writes heart rate to Health Connect; turn on heart-rate zones | Zones appear on the run; Health Connect's permission screen's privacy-policy link opens PaceLeague's Privacy Policy |
| AND-REMINDER | Turn on the daily reminder on Android 13 or later | Android asks for notification permission once; the reminder arrives at the chosen time on the "Run reminders" channel, silently |
| AND-SHARE | Save a share image to the gallery on Android 13 or later and on Android 10 | The image saves without any photo-reading permission on 13+; on 10 the storage permission is asked once |
| AND-PRO | Google Play's license testers: buy each plan, restore on another phone, cancel | As P3-PRO, with Google Play's wording and its subscription page |

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
