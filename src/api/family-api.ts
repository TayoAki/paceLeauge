import { z } from 'zod';

import type { Call } from './social-api';

/**
 * Teen accounts in family leagues (docs/ROADMAP.md 4.10). Field names mirror
 * db/migrations/20261003000600_teen_accounts.sql.
 */
export const familyRequestSchema = z.object({
  id: z.string(),
  league_id: z.string(),
  league_name: z.string().nullable(),
  alias: z.string().nullable(),
  /** 13_15 or 16_17. */
  band: z.enum(['13_15', '16_17']).nullable(),
  status: z.enum(['pending', 'approved', 'declined', 'cancelled']),
  created_at_ms: z.number(),
  is_mine: z.boolean(),
});
export type FamilyRequest = z.infer<typeof familyRequestSchema>;
export const familyRequestsSchema = z.array(familyRequestSchema);

export const familyTeenSchema = z.object({
  member_id: z.string(),
  alias: z.string(),
  band: z.enum(['13_15', '16_17']),
  joined_at_ms: z.number(),
  consent_at_ms: z.number().nullable(),
  runs_this_week: z.number(),
  last_run_at_ms: z.number().nullable(),
});
export type FamilyTeen = z.infer<typeof familyTeenSchema>;
export const familyTeensSchema = z.array(familyTeenSchema);

export interface FamilyApi {
  /** A teen asks to join the family league behind an invite code. */
  requestFamilyJoin(code: string): Promise<FamilyRequest>;
  listMyFamilyRequests(): Promise<FamilyRequest[]>;
  cancelFamilyRequest(requestId: string): Promise<FamilyRequest[]>;
  /** The adult who runs a family league: teens waiting to join. */
  listFamilyRequests(leagueId: string | null): Promise<FamilyRequest[]>;
  /** Approving is the parent's or guardian's consent. */
  decideFamilyRequest(requestId: string, approve: boolean): Promise<FamilyRequest[]>;
  listFamilyTeens(leagueId: string): Promise<FamilyTeen[]>;
}

export function familyApi(call: Call): FamilyApi {
  return {
    requestFamilyJoin: (code) => call('request_family_join', { p_code: code }, familyRequestSchema),
    listMyFamilyRequests: () => call('list_my_family_requests', {}, familyRequestsSchema),
    cancelFamilyRequest: (requestId) => call('cancel_family_request', { p_request_id: requestId }, familyRequestsSchema),
    listFamilyRequests: (leagueId) => call('list_family_requests', { p_league_id: leagueId }, familyRequestsSchema),
    decideFamilyRequest: (requestId, approve) => call('decide_family_request', { p_request_id: requestId, p_approve: approve }, familyRequestsSchema),
    listFamilyTeens: (leagueId) => call('list_family_teens', { p_league_id: leagueId }, familyTeensSchema),
  };
}
