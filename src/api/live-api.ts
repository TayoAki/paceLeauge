import { z } from 'zod';

import type { Call } from './social-api';

/**
 * Live location (docs/ROADMAP.md 4.8). Field names mirror
 * db/migrations/20261003000500_live_location.sql.
 */
export const liveShareSchema = z.object({ share_id: z.string(), token: z.string(), expires_at_ms: z.number() });
export type LiveShare = z.infer<typeof liveShareSchema>;

export const livePostSchema = z.object({ live: z.boolean(), expires_at_ms: z.number() });
export const liveEndSchema = z.object({ ended: z.number() });

/** What a link shows: the runner's name and latest position while it's live, and nothing after. */
export const liveLocationSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('ended') }),
  z.object({
    state: z.literal('live'),
    alias: z.string(),
    started_at_ms: z.number(),
    expires_at_ms: z.number(),
    position: z.object({ lat: z.number(), lon: z.number(), accuracy_m: z.number().nullable(), at_ms: z.number() }).nullable(),
    distance_m: z.number().nullable(),
    elapsed_ms: z.number().nullable(),
  }),
]);
export type LiveLocation = z.infer<typeof liveLocationSchema>;

export interface LivePoint {
  lat: number;
  lon: number;
  accuracyM: number | null;
  atMs: number;
  distanceM: number;
  elapsedMs: number;
}

export interface LiveApi {
  /** A link for this run, replacing any other; the code is returned once. */
  startLiveShare(minutes: number): Promise<LiveShare>;
  postLiveLocation(shareId: string, point: LivePoint): Promise<{ live: boolean; expires_at_ms: number }>;
  /** Stops the link now (every open link when no id is given). */
  endLiveShare(shareId: string | null, reason: 'run_ended' | 'stopped'): Promise<void>;
  /** The viewer's side; works without an account. */
  getLiveLocation(token: string): Promise<LiveLocation>;
}

export function liveApi(call: Call): LiveApi {
  return {
    startLiveShare: (minutes) => call('start_live_share', { p_minutes: minutes }, liveShareSchema),
    postLiveLocation: (shareId, p) =>
      call(
        'post_live_location',
        {
          p_share_id: shareId,
          p_lat: p.lat,
          p_lon: p.lon,
          p_accuracy_m: p.accuracyM,
          p_at_ms: Math.round(p.atMs),
          p_distance_m: Math.round(p.distanceM),
          p_elapsed_ms: Math.round(p.elapsedMs),
        },
        livePostSchema,
      ),
    endLiveShare: async (shareId, reason) => {
      await call('end_live_share', { p_share_id: shareId, p_reason: reason }, liveEndSchema);
    },
    getLiveLocation: (token) => call('get_live_location', { p_token: token }, liveLocationSchema),
  };
}
