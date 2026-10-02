# App Store listing

Everything App Store Connect asks for PaceLeague 1.0.0, page by page, checked against what the
app does. Each heading gives a field's current length and Apple's limit. The copy-and-paste
version of this page is the private artifact *PaceLeague Store Listing*.

The links below point at staging until the production server exists. Swap them for the
production addresses before submitting.

## Before you press Add for Review

| Status | Step |
|---|---|
| Done | Pro subscriptions created in App Store Connect, Ready to Submit (2 October 2026). |
| Done | App version set to 1.0.0 in `app.config.ts`, so the next build matches this page. |
| Done | Support page served at `/support` from `legal/support.md`. It shows as a draft until the contact email is filled in. |
| To do | App Information → Name: change “PaceLeague (staging)” to “PaceLeague”. |
| To do | Choose the public support email, then put it in `legal/support.md`, the legal pages and `EXPO_PUBLIC_SUPPORT_EMAIL` in the build profiles. |
| To do | Counsel finishes the privacy policy and terms: operator name, address, contact email, effective date and email provider. |
| Decide | Training plans in 1.0 before a coach reviews them? If not, hide them and delete “TRAIN WITH A FREE PLAN” from the description. |
| To do | Production server: a Railway production environment with its own database, an email provider for trial reminders, a RevenueCat webhook for real purchases, and the `production` build profile’s settings. It adds a monthly Railway cost, and sending email needs a Resend account and a domain. |
| To do | Production build: `eas build --platform ios --profile production --auto-submit`, then pick it under Build. |
| To do | Review account on the production server, with a league and a few weeks of runs, for Sign-In Information. |
| Done | Six screenshots at 1284 × 2778, from the current app with the demo league, in [app-store/screenshots](app-store/screenshots). |
| To do | Upload the six screenshots to the 6.5-inch slot, in order. Retake the two run screens on an iPhone when possible, where the route is drawn on Apple Maps. |
| To do | Business → Paid Apps agreement shows Active, and each subscription’s review screenshot is a real one. |
| To do | Swap the staging links for the production ones: Support URL, Privacy Policy URL, and the links at the end of the description. |

## iOS App Version 1.0.0

### Previews and Screenshots

Six screenshots for the 6.5-inch slot (1284 × 2778, portrait) are in
[app-store/screenshots](app-store/screenshots), in upload order:

1. `01-league.png`: League: this week’s standings
2. `02-today.png`: Today: the week, today’s plan and Start run
3. `03-run.png`: A run in progress, with live pace
4. `04-summary.png`: The finished run, with its coach note and XP
5. `05-progress.png`: Progress: rank, active days, streak and distance
6. `06-train.png`: Train: a 10K plan

They’re the app’s real screens with the demo league from the development seed (no real people), drawn from the web build at iPhone 14 Plus size (428 × 926 points at 3x), with the iPhone’s safe areas and Inter standing in for the iPhone’s system font. On the two run screens the route sits on a plain grid; on the iPhone it’s drawn on Apple Maps. Retake the two run screens on an iPhone when possible. As the product packet
says, store screenshots are real screens, never the concept boards.

### Promotional Text (168/170)

Can be changed at any time without a new version.

```text
Start a private weekly running league with up to 19 friends. Runs earn XP, your best three days count, and three steady runs can top the table. Free, with optional Pro.
```

### Description (3,760/4,000)

