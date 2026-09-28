import { z } from 'zod';

import { runnerCardSchema, sharedRunSchema } from './social-schemas';

/**
 * Runtime schemas for the feed, kudos, comments, reports, notification settings and the staff
 * moderation queue (docs/ROADMAP.md 4.4 and 4.9). Field names mirror
 * db/migrations/20261002000200_feed.sql.
 */
export const feedItemSchema = sharedRunSchema.extend({ kudos: z.number(), kudoed: z.boolean(), comments: z.number() });
export type FeedItem = z.infer<typeof feedItemSchema>;

export const feedCursorSchema = z.object({ before_ms: z.number(), before_id: z.string() });
export type FeedCursor = z.infer<typeof feedCursorSchema>;

export const feedPageSchema = z.object({ items: z.array(feedItemSchema), next: feedCursorSchema.nullable() });
export type FeedPage = z.infer<typeof feedPageSchema>;

export const kudosResultSchema = z.object({ run_id: z.string(), kudos: z.number(), kudoed: z.boolean() });
export type KudosResult = z.infer<typeof kudosResultSchema>;

export const kudosListSchema = z.array(runnerCardSchema.extend({ is_me: z.boolean() }));
export type KudosEntry = z.infer<typeof kudosListSchema>[number];

const commentFields = z.object({
  id: z.string(),
  /** Null for a removed comment kept as a placeholder for its replies. */
  author: runnerCardSchema.nullable(),
  body: z.string().nullable(),
  created_at_ms: z.number(),
  is_mine: z.boolean(),
  can_delete: z.boolean(),
  removed: z.boolean(),
});
export const commentSchema = commentFields.extend({ replies: z.array(commentFields) });
export type Comment = z.infer<typeof commentSchema>;
export type Reply = z.infer<typeof commentFields>;
export const commentsSchema = z.array(commentSchema);

export const contentReportReasonSchema = z.enum(['harassment', 'offensive_content', 'spam', 'impersonation', 'cheating', 'private_info', 'offensive_name', 'other']);
export type ContentReportReason = z.infer<typeof contentReportReasonSchema>;
export type ReportKind = 'runner' | 'run' | 'comment' | 'club' | 'group_run' | 'challenge';

export const contentReportResultSchema = z.object({ report_id: z.string(), status: z.string(), due_at_ms: z.number() });
export type ContentReportResult = z.infer<typeof contentReportResultSchema>;

export const notificationKinds = ['kudos', 'comments', 'follows', 'cheers', 'results', 'league'] as const;
export type NotificationKind = (typeof notificationKinds)[number];

export const notificationPrefsSchema = z.object({
  kudos: z.boolean(),
  comments: z.boolean(),
  follows: z.boolean(),
  cheers: z.boolean(),
  results: z.boolean(),
  /** Duels, group runs and season champions (docs/ROADMAP.md 4.1). */
  league: z.boolean().default(true),
});
export type NotificationPrefs = z.infer<typeof notificationPrefsSchema>;

export const notificationSettingsSchema = z.object({ available: z.boolean(), prefs: notificationPrefsSchema, devices: z.number() });
export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;

export const modActionSchema = z.enum([
  'dismiss',
  'reset_alias',
  'remove_from_league',
  'rename_league',
  'hide_run',
  'remove_comment',
  'reset_club',
  'close_club',
  'remove_group_run',
  'reset_challenge_name',
  'remove_challenge',
]);
export type ModAction = z.infer<typeof modActionSchema>;

export const modReportSchema = z.object({
  report_id: z.string(),
  target_kind: z.enum(['member', 'league', 'runner', 'run', 'comment', 'club', 'group_run', 'challenge']),
  reason_code: z.string(),
  content_snapshot: z.record(z.string(), z.unknown()),
  status: z.enum(['open', 'actioned', 'dismissed']),
  created_at_ms: z.number(),
  due_at_ms: z.number(),
  overdue: z.boolean(),
  resolution: z.string().nullable(),
  resolved_at_ms: z.number().nullable(),
  open_on_target: z.number(),
  target_state: z.record(z.string(), z.unknown()),
  actions: z.array(modActionSchema),
});
export type ModReport = z.infer<typeof modReportSchema>;

export const modResolutionSchema = z.object({
  report_id: z.string(),
  status: z.enum(['actioned', 'dismissed']),
  also_resolved: z.number(),
  within_target: z.boolean(),
});
export type ModResolution = z.infer<typeof modResolutionSchema>;

export const modQueueHealthSchema = z.object({
  response_target_hours: z.number(),
  open: z.number(),
  overdue: z.number(),
  next_due_at_ms: z.number().nullable(),
  resolved_7d: z.number(),
  resolved_within_target_7d: z.number(),
  held_comments: z.number(),
});
export type ModQueueHealth = z.infer<typeof modQueueHealthSchema>;

export const pushTokenRemovedSchema = z.object({ removed: z.boolean() });
