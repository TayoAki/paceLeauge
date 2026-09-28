# PaceLeague roadmap after V1

Status: **draft for the founder's review**, 28 September 2026. The seven open questions were
decided the same day; see [Decisions](#decisions-28-september-2026).
Evidence: the gap analysis *PaceLeague vs the Field* (a private page; its data is summarized
here). It compares 46 features across Runify, Strava, Runna, Nike Run Club and Garmin Connect and
tags 2,112 US App Store reviews by theme. Review counts below are unique reviews raising a theme.

This plan does not change V1. V1 ships as built; everything here comes after the beta starts.

## What was asked

On 28 September 2026 the founder asked for a plan that:

1. Matches what runners love most about each rival:
   - Runify: competing with friends and family (9 of 22 reviews)
   - Strava: a complete log of every activity, and kudos from friends (91 of 596)
   - Runna: personal plans that feel like a coach (305 of 450)
   - Nike Run Club: audio-guided runs, and free plans (182 of 549)
   - Garmin Connect: deep health and training data (77 of 495)
2. Makes watch pairing and sync easy and reliable. It is the top complaint: 463 reviews.
3. Makes training plans fit the runner (183 complaints about plans that don't).
4. Keeps voice cues from clashing with music (74 complaints).
5. Covers every feature runners ask for (10 request themes).
6. Adds the 13 features not yet built.
7. Adds the 6 features V1 left out by design.

## Coverage checklist

Every requested item, and where it is planned. Epic numbers refer to the phase sections below.

| Item | Epics | Phase |
|---|---|---|
| **Most loved** | | |
| Competing with friends and family | 1.9 league cheers, 4.1 leagues 2.0 | 1, 4 |
| A complete log of every activity | 1.10 run log, 2.1 Health import, 2.7 other workouts | 1, 2 |
| Kudos from friends | 1.9 league cheers, 4.4 feed | 1, 4 |
| Personal plans that feel like a coach | 3.1–3.3 and [Part B](#b-training-plans-that-fit-the-runner) | 3 |
| Audio-guided runs | 3.4 | 3 |
| Free plans | 3.1 | 3 |
| Deep health and training data | 3.5 | 3 |
| **Problem areas** | | |
| Watch pairing and sync without failures | [Part A](#a-watch-pairing-and-sync-that-doesnt-fail), 2.1, 2.2, 2.6 | 2 |
| Training plans that fit the runner | [Part B](#b-training-plans-that-fit-the-runner), 3.2 | 3 |
| Voice cues that don't clash with music | [Part C](#c-voice-cues-that-dont-clash-with-music), 1.1 | 1 |
| **What runners ask for** | | |
| Training plans runners can adjust (130 reviews) | 3.2 | 3 |
| Live pace and voice cues they control (64) | 1.1, 1.2 | 1 |
| A better Apple Watch app (59) | 2.2 | 2 |
| Friends, groups and fair competition (43) | 4.1, 4.3–4.7 | 4 |
| Simpler screens, and old features back (42) | [Screens](#screens-where-new-features-go), 1.11 widgets | all |
| Keep the basics free (39) | [Free and Pro](#free-and-pro) | 3 |
| Deeper stats and trends (38) | 1.7, 3.5 | 1, 3 |
| More sports and treadmill runs (32) | 2.5, 2.7 | 2 |
| Two-way sync with Apple Health and other apps (28) | 1.6, 2.1, 2.3, 2.4, P.1 | 1, 2 |
| Fix a run after it's recorded (24) | 1.5 | 1 |
| **The 13 not yet built** | | |
| Personal records | 1.4 | 1 |
| Spoken pace and distance | 1.1 | 1 |
| Imports from watches and Apple Health | 2.1, 2.4, P.1 | 2 |
| Badges and achievements | 1.8 | 1 |
| Android app | P.1 | Platform track |
| Auto-pause | 1.3 | 1 |
| Apple Watch app | 2.2 | 2 |
| Treadmill and indoor runs | 2.5 | 2 |
| Clubs and communities | 4.5 | 4 |
| Challenges | 4.6 | 4 |
| Route planning | 5.1 | 5 |
| Web app | P.2 | Platform track (with 4) |
| Offline maps or navigation | 5.2 | 5 |
| **The 6 left out by design** | | |
| Follow friends | 4.3 | 4 |
| Live location sharing | 4.8 | 4 |
| Global leaderboards | 4.7 | 4 |
| Social feed | 4.4 | 4 |
| Heatmaps and route discovery | 5.4 | 5 |
| Segments | 5.3 | 5 |

## Phases at a glance

| Phase | Theme | What ships | Rough size |
|---|---|---|---|
| 0 | Beta ready | Prove recording on real iPhones, support email, clear privacy copy, explain held runs | 1–2 weeks |
| 1 | Better runs (V1.1) | Voice cues, live pace, auto-pause, personal records, fix a run, save to Apple Health, stats, badges, league cheers, run log, widgets | 14–20 weeks |
| 2 | Every run counts | Apple Health import, PaceLeague Apple Watch app, Strava export, file import and Garmin sync, treadmill, sync status | 15–26 weeks |
| 3 | Coach | Training plans, adaptive coaching, coach feedback, guided runs, health and training data, Pro | 18–28 weeks |
| Platform track | Android, web | Android app from the start of Phase 2; web app lands with Phase 4 | 6–10 + 3–6 weeks |
| 4 | Friends, family and everyone | Leagues 2.0 with group runs, privacy zones, follow, feed, clubs, challenges, opt-in leaderboards, live location, push, teen family accounts | 23–36 weeks |
| 5 | Maps | Route planning, offline maps and navigation, segments, heatmaps | 18–28 weeks |

**Progress (28 September 2026).** Phase 0's age check, all five phases and the platform track
(the Android app and the web app) are built and tested in code. Phase 4 brought privacy zones
and per-run sharing (4.2), follows (4.3), the feed (4.4), push notifications and moderation
(4.9), Leagues 2.0 with seasons, duels and group runs (4.1), clubs (4.5), challenges (4.6),
opt-in leaderboards (4.7), live location (4.8) and teen accounts in family leagues (4.10,
switched off until counsel's review). Phase 5 brought route planning (5.1), offline maps and
navigation (5.2), segments (5.3) and the heatmap with suggested loops (5.4). The server is
tested by 364 database and API tests, the app by 366 unit tests and browser walkthroughs of the
new screens. What remains is on devices and with people: the Part C audio matrix and the Part A
failure tests (DEVICE_TEST_PROTOCOL.md), the first native builds of the new Swift and Kotlin
code (the watch app is off until then), the recorded voice and guided runs, the coach's review
of plans and notes, the 30-runner pilot, counsel's review of health data, and the Strava, Terra,
App Store and RevenueCat accounts. Phase 4 adds the APNs and FCM push credentials (push stays
off until `PUSH_ENABLED` is set), its device cases (P4-LEAGUES to P4-TEEN, including the
one-hour live-location battery test), counsel's review of teen accounts
(`docs/legal-drafts/teen-accounts.md`), a named moderation rota, and real crews, clubs and
boards in the pilot. Phase 5 adds a routing service (`ROUTING_URL`), the Android maps key, a
Mapbox account and token for offline maps, its device cases (P5-PLAN to P5-HEATMAP), segments
chosen for the pilot's places, and enough runners adding their runs for the heatmap to show
anything. Each item below says what was built.

Sizes are rough engineer-weeks for one engineer working with Claude, before testing on devices.
Sizes per epic: **S** is up to a week, **M** 1–3 weeks, **L** 3–6 weeks, **XL** more than 6.
Content work (coach-written plans, recorded guided runs) runs alongside and needs a budget.
Added up, this is roughly two to three years of work for one engineer. A second engineer or a
contractor per track (watch, Android, content) shortens it; the phase order stays the same.

Order matters. Reliability comes first because the most common complaints are about breakage:
sync (463), crashes (438) and lost runs (234). Coaching comes before public social because it
depends on watch data and Apple Health data. Public sharing waits for privacy zones and moderation
at scale.

## Ground rules that don't change

1. **Never lose a run.** Every source (phone, watch, import) stores the run on the device before
   anything tries to move it, and uploads are idempotent. A phase does not ship until the previous
   release has zero confirmed lost runs.
2. **Fair scoring stays.** Daily cap of 125 XP, the weekly score is the best 3 days, rank never
   decays, and no paid feature changes XP or rank. Every new source of runs goes through the
   validator. A source we can't check earns personal history and goal credit, never league XP.
3. **Private by default.** Routes stay owner-only unless the runner shares a specific run.
   Privacy zones exist before any map is shown to anyone else. Health data is never shown to
   other people.
4. **The free core stays free.** The list in [Free and Pro](#free-and-pro) is published in the app,
   and nothing on it moves behind Pro later. Paywalls, upsells and billing are Strava's biggest
   complaint theme (145 reviews).
5. **Don't reshuffle screens.** New features arrive in the places listed under
   [Screens](#screens-where-new-features-go). Nothing is removed without a replacement.
6. **Release safety.** Every update goes to TestFlight testers first, then out through the App
   Store's phased release. A phase ships only when the release before it has crash-free sessions
   of at least 99.5%, and runs sync without the runner doing anything at least 99.5% of the time.
7. **Adults only** (18+) through Phase 3, checked with Apple's age signal from Phase 0. From
   Phase 4, 13–17 year olds can join family leagues only, with a parent's consent (4.10).

## Scope changes this plan makes

The founder's request reverses several defaults in the packet's decision log
(`docs/packet/specs/DECISION_LOG.md`) and V1 non-goals (`docs/packet/specs/FACTORY_PRD.md`).

| Packet default | New direction |
|---|---|
| D-002: own GPS plus one private league is the product; imports depend on outside access | Add imports (Apple Health first) and a PaceLeague Apple Watch app. Imported runs are validated like phone runs |
| D-006: routes owner-only; others see only name, tier and weekly XP | Owner-only stays the **default**. A runner can share a run with followers or everyone, with privacy zones applied |
| D-008: one private league per account, up to 20 people | Several leagues per runner, plus larger clubs |
| D-010: no AI coach | Plans and coaching are rule-based and written with a certified running coach. No generative-AI coach in this plan: 18 Strava reviews complain about its AI features (17 of them from 2026), and several ask for a way to turn it off |
| D-011: no Strava import without a provider review | Still no Strava **import**: Strava's API agreement bars showing a runner's Strava data to anyone else, and leagues show results to others. **Export** to Strava is added |
| Non-goals: public feeds, comments, global and country leaderboards, route discovery, navigation, automatic pause, live location sharing, training plans, wearable apps, Apple Health and Garmin imports, treadmill distance, Android | All now in scope, in the phases below |
| Still out | Direct messages, cash prizes, wagering, live pace races on public roads, medical advice |

## Screens: where new features go

V1 has four tabs: Home, League, Progress and Profile. The run screen opens from Home. The
cluttered-screens theme (171 complaints, and 42 requests to bring back old layouts) means new
features need a home decided up front.

| Tab | Phases 1–2 | Phase 3 | Phase 4 | Phase 5 |
|---|---|---|---|---|
| Home | Start run, today's league snapshot, sync status | + today's planned workout | + friends' activity summary | — |
| Train | — | **New tab:** plans, guided runs, coach notes | — | + saved routes, route planner |
| League, later Social | Standings, cheers | — | Leagues, feed, clubs, challenges, leaderboards | + segments, heatmap |
| Progress | Records, badges, trends, run log | + health and training data | — | — |
| Profile | Settings, Health connection, voice settings, watch | + Pro | + privacy zones, visibility, who can follow | + offline maps |

Rules: a new feature starts switched off where it touches privacy or health (Health read,
public sharing, live location). An existing screen never moves without a redirect from its
old place. Each phase gets a design review against this table before build.

## A. Watch pairing and sync that doesn't fail

The complaint is about three things: watches that lose their connection, runs that never reach
the phone, and duplicates. The plan avoids building any pairing of our own.

**Design principles**

1. **No pairing inside PaceLeague.** Apple manages the Apple Watch link. We use Apple Health and
   Apple's watch APIs, never our own Bluetooth code. Other watches reach us through their makers'
   phone apps and Apple Health.
2. **Store, then forward.** The device that records a run keeps it (in its own storage and in
   Apple Health) until the server confirms it. Nothing depends on a live connection during the run.
3. **One run, one ID.** A run gets its ID when it starts. The server already rejects duplicates by
   `(owner_id, client_run_id)` and request hash. Imports use the Apple Health workout's ID as their
   key, so importing twice is harmless. If a phone recording and an imported workout overlap in
   time, keep the one with better GPS coverage and mark the other as a duplicate. Reviewers of
   Strava and Runna complain about duplicated runs.
4. **Two roads to the server.** The watch app uploads directly over Wi-Fi or cellular, and also
   hands the file to the phone through Apple's queued transfer, which survives restarts. The first
   arrival wins; the second is a no-op.
5. **Sync state is always visible.** Every run shows one of: *On watch*, *On phone*, *Uploading*,
   *Synced*, *Needs attention*, with a plain reason and a retry button. Nothing fails silently.
6. **The app wakes itself.** Apple Health background delivery wakes PaceLeague when a new workout
   appears, so runners don't have to open the app to sync.

**How each watch gets its runs in**

| Watch | Path | League XP? |
|---|---|---|
| Apple Watch, PaceLeague app (2.2) | Recorded by our watch app; direct upload plus hand-off to the phone | Yes, validated like phone runs |
| Apple Watch, Apple's Workout app | Apple Health import (2.1). The route comes with the workout | Yes, validated from the route |
| Garmin | Garmin Connect shares workouts to Apple Health **without the route**, so they import as personal history (2.1). For league credit, see 2.4 | Not until 2.4 lands |
| Coros, Polar, Suunto and others | Apple Health import when their app writes a route; otherwise personal history | Only with a route |
| Android and Wear OS | Health Connect import (P.1), which provides routes with the runner's consent | Yes, with a route |

**Garmin (decided; see decision 1 under [Decisions](#decisions-28-september-2026)).** Garmin runs count for history and
goals from day one through Apple Health. League credit comes through a data aggregator that
already has Garmin access, switched on once enough runners use Garmin (2.4). Later it moves to
Garmin's own API when that reopens to new developers. There is no Connect IQ app.

**Failure tests before Phase 2 ships.** Airplane mode for the whole run. Phone left at home. Watch
battery dies mid-run. App force-quit on either device. Phone restarted before sync. Watch and phone
signed in to different accounts. Apple Health permission revoked. Low storage. The same workout
imported twice. The same run recorded on phone and watch. Target: zero lost runs, zero duplicates
in league standings. At least 99.5% of runs synced without action, and a median of under 60
seconds from finish to synced when the phone is nearby.

## B. Training plans that fit the runner

Why plans fail runners, from the reviews: Runna's plans ramp too fast and cause injuries (34),
can't be edited (34), and don't adapt to illness, injury, heat or feedback (31). Nike Run Club's
plans stop crediting completed runs, and its adaptive coach was replaced with fixed plans (66).
The requests say the same: edit workouts and goal times, pause for illness, count cross-training,
move sessions freely.

**How our plans work**

1. **Written with a certified running coach.** A coach sets the templates, the progression
   rules and the in-app wording. The rules run in a deterministic engine with golden test cases,
   the same way scoring does. No generative AI writes a plan.
2. **Start where the runner is.** Setup uses real history (PaceLeague runs and imports), days
   available per week, the longest session they'll do, an optional recent race, and an injury
   question. When in doubt, start lower.
3. **Conservative progression by default.** The coach sets the numbers. Starting points to
   review: small weekly increases, a lighter week every third or fourth week, no more than two
   hard sessions a week, a hard day never followed by another, and run/walk intervals for new
   runners. When a runner's edit breaks a rule, the app warns rather than blocks.
4. **Paces as ranges.** Pace ranges come from recent best efforts (1.4), and runners can train
   by effort instead of pace. With Pro, they can train by heart rate, and in hot weather the
   day's range slows down using the forecast from Apple WeatherKit (decision 4).
5. **It listens.** After each session, one tap: *easy*, *about right*, *hard* or *too hard*,
   plus an optional pain flag.
   - Two *too hard* answers in a week lighten the next week.
   - A pain flag suggests rest, offers the return-to-run plan and suggests seeing a professional.
     No medical advice.
   - A daily *not feeling 100%* check-in swaps the day for an easy run or rest.
   - Missed sessions are dropped, never crammed into the following days.
6. **Everything is editable.** Runners can:
   - Move or swap sessions within a week or across weeks.
   - Repeat or skip a week.
   - Change a session's distance or pace.
   - Set a longest-run limit.
   - Change the goal time or race date, or switch to a finish-only goal.
   - Pause the plan for illness or travel.

   The plan recalculates from the edit onward.
7. **Every run counts.** A run on the planned day is matched to that session automatically,
   including runs from the watch or Apple Health. Runners can also pick which session a run was.
   Cycling, swimming and strength workouts imported from Apple Health count toward training load
   but not toward league XP.
8. **Plans and the league agree.** Plans never change the XP rules. The best-3-days score already
   rewards three good sessions a week, which is what most plans ask for.

**Plan types:** start running (run/walk to 30 minutes), 5K, 10K, half marathon, marathon, stay
consistent (no race) and return from a break. Strength content is left out at first. It draws 19 Runna
complaints, and a partner can add it later.

**Proving it fits.** Pilot with about 30 runners across levels before launch. Targets: fewer than
15% of sessions rated *too hard*, no rise in pain flags against the pilot's baseline, and at least
70% of planned sessions completed or deliberately moved.

## C. Voice cues that don't clash with music

The complaints: robotic or mistimed announcements, cues that talk over music or never give the
volume back, and guided runs that won't play offline. An Apple developer forum thread explains the
volume problem. Apple's speech engine turns its audio on but never turns it off, so other apps
stay quiet after it finishes.

**How our cues work**

1. **We control the phone's audio ourselves** with a small native module (Swift, via the Expo
   Modules API):
   - Audio mode: *playback* with the *voice prompt* mode, set to lower other audio, and to pause
     podcasts and audiobooks rather than talk over them.
   - Turn our audio on just before a cue, then off right after, telling other apps they can
     resume. Music returns to full volume and podcasts pick up where they paused.
2. **A natural voice.** A recorded human voice for numbers, units and common phrases, stitched
   together, with the best installed iOS voice as a fallback. Runners can choose between two
   voices and turn cue volume up.
3. **Runners choose what they hear and how often:**
   - Every half or whole kilometre or mile, every few minutes, or *important only* (splits,
     workout steps, goals reached).
   - Each of: time, distance, current pace, average pace, split and heart rate can be switched
     on or off.
   - Cues aim for 3 seconds or less, never overlap, and a stale cue is skipped rather than
     played late.
4. **Works with the screen locked.** Add the background audio mode alongside the existing
   location mode, so cues play while the phone is in a pocket.
5. **Headphones.** If headphones disconnect, cues pause rather than playing from the speaker,
   unless the runner has chosen the speaker. Our audio switches on a moment before each cue so
   Bluetooth headphones don't clip the first word.
6. **Watch and Android.** The watch app speaks through the watch or its paired AirPods. Android
   briefly takes audio focus with lowering allowed, as navigation apps do, and releases it after
   each cue.
7. **Guided runs** (3.4) use the same rules for longer coaching. Coaching audio is downloaded
   before the run, so it plays offline.

**Test before shipping** with Apple Music, Spotify, YouTube Music, Apple Podcasts, Overcast and
Audible. Use AirPods, other Bluetooth headphones and the phone speaker. Run each with the screen
locked, in Low Power Mode, and during an incoming call, Siri or an alarm. Pass criteria:

- Music returns to full volume within a second after every cue.
- Podcasts resume after every cue.
- No cue runs longer than 4 seconds in *important only* mode.
- No cue plays after the run ends.

## Phase 0: beta ready (now)

From the gap analysis, before inviting testers:

- **Prove recording on a real iPhone**: a 45-minute run with the screen locked, one in airplane
  mode, one after a force-quit (DEVICE_TEST_PROTOCOL.md).
- **Set the support email.** Password resets depend on it, and the TestFlight profile in
  `eas.json` doesn't set `EXPO_PUBLIC_SUPPORT_EMAIL` yet.
- **Say where routes go**: one line in onboarding and on the App Store page. Only you see your route.
  (Built in the app: onboarding says "Your routes stay private." The App Store page is still to
  write.)
- **Explain held runs**: when the validator holds a run for review, say why and how to ask for
  another look. (Built: the run's panel gives the reason, that a person checks held runs, usually
  within 2 days, with the result on the same screen, and, once `EXPO_PUBLIC_SUPPORT_EMAIL` is set,
  to email support with the run's date for another look.)
- **Check age at sign-up** (built): Apple's Declared Age Range and Google Play Age Signals through
  `expo-age-range`, alongside the existing adult self-declaration. Texas has required age
  assurance for new Apple accounts since 1 January 2026 (decision 3). See
  `src/features/account/age-check.ts` and `db/migrations/20260928000100_age_assurance.sql`.

## Phase 1: better runs (V1.1)

**1.1 Voice cues that play nicely with music** · M
- What: spoken splits, pace, time and distance, designed as in Part C.
- How: a native audio module (Expo Modules API), a cue scheduler driven by the recorder's live
  metrics, the recorded voice set, and settings under Profile.
- Built: `modules/voice-cue` (Swift: `.playback`/`.voicePrompt` session that ducks and hands audio back with `.notifyOthersOnDeactivation`; Kotlin: transient may-duck audio focus), the cue scheduler (`src/domain/cues.ts`), the cue controller and Run settings. The best installed system voice speaks until the recorded voice exists.
- Done when: the Part C test matrix passes on two iPhone models.

**1.2 Live pace, data screens and a lock-screen Live Activity** · M
- What: current pace (smoothed over about 20 seconds), lap pace, and a choice of 3–4 fields
  on the run screen. The run also shows on the lock screen and Dynamic Island.
- How: smoothing in the recorder's live metrics. Software Mansion's `expo-live-activity`
  (iOS 16.2 and later) for the lock screen.
- Built: current pace over 20 s of credited running, lap pace and lap time, up to three chosen numbers on the run screen, and our own ActivityKit Live Activity (`modules/run-activity` + `targets/widgets`) instead of `expo-live-activity`, whose template can't show a clock counting up.
- Done when: current pace settles within 10 seconds of a pace change on a track test, and the
  Live Activity updates with the phone locked.

**1.3 Auto-pause** · M
- What: pauses when you stop and resumes when you move, on by default with a switch in settings.
- How: speed thresholds with a delay (for example, under about 1 m/s for 5 seconds pauses, over
  about 1.5 m/s for 3 seconds resumes). Motion data avoids false pauses from GPS jitter.
  Scoring already uses active time.
- Built: `src/domain/auto-pause.ts` (0.6 m/s for 8 s pauses, 1.4 m/s for 3 s resumes, straight-line displacement over 5 s so jitter doesn't count), in the recorder, on by default with a switch. Motion-sensor input is not used yet.
- Done when: traffic-light stops pause and resume on 10 test runs without a false pause while
  running.

**1.4 Personal records** · M
- What: fastest 1K, mile, 5K, 10K, half and marathon, plus longest run, with history. Free:
  all five rivals track best times, and Strava and Runify charge for it.
- How: the server finds the fastest stretch of each distance inside accepted runs, measured by
  distance and interpolated between GPS points. Existing runs are backfilled once. Records don't
  affect XP.
- Built: `20260928000300_personal_records.sql`, the Records screen with each record's history, and best efforts on the run screen.
- Done when: the computed results match hand-checked results on a golden set of routes, and
  deleting a run removes its records.

**1.5 Fix a run** · M
- What: trim the start or end, cut out a section recorded while stopped, change a run to a walk,
  merge two runs split by accident. Renaming already exists.
- How: the edit is sent as a new version of the run. The server re-validates and re-scores it and
  keeps an audit trail. Edits can only remove distance, never add it. Merging keeps the two runs'
  distance and adds nothing for the gap between them. So edits can't be used to cheat. Leagues show a correction note, as they already do for deletions.
- Built: `20260928000700_run_edits.sql` and the Fix screen. The phone previews every fix with the server's rules (a DB test shows they agree to the centimetre); stops are found along the route for one-tap cuts.
- Done when: trimming updates XP and standings the same way a deletion does, and a trimmed run
  can never score more than the original.

**1.6 Save runs to Apple Health** · S–M
- What: finished runs appear in Apple Health and Fitness with their route and distance.
  People want their runs in one place.
- How: `@kingstinct/react-native-healthkit` (Expo config plugin) writes the workout and route
  when the run is saved, and removes them if the runner deletes the run. It asks for write
  permission only when the runner switches this on.
- Built: `src/features/health/apple-health.ts` on `@kingstinct/react-native-healthkit`, a Run settings switch, rewrite after fixes and removal on delete.
- Done when: a run saved on the phone appears in the Fitness app with its map, exactly once, and
  deleting the run removes it.

**1.7 Stats and trends v1** · M
- What: weekly, monthly and yearly totals, the same period last year, a custom date range,
  pace trend and personal-record history.
- How: server aggregates over accepted runs, cached per week.
- Built: `20260928000600_stats.sql` and the Stats screen (12 weeks, 12 months, this year, 5 years or custom; runs, walks or all; a year earlier; pace trend).
- Done when: totals match the run log exactly for any range.

**1.8 Badges and achievements** · M
- What: milestones (first run; 10, 50 and 100 runs), distance totals, tier-ups, personal records
  and league wins. Plus a **weekly streak**: weeks in a row meeting your weekly goal, or running at
  least once if you haven't set one. There are no daily streaks (decision 2), so rest days never
  break anything.
- How: a badge table and rules evaluated when scoring is applied, so badges reverse if a run is
  deleted. Badges never award XP.
  - The streak counts by each run's start date, so a late sync or import never breaks it.
  - Pausing a plan for illness or travel freezes it.
  - No "you're about to lose your streak" notifications (REQ-012).
- Built: `20260928000400_streaks_badges.sql`, the streak card and the Badges screen. League-win badges wait for Leagues 2.0.
- Done when: every badge rule has a test, deleting the run that earned a badge removes it, and a
  run synced days late still extends the streak for the week it was run.

**1.9 League cheers** · S
- What: tap to cheer a league-mate's day or week. A notification-light version of kudos inside
  the league, with nothing to moderate.
- How: a cheers table (who cheered whom, for which day), limited per day. Cheers are shown to the
  runner being cheered and to their league.
- Built: `20260928000500_league_cheers.sql` and cheer buttons on the standings.
- Done when: blocked runners can't cheer each other, and cheers disappear with a deleted account.

**1.10 Run log extras** · S
- What: notes on a run, shoe tracking with mileage and a replacement reminder, a calendar view,
  and search and filter. This makes the log complete, the thing Strava is praised for.
- How: new columns and tables. Shoes are private.
- Built: `20260928000200_run_log.sql`, notes and shoe on each run, the Shoes screen, the calendar with search, and export format 2 (`20260928000800_export_v2.sql`).
- Done when: notes and shoes are included in the data export.

**1.11 Home-screen widgets** · S–M
- What: this week's goal progress and league rank on the home screen (Garmin reviewers ask for this).
- How: a WidgetKit extension added with `@bacons/apple-targets`, fed from shared app-group storage.
- Built: the "this week" widget (home screen small and medium, lock screen circular, rectangular and inline) in `targets/widgets`, fed through the App Group.
- Done when: the widget updates within 15 minutes of a synced run.

**Phase 1 is done when** it has passed the Part C audio tests and had zero lost runs during
TestFlight, and the new features are in the data export.

## Phase 2: every run counts (watches and sync)

**2.1 Apple Health import** · L
- What: runs recorded by the Apple Watch Workout app, or by any app that saves a route to
  Apple Health, come into PaceLeague automatically. Workouts without a route (Garmin today) and
  runs typed in by hand come in as personal history.
- How:
  - Read running workouts, routes and heart rate with `@kingstinct/react-native-healthkit`.
    Release each workout after reading it; the library has a known memory issue with routes.
  - Apple Health background delivery for new workouts.
  - On first connection, offer to import the last 30 days.
  - Store where each run came from: the source app, the device, and whether it was typed in
    by hand.
  - The `runs.source` check gains `health_import`. The validator runs on the imported route
    points exactly as on phone GPS.
  - Cross-source duplicate detection as described in Part A.
- Done when:
  - Every case in the Part A failure tests passes.
  - An Apple Watch run imports once, with its route, and scores like a phone run.
  - A Garmin workout imports as personal history with a clear explanation.
- Built: `src/features/health/health-import.ts` (30-day backfill, background delivery, one run per
  workout by its Health id, routes read and released), the source rules and duplicate resolution in
  `20260929000100_run_sources.sql`, and an Imports switch in Run settings. Indoor workouts carry
  their steps, for 2.5.

**2.2 PaceLeague Apple Watch app** · XL
- What: start a run from the watch without the phone, see pace, distance, heart rate and planned
  workout steps, and pause and resume with one button that's hard to hit by accident. Start on the
  phone and track on the watch. League rank shows as a watch complication. Nike Run Club gets 140
  complaints about its watch app, so reliability beats features here.
- How:
  - A SwiftUI watch target added with `@bacons/apple-targets`. It has an open issue about how
    the watch app is embedded; test the Xcode project it generates early.
  - Recording: an Apple workout session with a live workout builder and a route builder.
  - Saving: the run is stored locally and saved to Apple Health.
  - Uploading: direct over Wi-Fi or cellular, and a queued file transfer to the phone.
  - Phone screen: workout mirroring shows the watch run live on the phone and in the Live
    Activity. Mirroring needs iOS 17 and watchOS 10; older devices get store-and-forward only.
  - Voice cues play through the watch or its AirPods.
- Done when:
  - A 60-minute run with the phone left at home syncs within a minute of reaching Wi-Fi.
  - Every Part A failure test passes.
  - Battery use is recorded on a Series 6 or later.
- Built, behind `PL_WATCH=1` until it has run on devices: `targets/watch` (watchOS 10: workout
  session, live and route builders, press-and-hold pause, voice cues, treadmill runs, the week and
  league on the start screen), `targets/watch-complication`, and the phone's `modules/watch-link`.
  Runs reach the phone two ways under one run id: a queued WatchConnectivity file and the Apple
  Health copy, so a run counts once whichever arrives first. The live run is mirrored to Today.
  Not built yet: direct upload from the watch without the phone, and planned workout steps
  (they come with plans in 3.1).

**2.3 Strava export** · S–M
- What: optionally post each accepted run to the runner's Strava account.
- How: Strava sign-in (OAuth) and Strava's upload API. The Strava connection is stored
  server-side and can be revoked from Profile. Nothing is read back from Strava into leagues;
  Strava's agreement forbids showing a runner's Strava data to others.
- Done when: a run appears in Strava once, and disconnecting stops further posts.
- Built: `20260930000100_strava.sql`, `server/src/strava.ts` (OAuth callback, GPX upload with
  processing checks, token refresh, rate-limit windows, revocation, Strava's webhook), and
  Profile › Connections. Accepted runs recorded with PaceLeague post automatically; any run with a
  route can be posted from its detail screen. Tokens are sealed with AES-256-GCM. Off until the
  Strava credentials are set (OPERATIONS.md).

**2.4 File import and Garmin sync** · M, plus M for the aggregator
- What: import GPX, FIT or TCX files from the share sheet as personal history. A file can be
  edited, so it can't be trusted for the league. Garmin gets automatic sync with routes through a
  data aggregator once the trigger in decision 1 is met.
- How:
  - Files: parsed on the server, with `source` of `file_import` (history only).
  - Garmin: activities arrive by webhook from the aggregator with `source` of `garmin` and go
    through the validator using their GPS samples.
  - The Apple Health copy of the same Garmin workout is detected as a duplicate (Part A).
- Done when: a FIT file shows its route and splits in the log, and a Garmin run synced through
  the aggregator scores once, even though Apple Health has it too.
- Built: files are picked in Imports and sync (the Files picker; opening a file from the share
  sheet is not wired up yet), parsed on the phone (`src/domain/file-import.ts`; FIT with Garmin's
  FIT SDK), uploaded with their points, measured by the server and kept as history. Garmin sync through Terra:
  `20260930000200_garmin.sql` and `server/src/garmin.ts` (signed webhook, a queue, and upload as
  the runner through the normal upload path with source `garmin`). Off until Terra's credentials
  are set, which decision 1 ties to the Garmin user-count trigger.

**2.5 Treadmill and indoor runs** · M
- What: record indoor runs. Distance comes from the phone's step counter, calibrated against the
  runner's outdoor runs, or from the watch. Runners can correct the distance at the end to match
  the treadmill.
- How: `source` of `indoor`.
  - Indoor runs always count for history, goals and plans.
  - League credit only when the run comes from a watch with heart rate and step data that pass
    plausibility checks, and at a lower daily cap than outdoor runs, since GPS can't check them.
  - A typed-in distance never earns league XP.
- Done when: the league rules page explains indoor credit, and tests cover the cap.
- Built: treadmill runs on the phone (`src/features/indoor`: a clock, the step counter, the
  runner's confirmed distance, stride learned from treadmill corrections and outdoor runs), and
  `20260929000300_indoor_credit.sql`: a watch indoor run whose pace, cadence, stride and heart rate
  look like running earns XP for up to 5 km a day; the rules page explains it.

**2.6 Sync status and repair** · S
- What: the per-run sync states and retry described in Part A, a sync screen in Profile, and a
  one-tap *send diagnostics* for support.
- Done when: every failure test ends in *Synced* or *Needs attention* with a reason.
- Built: Profile › Imports and sync (each unsynced run with its state and reason, retry, the last
  Health import, file import) and *Send diagnostics* (counts, states and error codes only).

**2.7 Walks, hikes and other workouts** · S–M
- What: walks, hikes, rides and strength workouts from Apple Health appear in the log and count
  toward training load (3.5). They never earn league XP.
- Done when: the log filters by type and totals separate running from everything else.
- Built: activity filters on the calendar and stats, a running-versus-everything-else card
  (`20260929000400_activity_totals.sql`), and walks or rides shown as "saved to your log".

**Phase 2 is done when** the Part A targets are met across a two-week TestFlight round with at
least 20 Apple Watch users and at least 5 Garmin users.

## Phase 3: coach

**3.1 Training plans (free)** · L
- What: the plan types in Part B, a Train tab, today's workout on Home, workout steps on the run
  screen and the watch, and runs credited automatically. Nike Run Club's free plans are loved
  (100 reviews), so the plans are free.
- How: plan templates and rules (coach-written) in a versioned engine with golden tests, and
  plan and session tables on the server.
- Done when: every template passes the coach's review, and the engine's tests cover edits,
  missed sessions and pauses.
- Built: the engine in `src/domain/plans` (7 plan types at 3 levels, run/walk ladder, lighter
  weeks, tapers, warnings, 36 golden and invariant tests), `20261001000100_training_plans.sql`
  (plans and sessions, versioned saves, sessions before today frozen, runs matched to the session
  on their local date, feedback and pain flags, export), the Train tab (setup from real history,
  the plan by week, each session, managing the plan), today's workout on Home, and workout steps
  spoken on the run screen (`src/domain/workout.ts`). The templates and numbers are a draft for
  the coach. Workout steps on the watch wait for the watch app's first build.

**3.2 Adjustable, adaptive plans** · XL
- What: everything in Part B points 3–7. That covers the check-ins, feedback, heat, pain flag,
  pausing and full editing.
- Done when: the 30-runner pilot meets the targets at the end of Part B.
- Built: `src/domain/plans/adapt.ts` and the Train screens: feedback after each session (two
  *too hard* answers lighten the next week), the pain flag (rest suggested, return-to-run offered),
  the daily check-in (easy run or rest), missed sessions dropped, and every edit in Part B point 6
  with warnings instead of blocks. Pauses resume with a lower rung. Heat (Pro) takes the
  temperature and humidity from the runner; the WeatherKit forecast needs the Apple developer
  account's WeatherKit key and isn't built. The pilot hasn't run.

**3.3 Coach feedback after runs** · M
- What: a short note after each run in the coach's voice. For example: *"You held your easy pace.
  That's what today was for."* Rule-based, from coach-written templates, with no generative AI.
- Done when: every note maps to a rule and a template the coach approved.
- Built: `src/domain/coach-notes.ts` (13 rules, each with its own templates, picked the same way
  every time for a run), on the run summary and each run's page. The wording is a draft for the
  coach.

**3.4 Audio-guided runs** · L, plus content
- What: a starter library of 12–20 coached runs: first run, easy, recovery, tempo, intervals,
  long run and a mindful run. Nike Run Club's guided runs are its most-praised feature (182).
- How:
  - Scripts from the coach, recorded by voice talent.
  - Each run is a timeline triggered by time or distance. It plays over the runner's music
    using Part C, and downloads for offline use.
  - Search and filters by length and type; Nike Run Club reviewers asked for these.
  - A starter set is free; the full library is Pro.
- Done when: every guided run plays correctly offline, with the screen locked, over Spotify and
  Apple Music.
- Built: `src/features/guided/catalog.ts` (18 runs, 6 free, scripts anchored to workout steps),
  the Guided runs list with length and type filters, and coaching spoken through the Part C cue
  path. Until the recordings exist, the best installed voice reads the scripts, so nothing needs
  downloading; recorded audio and the device checks are still to do.

**3.5 Health and training data** · L
- What: heart-rate zones per run (free), and these trends (Pro, decision 4):
  - Resting heart rate, heart rate variability, VO2 max (Apple's estimate) and sleep, from
    Apple Health.
  - Training load, and a fitness and fatigue chart (7-day against 42-day load).
  - Race predictions from personal records, and aerobic efficiency (pace at a given heart rate).
- How: read with the runner's consent. Compute on the phone where possible, and send the server
  only what plans need.
  - Never shown to other people, never used for ads.
  - App Review guideline 5.1.3 limits how health data may be used and stored.
  - No medical claims: wording is about training, not health risks.
  - Counsel reviews the FTC Health Breach Notification Rule and state consumer-health-data laws
    (such as Washington's My Health My Data Act) before this ships.
- Done when: counsel signs off, and each metric has a written definition in the app.
- Built: `src/domain/training.ts` (load, fitness and fatigue, form, Riegel predictions, aerobic
  efficiency, zones, health-trend averages), heart-rate zones on each run's page (free, from
  Apple Health on the phone), the Training screen under Progress (Pro) with a definition beside
  every number, health trends behind their own switch (off by default, read on the phone, never
  uploaded), and heart-rate ranges on plan sessions (Pro). Counsel hasn't reviewed it yet; plan
  answers about injury and pain flags are on the server, so they're part of that review.

**3.6 Pro subscription** · M
- What: the Pro tier in [Free and Pro](#free-and-pro): $29.99 a year or $4.99 a month (REQ-013).
- How: App Store subscriptions through RevenueCat, as the packet planned.
  - A 7-day free trial on the annual plan only, and a reminder two days before it converts.
  - A *Manage subscription* link in Profile.
  - Account deletion never requires cancelling first (REQ-010).
- Done when: purchase, restore, expiry, refund, trial reminder and deletion are tested in the
  sandbox.
- Built: `20261001000200_pro.sql` and `20261001000300_pro_grants.sql` (entitlements applied in
  event order, staff grants that never replace a store subscription), `server/src/revenuecat.ts`
  (the webhook, an optional check with RevenueCat's API, trial reminders two days ahead), the Pro
  screen with purchase and restore on `react-native-purchases`, *Manage subscription* in Profile,
  and Pro gating for the guided library, training analytics, heat and heart-rate ranges. The App
  Store products, the RevenueCat project and the sandbox tests need the operator's accounts
  (OPERATIONS.md).

## Platform track

**P.1 Android app** · L–XL (starts with Phase 2; ships before Phase 4)
- Why now: competing with friends and family breaks when half the family has Android.
- How:
  - Recording: the same Expo code base, with `expo-location` running as a location foreground
    service.
  - Store approval: Google Play requires a declaration for background location.
  - Imports: Health Connect via `react-native-health-connect`, which includes its Expo config
    plugin from v4; routes need a separate consent.
  - Voice cues: Android audio focus with lowering allowed.
  - Wear OS: through Health Connect first; a Wear OS app later if there's demand.
- Done when: the Android version of the device test protocol passes on three phones from
  different makers.
- Built: recording in a location foreground service the runner starts (`location-driver.android.ts`),
  so the app never asks for background location and needs no background-location declaration;
  preflight with Android's wording and a battery-saving tip; Health Connect behind the same ports
  as Apple Health (`src/features/health/health-connect.ts`): imports with routes when allowed,
  saved runs, heart-rate zones and trends; Health Connect's privacy-policy link answered
  (`modules/launch-intent`); Google Play wording for Pro; a reminder channel; media-read
  permissions removed. The Android protocol is in DEVICE_TEST_PROTOCOL.md; no Android build has
  run yet, and treadmill step counting on Android waits for a device.

**P.2 Web app** · L (lands with Phase 4)
- What: history, league standings, profile, export, and the page people open to follow a shared
  live run (4.8).
- How: Expo Router already renders the app on the web for development. The web app turns that into
  a supported, signed-in site.
- Done when: the core screens pass the existing web walkthrough and an accessibility check.
- Built: the production web build (`npm run build:web`) served by `scripts/web/serve.mjs` with a
  strict Content-Security-Policy and security headers, deployable as its own Railway service
  (`web/Dockerfile`); a readable column on wide screens; recording left to the phone app; the
  browser's local copy removed at sign-out; and `npm run e2e:web-app`, which signs in and opens 13
  core screens at phone and desktop widths with no browser or CSP errors and no serious axe-core
  findings. The live-run page arrives with 4.8.

## Phase 4: friends, family and everyone

Before this phase: privacy zones (4.2) and moderation at scale (4.9) ship first, because this
is where other people start seeing more than a name and a number.

**4.1 Leagues 2.0** · L
- What: up to five leagues per runner (family, friends, work), four-week seasons with a champion,
  one-on-one weekly duels, a Sunday recap of the week, and a family-league template. Teens can
  join family leagues under 4.10.
  - **Group runs**: a league event with a time, a meeting point and RSVPs.
  - **Group-chat link**: the owner can add the crew's existing WhatsApp, iMessage or Discord
    link, visible only to members. There is no in-app chat (decision 6).
- How: lift the one-league-per-runner rule (D-008). Standings stay capped best-3-days everywhere.
- Done when: the existing league tests pass per league, and seasons settle correctly across
  daylight-saving changes.
- Built: up to five leagues per runner, each with its own standings counted from when the runner
  joined it; a switcher on the League tab; Friends, Family and Work templates (family leagues are
  the kind teens will join under 4.10); four-week seasons shared by every league (counted from
  5 January 2026 in the competition calendar) with a champion kept once the last week is final;
  weekly duels a runner starts from a league-mate's name (best three days wins, three a week at
  most); a recap card from Sunday; group runs with a day, time, meeting point, notes and RSVPs,
  a push to members and a reminder an hour before to everyone going; and the owner's group-chat
  link (WhatsApp, Discord, Signal, Telegram, GroupMe or Messenger; iMessage has no invite links)
  shown only to members. Every league call takes an optional league id and otherwise acts on the
  first league, so older app versions keep working. `tests/backend/leagues2.test.ts` includes a
  season across the end of daylight saving time in November 2025, where a run from 23:00 on the
  season's last Sunday counts and one after midnight belongs to the next season.

**4.2 Privacy zones and per-run visibility** · M
- What: hide the start and end of a map within a chosen distance of saved places. Each run is
  visible to *only me* (the default), *my leagues*, *followers* or *everyone*. Maps are hidden
  unless the runner turns them on for that run.
- How: the server trims routes before any shared map is drawn. Share cards stay stats-only by
  default.
- Done when: no shared map ever includes points inside a privacy zone, tested against the
  stored route.
- Built: up to five privacy zones (100–800 m) set from where you are or where a recent run
  started; each run's visibility and map switch on its page, with defaults for new runs in
  Profile › Sharing and privacy zones; the server cuts every shared map (`private.shared_route`:
  coordinates rounded before they're checked, 200 m off each end, lines split where points were
  left out, at most about 400 points). `tests/backend/social.test.ts` checks every shown point
  against the stored route.

**4.3 Follow friends and profiles** · M
- What: follow a runner, with approval required by default. Find people through invite links,
  QR codes and opt-in name search. There is no contact-book upload.
- How: a follow table, requests, and block and mute that hide both runners from each other
  everywhere.
- Done when: a blocked runner can't find, follow or see the other, including through a cached link.
- Built: runner profiles, follow requests with approval on by default, follow links and codes
  that can be replaced, opt-in name search, People (following, followers, requests, your link),
  mute, and block from any profile or the league. A block ends follows both ways and hides both
  runners everywhere, including through an old link (`tests/backend/social.test.ts`).

**4.4 Feed with kudos and comments** · L
- What: runs from people you follow and your leagues. Posts are stats-only cards unless the
  runner shares the map. Kudos, and comments with replies (Strava reviewers ask to reply to
  comments). No direct messages (decision 6).
- How:
  - Pull-based feed queries; this scale doesn't need fan-out.
  - Comments pass the blocked-terms filter and a rate limit, and can be reported.
  - Apple's rules for user-generated content (guideline 1.2) apply.
- Done when: reporting, blocking and deleting all remove content everywhere it appears.
- Built: the feed (League › Feed, and "From friends" on Today): your runs, runs your follows share
  with followers or everyone, and runs league-mates share with the league, newest first, pulled a
  page at a time; stats-only cards unless the map is shared. Kudos (a burst arrives as one push)
  and comments with one level of replies on each run's page. Comments are filtered (500
  characters, no links, no hidden characters, whole blocked words) and limited (8 a minute, 100 a
  day); the author and the run's owner can delete them. Runners, runs and comments can be
  reported: a reported run or comment disappears for the reporter at once, and three reports hold
  a comment for review. `tests/backend/feed.test.ts` shows reporting, blocking, deleting a run and
  deleting an account each removing the content from the feed, the run page, profiles, counts and
  comments.

**4.5 Clubs** · L
- What: larger groups (up to a few hundred) with a club page, a weekly club board, group runs
  with RSVPs and a group-chat link. Clubs can be public or invite-only. No in-app chat
  (decision 6).
- How: club roles (owner, admins), moderation tools for admins, and reports that reach the
  existing moderation queue.
- Done when: a club admin can remove a member and content, and the moderation queue shows club
  reports.
- Built: clubs of up to 500 (League › Clubs), public (found by name, joined in one tap) or
  invite-only (joined with a 14-day code), up to ten per runner; a club page with who runs it, a
  weekly board scored like leagues (best three days, from when each member joined, members only,
  blocked runners shown without a name), group runs with RSVPs (members see them on the page;
  there's no push to hundreds of people, only reminders to those going) and the group-chat link.
  The owner makes and removes admins and hands the club on; admins edit the description, invite,
  remove members (who can't rejoin) and remove group runs, each recorded in
  `private.moderation_actions`. Clubs and group runs can be reported, and moderators can reset a
  club's name, close it or remove a group run. `tests/backend/clubs.test.ts` covers the admin
  removals and club reports in the queue.

**4.6 Challenges** · M
- What: monthly challenges such as *run 12 days in October* or *best-3-days all month*, league
  challenges and club challenges, each with a badge.
- How: challenges measure days and the capped weekly score, not raw mileage. Nike Run Club's
  distance challenges are topped by accounts logging 5,000 miles a month.
- Done when: a challenge can't be won by one very long run or by splitting runs.
- Built: League › Challenges. Two monthly challenges for everyone (run on 12 days; 750 points from
  each week's best three days) and challenges a league's owner or a club's admins set for this
  month or next (2 days up to every day of the month, or 100–1,500 points), three at a time per
  group, with an optional name that passes the name filter. Runners join in one tap until the
  last day; league members get a push about a new challenge, a club sees it on its page. Progress
  uses the league board's day totals (accepted runs, the indoor cap, runs the server had by a day
  after the end), each day capped at 125 points, and is worked out when it's read, so deleting a
  run takes the badge back. A league's or club's challenge has a board (blocked runners unnamed);
  the monthly ones show only your own progress. Each finished challenge is a badge on the Badges
  screen, and none awards XP. Challenges can be reported: moderators can reset a challenge's name
  or remove it, and owners and admins can remove one before it ends (recorded).
  `tests/backend/challenges.test.ts` shows a marathon, and ten 1 km runs on one day, each counting
  as one day and 125 points, behind three ordinary 4 km days.

**4.7 Global and regional leaderboards** · M–L
- What: weekly boards by tier (Seed to Elite) and by country, scored with the capped best-3-days
  XP.
- How:
  - Opt-in (decision 7). Runners are invited at natural moments, such as after their first
    full league week or when they win their league, and join with one tap.
  - Boards show the runner's name, tier and weekly score, never a route. Runners can leave at
    any time.
  - Only accepted runs count.
  - Results are provisional until a review window after the week closes. The top of each board
    gets extra automated checks.
  - Runners can report a result.
  - New accounts join after two weeks of normal runs.
- Done when: a simulated cheating account (car-speed runs, a replayed route, a hand-typed run)
  never appears on a final board.
- Built: League › Leaderboards. Weekly boards for each tier (the runner's tier when the week
  began) and each country (chosen by the runner, never worked out from their runs), showing only
  name, tier and score. Anyone signed in can look; runners join in one tap, from the screen or an
  invitation on the League tab after winning a league's week or a full league week, and leaving
  takes them off every board, past weeks included. Scores are the best three days, capped, from
  accepted GPS runs the server had within a day of the week's end (no treadmill or typed-in runs).
  Accounts appear once they have two weeks of runs and are 14 days old. Boards stay provisional
  until 48 hours after the week closes; the top ten of every board are checked for a route with
  the same GPS points as another run at another time (every route now has a fingerprint of its
  points without their times), a pace under 3:00/km over 5 km or more, and runs held for speed that
  week. A result that fails is held off the board and goes to the moderation queue, where a
  moderator releases it, removes it or takes the runner off the leaderboards; anyone can report a
  result too. `tests/backend/leaderboards.test.ts` runs the simulated cheater: its car-speed runs
  are held for review, its typed-in marathon never scores, and three replays of its own earlier
  route, which the validator accepts, are caught before any board and never reach a final one.

**4.8 Live location sharing** · L
- What: share a live link with chosen people for this run only. It stops when the run ends or
  after a set time. It is never public, and it is free, because it is a safety feature.
- How: the recorder posts a location every 30 seconds or so to a link that expires. Viewers
  open the web app (P.2). Battery use is measured.
- Done when: the link stops working the moment the run ends, and a one-hour run's battery use is
  documented.
- Built: a live button on the run screen makes a link for this run (it stops after 1, 2, 3 or 6
  hours at most) and opens the share sheet, so the runner picks who gets it. While it's open the
  phone posts its latest fix about every 30 seconds, from the background too; finishing,
  discarding or starting another run stops it at once, and a stop that couldn't reach the server
  goes again with the next fix. The link opens the web app's `/live/[code]` page with no account:
  the runner's name, when they were last seen, the position with links to Apple Maps and Google
  Maps, and the distance and time so far, refreshed every 15 seconds. The server keeps only a hash
  of the code and only the latest position, wiped the moment the link stops; after that the page
  and the API show nothing but "ended". `tests/backend/live-location.test.ts` shows the link
  stopping at the end of the run, on "Stop", when a new link replaces it and when its time runs
  out. The battery measurement is a device case (P4-LIVE-BATTERY in DEVICE_TEST_PROTOCOL.md),
  not yet run.

**4.9 Push notifications and moderation at scale** · M
- What: remote notifications for cheers, kudos, comments, follows and results. All are optional,
  and none threaten rank loss (REQ-012). Moderation adds a review tool for staff, response targets
  and a published contact.
- How: the server sends pushes through Expo's push service. The existing report and moderation
  tables are extended to comments, clubs and challenges.
- Done when: every notification type can be switched off, and a report is acted on within the
  response target in a drill.
- Built: pushes for kudos, comments and replies, follows, cheers and week results (the day after
  a week is final, only to members who ran), queued by the database and sent by the API service
  through Expo (`server/src/push.ts`): each type has its own switch under Profile ›
  Notifications, nothing arrives between 22:00 and 07:00 local time, a block or deletion drops a
  push that hasn't gone out, uninstalled apps are forgotten from Expo's receipts, and a tap opens
  only the app's own screens. Moderation: a 24-hour response target on every report, Profile ›
  Moderation for staff (the queue by due time, snapshots without routes or contact details,
  audited actions: remove a comment, hide a run, reset a name, and the league actions), overdue
  reports in the health report, and the published contact after every report. The drill runs in
  `tests/backend/feed.test.ts`; OPERATIONS.md has it for people, and the APNs and FCM setup. Not
  yet on a device: pushes need the APNs key and FCM credentials in EAS and `PUSH_ENABLED` on the
  API.

**4.10 Teen accounts in family leagues** · L
- What: 13–17 year olds can join a family league created by an adult, with a parent's consent
  (decision 3).
- How:
  - Age from Apple's Declared Age Range API. Parent consent through Apple's tools, with
    Significant Change requests when features change.
  - Teens see only their family leagues:
    - No follows from outside the family.
    - No feed, comments, clubs, global leaderboards or public sharing.
    - Live location only to family members.
    - No health data under 16.
  - The adult who created the league sees the teen's league activity and can remove them.
  - Counsel reviews state age laws (Texas, Utah and others) before launch.
- Done when: a teen account can't reach any feature outside its family league, tested
  through the API as well as the screens.
- Built, behind the `teen_accounts_enabled` flag (off: under 18 stays locked, as in the beta):
  the age check asks the store for 13, 16 and 18 and makes a teen account for 13–15 or 16–17
  (under 13 is locked). A teen asks to join a family league with its code, and the adult who runs
  it approves them as their parent or guardian, which is recorded as the consent. Teens can't
  create or invite to leagues, and can't be made owners; if the league's adult leaves, it passes
  to another adult or closes. Every profile-scoped API call from a teen account is checked against
  an allowlist of what they may reach (their running, their family leagues, live location,
  blocking and reporting), and triggers keep them out of clubs, follows, leaderboards and Strava,
  keep their runs to "only me" or "my leagues", keep comments and kudos off their runs, and keep
  heart rate and health data out under 16. Their live-location links open only for family members
  who are signed in. The adult sees each teen's week and can remove them. An adult account the
  store later reports as a teen steps back to its family leagues, and a store answer can't undo a
  teen account. `tests/backend/teens.test.ts` calls every API function as a teen: each is either
  on the allowlist, one of the runner's own (runs, records, plans, export, deletion) or refused.
  The policy and terms text to publish when it's switched on is in
  `docs/legal-drafts/teen-accounts.md`, for counsel.

## Phase 5: maps

**5.1 Route planning** · L
- What: draw or auto-route a run of a chosen distance, save it, follow it, and send it to the
  watch.
- How: a routing service with a walking or running profile, such as Mapbox Directions or
  GraphHopper. Costs grow with users, so check pricing before choosing.
- Done when: a planned 10 km loop is within 2% of 10 km and can be followed on the phone and
  the watch.
- Built: a Routes section in Train. The planner makes a loop of a chosen distance from where the
  runner is (or a point they tap), with "Try another loop", or draws a route tap by tap, each
  stretch following paths or, with "Follow paths" off, a straight line; undo, back to the start,
  and save with a name. The API service plans through GraphHopper's Routing API (hosted or
  self-hosted, off until `ROUTING_URL` is set; drawing works without it) and keeps its key; round
  trips come out 10–20 % off the distance asked for, so it asks for four at a time and corrects
  the distance until one is within 2 % (checked against GraphHopper 11 on OpenStreetMap data
  around Cambridge, UK: 135 of 150 loops of 3–21.1 km within 2 %, 8 calls on average; the rest
  show their real distance). Saved routes are private, measured by the server from their points,
  in the export and deleted with the account; teens can plan their own. A route page shows the
  map, the distance, climb and turn-by-turn list, and offers "Run this route", "Send to Apple
  Watch" (the watch app shows it on a map during a run) and a GPX file for Garmin Connect and
  other watches. Following it on a run is 5.2's navigator; the run screen shows the next turn and
  the distance to go. Android builds need a Google Maps key (`GOOGLE_MAPS_ANDROID_KEY`) for real
  maps, and draw routes on a grid without one; the web app plans loops and shows routes on a grid.

**5.2 Offline maps and navigation** · L–XL
- What: download a map area and a route before a run. Get turn cues and off-route alerts through
  the voice cues (Part C).
- How: Apple's MapKit offers apps no way to download map areas, so this uses Mapbox offline
  packs (`@rnmapbox/maps`) for these screens.
- Done when: a route can be followed in airplane mode with turn and off-route cues.
- Built, in two parts. The navigation: a navigator on the phone matches each GPS fix to the route near
  where the runner was (so out-and-backs, spurs and a loop's shared start and finish are followed
  in order, the runner's direction deciding), says each turn once about 60 m before it ("In 60
  meters, turn left onto Elm Street", two close turns together), says when the runner is more
  than 45 m off the route for 8 seconds and which way it is (again each minute), "Back on the
  route", a wrong-way warning and the end, through the voice cues ahead of anything else due. It
  needs no connection: a route opened once is kept in the phone's encrypted journal, and where
  the runner is along it is saved as they go, so a relaunch carries on without repeating turns.
  On 14 real GraphHopper loops (698 turns) walked with 12 m of GPS noise, every turn was said or
  folded into the one a few metres before it, with no false off-route or wrong-way alert.
  And the maps: a route's page offers "Download map", a Mapbox offline pack of the route's area
  (its bounds and 400 m, zoom 10 to 16, less close-up detail for very long routes); the route
  page, the preflight and the run screen of a run that follows a route are then drawn by Mapbox,
  which shows the kept area without a signal. Profile › Offline maps lists the areas with their
  size and removes them; each is marked with its account and signing out removes them. Mapbox's
  own telemetry is off. The Mapbox SDK is in a build only with `PL_MAPBOX=1` and a public token
  (`react-native.config.js` keeps it out otherwise; checked with Expo's autolinking and prebuild),
  so until the Mapbox account exists, runs without a signal follow the route by voice on the
  usual maps.

**5.3 Segments** · XL
- What: stretches of path with leaderboards.
- How:
  - Start with curated segments on paths, not roads (a safety call).
  - Matching happens on the server, for accepted runs the runner has shared.
  - Boards hide runners who haven't opted in.
  - Vehicle and e-bike checks come from the validator.
  - The "local legend" style award counts distinct days, not the raw number of efforts.
  - Needs PostGIS or a separate geo service; confirm Railway's Postgres supports it.
- Done when: matching agrees with hand-checked results on a golden set and ignores
  opposite-direction passes.
- Built: League › Segments lists the segments, each with its best times (a runner's best, the top
  50 and the runner), its local regular (who ran it on the most different days in the last 90)
  and the runner's own times; a run's page lists the segments it went through, marking bests.
  Staff make a segment from a route they planned along a path, trail, track or park, and can
  retire it; both go in the moderation log. Runners join and leave the boards; teens can't join.
  Only accepted runs shared with everyone, map included, are matched, and only on what a shared
  map shows (not the first or last 200 m, nothing inside a privacy zone), so the validator's
  vehicle and e-bike checks apply first. A time needs the whole segment in its direction, in one
  stretch: near the start line, along the line (within 30 m, a few GPS slips allowed, never back
  more than 30 m) and out near the end, timed between the two lines. Faster than 7 m/s is held
  for a moderator (release, remove the time, or take the runner off the boards); faster than
  11 m/s isn't counted. Railway's standard Postgres has no PostGIS (its PostGIS template is a
  separate, unmanaged database), so matching is plain SQL and PL/pgSQL, run by the minute job.
  The golden set (`tests/backend/segments.test.ts`) checks runs whose times are known by
  construction: through the segment (within 1 s of the true time), the other way (no time),
  leaving or joining it part way, a 100 m detour (no time) against 10 m of GPS noise (timed within
  3 s), two laps (two times), a pause, a start on the start line, a privacy zone halfway, and the
  sharing rules.

**5.4 Heatmaps and route discovery** · L
- What: a map of popular running paths and suggested routes nearby.
- How:
  - Built only from runs shared with *everyone*, and only from runners who choose to contribute.
  - Privacy zones and the first and last stretch of every run are removed.
  - A path appears only after at least 5 different runners have used it.
  - Tiles are rebuilt weekly and cached in storage.
- Done when: a single runner's route can't be reconstructed from the heatmap, tested with
  synthetic data.
- Built: Train › Routes › Popular paths shows the heatmap around the runner, four brightness
  levels from quieter to busier (never a count), and "Loops through busy paths": for 3 to 10 km
  (or miles), up to three loops from the runner through two of the busiest places nearby, in
  different directions, planned along paths by 5.1's planner and saved as routes. Runners choose
  to add their runs (on that screen or in Profile › Sharing; never teens), and then only accepted
  runs shared with everyone, map included, from the last year count, on what a shared map shows
  (not the first or last 200 m, nothing in a privacy zone). Each run's cells (the web map grid at
  zoom 21, about 14 m across in mid-latitudes, so no PostGIS) are worked out once by the minute
  job; the map is rebuilt weekly and a cell shows only when 5 different runners went through it,
  however often one of them did. The API service draws the tiles (PNG, zooms 10 to 18), keeps each
  until the next build, and serves them through links it signs for a day, which name no runner:
  the phones' maps overlay them, and the web app lays them out on a grid. The synthetic-data test
  (`tests/backend/heatmap.test.ts`): a route one runner runs twelve times never shows, four
  runners don't make a path and a fifth does, five runners from the same front door never show
  its first or last 200 m, a privacy zone halfway takes the path out there, runs not shared with
  everyone or without the map don't count, and in a town of 40 runners on a street grid the map
  is exactly the cells five or more share, so none of anyone's own streets show. A weakness any
  threshold has remains, and is written down (OPERATIONS.md): comparing builds a week apart could
  show where a path just reached five runners.

## Free and Pro

Decided 28 September 2026 (decision 4).

**Free, forever**
- Recording on phone and watch, imports, export, voice cues, auto-pause and live pace.
- The complete run log, personal records, and weekly, monthly and yearly stats with
  comparisons.
- Heart-rate zones per run, badges and weekly streaks.
- Leagues, cheers, group runs, follows, the feed, clubs, challenges and leaderboards.
- Training plans for every distance, with full editing, check-ins, illness pauses and
  adjustments after *too hard* feedback.
- A starter set of guided runs.
- Live location sharing, and every privacy and safety setting.

**Pro: $29.99 a year or $4.99 a month** (7-day trial on the annual plan)
- The full guided-run library.
- Plan adjustments for heat and heart rate.
- Training analytics: training load, fitness and fatigue, race predictions, aerobic efficiency,
  health trends and year-over-year comparisons.
- Offline maps, navigation and route planning.
- Extra share-card styles.

**Never paid:** anything that changes XP or rank, safety features, data export and account
deletion.

## Content budget

Decided 28 September 2026 (decision 5): plan on about **$30,000**, mostly in Phase 3.

| Item | Phase | Assumptions | Estimate |
|---|---|---|---|
| Voice-cue clips | 1 | Two voices, about 1,500 words each (numbers, units, phrases), full buyout for in-app use, editing | $1,000–2,000 |
| Running coach | 3 | 7 plan types at 3 levels, progression rules, post-run notes, 16 guided-run scripts, pilot review: about 160 hours at $75–125 an hour, rights assigned to PaceLeague | $12,000–20,000 |
| Guided-run recording | 3 | 16 runs with about 10 minutes of speech each, at $30–55 per finished minute (e-learning rates), plus editing and mastering | $6,000–12,000 |
| Navigation cue clips | 5 | One session for turn and off-route phrases | $500–1,000 |
| **Total** | | | **$19,500–35,000** |

Rates: coaches charge $50–120 an hour for private sessions in 2026 (specialists more); product
and rights work is assumed at $75–125. Voice-over rates from Voice Crafters' 2026 guide:
e-learning $0.20–0.35 a word or $30–55 per finished minute; phone-prompt work $0.08–0.25 a word,
with a $100–200 minimum. If the coach records the guided runs, as Nike's coaches do, the
recording line shrinks to studio time and editing.

## Measures

| Phase | Measure | Target |
|---|---|---|
| All | Confirmed lost runs | 0 |
| All | Crash-free sessions | ≥ 99.5% |
| 1 | Music back to full volume after a cue (test matrix) | 100% |
| 1 | Weekly streaks broken by a late sync or import | 0 |
| 2 | Runs synced without the runner doing anything | ≥ 99.5% |
| 2 | Median time from watch finish to synced (phone nearby) | < 60 s |
| 3 | Sessions rated *too hard* | < 15% |
| 3 | Planned sessions completed or moved | ≥ 70% |
| 4 | Runners in an active league or club each week | Set after Phase 3 baseline |
| 4 | Reports acted on within target | ≥ 95% |

## Risks

| Risk | Mitigation |
|---|---|
| This plan roughly triples the product, and more features mean more breakage, the second-biggest complaint | Phase gates in the ground rules; TestFlight and phased release; no phase overlaps except the platform track |
| Social features erode the privacy promise | Private by default, privacy zones first, stats-only cards, opt-in maps and boards |
| Moderation load from comments and clubs | Blocked terms, rate limits, reports, club admins, a staff tool and response targets before the feed ships |
| Health-data rules | Counsel review before 3.5; consent screens; no ads; data minimization |
| Content costs (coach, voice talent) | Budget per phase; starter library first |
| Garmin access and cost | Aggregator switched on by a user-count trigger, Garmin's own API when it reopens; Garmin runners get history and goals meanwhile. Confirm the aggregator's terms allow league scoring |
| Minors and state age laws | Adults only until Phase 4; Apple's age check from Phase 0; teen accounts limited to family leagues; counsel review before 4.10 |
| Apple review: background audio, HealthKit wording, user-generated content | Use each capability only for its stated purpose, write the permission text carefully, add a review note per release |
| Battery (watch app, live location) | Measure on real devices; published targets per feature |
| Map and routing costs | Price check before Phase 5; features limited to the screens that need them |

## Decisions (28 September 2026)

The founder asked for the best answer to each open question, based on the market and on what
runners ask for in the reviews. Each decision cites both.

### 1. Garmin: automatic sync through a data aggregator, then Garmin's own API

**Decision.** Garmin runs count for history and goals from day one through Apple Health. For
league credit, connect Garmin through a data aggregator that already has Garmin access, such as
Terra or Spike. Switch it on when about 50 active runners, or 15% of weekly active runners, use
Garmin. Move to Garmin's own developer program when it reopens. No Connect IQ app.

**Why.**
- Every rival syncs Garmin automatically: Strava, Runna, Nike Run Club and Runify all connect to a
  Garmin account. A Connect IQ app would make Garmin owners start every run from our app instead
  of Garmin's own run mode, which no rival asks of them.
- Sync friction is the top complaint in the reviews (463). Two of Runify's 22 reviews say runs
  from a connected watch or Garmin never arrived.
- Garmin stopped reviewing new developer applications in spring 2026 for a redesign and has given
  no reopening date. Existing partners, including aggregators, keep working.
- Apple Health can't carry league credit, because Garmin sends workouts there without the route.

**Cost and checks.**
- Terra starts at $399 a month billed annually. That includes 100,000 credits, and each connected
  runner uses 200 a month, so about 500 runners. Spike prices per active user; get a quote.
- Before signing, confirm the feed includes GPS samples.
- Also confirm its terms allow using a runner's activities in scores their league-mates see.
  Strava's terms, for comparison, do not.

### 2. Streaks: weekly, not daily

**Decision.** No daily streaks. A weekly streak counts the weeks in a row a runner meets their
weekly goal, or runs at least once if they haven't set one (1.8).

**Why.**
- Strava's free streak is weekly (one activity a week), and Runna has none. Runify shows streaks
  without saying whether they're daily. Otherwise, daily streaks appear only as Garmin step
  streaks and Nike Run Club's run-day achievements.
- Runners barely mention streaks: 8 of 2,112 reviews. Three like them, four are angry that a bug
  or a failed sync broke theirs, and one dislikes the pressure.
- A daily streak pushes people to skip rest days. That works against plans that fit the runner
  (Part B) and against PaceLeague's rule that rest days never cost you.

**Guardrails.**
- The streak counts by each run's start date, so a late sync or import never breaks it.
- Pausing a plan for illness or travel freezes it.
- There are no "you're about to lose your streak" notifications (REQ-012).

### 3. Teens: adults only until Phase 4, then family leagues only

**Decision.** 18+ for the beta and Phases 1–3. In Phase 4, 13–17 year olds can join only a family
league an adult creates, with a parent's consent and restricted features (4.10).

**Why.**
- The market is split. Strava and Nike accept 13+ with extra protections. Strava tightens privacy
  defaults for under-18s and holds back heart-rate data under 16. Runna is 18+.
- The demand is real: Runify's happiest reviewers describe whole families competing, and a Nike
  Run Club reviewer mentions being 16.
- The rules are tightening. Texas now requires age assurance, and a parent's consent for minors,
  for apps downloaded on new Texas Apple accounts. Apple supports this with its Declared Age Range
  and Significant Change APIs, and Utah and other states have passed similar laws.
- Teens need the Phase 4 safety work first: privacy zones, blocking and moderation at scale.

**Also now (Phase 0).** Check Apple's age range at sign-up and turn away under-18 accounts,
alongside the existing adult self-declaration.

### 4. Free and Pro: a generous free tier, $29.99 a year

**Decision.** Pro costs $29.99 a year or $4.99 a month, with a 7-day free trial on the annual
plan only. A reminder comes two days before the trial converts, along with a cancel link. The
tiers are listed in [Free and Pro](#free-and-pro).

**Why.**
- Paywalls are the fourth-biggest complaint (220 reviews). Strava accounts for 145 of them:
  once-free features moved behind the paywall, constant upgrade prompts and billing problems.
  Among those, 45 complain about trials that roll into yearly charges, hidden cancellation or hard
  account deletion.
- The *keep the basics free* requests name best efforts, progress and leaderboards. A Garmin
  reviewer objects to paying for heart-rate zones that rivals include as standard. Nike Run Club's free plans are loved (100
  reviews), while Runna's price is its top complaint (50).
- Market prices: Runify $39.99 a year ($4.99 a month), Garmin Connect+ $69.99, Strava $79.99 and
  Runna $119.99. Nike Run Club is free. At $29.99, PaceLeague is the cheapest paid tier.
- Pro holds what costs money to run or goes beyond the basics:
  - The full guided-run library (voice talent).
  - Advanced training analytics.
  - Weather and heart-rate plan adjustments (weather data).
  - Offline maps and route planning (map fees).

### 5. Coach and voice: about $30,000, human voices

**Decision.** Plan on about $30,000, mostly in Phase 3; the breakdown is in
[Content budget](#content-budget). Use human voices. If the coach has a good voice, the coach
records the guided runs and a voice actor records only the short cue clips.

**Why.** Runna's synthetic voice draws complaints: "It sounds like Mii's from Wii/DS," and 31
reviews complain about its audio. Nike Run Club's human coaches are its most-praised feature (182
reviews), and its guided runs are voiced by real coaches.

### 6. Chat: none; link to the chats crews already use

**Decision.** No chat and no direct messages. Leagues and clubs get:
- Comments with replies on shared runs.
- Cheers and reactions.
- Group runs with RSVPs.
- A group-chat link the owner can add (WhatsApp, iMessage, Discord), visible only to members.

**Why.**
- Chat is barely requested: one Nike Run Club review asks for run groups with chat.
- Messaging draws complaints where it exists:
  - A Strava reviewer: "it is easier for me to message a stranger than to find my summary
    statistics."
  - Another Strava reviewer says strangers found and messaged them.
  - A Garmin reviewer was harassed through its chat and asks it to "get rid of chat."
  - A Strava reviewer found it easier to organize a group run on WhatsApp.
- Runna, Nike Run Club and Runify have no chat. Crews already have group chats, and linking to
  them needs no moderation.
- Chat would make teen accounts (decision 3) much riskier.

**Revisit** if more than a quarter of active leagues ask for in-app chat after Phase 4.

### 7. Leaderboards: opt-in

**Decision.** Opt-in. Runners are invited at natural moments, such as after their first full
league week or when they win their league, and join with one tap. Boards are by tier division
and country, and show only the runner's name, tier and weekly score, never a route. Runners can
leave at any time (4.7).

**Why.**
- Strava shows activities publicly by default and draws privacy and stalking complaints. Garmin
  ranks only activities a runner made public. Nike Run Club's boards include only runners who
  joined that challenge.
- Public boards attract cheating: Nike Run Club's are topped by accounts claiming 5,000 miles a
  month.
- Open boards can put beginners off: a Runify reviewer quit after seeing the leader's mileage.
  Tier divisions keep beginners competing with beginners.
- Opt-in keeps PaceLeague's private-by-default promise.

## Sources

- [Apple: Build a multi-device workout app (WWDC23)](https://developer.apple.com/videos/play/wwdc2023/10023/): workout sessions and mirroring
- [Apple developer forums: speech doesn't return audio to other apps](https://developer.apple.com/forums/thread/759553)
- [Apple: interruptSpokenAudioAndMixWithOthers](https://developer.apple.com/documentation/avfoundation/avaudiosession/categoryoptions/1616534-interruptspokenaudioandmixwithot)
- [Expo Apple Targets (watch apps, widgets)](https://github.com/EvanBacon/expo-apple-targets) and its [watch embedding issue](https://github.com/EvanBacon/expo-apple-targets/issues/175)
- [react-native-healthkit](https://github.com/kingstinct/react-native-healthkit) and its [route memory issue](https://github.com/kingstinct/react-native-healthkit/issues/370)
- [expo-live-activity (Software Mansion)](https://github.com/software-mansion-labs/expo-live-activity)
- [react-native-health-connect](https://github.com/matinzd/react-native-health-connect)
- [Garmin forums: Garmin Connect doesn't sync routes to Apple Health](https://forums.garmin.com/apps-software/mobile-apps-web/f/garmin-connect-mobile-ios/352961/garmin-connect-does-not-sync-workout-routes-i-e-gps-data-to-apple-health-app)
- [Garmin Connect Developer Program FAQ](https://developer.garmin.com/gc-developer-program/program-faq/) and a [report that onboarding paused in 2026](https://aifitnessapi.com/fix/garmin-api-approval)
- [Garmin Connect IQ](https://developer.garmin.com/connect-iq/)
- [the5krunner: Garmin freezes developer API access (September 2026)](https://the5krunner.com/2026/09/14/garmin-developer-api-access-paused/)
- [Terra pricing](https://tryterra.co/pricing) and [Spike pricing](https://www.spikeapi.com/pricing)
- [Apple: next steps for apps distributed in Texas](https://developer.apple.com/news/?id=2ezb6jhj)
- [Strava: using Strava under 16](https://support.strava.com/en-us/articles/15401925-can-i-use-strava-if-i-m-under-the-age-of-16) and [Runna: age requirements](https://support.runna.com/en/articles/14102837-age-requirements-for-using-runna)
- [Voice Crafters: 2026 voice-over rates](https://www.voicecrafters.com/industry-standard-voice-over-rates/)
- [CoachIQ: private training session pricing, 2026](https://www.coachiq.io/blog/how-to-price-private-training-sessions-2026-guide)
- [Strava: how data appears on third-party apps](https://support.strava.com/en-us/articles/15401608-api-agreement-update-how-data-appears-on-3rd-party-apps)
- Packet: `docs/packet/specs/DECISION_LOG.md`, `FACTORY_PRD.md`, `TECHNICAL_SPEC.md`, `SOURCES.md` (S11–S13)
