import { z } from 'zod';

/**
 * Runtime schemas for every RPC response (types alone cannot validate a hostile or
 * mismatched payload). Field names mirror the SQL functions in db/migrations.
 */

const xpParts = z.object({ distance_xp: z.number(), active_day_bonus: z.number(), xp: z.number() });

export const xpAwardSchema = z.object({
  days: z.array(z.object({ competition_date: z.string(), before: xpParts, after: xpParts, delta: z.number() })),
  total_xp: z.number(),
  distance_xp: z.number(),
  active_day_bonus: z.number(),
});
export type XpAward = z.infer<typeof xpAwardSchema>;

export const activityTypeSchema = z.enum(['run', 'walk', 'hike', 'ride', 'other']);
export type ActivityType = z.infer<typeof activityTypeSchema>;

export const runStatusSchema = z.enum(['uploading', 'accepted', 'personal_only', 'review', 'duplicate']);
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
  // Run log extras (Phase 1). Optional so a server without the migration still validates.
  activity_type: activityTypeSchema.optional(),
  source: z.string().optional(),
  notes: z.string().nullable().optional(),
  shoe_id: z.string().nullable().optional(),
  edited_at_ms: z.number().nullable().optional(),
  // Sources and provenance (Phase 2).
  source_app: z.string().nullable().optional(),
  source_device: z.string().nullable().optional(),
  manual_entry: z.boolean().optional(),
  avg_heart_rate: z.number().nullable().optional(),
  max_heart_rate: z.number().nullable().optional(),
  steps: z.number().nullable().optional(),
  indoor: z.boolean().optional(),
  duplicate_of: z.string().nullable().optional(),
});
export type ServerRun = z.infer<typeof serverRunSchema>;
export const runSourceSchema = z.enum(['phone_gps', 'watch', 'health_import', 'file_import', 'garmin', 'indoor']);
export type RunSource = z.infer<typeof runSourceSchema>;

