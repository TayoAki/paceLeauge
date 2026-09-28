import type { Effort, EffortKey, PaceZones, SessionKind } from './plans/types';

/**
 * Coach notes after runs (docs/ROADMAP.md 3.3): a short line in the coach's voice. Each note comes
 * from one rule and one of that rule's templates; there is no generative AI, so every note a
 * runner can see is written below. The wording is a draft for the coach to rewrite and approve.
 */

export type CoachRule =
  | 'first_run'
  | 'record'
  | 'race_done'
  | 'run_walk_done'
  | 'short_of_plan'
  | 'over_plan'
  | 'hard_done'
  | 'long_done'
  | 'easy_too_fast'
  | 'easy_on_pace'
  | 'week_goal'
  | 'negative_split'
  | 'even_pace';

/** Templates per rule. `{effort}` is a record's distance ("5K"). */
export const COACH_TEMPLATES: Record<CoachRule, string[]> = {
  first_run: ['Your first PaceLeague run. The hardest step is the first one, and it’s done.', 'Run one, logged. Come back to it in a month and see how far you’ve come.'],
  record: ['A new best {effort}. That’s the training showing.', 'New {effort} record. Enjoy it, then keep the easy days easy.'],
  race_done: ['Race done. You trained for this and showed up. Recover well this week.', 'That’s the race. Whatever the clock says, well run. Easy days next.'],
  run_walk_done: ['Run/walk done. Each week the runs get a little longer.', 'Another run/walk in the bank. Slow and steady builds the habit.'],
  short_of_plan: ['Shorter than planned, and that’s fine. Some is always better than none.', 'Not the full session today. Listen to your body; the plan carries on.'],
  over_plan: ['Longer than planned. It’s tempting, but the plan works best when you stay close to it.', 'You went past the plan today. Save the extra for another day.'],
  hard_done: ['Session done. Days like this build your speed. Keep tomorrow easy.', 'Hard work done. Recovery is where it turns into fitness.'],
  long_done: ['Long run in the bank. Eat, drink and rest well today.', 'That’s the long run. It builds the endurance everything else sits on.'],
  easy_too_fast: ['That was quicker than easy. Slower easy days make the hard days better.', 'Easy days work best truly easy. Try holding back a little next time.'],
  easy_on_pace: ['You held your easy pace. That’s what today was for.', 'Easy and steady, just as planned. Good work.'],
  week_goal: ['That’s your week’s goal met. Anything more is a bonus.', 'Goal for the week: done.'],
  negative_split: ['A negative split: the second half quicker than the first. Nicely paced.', 'You finished faster than you started. That’s smart running.'],
  even_pace: ['Even pacing all the way. That’s a real skill.', 'Steady from start to finish. Well judged.'],
};

export interface CoachNoteInput {
  /** Picks the template, so a run always gets the same note. */
  runId: string;
  distanceM: number;
  activeMs: number;
  /** Seconds per km for each full split, in order. */
  splitPacesS?: number[];
  /** The plan session this run was. */
  session?: { kind: SessionKind; effort: Effort; durationS: number } | null;
  zones?: PaceZones | null;
  newRecord?: EffortKey | null;
  firstRun?: boolean;
  weekGoalMet?: boolean;
}

export interface CoachNote {
  rule: CoachRule;
  text: string;
}

const EFFORT_NAMES: Record<EffortKey, string> = { '1k': '1K', '1mi': 'mile', '5k': '5K', '10k': '10K', half: 'half marathon', marathon: 'marathon' };

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
  return h;
}

function note(rule: CoachRule, runId: string, effort?: EffortKey): CoachNote {
  const templates = COACH_TEMPLATES[rule];
  const text = templates[hash(`${rule}:${runId}`) % templates.length]!;
  return { rule, text: effort ? text.replace('{effort}', EFFORT_NAMES[effort]) : text };
}

/** Which rule applies: the first that matches, in this order. Null when there's nothing to add. */
export function coachNote(input: CoachNoteInput): CoachNote | null {
  const { runId, session } = input;
  if (input.activeMs < 60_000 || input.distanceM < 200) return null;
  if (input.firstRun) return note('first_run', runId);
  if (input.newRecord) return note('record', runId, input.newRecord);
  if (session) {
    if (session.kind === 'race') return note('race_done', runId);
    const ratio = input.activeMs / (session.durationS * 1000);
    if (session.kind === 'run_walk') return ratio < 0.7 ? note('short_of_plan', runId) : note('run_walk_done', runId);
    if (ratio < 0.7) return note('short_of_plan', runId);
    if (ratio > 1.3) return note('over_plan', runId);
    if (session.kind === 'tempo' || session.kind === 'intervals' || session.kind === 'steady') return note('hard_done', runId);
    if (session.kind === 'long') return note('long_done', runId);
    const easy = input.zones?.easy;
    const paceS = input.activeMs / 1000 / (input.distanceM / 1000);
    if (easy && paceS < easy.fastSPerKm * 0.95) return note('easy_too_fast', runId);
    return note('easy_on_pace', runId);
  }
  if (input.weekGoalMet) return note('week_goal', runId);
  const splits = input.splitPacesS ?? [];
  if (splits.length >= 4) {
    const half = Math.floor(splits.length / 2);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const first = mean(splits.slice(0, half));
    const second = mean(splits.slice(splits.length - half));
    if (second < first * 0.98) return note('negative_split', runId);
    const all = mean(splits);
    if (splits.every((s) => Math.abs(s - all) <= all * 0.03)) return note('even_pace', runId);
  }
  return null;
}
