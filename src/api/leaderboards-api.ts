import { leaderboardSchema, leaderboardStatusSchema, type Leaderboard, type LeaderboardKind, type LeaderboardStatus } from './leaderboard-schemas';
import type { Call } from './social-api';

/** Opt-in global and regional leaderboards (docs/ROADMAP.md 4.7). */
export interface LeaderboardsApi {
  getLeaderboardStatus(): Promise<LeaderboardStatus>;
  joinLeaderboards(country: string): Promise<LeaderboardStatus>;
  leaveLeaderboards(): Promise<LeaderboardStatus>;
  dismissLeaderboardInvite(): Promise<LeaderboardStatus>;
  /** A tier or country board; the runner's own when `key` is null. */
  getLeaderboard(board: LeaderboardKind, key: string | null, weekOffset: number): Promise<Leaderboard>;
}

export function leaderboardsApi(call: Call): LeaderboardsApi {
  return {
    getLeaderboardStatus: () => call('get_leaderboard_status', {}, leaderboardStatusSchema),
    joinLeaderboards: (country) => call('join_leaderboards', { p_country: country }, leaderboardStatusSchema),
    leaveLeaderboards: () => call('leave_leaderboards', {}, leaderboardStatusSchema),
    dismissLeaderboardInvite: () => call('dismiss_leaderboard_invite', {}, leaderboardStatusSchema),
    getLeaderboard: (board, key, weekOffset) => call('get_leaderboard', { p_board: board, p_key: key, p_week_offset: weekOffset }, leaderboardSchema),
  };
}
