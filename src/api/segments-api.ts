import { z } from 'zod';

import type { Call } from './social-api';

/**
 * Segments (docs/ROADMAP.md 5.3): curated stretches of path with boards for runners who join.
 * Field names mirror db/migrations/20261004000200_segments.sql.
 */
const pointSchema = z.tuple([z.number(), z.number()]);
const latLonSchema = z.object({ lat: z.number(), lon: z.number() });

export const SEGMENT_SURFACES = ['path', 'trail', 'track', 'park'] as const;
export type SegmentSurface = (typeof SEGMENT_SURFACES)[number];

/** Whoever ran it on the most different days in the last 90. */
const legendSchema = z.object({ alias: z.string(), days: z.number(), is_me: z.boolean() });
export type SegmentLegend = z.infer<typeof legendSchema>;

const segmentBase = {
  id: z.string(),
  name: z.string(),
  surface: z.enum(SEGMENT_SURFACES),
  distance_m: z.number(),
  start: latLonSchema,
  end: latLonSchema,
  /** Runners with a time on the board. */
  runners: z.number(),
  my_best_ms: z.number().nullable(),
  legend: legendSchema.nullable(),
};

export const segmentSummarySchema = z.object({ ...segmentBase, preview: z.array(pointSchema).nullable().default([]) });
export type SegmentSummary = z.infer<typeof segmentSummarySchema>;

const boardRowSchema = z.object({
  place: z.number(),
  alias: z.string(),
  elapsed_ms: z.number(),
  run_at_ms: z.number(),
  effort_id: z.string(),
  is_me: z.boolean(),
});
export type SegmentBoardRow = z.infer<typeof boardRowSchema>;

const myEffortSchema = z.object({
  effort_id: z.string(),
  elapsed_ms: z.number(),
  run_at_ms: z.number(),
  /** held: faster than a runner could go, waiting for a moderator. */
  status: z.enum(['counted', 'held']),
});
export type SegmentEffort = z.infer<typeof myEffortSchema>;

export const segmentSchema = z.object({
  ...segmentBase,
  points: z.array(pointSchema),
  board: z.array(boardRowSchema),
  my_efforts: z.array(myEffortSchema),
  /** Different days the runner ran it in the last 90. */
  my_days: z.number(),
  joined: z.boolean().default(false),
});
export type Segment = z.infer<typeof segmentSchema>;

export const segmentListSchema = z.object({
  joined: z.boolean(),
  /** A moderator took the runner off the boards. */
  banned: z.boolean(),
  segments: z.array(segmentSummarySchema),
});
export type SegmentList = z.infer<typeof segmentListSchema>;

export const runSegmentSchema = z.object({
  effort_id: z.string(),
  segment_id: z.string(),
  name: z.string(),
  distance_m: z.number(),
  elapsed_ms: z.number(),
  started_at_ms: z.number(),
  status: z.enum(['counted', 'held']),
  is_best: z.boolean(),
});
export type RunSegment = z.infer<typeof runSegmentSchema>;

export interface SegmentsApi {
  listSegments(): Promise<SegmentList>;
  getSegment(segmentId: string): Promise<Segment>;
  /** Puts the runner (and their recent runs shared with everyone) on the boards. */
  joinSegments(): Promise<{ joined: boolean; queued: number }>;
  /** Takes every one of the runner's times off the boards. */
  leaveSegments(): Promise<void>;
  getRunSegments(runId: string): Promise<RunSegment[]>;
  /** Staff: a segment from one of their own saved routes. */
  modCreateSegment(routeId: string, name: string, surface: SegmentSurface): Promise<Segment>;
  modRetireSegment(segmentId: string, reason: string): Promise<void>;
}

export function segmentsApi(call: Call): SegmentsApi {
  return {
    listSegments: () => call('list_segments', {}, segmentListSchema),
    getSegment: (segmentId) => call('get_segment', { p_segment_id: segmentId }, segmentSchema),
    joinSegments: () => call('join_segments', {}, z.object({ joined: z.boolean(), queued: z.number() })),
    leaveSegments: async () => {
      await call('leave_segments', {}, z.object({ joined: z.boolean() }));
    },
    getRunSegments: (runId) => call('get_run_segments', { p_run_id: runId }, z.array(runSegmentSchema)),
    modCreateSegment: (routeId, name, surface) =>
      call('mod_create_segment', { p_route_id: routeId, p_name: name, p_surface: surface }, segmentSchema),
    modRetireSegment: async (segmentId, reason) => {
      await call('mod_retire_segment', { p_segment_id: segmentId, p_reason: reason }, z.object({ retired: z.boolean() }));
    },
  };
}
