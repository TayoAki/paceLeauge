import type { z } from 'zod';

import type { RunOrigin } from '@/db/journal';
import type { ActiveSegment } from '@/domain/types';

import { ApiError } from './errors';
import { feedApi, type FeedApi } from './feed-api';
import { leaguesApi, type LeaguesApi } from './leagues-api';
import { socialApi, type SocialApi } from './social-api';
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
  badgesSchema,
  cheersSchema,
  diagnosticsResultSchema,
  entitlementsSchema,
  garminStatusSchema,
  planResultSchema,
  serverPlanSchema,
  stravaConnectSchema,
  stravaStatusSchema,
  stravaUploadSchema,
  deletedSchema,
  personalRecordsSchema,
  recordHistorySchema,
  runEditResultSchema,
  runEffortsSchema,
  runListSchema,
  shoeSchema,
  shoesSchema,
  statsSchema,
  streakSchema,
  type ActivityType,
  type Badges,
  type Cheers,
  type EffortKey,
  type PersonalRecords,
  type RecordRun,
  type RunEditResult,
  type RunEfforts,
  type Shoe,
  type Entitlements,
  type GarminStatus,
  type PlanFeedback,
  type ServerPlan,
  type Stats,
  type StravaStatus,
  type StravaUpload,
  type Streak,
  type AppConfig,
  type BlockEntry,
  type DeletionStatus,
  type ExportData,
  type FinalizeResult,
  type HistoryPage,
  type Invite,
  type InvitePreview,
  type LeagueKind,
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
  /** Where the run came from, for runs not recorded by the phone's GPS (Phase 2). */
  origin?: RunOrigin | null;
}

export interface ProfileInput {
  alias: string;
  units: 'metric' | 'imperial';
  goalDays: number | null;
  notificationTz: string | null;
  ackEligibility: boolean;
  /** What the App Store / Google Play age check said (features/account/age-check.ts). */
  ageSignal?: 'adult' | 'not_required';
  ageSource?: string;
}

export type ReportReason = 'offensive_name' | 'harassment' | 'impersonation' | 'cheating' | 'spam' | 'other';

export interface ShoeInput {
  name: string;
  /** Remind at this distance; null for no reminder. */
  limitKm: number | null;
  isDefault: boolean;
  /** Absent to add a new shoe. */
  shoeId?: string;
}

export interface RunDetailsInput {
  /** Omitted: unchanged. An empty string clears the note. */
  notes?: string;
  /** Omitted: unchanged. Null removes the shoe. */
  shoeId?: string | null;
}

export interface RunEditInput {
  keepFromMs?: number;
  keepToMs?: number;
  cutRanges?: { fromMs: number; toMs: number }[];
  activityType?: ActivityType;
}

/** A plan version to save (src/features/plans/plan-client.ts builds it from the engine's output). */
export interface PlanSave {
  planId: string;
  /** Null creates the plan; otherwise the version this one replaces. */
  baseVersion: number | null;
  input: unknown;
  adjustments: unknown[];
  sessions: Record<string, unknown>[];
  engineVersion: number;
  timeZone: string;
  endDate: string;
}

export interface StatsInput {
  /** Inclusive calendar dates, YYYY-MM-DD. */
  from: string;
  to: string;
  bucket: 'week' | 'month' | 'year';
  activity?: ActivityType | 'all';
}

export interface TelemetryEvent {
  event_id: string;
  name: string;
  environment: string;
  occurred_at_ms: number;
  props: Record<string, string | boolean>;
}

export interface PaceApi extends SocialApi, FeedApi, LeaguesApi {
  getAppConfig(): Promise<AppConfig>;
  getMe(): Promise<Me>;
  checkAlias(alias: string): Promise<{ available: boolean; problem: 'invalid' | 'not_allowed' | 'taken' | null }>;
  saveProfile(input: ProfileInput): Promise<Me>;
  /** Records an age check for an existing profile; a minor answer locks the account. */
  recordAgeSignal(signal: 'adult' | 'not_required' | 'minor', source: string | null): Promise<Me>;

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

