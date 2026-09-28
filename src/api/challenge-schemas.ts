import { z } from 'zod';

/**
 * Runtime schemas for challenges (docs/ROADMAP.md 4.6). Field names mirror
 * db/migrations/20261003000300_challenges.sql. Dates are competition dates ("2026-10-01").
 */
export const challengeMetricSchema = z.enum(['active_days', 'capped_score']);
export type ChallengeMetric = z.infer<typeof challengeMetricSchema>;
export const challengeScopeSchema = z.enum(['global', 'league', 'club']);
export type ChallengeScope = z.infer<typeof challengeScopeSchema>;
/** Upcoming until the 1st, open through the last day, closing for a day while late runs arrive, then final. */
export const challengeStateSchema = z.enum(['upcoming', 'open', 'closing', 'final']);
export type ChallengeState = z.infer<typeof challengeStateSchema>;

const boardRow = z.object({
  position: z.number(),
  rank: z.number(),
  alias: z.string().nullable(),
  tier: z.string().nullable(),
  progress: z.number(),
  completed: z.boolean(),
  completed_on: z.string().nullable(),
  is_me: z.boolean(),
  hidden: z.boolean(),
});
export type ChallengeBoardRow = z.infer<typeof boardRow>;

export const challengeSchema = z.object({
  id: z.string(),
  scope: challengeScopeSchema,
  league_id: z.string().nullable(),
  club_id: z.string().nullable(),
  group_name: z.string().nullable(),
  metric: challengeMetricSchema,
  target: z.number(),
  title: z.string(),
  custom_title: z.boolean(),
  starts_on: z.string(),
  ends_on: z.string(),
  state: challengeStateSchema,
  joined: z.boolean(),
  participants: z.number(),
  /** The viewer's own days or points, joined or not. */
  progress: z.number(),
  completed: z.boolean(),
  completed_on: z.string().nullable(),
  can_manage: z.boolean(),
  is_creator: z.boolean(),
  created_by: z.string().nullable(),
  /** Leagues' and clubs' challenges, from get_challenge only. */
  board: z.object({ rows: z.array(boardRow), me: boardRow.nullable(), finished: z.number() }).nullable().optional(),
});
export type Challenge = z.infer<typeof challengeSchema>;

export const challengeListSchema = z.object({ current: z.array(challengeSchema), past: z.array(challengeSchema) });
export type ChallengeList = z.infer<typeof challengeListSchema>;

export const challengeLeftSchema = z.object({ left: z.boolean(), challenge_id: z.string() });
export const challengeRemovedSchema = z.object({ removed: z.boolean() });

/** A finished challenge on the Badges screen. */
export const challengeBadgeSchema = z.object({
  challenge_id: z.string(),
  title: z.string(),
  scope: challengeScopeSchema,
  group_name: z.string().nullable(),
  metric: challengeMetricSchema,
  target: z.number(),
  starts_on: z.string(),
  ends_on: z.string(),
  earned_on: z.string(),
});
export type ChallengeBadge = z.infer<typeof challengeBadgeSchema>;
