# PaceLeague

A private running league for iPhone. Record runs with GPS, earn permanent XP, climb tiers
(Seed → Stride → Tempo → Surge → Elite), and compete with your crew each week — your best three
days count, rest days never cost you rank, and routes are only ever visible to you.

Built from the design and build packet in [`docs/packet/`](docs/packet/README.md) (the source of
truth for requirements, scoring rules, copy and design tokens).

| | |
|---|---|
| App | Expo SDK 57 · React Native 0.86 · React 19 · TypeScript (strict) · Expo Router |
| Backend | Supabase (Postgres 16): Row Level Security, SECURITY DEFINER RPCs, all scoring server-side |
| Local data | Encrypted SQLite journal (SQLCipher) per account, durable upload outbox |
| Status | V1 feature-complete (REQ-001–012, 014, 015). Pro purchase (REQ-013 / S17) is deferred by design. Device evidence pending — see [docs/STATUS.md](docs/STATUS.md). |

## Quick start (web preview + local backend, no Docker)

Requires Node ≥ 22.13 and PostgreSQL 16 server binaries (`apt install postgresql-16` or set
`PG_BIN`).

```bash
npm install
npm run db:local                  # local Postgres on 127.0.0.1:54329 (scripts/db/local-db.sh)
npm run dev:backend -- --reset --seed alex@demo.paceleague.test
```

The development backend prints the two environment values to use. Start the app with them:

```bash
EXPO_PUBLIC_SUPABASE_URL=http://127.0.0.1:54400 \
EXPO_PUBLIC_SUPABASE_ANON_KEY=<printed anon key> \
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
cp .env.example .env              # fill in EXPO_PUBLIC_SUPABASE_URL / _ANON_KEY and bundle id
npx eas build --profile development --platform ios     # or: npx expo run:ios
npm start                          # expo start --dev-client
```

Profiles live in [`eas.json`](eas.json). Only the Supabase **anon** key ever goes into the app;
`npm run check:secrets` fails the build if anything privileged appears in app code.

## Scripts

| Command | What it does |
|---|---|
| `npm run verify` | Typecheck, lint, secret guard and unit tests (what CI's app job runs) |
| `npm test` | Unit tests: domain rules, recorder, sync, formatting, export, design tokens |
| `npm run test:db` | Applies every migration to a real PostgreSQL and runs the backend integration suite (RLS, grants, concurrency, parity, lifecycle, client ↔ server sync) |
| `npm run test:all` | Both suites |
| `npm run dev:backend` | Local Supabase-compatible Auth + RPC server over the real migrations (`--reset`, `--seed <email>`) |
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
supabase/           Migrations (schema, RLS, RPCs, SQL validator and scoring), config
scripts/            Local DB harness, dev backend, e2e walkthrough, secret guard, icon generator
tests/              Backend integration suite (real Postgres) and unit tests
docs/               Architecture, status/evidence, device protocol, operations, decisions
```

## Documentation

- [ARCHITECTURE.md](docs/ARCHITECTURE.md) — how recording, sync, scoring and privacy fit together
- [STATUS.md](docs/STATUS.md) — requirement-by-requirement status and the evidence behind it
- [DEVICE_TEST_PROTOCOL.md](docs/DEVICE_TEST_PROTOCOL.md) — the physical-iPhone checks still required (F01 and EV-001–015)
- [OPERATIONS.md](docs/OPERATIONS.md) — deploying the backend, flags, jobs, moderation, incidents
- [IMPLEMENTATION_DECISIONS.md](docs/IMPLEMENTATION_DECISIONS.md) — choices and deviations from the packet, with reasons
- [COMPATIBILITY.md](docs/COMPATIBILITY.md) — pinned versions and how they were verified
