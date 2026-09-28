import {
  commentsSchema,
  contentReportResultSchema,
  feedPageSchema,
  kudosListSchema,
  kudosResultSchema,
  modQueueHealthSchema,
  modReportSchema,
  modResolutionSchema,
  notificationSettingsSchema,
  pushTokenRemovedSchema,
  type Comment,
  type ContentReportReason,
  type ContentReportResult,
  type FeedCursor,
  type FeedPage,
  type KudosEntry,
  type KudosResult,
  type ModAction,
  type ModQueueHealth,
  type ModReport,
  type ModResolution,
  type NotificationPrefs,
  type NotificationSettings,
  type ReportKind,
} from './feed-schemas';
import type { Call } from './social-api';

/** The feed, kudos, comments, reports, pushes and moderation (docs/ROADMAP.md 4.4 and 4.9). */
export interface FeedApi {
  getFeed(before: FeedCursor | null, limit?: number): Promise<FeedPage>;
  setKudos(runId: string, on: boolean): Promise<KudosResult>;
  listKudos(runId: string): Promise<KudosEntry[]>;
  listComments(runId: string): Promise<Comment[]>;
  /** Returns the run's threads after the comment is added. */
  addComment(runId: string, body: string, parentId?: string | null): Promise<Comment[]>;
  deleteComment(commentId: string): Promise<Comment[]>;
  /** A runner by public id, a run or a comment by id. */
  reportContent(kind: ReportKind, id: string, reason: ContentReportReason): Promise<ContentReportResult>;
  getNotificationSettings(): Promise<NotificationSettings>;
  setNotificationPrefs(prefs: Partial<NotificationPrefs>): Promise<NotificationSettings>;
  registerPushToken(token: string, platform: 'ios' | 'android'): Promise<NotificationSettings>;
  unregisterPushToken(token: string): Promise<boolean>;
  modListReports(status?: 'open' | 'actioned' | 'dismissed'): Promise<ModReport[]>;
  modResolveReport(reportId: string, action: ModAction, reason: string): Promise<ModResolution>;
  modQueueHealth(): Promise<ModQueueHealth>;
}

export function feedApi(call: Call): FeedApi {
  return {
    getFeed: (before, limit = 20) =>
      call('get_feed', { p_before_ms: before?.before_ms ?? null, p_before_id: before?.before_id ?? null, p_limit: limit }, feedPageSchema),
    setKudos: (runId, on) => call('set_kudos', { p_run_id: runId, p_on: on }, kudosResultSchema),
    listKudos: (runId) => call('list_kudos', { p_run_id: runId }, kudosListSchema),
    listComments: (runId) => call('list_comments', { p_run_id: runId }, commentsSchema),
    addComment: (runId, body, parentId = null) => call('add_comment', { p_run_id: runId, p_body: body, p_parent_id: parentId }, commentsSchema),
    deleteComment: (commentId) => call('delete_comment', { p_comment_id: commentId }, commentsSchema),
    reportContent: (kind, id, reason) => call('report_content', { p_kind: kind, p_id: id, p_reason: reason }, contentReportResultSchema),
    getNotificationSettings: () => call('get_notification_settings', {}, notificationSettingsSchema),
    setNotificationPrefs: (prefs) => call('set_notification_prefs', { p_prefs: prefs }, notificationSettingsSchema),
    registerPushToken: (token, platform) => call('register_push_token', { p_token: token, p_platform: platform }, notificationSettingsSchema),
    unregisterPushToken: async (token) => (await call('unregister_push_token', { p_token: token }, pushTokenRemovedSchema)).removed,
    modListReports: (status = 'open') => call('mod_list_reports', { p_status: status, p_limit: 100 }, modReportSchema.array()),
    modResolveReport: (reportId, action, reason) =>
      call('mod_resolve_report', { p_report_id: reportId, p_action: action, p_reason: reason }, modResolutionSchema),
    modQueueHealth: () => call('mod_queue_health', {}, modQueueHealthSchema),
  };
}