```text
PaceLeague turns your runs into a private weekly league with the people you run with.

Start a league, share the invite link or code, and up to 20 runners compete each week. Runs earn 1 XP for every 100 m, plus 25 XP on active days, up to 125 XP a day. Your league score is your best three days, so three steady runs can match a 100 km week.

Every XP also counts toward your rank, from Seed through Stride, Tempo and Surge to Elite. Rest days never lower it.

RECORD EVERY RUN
• GPS recording with a signal check, auto-pause, and pause and resume
• Spoken pace and distance that lower your music
• Live and lap pace, with your run on the Lock Screen and in the Dynamic Island
• Records with no internet connection, and recovers your run if the app closes
• Treadmill runs from your phone’s step counter
• Walks, hikes and rides are logged too (only runs earn XP)

BRING IN EVERY RUN
• Import runs from Apple Health, including your watch’s, starting with the last 30 days
• Save your runs to Apple Health
• Import GPX, TCX and FIT files
• A run recorded on two devices counts once
• Fix a run: trim it, cut out a stop, change its type or merge two, and undo any time

SEE YOUR PROGRESS
• Personal records from 400 m to the marathon
• Stats for any week, month, year or range, compared with a year earlier
• Badges and weekly streaks
• Run notes, shoe mileage and a calendar
• Home Screen and Lock Screen widgets
• An optional daily reminder at the time you choose

TRAIN WITH A FREE PLAN
• Plans to start running, for a 5K, 10K, half or full marathon, to run more consistently, or to come back after a break, each at three levels
• Built from the running you’ve already done, and adjusted as you go: move or shorten sessions, pause for pain or illness, and get lighter weeks after hard ones
• A coach note after each run, written from clear rules, not AI
• 6 free guided runs, spoken over your music
• Heart-rate zones for runs with heart-rate data

RUN TOGETHER
• Up to five leagues, with four-week seasons, duels and group runs
• Cheer a league-mate from the standings
• Follows, kudos and comments in the feed
• Clubs of up to 500 runners
• Monthly challenges with badges
• Opt-in weekly leaderboards by tier and country
• A live-location link for the people you choose, until your run ends

PRIVATE BY DEFAULT
• Your routes are visible only to you unless you share a run
• Shared maps hide your privacy zones and the first and last 200 m
• Share images never show a map
• Export your data or delete your account in the app at any time
• Report or block anyone
• No ads, and we don’t sell your data

Runs at impossible speeds are held for a person to check, never treated as proof of cheating. No cash prizes, no pace races.

PACELEAGUE PRO
Everything above is free. Pro adds every guided run (12 more), training analytics (training load, fitness and fatigue, race predictions and aerobic efficiency), heat-adjusted paces and heart-rate ranges for your plan, and health trends from Apple Health. Nothing you pay for changes XP or rank.

Pro is $4.99 a month, or $29.99 a year with a 7-day free trial. Payment is charged to your Apple ID when you confirm the purchase, or when the free trial ends. Subscriptions renew automatically unless cancelled at least 24 hours before the end of the current period; renewal is charged within the 24 hours before it ends. Manage or cancel in your Apple ID’s subscription settings. We email you two days before a free trial ends.

PaceLeague is for adults, 18 and over.

Privacy Policy: https://api-staging-753f.up.railway.app/legal/privacy
Terms of Use: https://api-staging-753f.up.railway.app/legal/terms
Apple’s standard license agreement also applies: https://www.apple.com/legal/internet-services/itunes/dev/stdeula/
```

### Keywords (100/100)

Words already in the name and subtitle are searched without repeating them here. Apple doesn't
allow other apps' names as keywords.

```text
running,jogging,gps,5k,10k,half,marathon,training,plan,coach,club,friends,challenge,streak,pace,race
```

### Support URL

```text
https://api-staging-753f.up.railway.app/support
```

Served by the API from `legal/support.md`. It shows as a draft until `[Contact email]` is
filled in; Apple needs a working way to reach you on this page.

### Marketing URL

Optional. Leave it empty.

### Version

```text
1.0.0
```

It must match the build's version, which `app.config.ts` now sets to 1.0.0.

### Copyright

The year, then the seller's legal name as App Store Connect shows it, for example `2026` and
your own name if you sell as an individual, or your company's name.

### Routing App Coverage File

Leave it empty. It's only for apps that give directions to other apps.

### Build

The 1.0.0 build from the `production` profile. Not build 4: that's the 0.1.0 test build, which
uses the staging server and is named "PaceLeague (staging)" on the Home Screen.

### In-App Purchases and Subscriptions

Once a build is chosen, add both subscriptions (`paceleague_pro_monthly` and
`paceleague_pro_yearly`) here. Apple reviews first subscriptions together with an app version.

### App Review Information

- **Sign-in required:** on. The user name and password are the review account's, set up on the
  production server.
- **Contact Information:** your name, phone number and email. Only App Review sees them.
- **Attachment:** none.
- **Notes (3,231/4,000):**

