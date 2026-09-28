import { z } from 'zod';

import type { PlanSave } from '@/api/pace-api';
import type { PersonalRecords, PlanFeedback, ServerPlan, ServerPlanSession, Stats } from '@/api/schemas';
import { addDays, isoWeekday, weekStartOf } from '@/domain/calendar';
import { sessionStatus, type SessionRecord, type SessionStatus } from '@/domain/plans/adapt';
import { daysBetween, generatePlan } from '@/domain/plans/generate';
import {
  PLAN_ENGINE_VERSION,
  type Effort,
  type EffortKey,
  type PaceRange,
  type Plan,
  type PlanAdjustment,
  type PlanHistory,
  type PlanInput,
  type PlanLevel,
  type PlannedSession,
  type PlanType,
  type WeekFocus,
  type WorkoutBlock,
} from '@/domain/plans/types';
import type { IsoDate, Units } from '@/domain/types';

/**
 * The app's side of training plans (docs/ROADMAP.md 3.1): reading a saved plan back into the
 * engine, making the next version of it, and the weeks and sessions the Train tab shows.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const effortSchema = z.enum(['easy', 'steady', 'tempo', 'interval', 'race', 'walk']);

export const planInputSchema = z.object({
  type: z.enum(['start_running', '5k', '10k', 'half', 'marathon', 'consistency', 'return']),
  level: z.enum(['beginner', 'intermediate', 'advanced']),
  startDate: isoDate,
  firstDay: isoDate.nullable().optional(),
  raceDate: isoDate.nullable(),
  goalTimeS: z.number().nullable(),
  daysPerWeek: z.number().int(),
  longRunDay: z.number().int(),
  maxSessionMin: z.number().nullable(),
  recentInjury: z.boolean(),
  history: z.object({
    weeklyMinutes: z.array(z.number()),
    longestRunMin: z.number(),
    bestEfforts: z.partialRecord(z.enum(['1k', '1mi', '5k', '10k', 'half', 'marathon']), z.number()),
  }),
});

export const planAdjustmentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('lighten'), week: z.number(), factor: z.number() }),
  z.object({ type: z.literal('pause'), from: isoDate, to: isoDate }),
  z.object({ type: z.literal('repeat_week'), week: z.number() }),
  z.object({ type: z.literal('skip_week'), week: z.number() }),
  z.object({ type: z.literal('move'), sessionId: z.string(), toDate: isoDate }),
  z.object({ type: z.literal('swap'), a: z.string(), b: z.string() }),
  z.object({ type: z.literal('set_duration'), sessionId: z.string(), durationS: z.number() }),
  z.object({ type: z.literal('set_effort'), sessionId: z.string(), effort: effortSchema }),
  z.object({ type: z.literal('easy_instead'), sessionId: z.string() }),
  z.object({ type: z.literal('rest_instead'), sessionId: z.string() }),
]);

export interface PlanState {
  server: ServerPlan;
  input: PlanInput | null;
  adjustments: PlanAdjustment[] | null;
  /** The engine's plan from the saved answers and edits; null when this app can't read them. */
  plan: Plan | null;
  /** Finished, or saved by a newer app: shown, not changed. */
  readOnly: boolean;
  /** The runner's today, in the plan's time zone. */
  today: IsoDate;
  records: SessionRecord[];
}

export function readPlan(server: ServerPlan): PlanState {
  const input = planInputSchema.safeParse(server.input);
  const adjustments = z.array(planAdjustmentSchema).safeParse(server.adjustments);
  let plan: Plan | null = null;
  if (input.success && adjustments.success && server.engine_version <= PLAN_ENGINE_VERSION) {
    try {
      plan = generatePlan(input.data, adjustments.data);
    } catch {
      plan = null;
    }
  }
  return {
    server,
    input: input.success ? input.data : null,
    adjustments: adjustments.success ? adjustments.data : null,
    plan,
    readOnly: plan === null || server.status !== 'active',
    today: server.today,
    records: server.sessions.map((s) => ({ sessionId: s.id, done: s.run_id !== null, feedback: s.feedback, pain: s.pain })),
  };
}

