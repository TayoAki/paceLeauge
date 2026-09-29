# What PaceLeague has built

29 September 2026. Every feature below is built and covered by tests in this repository: 366 unit
tests, and 364 backend and API tests run against real PostgreSQL 16 and 18. None of it has shipped
yet. The checks on a real iPhone, Apple Watch and Android phone are still to do (see
[DEVICE_TEST_PROTOCOL.md](DEVICE_TEST_PROTOCOL.md)), and some features need an outside account or a
review before they can be switched on. The **Waits on** column says which. [STATUS.md](STATUS.md)
has the evidence for each feature, and [ROADMAP.md](ROADMAP.md) has the plan each phase came from.

That makes 52 features: 9 in V1 and 43 from the roadmap.

## V1: the private league

| Feature | What it does | Waits on |
|---|---|---|
| Accounts | Email and password or Sign in with Apple, onboarding, and a runner name | |
| Recording | Phone GPS with a readiness check, pause and resume, recovery after a crash, and saving with no signal | |
| Sync that never double-counts | Resumable uploads, and one run however many times it's sent | |
| XP and tiers | Server-scored XP with a 125 XP daily cap, and Seed to Elite ranks that never decay | |
| Private weekly league | Invite link or code, up to 20 runners, standings from each runner's best three days | |
| Progress and history | Every run with splits, renaming and deletion | |
| Share card | Distance, time and pace, never a map | |
| Privacy and safety | Export as JSON and GPX, deletion in the app, name filter, reports, blocks and moderation | |
| Reminder | One optional daily reminder at the time you choose | |

## Phase 0: ready for the beta

| Feature | What it does | Waits on |
|---|---|---|
| Age check at sign-up | Apple's Declared Age Range and Google Play Age Signals, with the adult self-declaration | |
| Where routes go | Onboarding says routes stay private | App Store page wording |
| Held runs explained | Why a run is held, that a person checks it within about 2 days, and how to ask for another look | Support email |

## Phase 1: better runs

| Feature | What it does | Waits on |
|---|---|---|
| Voice cues | Spoken splits and pace that lower your music and give it back, as often as you choose | Recorded voice |
| Live pace and Live Activity | Current and lap pace, up to three numbers you choose, and the run on the lock screen | |
| Auto-pause | Pauses when you stop and resumes when you move, on by default | |
| Personal records | Free best efforts from 400 m to the marathon, with their history | |
| Fix a run | Trim, cut, change the type, merge and undo; never adds distance | |
| Save runs to Apple Health | Written once, rewritten after a fix, removed on delete | |
| Stats and trends | Weeks, months, years or a custom range, compared with a year earlier | |
| Badges and weekly streaks | Badges for firsts, distances, tiers and streak weeks; a week counts when you meet your days goal | |
| League cheers | Cheer a league-mate from the standings | |
| Run log extras | Notes, shoes with mileage, and a calendar with search | |
| Widgets | This week on the home screen and lock screen | |

## Phase 2: every run counts

| Feature | What it does | Waits on |
|---|---|---|
| Apple Health import | Runs from any watch or app, with a 30-day backfill and no duplicates | |
| Apple Watch app | Records without the phone, with voice cues, treadmill runs and routes on a map | First native build |
| Strava export | Posts your runs to Strava automatically or one at a time | Strava API app |
| File import and Garmin sync | GPX, TCX and FIT files; Garmin through the Terra service | Terra account (Garmin) |
| Treadmill and indoor runs | From the step counter or a watch; watch runs whose data looks like running earn XP, up to 5 km a day | |
| Sync status and diagnostics | Every run still waiting and why, retry, and a diagnostics report | |
| Walks, hikes and rides | Logged and counted in stats, never scored | |

## Phase 3: coaching

| Feature | What it does | Waits on |
|---|---|---|
| Training plans (free) | Seven plan types at three levels, built from what you've run, with today's workout on Home | Coach review |
| Adaptive plans | Edit any session; check-ins, pain and illness pauses, and lighter weeks after hard ones | Coach review |
| Coach notes | A note after each run from 13 written rules, not AI | Coach review |
| Guided runs | 18 coached runs, 6 of them free, spoken over your music | Recorded voice |
| Heart-rate zones and training analytics | Zones on every run for free; load, fitness and fatigue, predictions and efficiency with Pro | Counsel review |
| Pro | $4.99 a month or $29.99 a year, with a 7-day trial on the annual plan; nothing paid changes XP or rank | App Store and RevenueCat |

## Platforms: Android and the web

| Feature | What it does | Waits on |
|---|---|---|
| Android app | Recording in a foreground service, Health Connect, and Android's own wording | First Android build; Google Play developer account |
| Web app | Everything but recording, in any browser; on staging at web-staging-ba3b.up.railway.app | |

