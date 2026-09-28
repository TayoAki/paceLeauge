import { z } from 'zod';

/**
 * Runtime schemas for Leagues 2.0 (docs/ROADMAP.md 4.1): seasons, duels, the weekly recap and
 * group runs. Field names mirror db/migrations/20261003000100_leagues2.sql.
 */
const weekState = z.enum(['in_progress', 'settling', 'final']);

export const seasonStandingSchema = z.object({
  member_id: z.string(),
  rank: z.number(),
  alias: z.string().nullable(),
  tier: z.string().nullable(),
  season_xp: z.number(),
  is_me: z.boolean(),
  hidden: z.boolean(),
});

export const leagueSeasonSchema = z.object({
  league_id: z.string(),
  number: z.number(),
  starts_on: z.string(),
  ends_on: z.string(),
  /** Which of the season's four weeks this is. */
  week: z.number(),
  ends_at_ms: z.number(),
  standings: z.array(seasonStandingSchema),
  champions: z.array(
    z.object({ season_start: z.string(), number: z.number(), alias: z.string().nullable(), season_xp: z.number(), is_me: z.boolean() }),
  ),
});
export type LeagueSeason = z.infer<typeof leagueSeasonSchema>;

export const duelSchema = z.object({
  id: z.string(),
  status: z.enum(['pending', 'accepted']),
  i_challenged: z.boolean(),
  opponent: z.object({ member_id: z.string(), alias: z.string().nullable(), tier: z.string().nullable(), weekly_xp: z.number() }),
  my_xp: z.number(),
  state: weekState,
  result: z.enum(['won', 'lost', 'tied']).nullable(),
});
export type Duel = z.infer<typeof duelSchema>;
export const duelsSchema = z.array(duelSchema);

export const weekRecapSchema = z.object({
  league_id: z.string(),
  week_start: z.string(),
  state: weekState,
  league: z.object({
    members: z.number(),
    runs: z.number(),
    distance_m: z.number(),
    active_runners: z.number(),
    top: z.object({ alias: z.string().nullable(), weekly_xp: z.number() }).nullable(),
  }),
  me: z.object({
    runs: z.number(),
    distance_m: z.number(),
    weekly_xp: z.number(),
    rank: z.number().nullable(),
    cheers: z.number(),
    duels: z.object({ won: z.number(), lost: z.number(), tied: z.number(), open: z.number() }),
  }),
});
export type WeekRecap = z.infer<typeof weekRecapSchema>;

export const rsvpSchema = z.enum(['going', 'maybe', 'not_going']);
export type Rsvp = z.infer<typeof rsvpSchema>;

export const groupRunSchema = z.object({
  id: z.string(),
  league_id: z.string().nullable(),
  title: z.string(),
  starts_at_ms: z.number(),
  meeting_point: z.string(),
  notes: z.string().nullable(),
  host: z.string().nullable(),
  is_host: z.boolean(),
  can_edit: z.boolean(),
  cancelled: z.boolean(),
  my_rsvp: rsvpSchema.nullable(),
  going: z.array(z.string()),
  going_count: z.number(),
  maybe_count: z.number(),
});
export type GroupRun = z.infer<typeof groupRunSchema>;
export const groupRunsSchema = z.array(groupRunSchema);
