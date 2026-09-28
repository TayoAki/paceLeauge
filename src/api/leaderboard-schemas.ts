import { z } from 'zod';

/**
 * Runtime schemas for leaderboards (docs/ROADMAP.md 4.7). Field names mirror
 * db/migrations/20261003000400_leaderboards.sql.
 */
export const leaderboardTiers = ['Seed', 'Stride', 'Tempo', 'Surge', 'Elite'] as const;
export type LeaderboardTier = (typeof leaderboardTiers)[number];
export type LeaderboardKind = 'tier' | 'country';

export const leaderboardStatusSchema = z.object({
  joined: z.boolean(),
  country: z.string().nullable(),
  /** A moderator took the runner off the boards. */
  removed: z.boolean(),
  /** The first week the runner can appear (two weeks of runs, a 14-day-old account); null until then. */
  eligible_from: z.string().nullable(),
  eligible: z.boolean(),
  tier: z.string(),
  /** An invitation at a natural moment, for runners who never joined. */
  invite: z.enum(['won_league', 'full_week']).nullable(),
});
export type LeaderboardStatus = z.infer<typeof leaderboardStatusSchema>;

const rowSchema = z.object({
  result_id: z.string(),
  rank: z.number(),
  alias: z.string().nullable(),
  tier: z.string(),
  score: z.number(),
  is_me: z.boolean(),
  hidden: z.boolean(),
});
export type LeaderboardRow = z.infer<typeof rowSchema>;

export const leaderboardSchema = z.object({
  week_start: z.string(),
  board: z.enum(['tier', 'country']),
  key: z.string(),
  /** in_progress: this week · in_review: last week before its results are final · final */
  state: z.enum(['in_progress', 'in_review', 'final']),
  final_at_ms: z.number(),
  runners: z.number(),
  rows: z.array(rowSchema),
  me: rowSchema.nullable(),
  /** Only for the runner: their own result is being checked (held) or was taken off (removed). */
  my_status: z.enum(['provisional', 'held', 'final', 'removed']).nullable(),
});
export type Leaderboard = z.infer<typeof leaderboardSchema>;