  /** Without a league id, the runner's first league (docs/ROADMAP.md 4.1). */
  getMyLeague(weekOffset?: 0 | -1, leagueId?: string | null): Promise<LeagueView>;
  createLeague(name: string, kind?: LeagueKind): Promise<LeagueView>;
  createLeagueInvite(leagueId?: string | null): Promise<Invite>;
  rotateLeagueInvites(leagueId?: string | null): Promise<Invite>;
  getInvitePreview(code: string): Promise<InvitePreview>;
  joinLeague(code: string): Promise<LeagueView>;
  leaveLeague(leagueId?: string | null): Promise<void>;
  transferLeagueOwnership(memberId: string): Promise<LeagueView>;
  removeLeagueMember(memberId: string): Promise<LeagueView>;
  renameLeague(name: string, leagueId?: string | null): Promise<LeagueView>;

  blockMember(memberId: string): Promise<void>;
  listBlocks(): Promise<BlockEntry[]>;
  unblock(blockId: string): Promise<void>;
  submitReport(target: 'member' | 'league', memberId: string | null, reason: ReportReason, leagueId?: string | null): Promise<void>;

  requestExport(): Promise<{ exportId: string; expiresAtMs: number }>;
  getExport(exportId: string): Promise<ExportData>;
  getExportRoute(exportId: string, runId: string): Promise<RunRoute>;
  requestAccountDeletion(): Promise<DeletionStatus>;
  getAccountDeletionStatus(): Promise<DeletionStatus>;

  logEvents(events: TelemetryEvent[]): Promise<void>;

