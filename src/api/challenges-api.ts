import {
  challengeLeftSchema,
  challengeListSchema,
  challengeRemovedSchema,
  challengeSchema,
  type Challenge,
  type ChallengeList,
  type ChallengeMetric,
} from './challenge-schemas';
import type { GroupTarget } from './leagues-api';
import type { Call } from './social-api';

export interface ChallengeInput {
  metric: ChallengeMetric;
  target: number;
  /** 0 for this month, 1 for next month. */
  monthOffset: 0 | 1;
  /** A name the group chose; null for one made from the goal and the month. */
  title: string | null;
}

/** Challenges (docs/ROADMAP.md 4.6). */
export interface ChallengesApi {
  listChallenges(): Promise<ChallengeList>;
  getChallenge(challengeId: string): Promise<Challenge>;
  joinChallenge(challengeId: string): Promise<Challenge>;
  leaveChallenge(challengeId: string): Promise<void>;
  /** A league's owner or a club's admins set one for their group. */
  createChallenge(target: GroupTarget, input: ChallengeInput): Promise<Challenge>;
  removeChallenge(challengeId: string): Promise<void>;
}

export function challengesApi(call: Call): ChallengesApi {
  return {
    listChallenges: () => call('list_challenges', {}, challengeListSchema),
    getChallenge: (challengeId) => call('get_challenge', { p_challenge_id: challengeId }, challengeSchema),
    joinChallenge: (challengeId) => call('join_challenge', { p_challenge_id: challengeId }, challengeSchema),
    leaveChallenge: async (challengeId) => {
      await call('leave_challenge', { p_challenge_id: challengeId }, challengeLeftSchema);
    },
    createChallenge: (target, input) =>
      call(
        'create_challenge',
        {
          p_metric: input.metric,
          p_target: input.target,
          p_month_offset: input.monthOffset,
          p_title: input.title,
          p_league_id: 'leagueId' in target ? target.leagueId : null,
          p_club_id: 'clubId' in target ? target.clubId : null,
        },
        challengeSchema,
      ),
    removeChallenge: async (challengeId) => {
      await call('remove_challenge', { p_challenge_id: challengeId }, challengeRemovedSchema);
    },
  };
}