export const uploadStateSchema = z.object({
  run_id: z.string(),
  status: z.enum(['uploading', 'accepted', 'personal_only', 'review', 'duplicate', 'deleted']),
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
  /** Absent from servers older than the age-assurance migration. */
  age_signal: z.enum(['adult', 'not_required', 'minor']).nullable().optional(),
  age_checked_at_ms: z.number().nullable().optional(),
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
  days: z.array(z.object({ date: z.string(), xp: z.number(), active: z.boolean(), distance_cm: z.number(), active_ms: z.number() })),
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

// ---------------------------------------------------------------------------------------
// Phase 1 (docs/ROADMAP.md): run log, records, streaks, badges, cheers, stats, fixing runs
// ---------------------------------------------------------------------------------------
export const runListSchema = z.array(serverRunSchema);

export const shoeSchema = z.object({
  id: z.string(),
  name: z.string(),
  limit_km: z.number().nullable(),
  is_default: z.boolean(),
  retired: z.boolean(),
  created_at_ms: z.number(),
  runs: z.number(),
  distance_m: z.number(),
});
export type Shoe = z.infer<typeof shoeSchema>;
export const shoesSchema = z.array(shoeSchema);
export const deletedSchema = z.object({ deleted: z.boolean() });

export const effortKeySchema = z.enum(['1k', '1mi', '5k', '10k', 'half', 'marathon']);
export type EffortKey = z.infer<typeof effortKeySchema>;

const recordRunSchema = z.object({ run_id: z.string(), elapsed_ms: z.number(), started_at_ms: z.number(), title: z.string() });
export type RecordRun = z.infer<typeof recordRunSchema>;

export const personalRecordsSchema = z.object({
  records: z.array(z.object({ effort: effortKeySchema, distance_m: z.number(), best: recordRunSchema.nullable(), efforts: z.number() })),
  longest_run: z.object({ run_id: z.string(), distance_m: z.number(), started_at_ms: z.number(), title: z.string() }).nullable(),
});
export type PersonalRecords = z.infer<typeof personalRecordsSchema>;

export const recordHistorySchema = z.array(recordRunSchema);

export const runEffortsSchema = z.object({
  run_id: z.string(),
  counts_for_records: z.boolean(),
  efforts: z.array(z.object({ effort: effortKeySchema, elapsed_ms: z.number(), rank: z.number(), record_when_run: z.boolean() })),
});
export type RunEfforts = z.infer<typeof runEffortsSchema>;

export const streakSchema = z.object({
  current_weeks: z.number(),
  best_weeks: z.number(),
  this_week: z.object({ week_start: z.string(), active_days: z.number(), goal_days: z.number().nullable(), met: z.boolean(), frozen: z.boolean() }),
  at_stake: z.boolean(),
});
export type Streak = z.infer<typeof streakSchema>;

export const badgesSchema = z.object({
  earned: z.array(z.object({ badge: z.string(), earned_at_ms: z.number() })),
  progress: z.object({ accepted_runs: z.number(), distance_m: z.number(), lifetime_xp: z.number(), streak: streakSchema }),
});
export type Badges = z.infer<typeof badgesSchema>;

export const cheersSchema = z.object({
  week_start: z.string(),
  league_id: z.string().nullable(),
  received: z.array(z.object({ member_id: z.string(), count: z.number() })),
  mine: z.array(z.string()),
  cheered_me: z.array(z.string()),
});
export type Cheers = z.infer<typeof cheersSchema>;

const statsTotalSchema = z.object({ runs: z.number(), days: z.number(), distance_m: z.number(), active_ms: z.number(), longest_m: z.number() });
export const statsSchema = z.object({
  from: z.string(),
  to: z.string(),
  bucket: z.enum(['week', 'month', 'year']),
  activity: z.string(),
  buckets: z.array(z.object({ start: z.string(), runs: z.number(), days: z.number(), distance_m: z.number(), active_ms: z.number() })),
  total: statsTotalSchema,
  previous_year: statsTotalSchema,
  // Walks, hikes, rides and other workouts (Phase 2.7): the range's totals for each type.
  by_activity: z.array(z.object({ activity: activityTypeSchema, runs: z.number(), distance_m: z.number(), active_ms: z.number() })).optional(),
});
export type Stats = z.infer<typeof statsSchema>;

export const runEditResultSchema = z.object({
  run: serverRunSchema,
  xp_changes: z.array(z.object({ competition_date: z.string(), delta: z.number() }).passthrough()),
  lifetime_xp: z.number(),
  can_undo: z.boolean(),
  removed_run_id: z.string().optional(),
});
export type RunEditResult = z.infer<typeof runEditResultSchema>;

export const diagnosticsResultSchema = z.object({ report_id: z.number() });

// Strava export (Phase 2.3).
export const stravaStatusSchema = z.object({
  available: z.boolean(),
  connected: z.boolean(),
  athlete_name: z.string().nullable(),
  auto_upload: z.boolean(),
  connected_at_ms: z.number().nullable(),
  posted: z.number(),
  pending: z.number(),
  failed: z.number(),
  last_error: z.string().nullable(),
});
export type StravaStatus = z.infer<typeof stravaStatusSchema>;
export const stravaUploadSchema = z
  .object({
    state: z.enum(['queued', 'processing', 'done', 'failed', 'cancelled']),
    activity_id: z.string().nullable(),
    error: z.string().nullable(),
    updated_at_ms: z.number(),
  })
  .nullable();
export type StravaUpload = z.infer<typeof stravaUploadSchema>;
export const stravaConnectSchema = z.object({ url: z.string().url() });

// Garmin through an aggregator (Phase 2.4).
export const garminStatusSchema = z.object({
  available: z.boolean(),
  connected: z.boolean(),
  connected_at_ms: z.number().nullable(),
  imported: z.number(),
  last_activity_at_ms: z.number().nullable(),
});
export type GarminStatus = z.infer<typeof garminStatusSchema>;

// Training plans (Phase 3.1). `input` and `adjustments` are the app's own JSON, read with
// src/features/plans/plan-codec.ts.
const workoutStepSchema = z.object({
  kind: z.enum(['warmup', 'run', 'walk', 'work', 'recover', 'cooldown']),
  effort: z.enum(['easy', 'steady', 'tempo', 'interval', 'race', 'walk']),
  durationS: z.number().optional(),
  distanceM: z.number().optional(),
});
export const workoutBlockSchema = z.object({ repeat: z.number().int().min(1), steps: z.array(workoutStepSchema) });
export const planFeedbackSchema = z.enum(['easy', 'about_right', 'hard', 'too_hard']);
export type PlanFeedback = z.infer<typeof planFeedbackSchema>;
export const serverPlanSessionSchema = z.object({
  id: z.string(),
  date: z.string(),
  week: z.number(),
  kind: z.enum(['easy', 'long', 'tempo', 'intervals', 'steady', 'run_walk', 'race']),
  title: z.string(),
  hard: z.boolean(),
  duration_s: z.number(),
  distance_m: z.number().nullable(),
  effort: z.enum(['easy', 'steady', 'tempo', 'interval', 'race', 'walk']),
  blocks: z.array(workoutBlockSchema),
  edited: z.boolean(),
  run_id: z.string().nullable(),
  matched_by: z.enum(['auto', 'runner']).nullable(),
  feedback: planFeedbackSchema.nullable(),
  pain: z.boolean(),
  run: z
    .object({ title: z.string(), started_at_ms: z.number(), distance_m: z.number(), active_ms: z.number() })
    .nullable(),
});
export type ServerPlanSession = z.infer<typeof serverPlanSessionSchema>;
export const serverPlanSchema = z.object({
  id: z.string(),
  version: z.number(),
  type: z.enum(['start_running', '5k', '10k', 'half', 'marathon', 'consistency', 'return']),
  status: z.enum(['active', 'completed', 'ended', 'replaced']),
  engine_version: z.number(),
  input: z.unknown(),
  adjustments: z.array(z.unknown()),
  time_zone: z.string(),
  start_date: z.string(),
  end_date: z.string(),
  today: z.string(),
  created_at_ms: z.number(),
  updated_at_ms: z.number(),
  ended_at_ms: z.number().nullable(),
  sessions: z.array(serverPlanSessionSchema),
});
export type ServerPlan = z.infer<typeof serverPlanSchema>;
export const planResultSchema = z.object({ plan: serverPlanSchema.nullable() });

// Pro (Phase 3.6).
export const entitlementsSchema = z.object({
  pro: z.boolean(),
  period: z.enum(['trial', 'intro', 'normal', 'promotional']).nullable(),
  source: z.enum(['revenuecat', 'grant']).nullable(),
  store: z.string().nullable(),
  expires_at_ms: z.number().nullable(),
  will_renew: z.boolean(),
  billing_issue: z.boolean(),
});
export type Entitlements = z.infer<typeof entitlementsSchema>;
