import { z } from 'zod';

/**
 * Runtime schemas for every RPC response (types alone cannot validate a hostile or
 * mismatched payload). Field names mirror the SQL functions in supabase/migrations.
 */

const xpParts = z.object({ distance_xp: z.number(), active_day_bonus: z.number(), xp: z.number() });

export const xpAwardSchema = z.object({
  days: z.array(z.object({ competition_date: z.string(), before: xpParts, after: xpParts, delta: z.number() })),
  total_xp: z.number(),
  distance_xp: z.number(),
  active_day_bonus: z.number(),
});
export type XpAward = z.infer<typeof xpAwardSchema>;

export const runStatusSchema = z.enum(['uploading', 'accepted', 'personal_only', 'review']);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const serverRunSchema = z.object({
  id: z.string(),
  client_run_id: z.string(),
  title: z.string(),
  started_at_ms: z.number(),
  ended_at_ms: z.number(),
  active_ms: z.number(),
  distance_m: z.number(),
  status: runStatusSchema,
  reason_codes: z.array(z.string()),
  coverage: z.number().nullable(),
  interrupted: z.boolean(),
  scoring_state: z.enum(['none', 'pending', 'applied']),
  xp_award: xpAwardSchema.nullable(),
  version: z.number(),
  validator_version: z.number().nullable(),
  rule_version: z.number().nullable(),
  finalized_at_ms: z.number().nullable(),
});
export type ServerRun = z.infer<typeof serverRunSchema>;

export const uploadStateSchema = z.object({
  run_id: z.string(),
  status: z.enum(['uploading', 'accepted', 'personal_only', 'review', 'deleted']),
  version: z.number(),
  expected_chunks: z.number(),
  received_chunks: z.array(z.number()),
  run: serverRunSchema.nullable(),
});
export type UploadState = z.infer<typeof uploadStateSchema>;

export const chunkResultSchema = z.object({ status: z.enum(['stored', 'already_finalized']), seq: z.number().nullable() });

export const finalizeResultSchema = z.object({
  run: serverRunSchema,
  lifetime_xp: z.number(),
  tier: z.string(),
  competition_enabled: z.boolean(),
});
export type FinalizeResult = z.infer<typeof finalizeResultSchema>;

export const appConfigSchema = z.object({
  competition_enabled: z.boolean(),
  invites_enabled: z.boolean(),
  registration_enabled: z.boolean(),
  rule_version: z.number(),
  validator_version: z.number(),
  competition_time_zone: z.string(),
  league_capacity: z.number(),
  server_time_ms: z.number(),
});
export type AppConfig = z.infer<typeof appConfigSchema>;

export const profileSchema = z.object({
  alias: z.string(),
  units: z.enum(['metric', 'imperial']),
  goal_days: z.number().nullable(),
  notification_tz: z.string().nullable(),
  status: z.enum(['active', 'deleting']),
  created_at_ms: z.number(),
});
export type Profile = z.infer<typeof profileSchema>;

export const meSchema = z.object({
  user_id: z.string(),
  profile: profileSchema.nullable(),
  lifetime_xp: z.number(),
  tier: z.string(),
  is_staff: z.boolean(),
  config: appConfigSchema,
});
export type Me = z.infer<typeof meSchema>;

export const aliasCheckSchema = z.object({
  alias: z.string(),
  available: z.boolean(),
  problem: z.enum(['invalid', 'not_allowed', 'taken']).nullable(),
});

export const weekSummarySchema = z.object({
  week_start: z.string(),
  starts_at_ms: z.number(),
  ends_at_ms: z.number(),
  settles_at_ms: z.number(),
  days: z.array(z.object({ date: z.string(), xp: z.number(), active: z.boolean(), distance_cm: z.number() })),
  active_days: z.number(),
  weekly_xp: z.number(),
  goal_days: z.number().nullable(),
});
export type WeekSummary = z.infer<typeof weekSummarySchema>;

export const progressSchema = z.object({
  lifetime_xp: z.number(),
  tier: z.string(),
  week: weekSummarySchema,
  distance_by_week: z.array(z.object({ week_start: z.string(), distance_cm: z.number(), runs: z.number() })),
  competition_enabled: z.boolean(),
});
export type Progress = z.infer<typeof progressSchema>;

