# PaceLeague roadmap after V1

Status: **draft for the founder's review**, 28 September 2026.
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
| 2 | Every run counts | Apple Health import, PaceLeague Apple Watch app, Strava export, file import, treadmill, sync status | 14–22 weeks |
| 3 | Coach | Training plans, adaptive coaching, coach feedback, guided runs, health and training data, Pro | 18–28 weeks |
| Platform track | Android, web | Android app from the start of Phase 2; web app lands with Phase 4 | 6–10 + 3–6 weeks |
| 4 | Friends, family and everyone | Leagues 2.0, privacy zones, follow, feed, clubs, challenges, global leaderboards, live location, push | 20–30 weeks |
| 5 | Maps | Route planning, offline maps and navigation, segments, heatmaps | 18–28 weeks |

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
   and nothing on it moves behind Pro later. Strava gets 145 complaints for doing exactly that.
5. **Don't reshuffle screens.** New features arrive in the places listed under
   [Screens](#screens-where-new-features-go). Nothing is removed without a replacement.
6. **Release safety.** Every update goes to TestFlight testers first, then out through the App
   Store's phased release. A phase ships only when the release before it has crash-free sessions
   of at least 99.5%, and runs sync without the runner doing anything at least 99.5% of the time.
7. **Adults only** (18+) until a separate decision on teens. Family leagues mean adult family
   members for now.

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

**The Garmin decision (2.4).** Getting Garmin routes needs one of three things:

- Garmin's business-only developer program. Third parties report that new sign-ups were paused in
  2026, so this can't be relied on.
- A paid data aggregator such as Terra or Spike.
- A PaceLeague Connect IQ app on the Garmin that uploads over HTTPS through Garmin's phone app.

Recommendation: apply to Garmin's program now; prototype the Connect IQ app if there's no answer
in 8 weeks. Garmin runners get history and goal credit from day one either way.

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
4. **Paces as ranges.** Pace ranges come from recent best efforts (1.4). Runners can train by
   effort or heart rate instead of pace. In hot weather the day's range slows down, using the
   forecast from Apple WeatherKit.
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
- **Explain held runs**: when the validator holds a run for review, say why and how to ask for
  another look.

## Phase 1: better runs (V1.1)

**1.1 Voice cues that play nicely with music** · M
- What: spoken splits, pace, time and distance, designed as in Part C.
- How: a native audio module (Expo Modules API), a cue scheduler driven by the recorder's live
  metrics, the recorded voice set, and settings under Profile.
- Done when: the Part C test matrix passes on two iPhone models.

**1.2 Live pace, data screens and a lock-screen Live Activity** · M
- What: current pace (smoothed over about 20 seconds), lap pace, and a choice of 3–4 fields
  on the run screen. The run also shows on the lock screen and Dynamic Island.
- How: smoothing in the recorder's live metrics. Software Mansion's `expo-live-activity`
  (iOS 16.2 and later) for the lock screen.
- Done when: current pace settles within 10 seconds of a pace change on a track test, and the
  Live Activity updates with the phone locked.

**1.3 Auto-pause** · M
- What: pauses when you stop and resumes when you move, on by default with a switch in settings.
- How: speed thresholds with a delay (for example, under about 1 m/s for 5 seconds pauses, over
  about 1.5 m/s for 3 seconds resumes). Motion data avoids false pauses from GPS jitter.
  Scoring already uses active time.
- Done when: traffic-light stops pause and resume on 10 test runs without a false pause while
  running.

**1.4 Personal records** · M
- What: fastest 1K, mile, 5K, 10K, half and marathon, plus longest run, with history. Free:
  all five rivals track best times, and Strava and Runify charge for it.
- How: the server finds the fastest stretch of each distance inside accepted runs, measured by
  distance and interpolated between GPS points. Existing runs are backfilled once. Records don't
  affect XP.
- Done when: the computed results match hand-checked results on a golden set of routes, and
  deleting a run removes its records.

**1.5 Fix a run** · M
- What: trim the start or end, cut out a section recorded while stopped, change a run to a walk,
  merge two runs split by accident. Renaming already exists.
- How: the edit is sent as a new version of the run. The server re-validates and re-scores it and
  keeps an audit trail. Edits can only remove distance, never add it. Merging keeps the two runs'
  distance and adds nothing for the gap between them. So edits can't be used to cheat. Leagues show a correction note, as they already do for deletions.
- Done when: trimming updates XP and standings the same way a deletion does, and a trimmed run
  can never score more than the original.

**1.6 Save runs to Apple Health** · S–M
- What: finished runs appear in Apple Health and Fitness with their route and distance.
  People want their runs in one place.
- How: `@kingstinct/react-native-healthkit` (Expo config plugin) writes the workout and route
  when the run is saved, and removes them if the runner deletes the run. It asks for write
  permission only when the runner switches this on.
- Done when: a run saved on the phone appears in the Fitness app with its map, exactly once, and
  deleting the run removes it.

**1.7 Stats and trends v1** · M
- What: weekly, monthly and yearly totals, the same period last year, a custom date range,
  pace trend and personal-record history.
- How: server aggregates over accepted runs, cached per week.
- Done when: totals match the run log exactly for any range.

**1.8 Badges and achievements** · M
- What: milestones (first run; 10, 50 and 100 runs), distance totals, tier-ups, personal records,
  league wins, and weeks in a row meeting your weekly goal. The last is the consistency reward;
  rest days never break it. Daily streaks stay undecided (see [open decisions](#open-decisions)).
- How: a badge table and rules evaluated when scoring is applied, so badges reverse if a run is
  deleted. Badges never award XP.
- Done when: every badge rule has a test, and deleting the run that earned a badge removes it.

**1.9 League cheers** · S
- What: tap to cheer a league-mate's day or week. A notification-light version of kudos inside
  the league, with nothing to moderate.
- How: a cheers table (who cheered whom, for which day), limited per day. Cheers are shown to the
  runner being cheered and to their league.
- Done when: blocked runners can't cheer each other, and cheers disappear with a deleted account.

**1.10 Run log extras** · S
- What: notes on a run, shoe tracking with mileage and a replacement reminder, a calendar view,
  and search and filter. This makes the log complete, the thing Strava is praised for.
- How: new columns and tables. Shoes are private.
- Done when: notes and shoes are included in the data export.

**1.11 Home-screen widgets** · S–M
- What: this week's goal progress and league rank on the home screen (Garmin reviewers ask for this).
- How: a WidgetKit extension added with `@bacons/apple-targets`, fed from shared app-group storage.
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

**2.3 Strava export** · S–M
- What: optionally post each accepted run to the runner's Strava account.
- How: Strava sign-in (OAuth) and Strava's upload API. The Strava connection is stored
  server-side and can be revoked from Profile. Nothing is read back from Strava into leagues;
  Strava's agreement forbids showing a runner's Strava data to others.
- Done when: a run appears in Strava once, and disconnecting stops further posts.

**2.4 File import and the Garmin path** · M, plus Connect IQ if chosen (L)
- What: import GPX, FIT or TCX files from the share sheet. Imported files are personal history,
  because a file can be edited and so can't be trusted for the league. For Garmin league credit,
  follow the decision in Part A.
- How: file parsing on the server, the same run pipeline, and `source` of `file_import`
  (history only).
- Done when: a FIT file from a Garmin shows its route and splits in the log.

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

**2.6 Sync status and repair** · S
- What: the per-run sync states and retry described in Part A, a sync screen in Profile, and a
  one-tap *send diagnostics* for support.
- Done when: every failure test ends in *Synced* or *Needs attention* with a reason.

**2.7 Walks, hikes and other workouts** · S–M
- What: walks, hikes, rides and strength workouts from Apple Health appear in the log and count
  toward training load (3.5). They never earn league XP.
- Done when: the log filters by type and totals separate running from everything else.

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

**3.2 Adjustable, adaptive plans** · XL
- What: everything in Part B points 3–7. That covers the check-ins, feedback, heat, pain flag,
  pausing and full editing.
- Done when: the 30-runner pilot meets the targets at the end of Part B.

**3.3 Coach feedback after runs** · M
- What: a short note after each run in the coach's voice. For example: *"You held your easy pace.
  That's what today was for."* Rule-based, from coach-written templates, with no generative AI.
- Done when: every note maps to a rule and a template the coach approved.

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

**3.5 Health and training data** · L
- What: heart-rate zones per run, and trends in:
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

**3.6 Pro subscription** · M
- What: the Pro tier in [Free and Pro](#free-and-pro) at the planned $29.99 a year
  (REQ-013).
- How: App Store subscriptions through RevenueCat, as the packet planned, with a clear free list,
  a reminder before a trial converts, and a *Manage subscription* link. Account deletion never
  requires cancelling first (REQ-010).
- Done when: purchase, restore, expiry, refund and deletion are tested in the sandbox.

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

**P.2 Web app** · L (lands with Phase 4)
- What: history, league standings, profile, export, and the page people open to follow a shared
  live run (4.8).
- How: Expo Router already renders the app on the web for development. The web app turns that into
  a supported, signed-in site.
- Done when: the core screens pass the existing web walkthrough and an accessibility check.

## Phase 4: friends, family and everyone

Before this phase: privacy zones (4.2) and moderation at scale (4.9) ship first, because this
is where other people start seeing more than a name and a number.

**4.1 Leagues 2.0** · L
- What: up to five leagues per runner (family, friends, work), four-week seasons with a champion,
  one-on-one weekly duels, a Sunday recap of the week, and a family-league template (adults for
  now).
- How: lift the one-league-per-runner rule (D-008). Standings stay capped best-3-days everywhere.
- Done when: the existing league tests pass per league, and seasons settle correctly across
  daylight-saving changes.

**4.2 Privacy zones and per-run visibility** · M
- What: hide the start and end of a map within a chosen distance of saved places. Each run is
  visible to *only me* (the default), *my leagues*, *followers* or *everyone*. Maps are hidden
  unless the runner turns them on for that run.
- How: the server trims routes before any shared map is drawn. Share cards stay stats-only by
  default.
- Done when: no shared map ever includes points inside a privacy zone, tested against the
  stored route.

**4.3 Follow friends and profiles** · M
- What: follow a runner, with approval required by default. Find people through invite links,
  QR codes and opt-in name search. There is no contact-book upload.
- How: a follow table, requests, and block and mute that hide both runners from each other
  everywhere.
- Done when: a blocked runner can't find, follow or see the other, including through a cached link.

**4.4 Feed with kudos and comments** · L
- What: runs from people you follow and your leagues. Posts are stats-only cards unless the
  runner shares the map. Kudos and comments.
- How:
  - Pull-based feed queries; this scale doesn't need fan-out.
  - Comments pass the blocked-terms filter and a rate limit, and can be reported.
  - Apple's rules for user-generated content (guideline 1.2) apply.
- Done when: reporting, blocking and deleting all remove content everywhere it appears.

**4.5 Clubs** · L
- What: larger groups (up to a few hundred) with a club page, a weekly club board and
  events. Clubs can be public or invite-only.
- How: club roles (owner, admins), moderation tools for admins, and reports that reach the
  existing moderation queue.
- Done when: a club admin can remove a member and content, and the moderation queue shows club
  reports.

**4.6 Challenges** · M
- What: monthly challenges such as *run 12 days in October* or *best-3-days all month*, league
  challenges and club challenges, each with a badge.
- How: challenges measure days and the capped weekly score, not raw mileage. Nike Run Club's
  distance challenges are topped by accounts logging 5,000 miles a month.
- Done when: a challenge can't be won by one very long run or by splitting runs.

**4.7 Global and regional leaderboards** · M–L
- What: weekly boards by tier (Seed to Elite) and by country, scored with the capped best-3-days
  XP.
- How:
  - Only accepted runs count, and visibility is opt-in.
  - Results are provisional until a review window after the week closes. The top of each board
    gets extra automated checks.
  - Runners can report a result.
  - New accounts join after two weeks of normal runs.
- Done when: a simulated cheating account (car-speed runs, a replayed route, a hand-typed run)
  never appears on a final board.

**4.8 Live location sharing** · L
- What: share a live link with chosen people for this run only. It stops when the run ends or
  after a set time. It is never public, and it is free, because it is a safety feature.
- How: the recorder posts a location every 30 seconds or so to a link that expires. Viewers
  open the web app (P.2). Battery use is measured.
- Done when: the link stops working the moment the run ends, and a one-hour run's battery use is
  documented.

**4.9 Push notifications and moderation at scale** · M
- What: remote notifications for cheers, kudos, comments, follows and results. All are optional,
  and none threaten rank loss (REQ-012). Moderation adds a review tool for staff, response targets
  and a published contact.
- How: the server sends pushes through Expo's push service. The existing report and moderation
  tables are extended to comments, clubs and challenges.
- Done when: every notification type can be switched off, and a report is acted on within the
  response target in a drill.

## Phase 5: maps

**5.1 Route planning** · L
- What: draw or auto-route a run of a chosen distance, save it, follow it, and send it to the
  watch.
- How: a routing service with a walking or running profile, such as Mapbox Directions or
  GraphHopper. Costs grow with users, so check pricing before choosing.
- Done when: a planned 10 km loop is within 2% of 10 km and can be followed on the phone and
  the watch.

**5.2 Offline maps and navigation** · L–XL
- What: download a map area and a route before a run. Get turn cues and off-route alerts through
  the voice cues (Part C).
- How: Apple's MapKit offers apps no way to download map areas, so this uses Mapbox offline
  packs (`@rnmapbox/maps`) for these screens.
- Done when: a route can be followed in airplane mode with turn and off-route cues.

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

**5.4 Heatmaps and route discovery** · L
- What: a map of popular running paths and suggested routes nearby.
- How:
  - Built only from runs shared with *everyone*, and only from runners who choose to contribute.
  - Privacy zones and the first and last stretch of every run are removed.
  - A path appears only after at least 5 different runners have used it.
  - Tiles are rebuilt weekly and cached in storage.
- Done when: a single runner's route can't be reconstructed from the heatmap, tested with
  synthetic data.

## Free and Pro

**Free, forever:**
- Recording (phone and watch), imports and export, voice cues and auto-pause.
- The run log, personal records, basic stats and badges.
- Leagues, cheers, follows, the feed, clubs, challenges and leaderboards.
- Training plans with editing and basic adjustments, and starter guided runs.
- Live location sharing and every privacy and safety setting.

**Pro** ($29.99 a year planned):
- Advanced plan adaptation: heat, heart rate and check-in-driven load changes.
- The full guided-run library.
- Health and training analytics.
- Offline maps and navigation, and advanced route planning.
- Extra share-card styles.

**Never paid:** anything that changes XP or rank, safety features, data export and account
deletion.

This split is a recommendation for the founder to confirm. Advanced adaptation is the choice
most likely to draw complaints: Runna's price is its biggest complaint (50 reviews).

## Measures

| Phase | Measure | Target |
|---|---|---|
| All | Confirmed lost runs | 0 |
| All | Crash-free sessions | ≥ 99.5% |
| 1 | Music back to full volume after a cue (test matrix) | 100% |
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
| Garmin access | The three routes in Part A; Garmin runners get history and goals meanwhile |
| Apple review: background audio, HealthKit wording, user-generated content | Use each capability only for its stated purpose, write the permission text carefully, add a review note per release |
| Battery (watch app, live location) | Measure on real devices; published targets per feature |
| Map and routing costs | Price check before Phase 5; features limited to the screens that need them |

## Open decisions

1. **Garmin route access:** Garmin's program, an aggregator, or a Connect IQ app (Part A).
2. **Daily streaks:** keep only weekly-goal streaks (1.8), or add daily streaks too? The
   reviews are thin: 8 of 2,112 mention streaks.
3. **Teens in family leagues:** stays 18+ unless a separate safety and consent review says
   otherwise.
4. **Free and Pro split:** confirm the table above.
5. **Coach and voice budget** for plans and guided runs.
6. **Chat:** runners ask for run groups with chat. League or club chat adds moderation load;
   decide in Phase 4.
7. **Leaderboard visibility:** opt-in (recommended) or opt-out.

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
- [Strava: how data appears on third-party apps](https://support.strava.com/en-us/articles/15401608-api-agreement-update-how-data-appears-on-3rd-party-apps)
- Packet: `docs/packet/specs/DECISION_LOG.md`, `FACTORY_PRD.md`, `TECHNICAL_SPEC.md`, `SOURCES.md` (S11–S13)
