import { addDays } from '../calendar';
import type { IsoDate } from '../types';
import { planSessions, sessionsOn } from './generate';
import type { Plan, PlanAdjustment, PlannedSession, PlanWeek } from './types';

/**
 * How a plan listens (docs/ROADMAP.md Part B point 5). The engine never looks at what was run:
 * missed sessions are dropped, never crammed into the days after. These rules turn the runner's
 * answers into adjustments, which the plan is then recalculated with.
 */

export type SessionFeedback = 'easy' | 'about_right' | 'hard' | 'too_hard';

/** What became of a planned session, from the server's session log. */
export interface SessionRecord {
  sessionId: string;
  /** A run was matched to it. */
  done: boolean;
  feedback: SessionFeedback | null;
  pain: boolean;
}

export const ADAPT = {
  /** This many "too hard" answers in a week lighten the next week… */
  tooHardPerWeek: 2,
  /** …to this share of its minutes. */
  lightenFactor: 0.85,
  /** Days without a done session, with sessions planned, before the app offers a pause. */
  missedStretchDays: 10,
  /** A pain flag is brought up again for this many days. */
  painDays: 7,
};

export type SessionStatus = 'done' | 'missed' | 'today' | 'upcoming';

export function sessionStatus(session: PlannedSession, record: SessionRecord | undefined, today: IsoDate): SessionStatus {
  if (record?.done) return 'done';
  if (session.date < today) return 'missed';
  return session.date === today ? 'today' : 'upcoming';
}

export function weekProgress(week: PlanWeek, records: ReadonlyMap<string, SessionRecord>): { planned: number; done: number } {
  return { planned: week.sessions.length, done: week.sessions.filter((s) => records.get(s.id)?.done).length };
}

/** Two "too hard" answers in a week lighten the next one. Returns only adjustments the plan lacks. */
export function feedbackAdjustments(plan: Plan, records: SessionRecord[]): PlanAdjustment[] {
  const byId = new Map(records.map((r) => [r.sessionId, r]));
  const out: PlanAdjustment[] = [];
  for (const week of plan.weeks) {
    const tooHard = week.sessions.filter((s) => byId.get(s.id)?.feedback === 'too_hard').length;
    const next = week.index + 1;
    if (tooHard < ADAPT.tooHardPerWeek || next > plan.weeks.length) continue;
    if (plan.adjustments.some((a) => a.type === 'lighten' && a.week === next)) continue;
    out.push({ type: 'lighten', week: next, factor: ADAPT.lightenFactor });
  }
  return out;
}

/** The daily "not feeling 100%" check-in: today's sessions become an easy run, or rest. */
export function checkInAdjustments(plan: Plan, today: IsoDate, choice: 'easy' | 'rest', records: SessionRecord[] = []): PlanAdjustment[] {
  const done = new Set(records.filter((r) => r.done).map((r) => r.sessionId));
  const out: PlanAdjustment[] = [];
  for (const s of sessionsOn(plan, today)) {
    if (done.has(s.id) || s.kind === 'race') continue;
    if (choice === 'rest') out.push({ type: 'rest_instead', sessionId: s.id });
    else if (s.hard || s.durationS > 40 * 60 || s.kind === 'run_walk') out.push({ type: 'easy_instead', sessionId: s.id });
  }
  return out;
}

/** A pause that ends the day before training starts again. */
export function pauseAdjustment(from: IsoDate, resumeOn: IsoDate): PlanAdjustment {
  return { type: 'pause', from, to: addDays(resumeOn, -1) };
}

export type CoachPrompt =
  /** Suggest rest, offer the return-to-run plan, and suggest seeing a professional. No medical advice. */
  | { kind: 'pain'; sessionId: string }
  /** A week was made lighter after "too hard" answers. */
  | { kind: 'lightened'; week: number }
  /** A stretch of missed sessions: offer to count it as a pause, which eases the way back. */
  | { kind: 'missed'; pause: PlanAdjustment };

export function coachPrompts(plan: Plan, records: SessionRecord[], today: IsoDate): CoachPrompt[] {
  const byId = new Map(records.map((r) => [r.sessionId, r]));
  const sessions = planSessions(plan);
  const prompts: CoachPrompt[] = [];

  const painFrom = addDays(today, -ADAPT.painDays);
  const pain = sessions.filter((s) => s.date >= painFrom && s.date <= today && byId.get(s.id)?.pain).pop();
  if (pain) prompts.push({ kind: 'pain', sessionId: pain.id });

  const thisWeek = plan.weeks.find((w) => w.startDate <= today && today <= addDays(w.startDate, 6));
  if (thisWeek && plan.adjustments.some((a) => a.type === 'lighten' && a.week === thisWeek.index)) {
    prompts.push({ kind: 'lightened', week: thisWeek.index });
  }

  const past = sessions.filter((s) => s.date < today);
  const lastDone = past.filter((s) => byId.get(s.id)?.done).pop();
  const missed = past.filter((s) => (!lastDone || s.date > lastDone.date) && !byId.get(s.id)?.done);
  const first = missed[0];
  if (first && missed.length >= 2) {
    const since = lastDone ? addDays(lastDone.date, 1) : first.date;
    const already = plan.adjustments.some((a) => a.type === 'pause' && a.from <= first.date && a.to >= addDays(today, -1));
    if (!already && addDays(since, ADAPT.missedStretchDays) <= today) {
      prompts.push({ kind: 'missed', pause: pauseAdjustment(first.date, today) });
    }
  }
  return prompts;
}
