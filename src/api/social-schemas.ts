import { z } from 'zod';

/**
 * Runtime schemas for Phase 4's social RPCs (docs/ROADMAP.md 4.2 and 4.3). Field names mirror
 * db/migrations/20261002000100_social.sql.
 */
export const visibilitySchema = z.enum(['only_me', 'leagues', 'followers', 'everyone']);
export type Visibility = z.infer<typeof visibilitySchema>;

export const runnerCardSchema = z.object({ public_id: z.string(), alias: z.string(), tier: z.string() });
export type RunnerCard = z.infer<typeof runnerCardSchema>;

const followStatus = z.enum(['none', 'pending', 'accepted']);
export const followStateSchema = z.object({ following: followStatus, follows_me: followStatus, muted: z.boolean() });
export type FollowState = z.infer<typeof followStateSchema>;

export const privacyZoneSchema = z.object({ id: z.string(), label: z.string(), lat: z.number(), lon: z.number(), radius_m: z.number() });
export type PrivacyZone = z.infer<typeof privacyZoneSchema>;

export const socialSettingsSchema = z.object({
  public_id: z.string(),
  default_visibility: visibilitySchema,
  default_map_shared: z.boolean(),
  follow_approval: z.boolean(),
  discoverable: z.boolean(),
  zones: z.array(privacyZoneSchema),
});
export type SocialSettings = z.infer<typeof socialSettingsSchema>;

/** A shared map: lines of [lat, lon], already trimmed on the server. */
export const sharedRouteSchema = z.array(z.array(z.tuple([z.number(), z.number()]))).nullable();

export const sharedRunSchema = z.object({
  run_id: z.string(),
  owner: runnerCardSchema,
  is_mine: z.boolean(),
  title: z.string(),
  activity_type: z.enum(['run', 'walk', 'hike', 'ride', 'other']),
  started_at_ms: z.number(),
  distance_m: z.number(),
  active_ms: z.number(),
  visibility: visibilitySchema,
  map_shared: z.boolean(),
  route: sharedRouteSchema,
});
export type SharedRun = z.infer<typeof sharedRunSchema>;

export const runnerWithFollowSchema = runnerCardSchema.extend({ follow: followStateSchema });
export type RunnerWithFollow = z.infer<typeof runnerWithFollowSchema>;

export const runnerProfileSchema = runnerCardSchema.extend({
  is_me: z.boolean(),
  follow: followStateSchema,
  followers: z.number(),
  following: z.number(),
  runs: z.array(sharedRunSchema),
});
export type RunnerProfile = z.infer<typeof runnerProfileSchema>;

export const followListSchema = z.array(runnerCardSchema.extend({ status: z.string(), since_ms: z.number() }));
export type FollowListEntry = z.infer<typeof followListSchema>[number];

export const followCodeSchema = z.object({ code: z.string() });
export const blockedResultSchema = z.object({ blocked: z.boolean() });
export const followingResultSchema = z.object({ following: followStatus }).partial().passthrough();
