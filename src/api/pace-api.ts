import type { z } from 'zod';

import type { ActiveSegment } from '@/domain/types';

import { ApiError } from './errors';
import {
  aliasCheckSchema,
  appConfigSchema,
  blocksSchema,
  chunkResultSchema,
  deleteResultSchema,
  deletionSchema,
  exportDataSchema,
  exportJobSchema,
  finalizeResultSchema,
  historyPageSchema,
  invitePreviewSchema,
  inviteSchema,
  joinResultSchema,
  leagueViewSchema,
  leaveResultSchema,
  logEventsResultSchema,
  meSchema,
  progressSchema,
  renameResultSchema,
  reportResultSchema,
  runRouteSchema,
  serverRunSchema,
  uploadStateSchema,
  weekSummarySchema,
  type AppConfig,
  type BlockEntry,
  type DeletionStatus,
  type ExportData,
  type FinalizeResult,
  type HistoryPage,
  type Invite,
  type InvitePreview,
  type LeagueView,
  type Me,
  type Progress,
  type RunRoute,
  type ServerRun,
  type UploadState,
  type WeekSummary,
} from './schemas';

/** Calls public.<fn>(args) and returns the raw JSON result; throws ApiError. */
export type RpcTransport = (fn: string, args: Record<string, unknown>, options?: { timeoutMs?: number }) => Promise<unknown>;

export interface StartUploadInput {
  clientRunId: string;
  startedAtMs: number;
  endedAtMs: number;
  segments: ActiveSegment[];
  clientDistanceM: number;
  clientActiveMs: number;
  expectedPoints: number;
  expectedChunks: number;
  title: string;
  interrupted: boolean;
}

export interface ProfileInput {
  alias: string;
  units: 'metric' | 'imperial';
  goalDays: number | null;
  notificationTz: string | null;
  ackEligibility: boolean;
}

export type ReportReason = 'offensive_name' | 'harassment' | 'impersonation' | 'cheating' | 'spam' | 'other';

export interface TelemetryEvent {
  event_id: string;
  name: string;
  environment: string;
  occurred_at_ms: number;
  props: Record<string, string | boolean>;
}

export interface PaceApi {
  getAppConfig(): Promise<AppConfig>;
  getMe(): Promise<Me>;
  checkAlias(alias: string): Promise<{ available: boolean; problem: 'invalid' | 'not_allowed' | 'taken' | null }>;
  saveProfile(input: ProfileInput): Promise<Me>;

  startRunUpload(input: StartUploadInput): Promise<UploadState>;
  putRouteChunk(runId: string, seq: number, body: string, checksum: string): Promise<void>;
  finalizeRun(runId: string, expectedVersion: number, manifest: { seq: number; checksum: string }[]): Promise<FinalizeResult>;
  listMyRuns(cursor?: { beforeStartedAtMs: number; beforeId: string } | null, limit?: number): Promise<HistoryPage>;
  getMyRun(runId: string): Promise<ServerRun>;
  getMyRunRoute(runId: string): Promise<RunRoute>;
  renameRun(runId: string, title: string, expectedVersion?: number | null): Promise<ServerRun>;
  deleteRun(runId: string): Promise<{ lifetimeXp: number }>;

  getWeekSummary(weekOffset?: number): Promise<WeekSummary>;
  getProgress(weeks?: number): Promise<Progress>;

  getMyLeague(weekOffset?: 0 | -1): Promise<LeagueView>;
  createLeague(name: string): Promise<LeagueView>;
  createLeagueInvite(): Promise<Invite>;
  rotateLeagueInvites(): Promise<Invite>;
  getInvitePreview(code: string): Promise<InvitePreview>;
  joinLeague(code: string): Promise<LeagueView>;
  leaveLeague(): Promise<void>;
  transferLeagueOwnership(memberId: string): Promise<LeagueView>;
  removeLeagueMember(memberId: string): Promise<LeagueView>;
  renameLeague(name: string): Promise<LeagueView>;

  blockMember(memberId: string): Promise<void>;
  listBlocks(): Promise<BlockEntry[]>;
  unblock(blockId: string): Promise<void>;
  submitReport(target: 'member' | 'league', memberId: string | null, reason: ReportReason): Promise<void>;

  requestExport(): Promise<{ exportId: string; expiresAtMs: number }>;
  getExport(exportId: string): Promise<ExportData>;
  getExportRoute(exportId: string, runId: string): Promise<RunRoute>;
  requestAccountDeletion(): Promise<DeletionStatus>;
  getAccountDeletionStatus(): Promise<DeletionStatus>;

  logEvents(events: TelemetryEvent[]): Promise<void>;
}

const UPLOAD_TIMEOUT_MS = 30_000;

