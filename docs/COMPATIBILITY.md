# Compatibility record

The packet asks for pinned, SDK-matched dependencies and a record of how they were checked.
Versions below are what `package-lock.json` resolves to on 26 September 2026.

## Verification

| Check | Command | Result |
|---|---|---|
| Expo SDK alignment | `npx expo install --check` | "Dependencies are up to date" |
| Project health | `npx expo-doctor` (1.20.4) | 21/21 checks passed |
| Types | `npm run typecheck` (TypeScript 6.0, strict, `noUncheckedIndexedAccess`) | Clean |
| Lint | `npm run lint` (ESLint 9, `eslint-config-expo`, React Compiler rules) | Clean |
| Unit / backend / browser | `npm test`, `npm run test:db`, `npm run e2e:web` | See [STATUS.md](STATUS.md) |

Native modules were added with `npx expo install` (never a bare `npm install` of React Native
packages), so each matches SDK 57. Re-run the three commands above after any upgrade.

## Runtime

| Package | Version | Notes |
|---|---|---|
| expo | 57.0.25 | SDK 57 |
| react-native | 0.86.3 | New Architecture (SDK default) |
| react / react-dom | 19.2.3 | `ref` as a prop; React Compiler enabled in `app.config.ts` |
| react-native-web | 0.21.3 | Development preview only |
| expo-router | 57.0.23 | File routes in `src/app`; `Stack.Protected` guards; JS tabs (`expo-router/js-tabs`) |
| expo-location / expo-task-manager | 57.0.20 / 57.0.20 | Top-level background task, `UIBackgroundModes: location` |
| expo-sqlite | 57.0.3 | SQLCipher via the config plugin (`useSQLCipher`); async API only |
| expo-secure-store | 57.0.4 | Journal keys and chunked auth session, `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` |
| expo-apple-authentication | 57.0.2 | Native sign-in with hashed nonce |
| expo-notifications | 57.0.21 | One local daily reminder; no push |
| expo-sharing / expo-media-library / expo-file-system | 57.0.22 / 57.0.5 / 57.0.7 | Share sheet, Photos (add-only), export files |
| expo-network | 57.0.2 | Connectivity for sync and offline states |
| react-native-maps | 1.27.2 | Apple Maps on iOS (attribution kept); SVG drawing on web |
| react-native-svg | 15.15.4 | Art and charts |
| react-native-view-shot | 5.1.0 | Stats-only poster capture |
| react-native-reanimated / gesture-handler / screens / safe-area-context | 4.5.1 / 2.32.0 / 4.26.2 / 5.7.0 | SDK-managed |
| @supabase/supabase-js | 2.117.2 | Client for the API's Supabase-compatible auth (email OTP, id-token) and RPC endpoints |
| @tanstack/react-query | 5.103.3 | Server cache with journal-backed offline snapshots |
| zod | 4.6.5 | Every RPC response is parsed |
| lucide-react-native | 1.48.0 | One icon set (the boards' glyphs differ; the packet asks for one set) |

## Tooling

| Package | Version | Use |
|---|---|---|
| typescript | 6.0.3 | |
| jest / jest-expo | 29.7.0 / 57.0.5 | Unit project (jest-expo preset) and db project (node) |
| eslint | 9.39.5 | Flat config |
| pg | 8.23.0 | Backend tests, test-database builder, dev backend |
| tsx | 4.23.15 | Runs the dev backend and the smoke test |
| playwright-core | 1.56.1 | Browser walkthrough; pinned to match the preinstalled Chromium 141 build (`PLAYWRIGHT_BROWSERS_PATH`) |

## Backend

| Component | Version | Notes |
|---|---|---|
| PostgreSQL | 18 on Railway (template image `postgres-ssl:18`); 16 and 18 in tests | CI runs the backend and API suites on 18 with the strict platform layer and on 16 with Supabase-style permissive grants; verified locally on 16 and 18.6. The migrations use only features available in 15+ |
| API service (`server/`) | Node 22 (`node:22-bookworm-slim`) | Runtime dependency `pg` 8.23.0 only; bundled with esbuild 0.28.2; lockfile `server/package-lock.json` |
| pg_cron | not used on Railway | The API runs the jobs; the maintenance migration still creates schedules where the extension exists |
| Node.js | ≥ 22.13 | `engines` in `package.json`; CI and the API image use Node 22 |

## Known constraints

- **Web preview**: expo-sqlite's web build is unencrypted and cannot run the synchronous API
  without cross-origin isolation (the app uses only the asynchronous API); there is no background
  location, share sheet, Photos or notifications. The web target exists for development and the
  browser walkthrough, not as a product.
- **Platform layer** (`db/platform/`) creates the `anon` / `authenticated` / `service_role`
  roles, the `auth` schema and `auth.uid()` / `auth.jwt()` that the migrations expect, with no
  default privileges. `db/test-support/` adds Supabase-style permissive default grants for tests
  only (`DB_PLATFORM=permissive`), so the suite proves that RLS and explicit revokes — not missing
  grants — protect the data. The deploy migrator never applies it.