export function wireSessions(plan: Plan): Record<string, unknown>[] {
  return plan.weeks.flatMap((w) =>
    w.sessions.map((s) => ({
      id: s.id,
      date: s.date,
      week: s.week,
      kind: s.kind,
      title: s.title,
      hard: s.hard,
      duration_s: s.durationS,
      distance_m: s.distanceM,
      effort: s.effort,
      blocks: s.blocks,
      edited: s.edited ?? false,
    })),
  );
}

/** The next version of a plan: the engine's output for these answers and edits, ready to save. */
export function planSave(args: {
  planId: string;
  baseVersion: number | null;
  input: PlanInput;
  adjustments: PlanAdjustment[];
  timeZone: string;
}): { plan: Plan; save: PlanSave } {
  const plan = generatePlan(args.input, args.adjustments);
  return {
    plan,
    save: {
      planId: args.planId,
      baseVersion: args.baseVersion,
      input: args.input,
      adjustments: args.adjustments,
      sessions: wireSessions(plan),
      engineVersion: PLAN_ENGINE_VERSION,
      timeZone: args.timeZone,
      endDate: plan.endDate,
    },
  };
}

export function toPlannedSession(s: ServerPlanSession): PlannedSession {
  return {
    id: s.id,
    date: s.date,
    week: s.week,
    kind: s.kind,
    title: s.title,
    hard: s.hard,
    durationS: s.duration_s,
    distanceM: s.distance_m,
    effort: s.effort,
    blocks: s.blocks as WorkoutBlock[],
    edited: s.edited,
  };
}

// ---------------------------------------------------------------------------------------------
// What the Train tab shows

export type SessionViewStatus = SessionStatus | 'paused';

export interface SessionView {
  session: PlannedSession;
  status: SessionViewStatus;
  feedback: PlanFeedback | null;
  pain: boolean;
  matchedBy: 'auto' | 'runner' | null;
  run: ServerPlanSession['run'];
}

export interface WeekView {
  index: number;
  startDate: IsoDate;
  focus: WeekFocus;
  minutes: number;
  sessions: SessionView[];
  done: number;
  current: boolean;
  past: boolean;
}

function pausedOn(adjustments: PlanAdjustment[] | null, date: IsoDate): boolean {
  return (adjustments ?? []).some((a) => a.type === 'pause' && a.from <= date && date <= a.to);
}

export function sessionView(state: PlanState, s: ServerPlanSession): SessionView {
  const session = toPlannedSession(s);
  const record = state.records.find((r) => r.sessionId === s.id);
  let status: SessionViewStatus = sessionStatus(session, record, state.today);
  if (status === 'missed' && pausedOn(state.adjustments, s.date)) status = 'paused';
  return { session, status, feedback: s.feedback, pain: s.pain, matchedBy: s.matched_by, run: s.run };
}

/** The plan's weeks with the server's sessions: history as it happened, the rest as planned. */
export function planWeeks(state: PlanState): WeekView[] {
  const { server, plan, today } = state;
  const count = Math.max(1, Math.floor(daysBetween(server.start_date, server.end_date) / 7) + 1);
  const weeks: WeekView[] = Array.from({ length: count }, (_, i) => {
    const startDate = addDays(server.start_date, 7 * i);
    return {
      index: i + 1,
      startDate,
      focus: plan?.weeks[i]?.focus ?? 'build',
      minutes: 0,
      sessions: [],
      done: 0,
      current: startDate <= today && today <= addDays(startDate, 6),
      past: addDays(startDate, 6) < today,
    };
  });
  for (const s of server.sessions) {
    const week = weeks[Math.floor(daysBetween(server.start_date, s.date) / 7)];
    if (!week) continue;
    const view = sessionView(state, s);
    week.sessions.push(view);
    week.minutes += s.duration_s / 60;
    if (view.status === 'done') week.done++;
  }
  for (const week of weeks) week.minutes = Math.round(week.minutes);
  return weeks;
}