## Phase 4: friends, family and everyone

| Feature | What it does | Waits on |
|---|---|---|
| Leagues 2.0 | Up to five leagues, four-week seasons, duels, group runs and a group-chat link | |
| Privacy zones and sharing | Choose who sees each run and its map; shared maps drop your zones and each end | Counsel review (wording) |
| Follows and profiles | Follow requests, follow links, opt-in name search, mute and block | |
| Feed | Runs friends and league-mates share, with kudos and comments | |
| Clubs | Public or invite-only, up to 500 runners, a weekly board and group runs | |
| Challenges | Monthly challenges for everyone and your league's or club's own, a badge each | |
| Leaderboards | Opt-in weekly boards by tier and country, with the top results checked for cheating | |
| Live location | A link for the people you choose, until the run ends | |
| Push notifications and moderation | Kudos, comments, follows, cheers and results, quiet at night; a 24-hour report queue | Push credentials; a moderation rota |
| Teen accounts | For 13 to 17, in a family league an adult approves | Counsel review (off until then) |

## Phase 5: maps

| Feature | What it does | Waits on |
|---|---|---|
| Route planning | Loops of a set distance or routes drawn along paths, with GPX and Apple Watch | Routing service; Google Maps key (Android) |
| Navigation and offline maps | Spoken turns and off-route alerts with no signal; map areas kept on the phone | Mapbox account (maps) |
| Segments | Curated stretches of path with opt-in boards and a local regular | |
| Heatmap and suggested loops | Popular paths once 5 runners use them, and loops through them | Routing service (for the loops) |

## Hidden until switched on

These are built but don't appear in the app until their account or review is in place. All but
offline maps and the watch app come back without a new app build.

| Feature | Appears once |
|---|---|
| Strava export | Its variables are set on the API ([OPERATIONS.md](OPERATIONS.md#strava-export-23)) |
| Garmin sync | The Terra variables are set on the API ([OPERATIONS.md](OPERATIONS.md#garmin-through-terra-24)) |
| Route planning, saved routes, popular paths, suggested loops and segments | `ROUTING_URL` is set on the API ([OPERATIONS.md](OPERATIONS.md#route-planning-51)) |
| Offline maps | A build with `PL_MAPBOX=1` and a Mapbox token |
| Apple Watch app | A build with `PL_WATCH=1` |
| Push notifications | Push credentials in EAS and `PUSH_ENABLED=true` on the API |
| Teen accounts | The `teen_accounts_enabled` flag is turned on, after counsel's review |

## Free and Pro

Pro costs $29.99 a year with a 7-day free trial, or $4.99 a month. It adds:

- The full guided-run library: 12 more runs on top of the 6 free ones.
- Training analytics: training load, fitness and fatigue, race predictions and aerobic efficiency.
- Heat and heart-rate training: plan paces that slow down on hot days, and a heart-rate range for
  each session.

Everything else is free, and nothing paid changes XP or rank. The build differs from the
roadmap's [Free and Pro](ROADMAP.md#free-and-pro) list in two places, which still need a decision:

- The roadmap puts offline maps, navigation and route planning in Pro. The build leaves them free.
- The roadmap lists extra share-card styles under Pro. They are not built.

## Left out

- **An AI coach.** Left out by choice: coach notes come from 13 written rules, and every note a
  runner can see is written in `src/domain/coach-notes.ts`.
- **Scoring other sports.** Walks, hikes and rides are logged and counted in stats, but only runs
  earn XP.

## How it compares

The private comparison page *PaceLeague vs the Field* was updated on 29 September 2026 to count
what is built. The five rivals' features are as checked on 27 September 2026: Runify, Strava,
Runna, Nike Run Club and Garmin Connect, against the same list of 46 features. A feature counts as
PaceLeague's once it is built, even though none of it has shipped.

- **22 of 24 gaps closed.** On 27 September, at least one rival had 24 features that PaceLeague
  didn't. The build now has 22 of them: auto-pause, spoken pace and distance, an Apple Watch app,
  imports from watches and Apple Health, treadmill and indoor runs, streaks, badges, personal
  records, training plans, audio-guided runs, clubs, leaderboards beyond your league, segments,
  challenges, a social feed, follows, live location sharing, route planning, heatmaps, offline
  maps and navigation, an Android app and a web app.
- **1 partly closed:** sports besides running, which are logged but never scored.
- **1 still missing, by choice:** an AI coach.
- **7 features at most one rival also has:** recovering a run after a crash, scoring that mileage
  can't dominate, segments, flagging impossible runs, routes private by default, block and report,
  and offline maps or navigation.
