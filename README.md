# PaceLeague

A private running league for iPhone. Record runs with GPS, earn permanent XP, climb tiers
(Seed → Stride → Tempo → Surge → Elite), and compete with your crew each week — your best three
days count, rest days never cost you rank, and routes are only ever visible to you.

Built from the design and build packet in [`docs/packet/`](docs/packet/README.md) (the source of
truth for requirements, scoring rules, copy and design tokens).

| | |
|---|---|
| App | Expo SDK 57 · React Native 0.86 · React 19 · TypeScript (strict) · Expo Router |
| Backend | PaceLeague API (`server/`, Node 22) on Railway with PostgreSQL 18: Row Level Security, SECURITY DEFINER RPCs, all scoring server-side |
| Local data | Encrypted SQLite journal (SQLCipher) per account, durable upload outbox |
| Status | V1 feature-complete (REQ-001–012, 014, 015). Pro purchase (REQ-013 / S17) is deferred by design. Device evidence pending — see [docs/STATUS.md](docs/STATUS.md). |

## Quick start (web preview + local backend, no Docker)

Requires Node ≥ 22.13 and PostgreSQL server binaries, 16 or newer (`apt install postgresql-16`
or set `PG_BIN`).

```bash
npm install
npm run db:local                  # local Postgres on 127.0.0.1:54329 (scripts/db/local-db.sh)
npm run dev:backend -- --reset --seed alex@demo.paceleague.test
```

The development backend is the production API service (`server/`) in development mode: it applies
the migrations, accepts code `123456` for every address and prints the two values the app needs.
Start the app with them:

```bash
EXPO_PUBLIC_API_URL=http://127.0.0.1:54400 \
EXPO_PUBLIC_API_KEY=pl_dev_public_key \
npx expo start --web
```

Sign in with `alex@demo.paceleague.test` and code `123456` to land in the packet's fictional
"Friday Crew" (from Wednesday on: 820 XP, 2 of 3 active days — the seed skips runs that would lie
in the future). Any other email creates a new runner and goes through
onboarding. The web build is a development preview: it cannot record with the screen locked and
has no encryption at rest (see [docs/IMPLEMENTATION_DECISIONS.md](docs/IMPLEMENTATION_DECISIONS.md)).

## iPhone development build

Background location, SQLCipher, Sign in with Apple, notifications and the share sheet need a
native build:

```bash
cp .env.example .env              # fill in EXPO_PUBLIC_API_URL / _API_KEY and bundle id
npx eas build --profile development --platform ios     # or: npx expo run:ios
npm start                          # expo start --dev-client
```

Profiles live in [`eas.json`](eas.json). Only the API's public key ever goes into the app;
`npm run check:secrets` fails the build if anything privileged appears in app code.

## Backend on Railway

The API runs as one Railway service next to a Railway Postgres. Staging is live at
`https://api-staging-753f.up.railway.app` (email codes currently go to the service logs; add an
email provider key to send them). Pushes that touch `server/` or `db/` redeploy it, and each deploy
runs the migrations first. [docs/OPERATIONS.md](docs/OPERATIONS.md) is the runbook: variables,
email and Apple setup, database access, jobs, backups, creating production and incidents.

## Scripts

| Command | What it does |
|---|---|
| `npm run verify` | Typecheck, lint, secret guard and unit tests (what CI's app job runs) |
| `npm test` | Unit tests: domain rules, recorder, sync, formatting, export, design tokens |
| `npm run test:db` | Builds a real PostgreSQL database with the production migrator and runs the backend and API suites (RLS, grants, concurrency, parity, lifecycle, client ↔ server sync, sign-in codes, sessions, Apple, RPC). `DB_PLATFORM=permissive` adds Supabase-style default grants to prove RLS alone protects the data |
| `npm run test:all` | Both suites |
| `npm run dev:backend` | The API service in development mode over the local database (`--reset`, `--seed <email>`) |
| `npm run smoke:api -- send` / `verify <codes>` | End-to-end check of a deployed API over HTTPS with the app's own client (see OPERATIONS.md) |
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
server/             The API service: sign-in codes, Apple, sessions, RPC, migrator, jobs, Dockerfile
db/                 Platform layer (roles, auth schema), migrations (schema, RLS, RPCs, SQL
                    validator and scoring), sign-in email template, test-only grants
scripts/            Local DB harness, dev backend, smoke test, e2e walkthrough, secret guard, icons
tests/              Backend and API suites (real Postgres) and unit tests
docs/               Architecture, status/evidence, device protocol, operations, decisions
```

## Documentation

- [ARCHITECTURE.md](docs/ARCHITECTURE.md) — how recording, sync, scoring and privacy fit together
- [STATUS.md](docs/STATUS.md) — requirement-by-requirement status and the evidence behind it
- [DEVICE_TEST_PROTOCOL.md](docs/DEVICE_TEST_PROTOCOL.md) — the physical-iPhone checks still required (F01 and EV-001–015)
- [OPERATIONS.md](docs/OPERATIONS.md) — the Railway runbook: deploys, variables, email, flags, jobs, backups, incidents
- [IMPLEMENTATION_DECISIONS.md](docs/IMPLEMENTATION_DECISIONS.md) — choices and deviations from the packet, with reasons
- [COMPATIBILITY.md](docs/COMPATIBILITY.md) — pinned versions and how they were verified
