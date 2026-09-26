#!/usr/bin/env bash
# Local PostgreSQL cluster (16 or newer) for backend tests and the development backend.
#   scripts/db/local-db.sh start|stop|status|reset
# Listens on 127.0.0.1:${PGPORT:-54329} with trust auth for local connections only.
# A new cluster uses the newest installed version (or PG_BIN); an existing one keeps its own.
# Not used when PG_TEST_URL is set (e.g. CI provides its own Postgres service).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PGDATA="${PGDATA_DIR:-$ROOT/.pgdata}"
SOCKET_DIR="$ROOT/.pg-socket"
PORT="${PGPORT:-54329}"
CLUSTER_VERSION="$(cat "$PGDATA/PG_VERSION" 2>/dev/null || true)"
if [[ -z "${PG_BIN:-}" && -n "$CLUSTER_VERSION" && -x "/usr/lib/postgresql/$CLUSTER_VERSION/bin/pg_ctl" ]]; then
  BIN="/usr/lib/postgresql/$CLUSTER_VERSION/bin"
else
  BIN="${PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -n 1)}"
fi

if [[ -z "$BIN" || ! -x "$BIN/pg_ctl" ]]; then
  echo "PostgreSQL server binaries not found (set PG_BIN)." >&2
  exit 1
fi

# The server refuses to run as root; delegate to the postgres system user when needed.
as_pg() {
  if [[ "$(id -u)" == "0" ]]; then
    runuser -u postgres -- "$@"
  else
    "$@"
  fi
}

prepare_dirs() {
  mkdir -p "$PGDATA" "$SOCKET_DIR"
  if [[ "$(id -u)" == "0" ]]; then
    chown postgres:postgres "$PGDATA" "$SOCKET_DIR"
    chmod 700 "$PGDATA"
  fi
}

is_running() {
  as_pg "$BIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1
}

start() {
  prepare_dirs
  if [[ ! -f "$PGDATA/PG_VERSION" ]]; then
    as_pg "$BIN/initdb" -D "$PGDATA" -U postgres --auth=trust --encoding=UTF8 --locale=C.UTF-8 >/dev/null
  fi
  if is_running; then
    echo "postgres already running on 127.0.0.1:$PORT"
    return
  fi
  as_pg "$BIN/pg_ctl" -D "$PGDATA" -l "$PGDATA/server.log" -w \
    -o "-p $PORT -k $SOCKET_DIR -c listen_addresses=127.0.0.1 -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c max_connections=200" \
    start >/dev/null
  echo "postgres started on 127.0.0.1:$PORT"
}

stop() {
  if is_running; then
    as_pg "$BIN/pg_ctl" -D "$PGDATA" -m fast stop >/dev/null
    echo "postgres stopped"
  fi
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  status) if is_running; then echo "running on 127.0.0.1:$PORT"; else echo "stopped"; exit 1; fi ;;
  reset) stop; rm -rf "$PGDATA" "$SOCKET_DIR"; start ;;
  *) echo "usage: $0 start|stop|status|reset" >&2; exit 2 ;;
esac