/** Today's sessions, for Home and the check-in. */
export function todaysSessions(state: PlanState): SessionView[] {
  return state.server.sessions.filter((s) => s.date === state.today).map((s) => sessionView(state, s));
}

/** The pause running today, if any. */
export function currentPause(state: PlanState): Extract<PlanAdjustment, { type: 'pause' }> | null {
  const pause = (state.adjustments ?? []).filter((a) => a.type === 'pause' && a.from <= state.today && state.today <= a.to).pop();
  return pause?.type === 'pause' ? pause : null;
}

/**
 * Ends a pause early: it now ends yesterday, or goes if it hadn't begun. Adjustments are the
 * runner's own list, so this one is rewritten rather than followed by another.
 */
export function resumeAdjustments(adjustments: PlanAdjustment[], today: IsoDate): PlanAdjustment[] {
  return adjustments.flatMap((a) => {
    if (a.type !== 'pause' || a.to < today) return [a];
    if (a.from >= today) return [];
    return [{ ...a, to: addDays(today, -1) }];
  });
}

// ---------------------------------------------------------------------------------------------
// Setup

/** Mondays to Thursdays start this week, from today; later in the week, next Monday. */
export function defaultStart(today: IsoDate): { startDate: IsoDate; firstDay: IsoDate | null } {
  const monday = weekStartOf(today);
  return isoWeekday(today) <= 3 ? { startDate: monday, firstDay: today === monday ? null : today } : { startDate: addDays(monday, 7), firstDay: null };
}

export function suggestedLevel(history: PlanHistory): PlanLevel {
  const weeks = history.weeklyMinutes;
  const average = weeks.length ? weeks.reduce((a, b) => a + b, 0) / weeks.length : 0;
  return average < 60 ? 'beginner' : average < 180 ? 'intermediate' : 'advanced';
}

const RECENT_EFFORT_MS = 182 * 86_400_000;
const RECENT_RUN_MS = 28 * 86_400_000;

/** Where the runner is: the last four weeks from stats, recent runs and personal records. */
export function planHistory(input: {
  stats: Stats | null;
  records: PersonalRecords | null;
  runs: { startedAtMs: number; activeMs: number }[];
  now: number;
}): PlanHistory {
  const weeklyMinutes = (input.stats?.buckets ?? []).slice(-4).map((b) => Math.round(b.active_ms / 60_000));
  const longestRunMin = Math.round(
    Math.max(0, ...input.runs.filter((r) => r.startedAtMs >= input.now - RECENT_RUN_MS).map((r) => r.activeMs)) / 60_000,
  );
  return { weeklyMinutes, longestRunMin, bestEfforts: recentBestEfforts(input.records, input.now) };
}

