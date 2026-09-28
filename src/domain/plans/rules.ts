import { addDays } from '../calendar';
import type { Plan, PlannedSession, PlanWarning } from './types';

/**
 * The progression rules a plan is checked against (docs/ROADMAP.md Part B point 3). The engine
 * follows them when it writes a plan; a runner's edits may break them, and then the app warns
 * rather than blocks.
 */
export const RULES = {
  /** A week may grow by this much over the busier of the two weeks before it… */
  maxGrowth: 1.1,
  /** …plus this many minutes, so rounding sessions to five minutes doesn't trip it. */
  growthSlackMin: 10,
  maxHardPerWeek: 2,
  /** The long run's largest share of a week of three or more sessions. */
  maxLongShare: 0.5,
};

const byDate = (a: PlannedSession, b: PlannedSession) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1);

export function planWarnings(plan: Pick<Plan, 'input' | 'weeks'>): PlanWarning[] {
  const warnings: PlanWarning[] = [];
  const sessions = plan.weeks.flatMap((w) => w.sessions);

  // A hard day is never followed by another (and never shares a day with one).
  const hard = sessions.filter((s) => s.hard).sort(byDate);
  for (let i = 1; i < hard.length; i++) {
    const prev = hard[i - 1]!;
    const cur = hard[i]!;
    if (cur.date === prev.date || addDays(prev.date, 1) === cur.date) {
      warnings.push({ code: 'two_hard_days', week: cur.week, sessionId: cur.id });
    }
  }

  for (const week of plan.weeks) {
    if (week.sessions.filter((s) => s.hard).length > RULES.maxHardPerWeek) {
      warnings.push({ code: 'too_many_hard', week: week.index });
    }
  }

  // Weekly growth, against full weeks only (a week with a pause in it is no baseline), and without
  // the race itself.
  const history = Math.max(0, ...plan.input.history.weeklyMinutes);
  const baselines: number[] = [];
  for (const week of plan.weeks) {
    if (week.focus === 'paused') continue;
    const training = Math.round(week.sessions.filter((s) => s.kind !== 'race').reduce((sum, s) => sum + s.durationS, 0) / 60);
    const recent = baselines.slice(-2);
    const reference = recent.length > 0 ? Math.max(...recent) : history > 0 ? history : null;
    if (reference !== null && training > reference * RULES.maxGrowth + RULES.growthSlackMin) {
      warnings.push({ code: 'big_jump', week: week.index });
    }
    if (week.daysOff === 0) baselines.push(training);
  }

  for (const week of plan.weeks) {
    // Race weeks are excepted: the race is most of the week, as it should be.
    if (week.sessions.length < 3 || week.sessions.some((s) => s.kind === 'race')) continue;
    const total = week.sessions.reduce((sum, s) => sum + s.durationS, 0);
    const longest = Math.max(...week.sessions.map((s) => s.durationS));
    if (total > 0 && longest > total * RULES.maxLongShare) warnings.push({ code: 'long_run_share', week: week.index });
  }

  const maxMin = plan.input.maxSessionMin;
  if (maxMin) {
    for (const s of sessions) {
      if (s.kind !== 'race' && s.durationS >= (maxMin + 1) * 60) {
        warnings.push({ code: 'over_max_session', week: s.week, sessionId: s.id });
      }
    }
  }
  return warnings;
}