```text
PaceLeague is a running app for adults. Runners record runs, earn XP, and compete in small private leagues that start again every week.

DEMO ACCOUNT
Sign in with the email and password in Sign-In Information. The account is in a league with other runners and has a few weeks of runs, so the League, Progress and run screens have content. You can also create an account with email and password or Sign in with Apple. Sign-up checks age with Apple’s Declared Age Range where it’s available and asks the runner to confirm they’re 18 or over, because PaceLeague is for adults.

RECORDING A RUN
Today → Start run. Outdoors, the start screen checks GPS before the run begins. Indoors, tap “Treadmill or indoors instead” on the start screen; it estimates distance from the step counter. A run earns league XP when it has at least 100 m, 1 minute of active time, and GPS for most of that time.

LOCATION AND BACKGROUND MODES
• Location: the start screen asks for While Using permission, then “Allow while locked” asks for Always, so a run keeps recording with the screen locked. Location is only collected during a run the runner starts.
• Audio background mode: spoken cues (pace, distance and guided-run instructions) play during a run with the screen locked, and lower other audio while they speak.

APPLE HEALTH (HEALTHKIT)
Off until the runner switches it on in Profile → Run settings:
• “Save runs to Apple Health” saves finished runs as workouts with their route.
• “Import runs from Apple Health” brings in running, walking, hiking, cycling and strength workouts from the last 30 days, and new ones as they arrive, with their routes and heart rate.
• Heart-rate zones read the heart rate recorded during a run. Pro’s health trends read resting heart rate, heart rate variability, VO2 max and sleep. Zones and trends are worked out on the phone and never uploaded.
Health data is never used for advertising or marketing.

PRO (IN-APP PURCHASES)
Profile → PaceLeague Pro. One subscription group with two auto-renewing subscriptions: monthly ($4.99) and yearly ($29.99, with a 7-day free trial). Restore purchases is on the same screen. Pro adds guided runs, training analytics and heat and heart-rate training. Nothing paid changes league scores.

USER-GENERATED CONTENT
Runners can write comments and name their leagues, clubs, challenges and group runs. Text passes a filter and rate limits. Runners, runs, comments, league names, clubs, group runs and challenges can each be reported; a report hides the content from the reporter straight away, and reports go to a queue our moderators review. Runners can be blocked from their profile, and Profile → Blocked runners lists them.

LIVE LOCATION
Off until the runner taps “Share your live location” on the run screen. The link shows their latest position to the people they send it to, and stops when the run ends.

ACCOUNT
Delete account: Profile → Privacy → Delete account. Export: Profile → Privacy → Export my data.

SWITCHED OFF IN THIS VERSION
Some features in the code are turned off and don’t appear: Strava export, Garmin sync, route planning, offline maps, the Apple Watch app and teen accounts. We’ll describe each one in the review notes of the update that turns it on.
```

The last part of the notes is there because of guideline 2.3.1: features that are in the app but
switched off should be described to App Review. Turn each one on together with an update whose
notes describe it.

### App Store Version Release

**Manually release this version**, so it goes live only once the production server, the legal
pages and support are ready.

## App Information

- **Name (10/30):** `PaceLeague`
- **Subtitle (28/30):** `Run tracker & weekly leagues`
- **Category:** Primary Health & Fitness, secondary Sports.
- **Content Rights:** the app doesn't contain, show or access third-party content.
- **License Agreement:** keep Apple's standard agreement. The description links PaceLeague's own
  terms as well.
- **Privacy Policy URL:** `https://api-staging-753f.up.railway.app/legal/privacy` (still a draft; production address before
  submitting).

### Age Rating

Answer the questionnaire from these facts; Apple works out the rating.

- No violence, sexual content, nudity, profanity, horror, drugs, alcohol, tobacco or gambling, real or simulated.
- No contests or prizes: leagues have no cash prizes.
- Not medical: plans and notes are general training guidance (the terms say so).
- User-generated content: yes. Comments, runner names, and names of leagues, clubs, challenges and group runs, with a text filter, reporting and blocking.
- No private messaging or chat in the app. A league can add a link to an outside group chat.
- No unrestricted web access and no ads.
- Sign-up is for adults: Declared Age Range where available, plus an 18+ confirmation.

## Pricing and Availability

- **Price:** Free. Pro is the in-app subscription.
- **Availability:** the United States only. The terms say runners must be 18 or older and live
  in the United States, and the privacy policy is written for that. Add countries once the lawyer
  updates both. The subscriptions are set for every country, but they're only sold where the app
  is.

## App Privacy

**Data collection:** yes. Every type below is **linked to the user**, **not used for tracking**,
and collected for **App Functionality** (Product Interaction for App Functionality and
Analytics). Health trends and heart-rate zones stay on the phone, so they aren't collected.

| Apple's category | Data type | What it is in PaceLeague |
|---|---|---|
| Contact Info | Email Address | The account’s email address |
| Health & Fitness | Health | Heart rate that comes with imported runs; “coming back from an injury” and “something hurt” answers in plans |
| Health & Fitness | Fitness | Runs: distance, time, pace, splits, and steps for treadmill runs |
| Location | Precise Location | Each run’s route, and the latest position while a live-location link is on |
| User Content | Other User Content | Comments, run titles and notes, and names of leagues, clubs, challenges and group runs |
| Identifiers | User ID | Account ID, runner name and the Sign in with Apple identifier |
| Identifiers | Device ID | The push token, once notifications are on |
| Purchases | Purchase History | Pro status, plan, renewal date and store |
| Usage Data | Product Interaction | A few app events, such as a run starting or a permission being granted |
| Diagnostics | Other Diagnostic Data | Sync events, and the report sent with Send diagnostics |

**Tracking:** no. No ads, no data brokers, and no third-party analytics.
