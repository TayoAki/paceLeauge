import type { Leaderboard, LeaderboardStatus } from '@/api/leaderboard-schemas';
import { dayLabel } from '@/features/challenges/challenge-text';

import { knownCountry } from './countries';

/**
 * Words for the leaderboards (docs/ROADMAP.md 4.7). The server decides who's on a board and
 * when it's final; this file only says it.
 */

/** When a board's results count: provisional during the week and its review window, then final. */
export function boardStateLine(board: Pick<Leaderboard, 'state' | 'final_at_ms'>, timeZone?: string): string {
  if (board.state === 'final') return 'Final results.';
  const when = new Date(board.final_at_ms).toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  });
  return board.state === 'in_progress'
    ? `This week so far. Provisional until ${when}, after checks.`
    : `Provisional until ${when}, while results are checked.`;
}

/** Why the runner isn't on this week's boards yet, if they aren't. */
export function eligibilityLine(status: Pick<LeaderboardStatus, 'joined' | 'eligible' | 'eligible_from'>): string | null {
  if (!status.joined || status.eligible) return null;
  if (!status.eligible_from) return 'You’ll show up on the boards once you have two weeks of runs. New accounts wait two weeks.';
  return `You’ll show up from the week of ${dayLabel(status.eligible_from)}, after two weeks of runs.`;
}

/** The invitation, at a natural moment. */
export function inviteCopy(invite: NonNullable<LeaderboardStatus['invite']>, tier: string): { title: string; body: string } {
  const body = `See how your week compares with other ${tier} runners and your country. Only your runner name, tier and weekly score are shown, never a route. You can leave any time.`;
  return invite === 'won_league' ? { title: 'You won your league’s week', body } : { title: 'Try the leaderboards', body };
}

/** The phone's region if the server knows it, otherwise the United States (the beta's country). */
export function defaultCountry(regionCode: string | null | undefined): string {
  return knownCountry(regionCode) ?? 'US';
}

/** The runner's own result, when it isn't on the board. */
export function myStatusLine(status: Leaderboard['my_status']): string | null {
  if (status === 'held') return 'Your result is being checked. It shows up once a person has looked at it.';
  if (status === 'removed') return 'Your result for this week was taken off the board after a review.';
  return null;
}