export function createPaceApi(rpc: RpcTransport): PaceApi {
  async function call<S extends z.ZodType>(fn: string, args: Record<string, unknown>, schema: S, timeoutMs?: number): Promise<z.infer<S>> {
    const data = await rpc(fn, args, { timeoutMs });
    const parsed = schema.safeParse(data);
    if (!parsed.success) throw new ApiError('invalid_response', null, `${fn}: ${parsed.error.message}`);
    return parsed.data;
  }

  return {
    getAppConfig: () => call('get_app_config', {}, appConfigSchema),
    getMe: () => call('get_me', {}, meSchema),
    checkAlias: async (alias) => {
      const r = await call('check_alias', { p_alias: alias }, aliasCheckSchema);
      return { available: r.available, problem: r.problem };
    },
    saveProfile: (input) =>
      call(
        'save_profile',
        {
          p_alias: input.alias,
          p_units: input.units,
          p_goal_days: input.goalDays,
          p_notification_tz: input.notificationTz,
          p_ack_eligibility: input.ackEligibility,
        },
        meSchema,
      ),

    startRunUpload: (input) =>
      call(
        'start_run_upload',
        {
          p_client_run_id: input.clientRunId,
          p_started_at_ms: input.startedAtMs,
          p_ended_at_ms: input.endedAtMs,
          p_segments: input.segments,
          p_client_distance_m: input.clientDistanceM,
          p_client_active_ms: input.clientActiveMs,
          p_expected_points: input.expectedPoints,
          p_expected_chunks: input.expectedChunks,
          p_title: input.title,
          p_interrupted: input.interrupted,
        },
        uploadStateSchema,
      ),
    putRouteChunk: async (runId, seq, body, checksum) => {
      await call('put_route_chunk', { p_run_id: runId, p_seq: seq, p_points: body, p_checksum: checksum }, chunkResultSchema, UPLOAD_TIMEOUT_MS);
    },
    finalizeRun: (runId, expectedVersion, manifest) =>
      call('finalize_run', { p_run_id: runId, p_expected_version: expectedVersion, p_manifest: manifest }, finalizeResultSchema, UPLOAD_TIMEOUT_MS),
    listMyRuns: (cursor, limit = 20) =>
      call(
        'list_my_runs',
        { p_before_started_at_ms: cursor?.beforeStartedAtMs ?? null, p_before_id: cursor?.beforeId ?? null, p_limit: limit },
        historyPageSchema,
      ),
    getMyRun: (runId) => call('get_my_run', { p_run_id: runId }, serverRunSchema),
    getMyRunRoute: (runId) => call('get_my_run_route', { p_run_id: runId }, runRouteSchema),
    renameRun: (runId, title, expectedVersion = null) =>
      call('rename_run', { p_run_id: runId, p_title: title, p_expected_version: expectedVersion }, renameResultSchema),
    deleteRun: async (runId) => {
      const r = await call('delete_run', { p_run_id: runId, p_expected_version: null }, deleteResultSchema);
      return { lifetimeXp: r.lifetime_xp };
    },

    getWeekSummary: (weekOffset = 0) => call('get_week_summary', { p_week_offset: weekOffset }, weekSummarySchema),
    getProgress: (weeks = 4) => call('get_progress', { p_weeks: weeks }, progressSchema),

    getMyLeague: (weekOffset = 0) => call('get_my_league', { p_week_offset: weekOffset }, leagueViewSchema),
    createLeague: (name) => call('create_league', { p_name: name }, leagueViewSchema),
    createLeagueInvite: () => call('create_league_invite', {}, inviteSchema),
    rotateLeagueInvites: () => call('rotate_league_invites', {}, inviteSchema),
    getInvitePreview: (code) => call('get_invite_preview', { p_code: code }, invitePreviewSchema),
    joinLeague: async (code) => {
      const r = await call('join_league', { p_code: code }, joinResultSchema);
      if ('error' in r) throw new ApiError(r.error, 200);
      return r;
    },
    leaveLeague: async () => {
      await call('leave_league', {}, leaveResultSchema);
    },
    transferLeagueOwnership: (memberId) => call('transfer_league_ownership', { p_member_id: memberId }, leagueViewSchema),
    removeLeagueMember: (memberId) => call('remove_league_member', { p_member_id: memberId }, leagueViewSchema),
    renameLeague: (name) => call('rename_league', { p_name: name }, leagueViewSchema),

    blockMember: async (memberId) => {
      await rpc('block_member', { p_member_id: memberId });
    },
    listBlocks: () => call('list_blocks', {}, blocksSchema),
    unblock: async (blockId) => {
      await rpc('unblock', { p_block_id: blockId });
    },
    submitReport: async (target, memberId, reason) => {
      await call('submit_report', { p_target_kind: target, p_member_id: memberId, p_reason: reason }, reportResultSchema);
    },

    requestExport: async () => {
      const r = await call('request_export', {}, exportJobSchema);
      return { exportId: r.export_id, expiresAtMs: r.expires_at_ms };
    },
    getExport: (exportId) => call('get_export', { p_export_id: exportId }, exportDataSchema, UPLOAD_TIMEOUT_MS),
    getExportRoute: (exportId, runId) => call('get_export_route', { p_export_id: exportId, p_run_id: runId }, runRouteSchema, UPLOAD_TIMEOUT_MS),
    requestAccountDeletion: () => call('request_account_deletion', {}, deletionSchema),
    getAccountDeletionStatus: () => call('get_account_deletion_status', {}, deletionSchema),

    logEvents: async (events) => {
      await call('log_events', { p_events: events }, logEventsResultSchema);
    },
  };
}
