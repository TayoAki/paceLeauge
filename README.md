# PaceLeague

A private running league for iPhone and Android, with a web app. Record runs with GPS, earn
permanent XP, climb tiers (Seed → Stride → Tempo → Surge → Elite), and compete with your crew each
week — your best three days count, rest days never cost you rank, and routes stay private unless
you choose to share them.

Built from the design and build packet in [`docs/packet/`](docs/packet/README.md) (the source of
truth for requirements, scoring rules, copy and design tokens).

| | |
|---|---|
| App | Expo SDK 57 · React Native 0.86 · React 19 · TypeScript (strict) · Expo Router |
| Backend | PaceLeague API (`server/`, Node 22) on Railway with PostgreSQL 18: Row Level Security, SECURITY DEFINER RPCs, all scoring server-side |
| Local data | Encrypted SQLite journal (SQLCipher) per account, durable upload outbox |
| Status | V1 feature-complete (REQ-001–012, 014, 015), and the roadmap after it built and tested in code: the age check, Phases 1–5 (records and voice cues, watch and imports, coaching and Pro, the social features, maps) and the Android and web apps — see [docs/ROADMAP.md](docs/ROADMAP.md). Device evidence and partner accounts (App Store, RevenueCat, Strava, push credentials, maps and routing) pending — see [docs/STATUS.md](docs/STATUS.md). |

## Quick start (web preview + local backend, no Docker)

Requires Node ≥ 22.13 and PostgreSQL server binaries, 16 or newer (`apt install postgresql-16`
or set `PG_BIN`).

```bash
npm install
npm run db:local                  # local Postgres on 127.0.0.1:54329 (scripts/db/local-db.sh)
npm run dev:backend -- --reset --seed alex@demo.paceleague.test
```

The development backend is the production API service (`server/`) in development mode: it applies
the migrations, seeds the demo crew and prints the two values the app needs. Start the app with
them:

```bash
EXPO_PUBLIC_API_URL=http://127.0.0.1:54400 \
EXPO_PUBLIC_API_KEY=pl_dev_public_key \
npx expo start --web
```

Choose **Sign in** with `alex@demo.paceleague.test` and the password `run-with-the-crew` to land in
the packet's fictional "Friday Crew" (from Wednesday on: 820 XP, 2 of 3 active days — the seed skips
runs that would lie in the future). **Create account** with any other email makes a new runner who
goes through onboarding. The web build is a development preview: it cannot record with the screen locked and
has no encryption at rest (see [docs/IMPLEMENTATION_DECISIONS.md](docs/IMPLEMENTATION_DECISIONS.md)).

## iPhone development build

