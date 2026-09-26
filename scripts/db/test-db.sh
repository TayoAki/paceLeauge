#!/usr/bin/env bash
# Runs the backend integration suite against a real PostgreSQL:
# local harness cluster by default, or the server at PG_TEST_URL (CI).
# DB_PLATFORM=permissive builds the template with Supabase-like default privileges.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

if [[ -z "${PG_TEST_URL:-}" ]]; then
  bash scripts/db/local-db.sh start
fi
npx tsx scripts/db/apply-migrations.ts --database paceleague_template
npx jest --selectProjects db "$@"
