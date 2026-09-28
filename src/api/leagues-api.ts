import {
  duelsSchema,
  groupRunSchema,
  groupRunsSchema,
  leagueSeasonSchema,
  weekRecapSchema,
  type Duel,
  type GroupRun,
  type LeagueSeason,
  type Rsvp,
  type WeekRecap,
} from './league-schemas';
import { leagueViewSchema, type LeagueView } from './schemas';
import type { Call } from './social-api';

/** Where a group run belongs: a league or a club (docs/ROADMAP.md 4.1 and 4.5). */
export type GroupTarget = { leagueId: string } | { clubId: string };

const targetArgs = (target: GroupTarget) =>
  'clubId' in target ? { p_league_id: null, p_club_id: target.clubId } : { p_league_id: target.leagueId, p_club_id: null };

export interface GroupRunInput {
  title: string;
  startsAtMs: number;
  meetingPoint: string;
  notes?: string | null;
}

/** Leagues 2.0 (docs/ROADMAP.md 4.1): seasons, duels, recaps, group runs and the chat link. */
export interface LeaguesApi {
  setLeagueChatLink(url: string | null, leagueId: string): Promise<LeagueView>;
  getLeagueSeason(leagueId: string): Promise<LeagueSeason>;
  listDuels(leagueId: string, weekOffset?: 0 | -1): Promise<Duel[]>;
  challengeDuel(memberId: string): Promise<Duel[]>;
  respondDuel(duelId: string, accept: boolean): Promise<Duel[]>;
  cancelDuel(duelId: string): Promise<Duel[]>;
  getWeekRecap(leagueId: string, weekOffset?: 0 | -1): Promise<WeekRecap>;
  listGroupRuns(target: GroupTarget): Promise<GroupRun[]>;
  createGroupRun(target: GroupTarget, input: GroupRunInput): Promise<GroupRun>;
  updateGroupRun(groupRunId: string, input: GroupRunInput): Promise<GroupRun>;
  cancelGroupRun(groupRunId: string): Promise<GroupRun>;
  rsvpGroupRun(groupRunId: string, status: Rsvp): Promise<GroupRun>;
}

export function leaguesApi(call: Call): LeaguesApi {
  return {
    setLeagueChatLink: (url, leagueId) => call('set_league_chat_link', { p_url: url ?? '', p_league_id: leagueId }, leagueViewSchema),
    getLeagueSeason: (leagueId) => call('get_league_season', { p_league_id: leagueId }, leagueSeasonSchema),
    listDuels: (leagueId, weekOffset = 0) => call('list_duels', { p_league_id: leagueId, p_week_offset: weekOffset }, duelsSchema),
    challengeDuel: (memberId) => call('challenge_duel', { p_member_id: memberId }, duelsSchema),
    respondDuel: (duelId, accept) => call('respond_duel', { p_duel_id: duelId, p_accept: accept }, duelsSchema),
    cancelDuel: (duelId) => call('cancel_duel', { p_duel_id: duelId }, duelsSchema),
    getWeekRecap: (leagueId, weekOffset = 0) => call('get_week_recap', { p_league_id: leagueId, p_week_offset: weekOffset }, weekRecapSchema),
    listGroupRuns: (target) => call('list_group_runs', targetArgs(target), groupRunsSchema),
    createGroupRun: (target, input) =>
      call(
        'create_group_run',
        { p_title: input.title, p_starts_at_ms: input.startsAtMs, p_meeting_point: input.meetingPoint, p_notes: input.notes ?? null, ...targetArgs(target) },
        groupRunSchema,
      ),
    updateGroupRun: (groupRunId, input) =>
      call(
        'update_group_run',
        { p_group_run_id: groupRunId, p_title: input.title, p_starts_at_ms: input.startsAtMs, p_meeting_point: input.meetingPoint, p_notes: input.notes ?? null },
        groupRunSchema,
      ),
    cancelGroupRun: (groupRunId) => call('cancel_group_run', { p_group_run_id: groupRunId }, groupRunSchema),
    rsvpGroupRun: (groupRunId, status) => call('rsvp_group_run', { p_group_run_id: groupRunId, p_status: status }, groupRunSchema),
  };
}