  // Phase 1 (docs/ROADMAP.md 1.4–1.10)
  listMyRunsBetween(fromMs: number, toMs: number, activity?: ActivityType | null): Promise<ServerRun[]>;
  updateRunDetails(runId: string, input: RunDetailsInput): Promise<ServerRun>;
  listShoes(): Promise<Shoe[]>;
  saveShoe(input: ShoeInput): Promise<Shoe>;
  retireShoe(shoeId: string, retired: boolean): Promise<Shoe>;
  deleteShoe(shoeId: string): Promise<void>;
  getPersonalRecords(): Promise<PersonalRecords>;
  getRecordHistory(effort: EffortKey): Promise<RecordRun[]>;
  getRunEfforts(runId: string): Promise<RunEfforts>;
  getStreak(): Promise<Streak>;
  getBadges(): Promise<Badges>;
  cheerMember(memberId: string): Promise<Cheers>;
  getLeagueCheers(weekOffset?: 0 | -1, leagueId?: string | null): Promise<Cheers>;
  getStats(input: StatsInput): Promise<Stats>;
  editRun(runId: string, expectedVersion: number, input: RunEditInput): Promise<RunEditResult>;
  mergeRuns(firstRunId: string, secondRunId: string): Promise<RunEditResult>;
  undoRunEdits(runId: string, expectedVersion: number): Promise<RunEditResult>;
  listRunDuplicates(runId: string): Promise<ServerRun[]>;
  submitDiagnostics(report: Record<string, unknown>): Promise<{ reportId: number }>;
  // Strava export (Phase 2.3)
  getStravaStatus(): Promise<StravaStatus>;
  /** Strava's authorization URL; the service sends the runner back to `returnTo`. */
  startStravaConnect(returnTo: string): Promise<string>;
  setStravaAutoUpload(enabled: boolean): Promise<StravaStatus>;
  disconnectStrava(): Promise<StravaStatus>;
  getStravaUpload(runId: string): Promise<StravaUpload>;
  postRunToStrava(runId: string): Promise<StravaUpload>;
  // Garmin through an aggregator (Phase 2.4)
  getGarminStatus(): Promise<GarminStatus>;
  /** The aggregator's widget URL; it sends the runner back to `returnTo`. */
  startGarminConnect(returnTo: string): Promise<string>;
  disconnectGarmin(): Promise<GarminStatus>;
  // Training plans (Phase 3.1)
  getPlan(): Promise<ServerPlan | null>;
  savePlan(save: PlanSave): Promise<ServerPlan>;
  endPlan(planId: string): Promise<ServerPlan | null>;
  setSessionFeedback(planId: string, sessionId: string, feedback: PlanFeedback | null, pain: boolean): Promise<ServerPlan>;
  /** Which session a run was; a null run means none of the runner's runs was. */
  matchPlanSession(planId: string, sessionId: string, runId: string | null): Promise<ServerPlan>;
  // Pro (Phase 3.6)
  getEntitlements(): Promise<Entitlements>;
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
          ...(input.ageSignal ? { p_age_signal: input.ageSignal, p_age_source: input.ageSource ?? null } : {}),
        },
        meSchema,
      ),

    recordAgeSignal: (signal, source) => call('record_age_signal', { p_signal: signal, p_source: source }, meSchema),

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
          // Only sent for imports, so a phone run's request is byte-for-byte what V1 sent.
          ...(input.origin
            ? {
                p_source: input.origin.source,
                p_activity_type: input.origin.activityType ?? null,
                p_source_app: input.origin.sourceApp ?? null,
                p_source_device: input.origin.sourceDevice ?? null,
                p_manual_entry: input.origin.manualEntry ?? false,
                p_external_id: input.origin.externalId ?? null,
                p_claimed_distance_m: input.origin.claimedDistanceM ?? null,
                p_avg_heart_rate: input.origin.avgHeartRate ?? null,
                p_max_heart_rate: input.origin.maxHeartRate ?? null,
                p_steps: input.origin.steps ?? null,
                // Sent only when set, so older servers still accept other imports.
                ...(input.origin.indoor ? { p_indoor: true } : {}),
              }
            : {}),
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

    getMyLeague: (weekOffset = 0, leagueId = null) => call('get_my_league', { p_week_offset: weekOffset, p_league_id: leagueId }, leagueViewSchema),
    createLeague: (name, kind = 'friends') => call('create_league', { p_name: name, p_kind: kind }, leagueViewSchema),
    createLeagueInvite: (leagueId = null) => call('create_league_invite', { p_league_id: leagueId }, inviteSchema),
    rotateLeagueInvites: (leagueId = null) => call('rotate_league_invites', { p_league_id: leagueId }, inviteSchema),
    getInvitePreview: (code) => call('get_invite_preview', { p_code: code }, invitePreviewSchema),
    joinLeague: async (code) => {
      const r = await call('join_league', { p_code: code }, joinResultSchema);
      if ('error' in r) throw new ApiError(r.error, 200);
      return r;
    },
    leaveLeague: async (leagueId = null) => {
      await call('leave_league', { p_league_id: leagueId }, leaveResultSchema);
    },
    transferLeagueOwnership: (memberId) => call('transfer_league_ownership', { p_member_id: memberId }, leagueViewSchema),
    removeLeagueMember: (memberId) => call('remove_league_member', { p_member_id: memberId }, leagueViewSchema),
    renameLeague: (name, leagueId = null) => call('rename_league', { p_name: name, p_league_id: leagueId }, leagueViewSchema),

    blockMember: async (memberId) => {
      await rpc('block_member', { p_member_id: memberId });
    },
    listBlocks: () => call('list_blocks', {}, blocksSchema),
    unblock: async (blockId) => {
      await rpc('unblock', { p_block_id: blockId });
    },
    submitReport: async (target, memberId, reason, leagueId = null) => {
      await call('submit_report', { p_target_kind: target, p_member_id: memberId, p_reason: reason, p_league_id: leagueId }, reportResultSchema);
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

    listMyRunsBetween: (fromMs, toMs, activity = null) =>
      call('list_my_runs_between', { p_from_ms: fromMs, p_to_ms: toMs, p_activity: activity }, runListSchema),
    updateRunDetails: (runId, input) =>
      call(
        'update_run_details',
        {
          p_run_id: runId,
          p_notes: input.notes ?? null,
          p_shoe_id: input.shoeId ?? null,
          p_clear_shoe: input.shoeId === null,
        },
        serverRunSchema,
      ),
    listShoes: () => call('list_shoes', {}, shoesSchema),
    saveShoe: (input) =>
      call('save_shoe', { p_name: input.name, p_limit_km: input.limitKm, p_is_default: input.isDefault, p_shoe_id: input.shoeId ?? null }, shoeSchema),
    retireShoe: (shoeId, retired) => call('retire_shoe', { p_shoe_id: shoeId, p_retired: retired }, shoeSchema),
    deleteShoe: async (shoeId) => {
      await call('delete_shoe', { p_shoe_id: shoeId }, deletedSchema);
    },
    getPersonalRecords: () => call('get_personal_records', {}, personalRecordsSchema),
    getRecordHistory: (effort) => call('get_record_history', { p_effort: effort }, recordHistorySchema),
    getRunEfforts: (runId) => call('get_run_efforts', { p_run_id: runId }, runEffortsSchema),
    getStreak: () => call('get_streak', {}, streakSchema),
    getBadges: () => call('get_badges', {}, badgesSchema),
    cheerMember: (memberId) => call('cheer_member', { p_member_id: memberId }, cheersSchema),
    getLeagueCheers: (weekOffset = 0, leagueId = null) => call('get_league_cheers', { p_week_offset: weekOffset, p_league_id: leagueId }, cheersSchema),
    getStats: (input) =>
      call('get_stats', { p_from: input.from, p_to: input.to, p_bucket: input.bucket, p_activity: input.activity ?? 'run' }, statsSchema),
    editRun: (runId, expectedVersion, input) =>
      call(
        'edit_run',
        {
          p_run_id: runId,
          p_expected_version: expectedVersion,
          p_keep_from_ms: input.keepFromMs ?? null,
          p_keep_to_ms: input.keepToMs ?? null,
          p_cut_ranges: (input.cutRanges ?? []).map((r) => ({ from_ms: r.fromMs, to_ms: r.toMs })),
          p_activity_type: input.activityType ?? null,
        },
        runEditResultSchema,
      ),
    mergeRuns: (firstRunId, secondRunId) =>
      call('merge_runs', { p_first_run_id: firstRunId, p_second_run_id: secondRunId }, runEditResultSchema),
    undoRunEdits: (runId, expectedVersion) =>
      call('undo_run_edits', { p_run_id: runId, p_expected_version: expectedVersion }, runEditResultSchema),
    listRunDuplicates: (runId) => call('list_run_duplicates', { p_run_id: runId }, runListSchema),
    submitDiagnostics: async (report) => {
      const r = await call('submit_diagnostics', { p_report: report }, diagnosticsResultSchema);
      return { reportId: r.report_id };
    },
    getStravaStatus: () => call('get_strava_status', {}, stravaStatusSchema),
    startStravaConnect: async (returnTo) => (await call('start_strava_connect', { p_return_to: returnTo }, stravaConnectSchema)).url,
    setStravaAutoUpload: (enabled) => call('set_strava_auto_upload', { p_enabled: enabled }, stravaStatusSchema),
    disconnectStrava: () => call('disconnect_strava', {}, stravaStatusSchema),
    getStravaUpload: (runId) => call('get_strava_upload', { p_run_id: runId }, stravaUploadSchema),
    postRunToStrava: (runId) => call('post_run_to_strava', { p_run_id: runId }, stravaUploadSchema),
    getGarminStatus: () => call('get_garmin_status', {}, garminStatusSchema),
    startGarminConnect: async (returnTo) => (await call('start_garmin_connect', { p_return_to: returnTo }, stravaConnectSchema)).url,
    disconnectGarmin: () => call('disconnect_garmin', {}, garminStatusSchema),
    getPlan: async () => (await call('get_plan', {}, planResultSchema)).plan,
    savePlan: (save) =>
      call(
        'save_plan',
        {
          p_plan_id: save.planId,
          p_base_version: save.baseVersion,
          p_input: save.input,
          p_adjustments: save.adjustments,
          p_sessions: save.sessions,
          p_engine_version: save.engineVersion,
          p_time_zone: save.timeZone,
          p_end_date: save.endDate,
        },
        serverPlanSchema,
      ),
    endPlan: async (planId) => (await call('end_plan', { p_plan_id: planId }, planResultSchema)).plan,
    setSessionFeedback: (planId, sessionId, feedback, pain) =>
      call('set_session_feedback', { p_plan_id: planId, p_session_id: sessionId, p_feedback: feedback, p_pain: pain }, serverPlanSchema),
    matchPlanSession: (planId, sessionId, runId) =>
      call('match_plan_session', { p_plan_id: planId, p_session_id: sessionId, p_run_id: runId }, serverPlanSchema),
    getEntitlements: () => call('get_entitlements', {}, entitlementsSchema),
    // Phase 4 (docs/ROADMAP.md): sharing, privacy zones and follows; the feed, pushes and moderation
    ...socialApi(call),
    ...feedApi(call),
    ...leaguesApi(call),
  };
}