Background location, SQLCipher, Sign in with Apple, notifications and the share sheet need a
native build. To put the app on your own iPhone, build the `pilot` profile — already pointed at
staging — and install it through TestFlight; the steps are in
[OPERATIONS.md](docs/OPERATIONS.md#iphone-builds-for-testers-testflight). For day-to-day
development with a dev client:

```bash
cp .env.example .env              # fill in EXPO_PUBLIC_API_URL / _API_KEY and bundle id
npx eas build --profile development --platform ios     # or: npx expo run:ios
npm start                          # expo start --dev-client
```

Profiles live in [`eas.json`](eas.json). Only the API's public key ever goes into the app;
`npm run check:secrets` fails the build if anything privileged appears in app code.

## Backend on Railway

The API runs as one Railway service next to a Railway Postgres. Staging is live at
`https://api-staging-753f.up.railway.app`, and the `pilot` build profile points at it. During the
beta, runners sign in with email and a password (or Apple), so no email service is needed. The API
also serves the draft Privacy Policy and Terms from [`legal/`](legal/) at `/legal/privacy` and
`/legal/terms`. Pushes that touch `server/`, `db/` or `legal/` redeploy it, and each deploy runs
the migrations first. [docs/OPERATIONS.md](docs/OPERATIONS.md) is the runbook: TestFlight builds,
variables, password resets, legal pages, database access, jobs, backups, creating production and
incidents.

## Scripts

| Command | What it does |
|---|---|
| `npm run verify` | Typecheck, lint, secret guard and unit tests (what CI's app job runs) |
| `npm test` | Unit tests: domain rules, recorder, sync, formatting, export, design tokens |
| `npm run test:db` | Builds a real PostgreSQL database with the production migrator and runs the backend and API suites (RLS, grants, concurrency, parity, lifecycle, client ↔ server sync, passwords, sign-in codes, sessions, Apple, RPC, legal pages). `DB_PLATFORM=permissive` adds Supabase-style default grants to prove RLS alone protects the data |
| `npm run test:all` | Both suites |
| `npm run dev:backend` | The API service in development mode over the local database (`--reset`, `--seed <email>`) |
| `npm run smoke:api` | End-to-end check of a deployed API over HTTPS with the app's own client, using two throwaway accounts (see OPERATIONS.md) |
| `npm run build --prefix server` | Bundles the API service into `server/dist`, as the Dockerfile does (after `npm ci --prefix server`) |
| `npm run e2e:web` | Browser walkthrough of the real app against the dev backend and a running `expo start --web`: records the packet's 5.24 km run with a scripted GPS feed, syncs, visits every V1 screen, saves screenshots to `artifacts/screenshots/web` (first run `npx playwright-core install chromium`, or point `PLAYWRIGHT_BROWSERS_PATH` at an existing install) |
| `npm run check:secrets` | Fails if app code references privileged keys, admin APIs or server-only modules |
| `npm run db:local -- stop\|reset` | Manage the local Postgres cluster |

## Repository map

```
src/app/            Expo Router screens (S01–S16) — see docs/STATUS.md for the screen map
src/domain/         Pure TypeScript rules: validator, scoring, calendar, recorder state machine
src/db/             Account-scoped encrypted journal (sessions, points, saved runs, outbox)
src/features/       Recorder service, sync engine, account runtime, leagues, privacy, reminders
src/api/            Typed RPC client with Zod-validated responses and stable error codes
src/components/     Design-system components; src/design/ holds tokens and typography
server/             The API service: passwords, sign-in codes, Apple, sessions, RPC, migrator, jobs,
                    legal pages, operator commands, Dockerfile
db/                 Platform layer (roles, auth schema), migrations (schema, RLS, RPCs, SQL
                    validator and scoring), sign-in email template, test-only grants
legal/              Privacy Policy and Terms (drafts, Markdown), served by the API
scripts/            Local DB harness, dev backend, smoke test, e2e walkthrough, secret guard, icons
tests/              Backend and API suites (real Postgres) and unit tests
docs/               Architecture, status/evidence, device protocol, operations, decisions
```

## Documentation

- [FEATURES.md](docs/FEATURES.md) — every feature built so far, what each still waits on, Free and Pro, and how it compares with five running apps
- [ARCHITECTURE.md](docs/ARCHITECTURE.md) — how recording, sync, scoring and privacy fit together
- [STATUS.md](docs/STATUS.md) — requirement-by-requirement status and the evidence behind it
- [DEVICE_TEST_PROTOCOL.md](docs/DEVICE_TEST_PROTOCOL.md) — the physical-iPhone checks still required (F01 and EV-001–015)
- [OPERATIONS.md](docs/OPERATIONS.md) — the Railway runbook: deploys, variables, email, flags, jobs, backups, incidents
- [IMPLEMENTATION_DECISIONS.md](docs/IMPLEMENTATION_DECISIONS.md) — choices and deviations from the packet, with reasons
- [COMPATIBILITY.md](docs/COMPATIBILITY.md) — pinned versions and how they were verified
- [ROADMAP.md](docs/ROADMAP.md) — the plan after V1: watch sync, voice cues, coaching, social and maps, in phases