/** Best efforts from the last six months, in seconds: older ones say little about fitness now. */
export function recentBestEfforts(records: PersonalRecords | null, now: number): Partial<Record<EffortKey, number>> {
  const best: Partial<Record<EffortKey, number>> = {};
  for (const record of records?.records ?? []) {
    if (record.best && record.best.started_at_ms >= now - RECENT_EFFORT_MS) best[record.effort] = Math.round(record.best.elapsed_ms / 1000);
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Words

export const PLAN_NAMES: Record<PlanType, string> = {
  start_running: 'Start running',
  '5k': '5K',
  '10k': '10K',
  half: 'Half marathon',
  marathon: 'Marathon',
  consistency: 'Stay consistent',
  return: 'Return from a break',
};

export const PLAN_BLURBS: Record<PlanType, string> = {
  start_running: 'Run/walk to 30 minutes without stopping.',
  '5k': 'Build to a strong 5K, from your first to your fastest.',
  '10k': 'More endurance, and a pace you can hold.',
  half: 'Long runs and steady pace for 21.1 km.',
  marathon: 'A patient build to 42.2 km.',
  consistency: 'Keep the habit, with a little variety. No race.',
  return: 'Ease back in after time off, injury or illness.',
};

export const LEVEL_NAMES: Record<PlanLevel, string> = { beginner: 'New to it', intermediate: 'Some experience', advanced: 'Experienced' };

export const FOCUS_NAMES: Record<WeekFocus, string> = {
  base: 'Base',
  build: 'Build',
  lighter: 'Lighter week',
  taper: 'Taper',
  race: 'Race week',
  paused: 'Paused',
};

export const EFFORT_NAMES: Record<Effort, string> = {
  easy: 'Easy',
  steady: 'Steady',
  tempo: 'Tempo',
  interval: 'Hard',
  race: 'Race pace',
  walk: 'Walk',
};

/** How each effort should feel, for training by effort. */
export const EFFORT_FEEL: Record<Effort, string> = {
  easy: 'Relaxed. You can talk in full sentences.',
  steady: 'Comfortably firm. A few words at a time.',
  tempo: 'Comfortably hard. You could hold it for about an hour in a race.',
  interval: 'Hard but controlled. Strong to the end of each rep.',
  race: 'The pace you plan to race at.',
  walk: 'A brisk walk.',
};

export const FEEDBACK_NAMES: Record<PlanFeedback, string> = { easy: 'Easy', about_right: 'About right', hard: 'Hard', too_hard: 'Too hard' };

export const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const KM_PER_MILE = 1.609344;

export function formatPaceS(sPerKm: number, units: Units): string {
  const s = Math.round(units === 'imperial' ? sPerKm * KM_PER_MILE : sPerKm);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function formatPaceRange(range: PaceRange, units: Units): string {
  return `${formatPaceS(range.fastSPerKm, units)}–${formatPaceS(range.slowSPerKm, units)} ${units === 'imperial' ? '/mi' : '/km'}`;
}

export function formatMinutes(durationS: number): string {
  const min = Math.round(durationS / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** A step's length: "3 min", "90 s", "2:30 min". */
export function formatStepLength(durationS: number): string {
  const s = Math.round(durationS);
  if (s % 60 === 0) return formatMinutes(s);
  if (s < 120) return `${s} s`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} min`;
}

/** h:mm:ss or m:ss for race times. */
export function formatRaceTime(s: number): string {
  const total = Math.round(s);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

/** Reads "25:30" or "1:52:00" (or plain minutes) as seconds; null when it isn't a time. */
export function parseRaceTime(text: string): number | null {
  const parts = text.trim().split(':');
  if (parts.length === 0 || parts.length > 3 || parts.some((p) => !/^\d{1,3}$/.test(p))) return null;
  const n = parts.map(Number);
  if (n.length > 1 && n.slice(1).some((x) => x >= 60)) return null;
  const s = n.length === 3 ? n[0]! * 3600 + n[1]! * 60 + n[2]! : n.length === 2 ? n[0]! * 60 + n[1]! : n[0]! * 60;
  return s > 0 ? s : null;
}

/** One line per step, repeats folded: "4 × 3 min hard, 2 min easy". */
export function describeBlocks(blocks: WorkoutBlock[]): string[] {
  const step = (st: WorkoutBlock['steps'][number]) => {
    const amount = st.distanceM ? `${(st.distanceM / 1000).toFixed(st.distanceM % 1000 === 0 ? 0 : 1)} km` : formatStepLength(st.durationS ?? 0);
    const what =
      st.kind === 'warmup' ? 'warm-up' : st.kind === 'cooldown' ? 'cool-down' : st.kind === 'recover' ? 'recovery' : st.kind === 'walk' ? 'walk' : '';
    const effort = st.effort === 'walk' ? (st.kind === 'walk' ? '' : 'walking') : EFFORT_NAMES[st.effort].toLowerCase();
    return [amount, effort, what].filter(Boolean).join(' ');
  };
  return blocks.map((b) => (b.repeat > 1 ? `${b.repeat} × ${b.steps.map(step).join(', ')}` : b.steps.map(step).join(', ')));
}
