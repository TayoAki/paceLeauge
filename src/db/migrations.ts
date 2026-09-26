import type { SqlDatabase } from './types';

/**
 * Versioned local schema (one database per signed-in account, encrypted on device).
 * Append new migrations; never edit a shipped one.
 */
export const LOCAL_MIGRATIONS: string[] = [
  `
  create table active_session (
    id integer primary key check (id = 1),
    run_id text not null,
    status text not null check (status in ('recording', 'paused', 'interrupted')),
    started_at integer not null,
    segments_json text not null,
    open_segment_index integer,
    open_segment_started_at integer,
    interrupted_at integer,
    interrupt_reason text,
    was_interrupted integer not null default 0,
    next_seq integer not null default 0,
    point_count integer not null default 0,
    last_point_at integer,
    last_checkpoint_at integer not null,
    updated_at integer not null
  );

  create table track_points (
    run_id text not null,
    seq integer not null,
    segment_index integer not null,
    t integer not null,
    lat real not null,
    lon real not null,
    accuracy real,
    primary key (run_id, seq)
  );
  create index track_points_run_t on track_points (run_id, t);

  create table session_events (
    run_id text not null,
    seq integer not null,
    type text not null,
    at integer not null,
    primary key (run_id, seq)
  );

  create table saved_runs (
    run_id text primary key,
    title text not null,
    started_at integer not null,
    ended_at integer not null,
    active_ms integer not null,
    distance_m real not null,
    point_count integer not null,
    segments_json text not null,
    interrupted integer not null default 0,
    validation_json text not null,
    provisional_xp_json text,
    sync_state text not null check (sync_state in ('pending', 'uploading', 'awaiting_validation', 'synced', 'needs_attention')),
    sync_error text,
    server_run_id text,
    server_json text,
    route_cached integer not null default 1,
    deleted integer not null default 0,
    created_at integer not null,
    updated_at integer not null
  );
  create index saved_runs_started on saved_runs (started_at desc);

  create table outbox (
    id integer primary key autoincrement,
    kind text not null check (kind in ('upload_run', 'rename_run', 'delete_run')),
    run_id text not null,
    payload_json text not null,
    state text not null check (state in ('pending', 'uploading', 'awaiting_validation', 'succeeded', 'needs_attention')),
    attempts integer not null default 0,
    next_attempt_at integer not null default 0,
    last_error text,
    progress_json text,
    created_at integer not null,
    updated_at integer not null
  );
  create index outbox_due on outbox (state, next_attempt_at);

  create table telemetry_queue (
    event_id text primary key,
    name text not null,
    occurred_at integer not null,
    props_json text not null
  );

  create table kv (
    key text primary key,
    value_json text not null,
    updated_at integer not null
  );
  `,
];

export async function migrate(db: SqlDatabase): Promise<void> {
  const row = await db.getFirstAsync<{ user_version: number }>('pragma user_version');
  const current = row?.user_version ?? 0;
  for (let version = current; version < LOCAL_MIGRATIONS.length; version += 1) {
    await db.execAsync('begin immediate');
    try {
      await db.execAsync(LOCAL_MIGRATIONS[version] as string);
      await db.execAsync(`pragma user_version = ${version + 1}`);
      await db.execAsync('commit');
    } catch (error) {
      await db.execAsync('rollback');
      throw error;
    }
  }
}
