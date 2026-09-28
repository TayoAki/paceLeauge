import {
  clubBoardSchema,
  clubInviteSchema,
  clubLeftSchema,
  clubMembersSchema,
  clubSchema,
  clubsSchema,
  groupRunRemovedSchema,
  type Club,
  type ClubBoard,
  type ClubMember,
  type ClubVisibility,
} from './club-schemas';
import type { Call } from './social-api';

export interface ClubInput {
  name: string;
  description: string | null;
  visibility: ClubVisibility;
}

/** Clubs (docs/ROADMAP.md 4.5). */
export interface ClubsApi {
  listMyClubs(): Promise<Club[]>;
  searchClubs(query: string): Promise<Club[]>;
  getClub(clubId: string): Promise<Club>;
  createClub(input: ClubInput): Promise<Club>;
  updateClub(clubId: string, input: ClubInput): Promise<Club>;
  setClubChatLink(clubId: string, url: string | null): Promise<Club>;
  joinClub(clubId: string): Promise<Club>;
  joinClubByCode(code: string): Promise<Club>;
  createClubInvite(clubId: string): Promise<{ code: string; expires_at_ms: number }>;
  leaveClub(clubId: string): Promise<void>;
  listClubMembers(clubId: string): Promise<ClubMember[]>;
  promoteClubAdmin(clubId: string, memberId: string): Promise<ClubMember[]>;
  demoteClubAdmin(clubId: string, memberId: string): Promise<ClubMember[]>;
  transferClubOwnership(clubId: string, memberId: string): Promise<ClubMember[]>;
  removeClubMember(clubId: string, memberId: string): Promise<ClubMember[]>;
  getClubBoard(clubId: string, weekOffset?: 0 | -1): Promise<ClubBoard>;
  /** Takes down a group run (its host, a club admin or the league's owner). */
  removeGroupRun(groupRunId: string): Promise<void>;
}

export function clubsApi(call: Call): ClubsApi {
  return {
    listMyClubs: () => call('list_my_clubs', {}, clubsSchema),
    searchClubs: (query) => call('search_clubs', { p_query: query }, clubsSchema),
    getClub: (clubId) => call('get_club', { p_club_id: clubId }, clubSchema),
    createClub: (input) => call('create_club', { p_name: input.name, p_description: input.description, p_visibility: input.visibility }, clubSchema),
    updateClub: (clubId, input) =>
      call('update_club', { p_club_id: clubId, p_name: input.name, p_description: input.description, p_visibility: input.visibility }, clubSchema),
    setClubChatLink: (clubId, url) => call('set_club_chat_link', { p_club_id: clubId, p_url: url ?? '' }, clubSchema),
    joinClub: (clubId) => call('join_club', { p_club_id: clubId }, clubSchema),
    joinClubByCode: (code) => call('join_club_by_code', { p_code: code }, clubSchema),
    createClubInvite: (clubId) => call('create_club_invite', { p_club_id: clubId }, clubInviteSchema),
    leaveClub: async (clubId) => {
      await call('leave_club', { p_club_id: clubId }, clubLeftSchema);
    },
    listClubMembers: (clubId) => call('list_club_members', { p_club_id: clubId }, clubMembersSchema),
    promoteClubAdmin: (clubId, memberId) => call('promote_club_admin', { p_club_id: clubId, p_member_id: memberId }, clubMembersSchema),
    demoteClubAdmin: (clubId, memberId) => call('demote_club_admin', { p_club_id: clubId, p_member_id: memberId }, clubMembersSchema),
    transferClubOwnership: (clubId, memberId) => call('transfer_club_ownership', { p_club_id: clubId, p_member_id: memberId }, clubMembersSchema),
    removeClubMember: (clubId, memberId) => call('remove_club_member', { p_club_id: clubId, p_member_id: memberId }, clubMembersSchema),
    getClubBoard: (clubId, weekOffset = 0) => call('get_club_board', { p_club_id: clubId, p_week_offset: weekOffset }, clubBoardSchema),
    removeGroupRun: async (groupRunId) => {
      await call('remove_group_run', { p_group_run_id: groupRunId }, groupRunRemovedSchema);
    },
  };
}
