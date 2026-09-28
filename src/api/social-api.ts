import type { z } from 'zod';

import { feedItemSchema, type FeedItem } from './feed-schemas';
import {
  blockedResultSchema,
  followCodeSchema,
  followingResultSchema,
  followListSchema,
  followStateSchema,
  runnerProfileSchema,
  runnerWithFollowSchema,
  sharedRunSchema,
  socialSettingsSchema,
  type FollowListEntry,
  type FollowState,
  type RunnerProfile,
  type RunnerWithFollow,
  type SharedRun,
  type SocialSettings,
  type Visibility,
} from './social-schemas';

/** Validates a call's result; the same helper the rest of the API client uses. */
export type Call = <S extends z.ZodType>(fn: string, args: Record<string, unknown>, schema: S) => Promise<z.infer<S>>;

export interface SocialSettingsInput {
  defaultVisibility?: Visibility;
  defaultMapShared?: boolean;
  followApproval?: boolean;
  discoverable?: boolean;
}

export interface PrivacyZoneInput {
  id?: string | null;
  label: string;
  lat: number;
  lon: number;
  radiusM: number;
}

export type FollowListKind = 'followers' | 'following' | 'requests' | 'muted';

/** Privacy zones, run sharing and follows (docs/ROADMAP.md 4.2 and 4.3). */
export interface SocialApi {
  getSocialSettings(): Promise<SocialSettings>;
  setSocialSettings(input: SocialSettingsInput): Promise<SocialSettings>;
  savePrivacyZone(zone: PrivacyZoneInput): Promise<SocialSettings>;
  deletePrivacyZone(zoneId: string): Promise<SocialSettings>;
  setRunSharing(runId: string, visibility: Visibility, mapShared: boolean): Promise<SharedRun>;
  /** The run with its kudos and comment counts. */
  getSharedRun(runId: string): Promise<FeedItem>;
  followRunner(publicId: string): Promise<RunnerWithFollow>;
  getFollowCode(rotate?: boolean): Promise<string>;
  getFollowLink(code: string): Promise<RunnerWithFollow>;
  followByCode(code: string): Promise<RunnerWithFollow>;
  respondFollow(publicId: string, accept: boolean): Promise<RunnerWithFollow>;
  unfollow(publicId: string): Promise<void>;
  removeFollower(publicId: string): Promise<void>;
  listFollows(kind: FollowListKind): Promise<FollowListEntry[]>;
  searchRunners(query: string): Promise<RunnerWithFollow[]>;
  getRunnerProfile(publicId: string): Promise<RunnerProfile>;
  muteRunner(publicId: string, muted: boolean): Promise<FollowState>;
  blockRunner(publicId: string): Promise<void>;
}

export function socialApi(call: Call): SocialApi {
  return {
    getSocialSettings: () => call('get_social_settings', {}, socialSettingsSchema),
    setSocialSettings: (input) =>
      call(
        'set_social_settings',
        {
          p_default_visibility: input.defaultVisibility ?? null,
          p_default_map_shared: input.defaultMapShared ?? null,
          p_follow_approval: input.followApproval ?? null,
          p_discoverable: input.discoverable ?? null,
        },
        socialSettingsSchema,
      ),
    savePrivacyZone: (zone) =>
      call('save_privacy_zone', { p_zone_id: zone.id ?? null, p_label: zone.label, p_lat: zone.lat, p_lon: zone.lon, p_radius_m: zone.radiusM }, socialSettingsSchema),
    deletePrivacyZone: (zoneId) => call('delete_privacy_zone', { p_zone_id: zoneId }, socialSettingsSchema),
    setRunSharing: (runId, visibility, mapShared) =>
      call('set_run_sharing', { p_run_id: runId, p_visibility: visibility, p_map_shared: mapShared }, sharedRunSchema),
    getSharedRun: (runId) => call('get_shared_run', { p_run_id: runId }, feedItemSchema),
    followRunner: (publicId) => call('follow_runner', { p_public_id: publicId }, runnerWithFollowSchema),
    getFollowCode: async (rotate = false) => (await call('get_follow_code', { p_rotate: rotate }, followCodeSchema)).code,
    getFollowLink: (code) => call('get_follow_link', { p_code: code }, runnerWithFollowSchema),
    followByCode: (code) => call('follow_by_code', { p_code: code }, runnerWithFollowSchema),
    respondFollow: (publicId, accept) => call('respond_follow', { p_public_id: publicId, p_accept: accept }, runnerWithFollowSchema),
    unfollow: async (publicId) => {
      await call('unfollow', { p_public_id: publicId }, followingResultSchema);
    },
    removeFollower: async (publicId) => {
      await call('remove_follower', { p_public_id: publicId }, followingResultSchema);
    },
    listFollows: (kind) => call('list_follows', { p_kind: kind }, followListSchema),
    searchRunners: (query) => call('search_runners', { p_query: query }, runnerWithFollowSchema.array()),
    getRunnerProfile: (publicId) => call('get_runner_profile', { p_public_id: publicId }, runnerProfileSchema),
    muteRunner: (publicId, muted) => call('mute_runner', { p_public_id: publicId, p_muted: muted }, followStateSchema),
    blockRunner: async (publicId) => {
      await call('block_runner', { p_public_id: publicId }, blockedResultSchema);
    },
  };
}