export const historyPageSchema = z.object({
  runs: z.array(serverRunSchema),
  next_cursor: z.object({ before_started_at_ms: z.number(), before_id: z.string() }).nullable(),
});
export type HistoryPage = z.infer<typeof historyPageSchema>;

export const compactPointSchema = z.tuple([z.number(), z.number(), z.number(), z.number(), z.number().nullable(), z.number()]);

export const runRouteSchema = z.object({
  run_id: z.string(),
  segments: z.array(z.object({ index: z.number(), startAt: z.number(), endAt: z.number() })),
  points: z.array(compactPointSchema),
});
export type RunRoute = z.infer<typeof runRouteSchema>;

export const renameResultSchema = serverRunSchema;

export const deleteResultSchema = z.object({
  run_id: z.string(),
  deleted: z.boolean(),
  xp_changes: z.array(z.object({ competition_date: z.string(), delta: z.number() }).passthrough()),
  lifetime_xp: z.number(),
});

export const standingSchema = z.object({
  member_id: z.string(),
  rank: z.number(),
  alias: z.string().nullable(),
  tier: z.string().nullable(),
  weekly_xp: z.number(),
  is_me: z.boolean(),
  is_owner: z.boolean(),
  hidden: z.boolean(),
});
export type Standing = z.infer<typeof standingSchema>;

export const leagueViewSchema = z.object({
  league: z
    .object({
      id: z.string(),
      name: z.string(),
      member_count: z.number(),
      capacity: z.number(),
      is_owner: z.boolean(),
      calendar_zone: z.string(),
      created_at_ms: z.number(),
      joined_at_ms: z.number(),
    })
    .nullable(),
  week: z
    .object({
      week_start: z.string(),
      offset: z.number(),
      starts_at_ms: z.number(),
      ends_at_ms: z.number(),
      settles_at_ms: z.number(),
      state: z.enum(['in_progress', 'settling', 'final']),
      revision: z.number(),
    })
    .optional(),
  standings: z.array(standingSchema).optional(),
  me: standingSchema.nullable().optional(),
  competition_enabled: z.boolean(),
});
export type LeagueView = z.infer<typeof leagueViewSchema>;

export const joinResultSchema = z.union([z.object({ error: z.string() }), leagueViewSchema]);

export const inviteSchema = z.object({ code: z.string(), expires_at_ms: z.number() });
export type Invite = z.infer<typeof inviteSchema>;

export const invitePreviewSchema = z.object({
  status: z.enum(['valid', 'full', 'already_member', 'in_other_league', 'not_found', 'closed', 'revoked', 'expired', 'unavailable']),
  league_name: z.string().optional(),
  member_count: z.number().optional(),
  capacity: z.number().optional(),
  expires_at_ms: z.number().optional(),
});
export type InvitePreview = z.infer<typeof invitePreviewSchema>;

export const leaveResultSchema = z.object({ left: z.boolean(), league_id: z.string() });

export const blocksSchema = z.array(z.object({ block_id: z.string(), alias: z.string(), created_at_ms: z.number() }));
export type BlockEntry = z.infer<typeof blocksSchema>[number];

export const reportResultSchema = z.object({ report_id: z.string(), status: z.string() });

export const exportJobSchema = z.object({ export_id: z.string(), expires_at_ms: z.number(), reused: z.boolean() });

export const exportDataSchema = z
  .object({
    format: z.literal('paceleague-export'),
    format_version: z.number(),
    generated_at_ms: z.number(),
    runs: z.array(serverRunSchema.extend({ segments: z.array(z.object({ index: z.number(), startAt: z.number(), endAt: z.number() })) })),
  })
  .passthrough();
export type ExportData = z.infer<typeof exportDataSchema>;

export const deletionSchema = z.object({
  job_id: z.string().optional(),
  state: z.enum(['none', 'queued', 'running', 'retrying', 'completed', 'failed']),
  requested_at_ms: z.number().optional(),
});
export type DeletionStatus = z.infer<typeof deletionSchema>;

export const logEventsResultSchema = z.object({ accepted: z.number(), dropped: z.number() });
