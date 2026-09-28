import { addDays, isoWeekday, parseIsoDate } from '../calendar';
import type { IsoDate } from '../types';
import { EFFORT_DISTANCE_M, fitness5kS, paceZones, riegel } from './paces';
import { planWarnings } from './rules';
import { DEFAULT_PACE_S_PER_KM, RUN_WALK_LADDER, TEMPLATES, type PlanTemplate } from './templates';
import {
  PLAN_ENGINE_VERSION,
  type Effort,
  type PaceZones,
  type Plan,
  type PlanAdjustment,
  type PlanInput,
  type PlannedSession,
  type PlanWarning,
  type PlanWeek,
  type SessionKind,
  type WeekFocus,
  type WorkoutBlock,
  type WorkoutStep,
} from './types';

/**
 * The plan engine (docs/ROADMAP.md 3.1 and 3.2). `generatePlan(input, adjustments)` is pure and
 * deterministic: the same answers and edits always give the same plan, so the server keeps only
 * those and the app recalculates.
 *
 * Volume is in minutes, not distance, so the same plan suits every pace. Each week's minutes come
 * from a running "level": build weeks grow it, lighter weeks and pauses rest it, the taper spends
 * it. Sessions are then laid out around the long-run day.
 */

/** The progression numbers, for the coach to review (Part B point 3). */
export const PROGRESSION = {
  growth: 1.1,
  /** Growth in the first build week after a lighter week, a lightened week or a pause. */
  growthAfterBreak: 1.05,
  lighterFactor: 0.75,
  /** A lighter week every fourth week, or every third for beginners and after an injury. */
  lighterEvery: 4,
  lighterEveryCautious: 3,
  /** Taper weeks as fractions of the level, the race week last, by taper length. */
  taper: { 1: [0.6], 2: [0.8, 0.55], 3: [0.85, 0.7, 0.5] } as Record<number, number[]>,
  /** What's left of the level after a pause of up to 3, 7 or 14 days, or longer. */
  resume: [
    [3, 1],
    [7, 0.9],
    [14, 0.75],
    [Infinity, 0.6],
  ] as [number, number][],
  /** Run/walk rungs to climb again after a pause. */
  rungsBack: [
    [7, 0],
    [14, 1],
    [Infinity, 2],
  ] as [number, number][],
  /** Longer than this is a new start: the app offers the return plan instead. */
  maxPauseDays: 84,
  /** The shortest long run, and the shortest other run. Fewer days are used when the week's minutes can't fill them. */
  minSessionMin: 20,
  minEasyMin: 15,
  hardShare: 0.2,
  hardMinMin: 25,
  hardMaxMin: 70,
  maxEasyMin: 75,
  maxWeeks: 52,
  /** How far a goal may outrun current fitness: 0.6% a week, 10% at most. */
  goalGainPerWeek: 0.006,
  goalGainMax: 0.1,
  lightenRange: [0.5, 1] as [number, number],
};

/** Run days as days after the long run, by days a week. */
export const DAY_PATTERNS: Record<number, number[]> = {
  2: [0, 3],
  3: [0, 2, 4],
  4: [0, 2, 4, 5],
  5: [0, 1, 2, 4, 5],
  6: [0, 1, 2, 3, 4, 5],
};
/** Hard sessions go two and four days after the long run: never together, never the day before it. */
const HARD_OFFSETS = [2, 4];
const LONG_SHARE: Record<number, number> = { 2: 0.55, 3: 0.4, 4: 0.33, 5: 0.3, 6: 0.27 };
const MAX_LONG_SHARE = 0.45;
const RUN_WALK_DAYS = 3;

export const HARD_KINDS: ReadonlySet<SessionKind> = new Set<SessionKind>(['tempo', 'intervals', 'steady', 'race']);
const RACE_NAMES: Record<string, string> = { '5k': '5K', '10k': '10K', half: 'half marathon', marathon: 'marathon' };
const SESSION_ID = /^w(\d{1,3})-d([0-6])$/;

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const round5 = (min: number) => Math.round(min / 5) * 5;
const floorMin = (s: number) => Math.floor(s / 60) * 60;

export function daysBetween(a: IsoDate, b: IsoDate): number {
  const pa = parseIsoDate(a);
  const pb = parseIsoDate(b);
  return Math.round((Date.UTC(pb.year, pb.month - 1, pb.day) - Date.UTC(pa.year, pa.month - 1, pa.day)) / 86_400_000);
}

function lookup(table: [number, number][], days: number): number {
  for (const [limit, value] of table) if (days <= limit) return value;
  return table[table.length - 1]![1];
}

// ---------------------------------------------------------------------------------------------
// Input

export type PlanInputProblem =
  | 'bad_start'
  | 'bad_first_day'
  | 'bad_race_date'
  | 'race_too_far'
  | 'bad_goal'
  | 'bad_days'
  | 'too_few_days'
  | 'bad_long_run_day'
  | 'bad_max_session';

const isDate = (d: unknown): d is IsoDate => {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const { year, month, day } = parseIsoDate(d);
  const t = new Date(Date.UTC(year, month - 1, day));
  return t.getUTCFullYear() === year && t.getUTCMonth() === month - 1 && t.getUTCDate() === day;
};

/** What's wrong with the setup answers, if anything. The setup screen checks before saving. */
export function validatePlanInput(input: PlanInput): PlanInputProblem | null {
  const tpl = TEMPLATES[input.type];
  if (!isDate(input.startDate) || isoWeekday(input.startDate) !== 0) return 'bad_start';
  const firstDay = input.firstDay ?? input.startDate;
  if (!isDate(firstDay) || firstDay < input.startDate || firstDay > addDays(input.startDate, 6)) return 'bad_first_day';
  if (input.raceDate !== null) {
    if (!tpl.race || !isDate(input.raceDate) || input.raceDate < firstDay) return 'bad_race_date';
    if (daysBetween(input.startDate, input.raceDate) >= PROGRESSION.maxWeeks * 7) return 'race_too_far';
  }
  if (input.goalTimeS !== null) {
    if (!tpl.race || !Number.isFinite(input.goalTimeS) || input.goalTimeS < 600 || input.goalTimeS > 12 * 3600) return 'bad_goal';
  }
  if (!Number.isInteger(input.daysPerWeek) || input.daysPerWeek < 2 || input.daysPerWeek > 6) return 'bad_days';
  if (input.daysPerWeek < tpl.minDays) return 'too_few_days';
  if (!Number.isInteger(input.longRunDay) || input.longRunDay < 0 || input.longRunDay > 6) return 'bad_long_run_day';
  if (input.maxSessionMin !== null && (!Number.isFinite(input.maxSessionMin) || input.maxSessionMin < 30 || input.maxSessionMin > 360)) {
    return 'bad_max_session';
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Context: the numbers fixed by the input.

interface Context {
  input: PlanInput;
  tpl: PlanTemplate;
  race: boolean;
  start: IsoDate;
  firstDay: IsoDate;
  raceDate: IsoDate | null;
  /** Calendar weeks up to and including the race week. */
  raceWeeks: number;
  startLevel: number;
  peak: number;
  raceTimeS: number | null;
  zones: PaceZones | null;
  predictedTimeS: number | null;
  warnings: PlanWarning[];
  /** Weeks before the taper, for when long runs get a steady finish. */
  buildWeeks: number;
}

function startLevel(input: PlanInput, tpl: PlanTemplate): number {
  const level = input.level;
  const weeks = input.history.weeklyMinutes.filter((m) => Number.isFinite(m) && m >= 0);
  // Weeks without running count: when in doubt, start lower.
  let start = weeks.some((m) => m > 0) ? weeks.reduce((a, b) => a + b, 0) / weeks.length : tpl.startMin[level];
  if (input.recentInjury) start *= 0.75;
  return Math.round(clamp(start, tpl.startMin[level] * 0.5, tpl.peakMin[level] * 0.85));
}

function context(input: PlanInput): Context {
  const tpl = TEMPLATES[input.type];
  const race = tpl.race !== null;
  const start = input.startDate;
  const firstDay = input.firstDay ?? start;
  let raceDate: IsoDate | null = null;
  let raceWeeks = 0;
  if (race) {
    raceDate = input.raceDate ?? addDays(start, (tpl.weeks[input.level] - 1) * 7 + input.longRunDay);
    raceWeeks = Math.floor(daysBetween(start, raceDate) / 7) + 1;
  }
  const warnings: PlanWarning[] = [];
  if (race && raceWeeks < tpl.minWeeks) warnings.push({ code: 'short_runway' });

  const fit5k = fitness5kS(input.history.bestEfforts);
  const raceM = tpl.race ? EFFORT_DISTANCE_M[tpl.race] : null;
  const predictedTimeS = raceM !== null && fit5k !== null ? Math.round(riegel(fit5k, 5000, raceM)) : null;
  let raceTimeS: number | null = null;
  let racePaceTimeS: number | null = null;
  if (raceM !== null) {
    raceTimeS = input.goalTimeS ?? predictedTimeS ?? Math.round((DEFAULT_PACE_S_PER_KM[input.level] * raceM) / 1000);
    racePaceTimeS = raceTimeS;
    if (input.goalTimeS !== null && predictedTimeS !== null) {
      const gain = Math.min(PROGRESSION.goalGainMax, raceWeeks * PROGRESSION.goalGainPerWeek);
      const fastest = Math.round(predictedTimeS * (1 - gain));
      if (input.goalTimeS < fastest) {
        warnings.push({ code: 'goal_ambitious' });
        // Train at the fastest pace the plan can build to, not the goal's.
        racePaceTimeS = fastest;
      }
    }
  }
  const zones =
    fit5k === null ? null : paceZones(fit5k, raceM !== null && racePaceTimeS !== null ? racePaceTimeS / (raceM / 1000) : fit5k / 5);

  const ctx: Context = {
    input,
    tpl,
    race,
    start,
    firstDay,
    raceDate,
    raceWeeks,
    startLevel: startLevel(input, tpl),
    peak: tpl.peakMin[input.level],
    raceTimeS,
    zones,
    predictedTimeS,
    warnings,
    buildWeeks: 0,
  };
  return ctx;
}

// ---------------------------------------------------------------------------------------------
// Structure: the template's weeks, then the runner's week-level edits.

interface TemplateWeek {
  focus: Exclude<WeekFocus, 'paused'>;
  /** Position in the template as written; rotates the hard sessions. */
  step: number;
  taperFactor: number;
  rung: number | null;
  /** A repeated week holds the level instead of growing it. */
  hold: boolean;
}

interface Structure {
  weeks: TemplateWeek[];
  paused: Set<IsoDate>;
  /** The day training resumes after each pause, and how much of the level is left. */
  resumes: { date: IsoDate; factor: number }[];
  /** Calendar week index to factor. */
  lighten: Map<number, number>;
}

function templateWeeks(ctx: Context): TemplateWeek[] {
  const { input, tpl } = ctx;
  const level = input.level;
  const every = level === 'beginner' || input.recentInjury ? PROGRESSION.lighterEveryCautious : PROGRESSION.lighterEvery;
  const week = (focus: TemplateWeek['focus'], step: number, rung: number | null = null, taperFactor = 1): TemplateWeek => ({
    focus,
    step,
    taperFactor,
    rung,
    hold: false,
  });
  const weeks: TemplateWeek[] = [];
  if (ctx.race) {
    const n = ctx.raceWeeks;
    const taper = Math.min(tpl.taperWeeks, n);
    const factors = PROGRESSION.taper[taper] ?? [];
    const pre = n - taper;
    // A race further off than usual starts with base weeks that hold the level.
    const base = Math.max(0, pre - (tpl.weeks[level] - tpl.taperWeeks));
    for (let i = 0; i < pre; i++) {
      // Base weeks don't build, so lighter weeks start counting with the build.
      const b = i - base + 1;
      const lighter = b > 1 && b % every === 0 && i + 1 < pre;
      weeks.push(week(lighter ? 'lighter' : i < base ? 'base' : 'build', i));
    }
    for (let j = 0; j < taper; j++) weeks.push(week(j === taper - 1 ? 'race' : 'taper', pre + j, null, factors[j] ?? 0.6));
    ctx.buildWeeks = pre;
    return weeks;
  }
  const n = tpl.weeks[level];
  const rw = tpl.runWalk;
  const rungWeeks = rw && (rw.when === 'always' || level === 'beginner' || input.recentInjury) ? (rw.weeks ?? n) : 0;
  const lighterWeeks = input.type === 'consistency';
  for (let i = 0; i < n; i++) {
    const rung = rw && i < rungWeeks ? Math.min(RUN_WALK_LADDER.length - 1, rw.startRung[level] + i) : null;
    const lighter = lighterWeeks && i > 0 && (i + 1) % every === 0 && i + 1 < n;
    weeks.push(week(lighter ? 'lighter' : 'build', i, rung));
  }
  ctx.buildWeeks = n;
  return weeks;
}

const mondayOf = (ctx: Context, k: number) => addDays(ctx.start, 7 * k);
const weekIndexOf = (ctx: Context, date: IsoDate) => Math.floor(daysBetween(ctx.start, date) / 7);

/**
 * Which template week each calendar week holds; null for a paused week. Race plans keep their
 * calendar (the race doesn't move): a week paused throughout is lost, and a partly paused week
 * keeps the sessions outside the pause. Other plans carry on where they left off: a week paused
 * for four days or more moves to the next week.
 */
function calendar(ctx: Context, s: Structure): (number | null)[] {
  const out: (number | null)[] = [];
  let p = 0;
  for (let k = 0; k < PROGRESSION.maxWeeks * 2; k++) {
    if (ctx.race ? k >= s.weeks.length : p >= s.weeks.length) break;
    const monday = mondayOf(ctx, k);
    let pausedDays = 0;
    for (let d = 0; d < 7; d++) if (s.paused.has(addDays(monday, d))) pausedDays++;
    if (pausedDays >= (ctx.race ? 7 : 4)) {
      out.push(null);
      if (ctx.race) p++;
      continue;
    }
    out.push(p++);
  }
  return out;
}

function repeatWeek(ctx: Context, s: Structure, k: number) {
  const p = calendar(ctx, s)[k];
  if (p === null || p === undefined) return;
  const w = s.weeks[p]!;
  if (w.focus === 'taper' || w.focus === 'race') return;
  if (ctx.race) {
    // The race doesn't move: a later week makes room, the last base week if there is one, else the
    // last build week.
    const later = s.weeks.map((x, i) => ({ x, i })).filter(({ x, i }) => i > p && (x.focus === 'base' || x.focus === 'build'));
    const drop = later.filter(({ x }) => x.focus === 'base').pop() ?? later.pop();
    if (!drop) return;
    s.weeks.splice(drop.i, 1);
  }
  s.weeks.splice(p + 1, 0, { ...w, hold: true });
}

function skipWeek(ctx: Context, s: Structure, k: number) {
  const monday = mondayOf(ctx, k);
  if (ctx.race) {
    // The race doesn't move, so skipping a week means resting through it.
    pause(ctx, s, monday < ctx.firstDay ? ctx.firstDay : monday, addDays(monday, 6));
    return;
  }
  const p = calendar(ctx, s)[k];
  if (p === null || p === undefined || s.weeks.length <= 1) return;
  s.weeks.splice(p, 1);
}

function pause(ctx: Context, s: Structure, from: IsoDate, to: IsoDate) {
  if (!isDate(from) || !isDate(to) || to < from) return;
  const limit = addDays(from, PROGRESSION.maxPauseDays - 1);
  const end = to > limit ? limit : to;
  for (let d = from; d <= end; d = addDays(d, 1)) s.paused.add(d);
  const days = daysBetween(from, end) + 1;
  const back = addDays(end, 1);
  s.resumes.push({ date: back, factor: lookup(PROGRESSION.resume, days) });

  // Run/walk steps back a rung or two, then climbs again.
  const rungs = lookup(PROGRESSION.rungsBack, days);
  if (rungs === 0 || ctx.race) return;
  const map = calendar(ctx, s);
  let p: number | null = null;
  for (let k = Math.max(0, weekIndexOf(ctx, back)); k < map.length && p === null; k++) p = map[k] ?? null;
  if (p === null) return;
  const w = s.weeks[p]!;
  if (w.rung === null) return;
  const top = w.rung;
  const bottom = Math.max(0, top - rungs);
  w.rung = bottom;
  for (let r = bottom + 1, i = 1; r <= top; r++, i++) s.weeks.splice(p + i, 0, { ...w, rung: r, hold: false });
}

function structure(ctx: Context, adjustments: PlanAdjustment[]): Structure {
  const s: Structure = { weeks: templateWeeks(ctx), paused: new Set(), resumes: [], lighten: new Map() };
  for (const adj of adjustments) {
    switch (adj.type) {
      case 'lighten': {
        const k = Math.trunc(adj.week) - 1;
        if (k < 0 || !Number.isFinite(adj.factor)) break;
        s.lighten.set(k, (s.lighten.get(k) ?? 1) * clamp(adj.factor, ...PROGRESSION.lightenRange));
        break;
      }
      case 'repeat_week':
        repeatWeek(ctx, s, Math.trunc(adj.week) - 1);
        break;
      case 'skip_week':
        if (adj.week >= 1) skipWeek(ctx, s, Math.trunc(adj.week) - 1);
        break;
      case 'pause':
        pause(ctx, s, adj.from, adj.to);
        break;
      default:
        break;
    }
  }
  return s;
}

/** The first day a week-level edit changes; session edits before it on or after that day lapse. */
function structuralFrom(ctx: Context, adj: PlanAdjustment): IsoDate | null {
  switch (adj.type) {
    case 'pause':
      return adj.from;
    case 'repeat_week':
      return mondayOf(ctx, Math.trunc(adj.week));
    case 'skip_week':
      return mondayOf(ctx, Math.trunc(adj.week) - 1);
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Minutes: the level, week by week.

interface WeekState {
  k: number;
  monday: IsoDate;
  t: TemplateWeek | null;
  minutes: number;
  hard: number;
  /** Weeks of training before this one. */
  active: number;
}

function hardSessions(ctx: Context, t: TemplateWeek, firstBack: boolean, firstWeek: boolean): number {
  const level = ctx.input.level;
  const h = ctx.tpl.hardPerWeek[level];
  if (t.rung !== null || h === 0 || t.step + 1 < ctx.tpl.hardFromWeek[level]) return 0;
  let n: number;
  switch (t.focus) {
    case 'base':
    case 'taper':
      n = Math.min(1, h);
      break;
    case 'lighter':
      n = h - 1;
      break;
    case 'race':
      n = 0;
      break;
    default:
      n = h;
  }
  // One hard session at most in the first week of training, to settle in.
  if (firstWeek) n = Math.min(n, 1);
  return Math.max(0, firstBack ? n - 1 : n);
}

function simulate(ctx: Context, s: Structure): WeekState[] {
  const map = calendar(ctx, s);
  const resumes = [...s.resumes].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const out: WeekState[] = [];
  let level = ctx.startLevel;
  let started = false;
  let afterBreak = false;
  let pending = 1;
  let r = 0;
  let active = 0;
  for (let k = 0; k < map.length; k++) {
    const monday = mondayOf(ctx, k);
    const sunday = addDays(monday, 6);
    while (r < resumes.length && resumes[r]!.date <= sunday) pending *= resumes[r++]!.factor;
    const p = map[k];
    if (p === null || p === undefined) {
      out.push({ k, monday, t: null, minutes: 0, hard: 0, active });
      continue;
    }
    const t = s.weeks[p]!;
    if (pending < 1) {
      level *= Math.max(pending, 0.5);
      afterBreak = true;
      pending = 1;
    }
    // The first days back after a cut in the level are easier: that week, and the next one too
    // when training resumes late in the week, hold the level with one hard session fewer.
    const firstBack = resumes.some((x) => x.factor < 1 && x.date <= sunday && addDays(x.date, 3) >= monday);
    if (t.rung !== null) {
      // Run/walk weeks follow the ladder; the level waits for the first week of continuous running.
      out.push({ k, monday, t, minutes: 0, hard: 0, active });
      active++;
      continue;
    }
    let minutes: number;
    switch (t.focus) {
      case 'base':
        minutes = level;
        started = true;
        break;
      case 'build':
        if (started && !firstBack && !t.hold) {
          level = Math.min(ctx.peak, level * (afterBreak ? PROGRESSION.growthAfterBreak : PROGRESSION.growth));
          afterBreak = false;
        }
        minutes = level;
        started = true;
        break;
      case 'lighter':
        minutes = level * PROGRESSION.lighterFactor;
        started = true;
        afterBreak = true;
        break;
      default:
        minutes = level * t.taperFactor;
    }
    const lighten = s.lighten.get(k) ?? 1;
    if (lighten < 1) {
      minutes *= lighten;
      if (t.focus === 'build' || t.focus === 'base') {
        level = minutes;
        afterBreak = true;
      }
    }
    out.push({ k, monday, t, minutes, hard: hardSessions(ctx, t, firstBack, active === 0), active });
    active++;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Sessions

interface Built {
  kind: SessionKind;
  title: string;
  effort: Effort;
  blocks: WorkoutBlock[];
}

const step = (kind: WorkoutStep['kind'], effort: Effort, durationS: number): WorkoutStep => ({ kind, effort, durationS });
const one = (...steps: WorkoutStep[]): WorkoutBlock => ({ repeat: 1, steps });

export function blocksDurationS(blocks: WorkoutBlock[]): number {
  return blocks.reduce((sum, b) => sum + b.repeat * b.steps.reduce((t, st) => t + (st.durationS ?? 0), 0), 0);
}

function timeLabel(s: number): string {
  if (s % 60 === 0) return `${s / 60} min`;
  return s < 120 ? `${s} s` : `${(s / 60).toFixed(1)} min`;
}

function easyRun(durationS: number): Built {
  return { kind: 'easy', title: 'Easy run', effort: 'easy', blocks: [one(step('run', 'easy', durationS))] };
}

function longRun(durationS: number, steadyShare: number): Built {
  const steady = steadyShare > 0 ? round5((durationS / 60) * steadyShare) * 60 : 0;
  if (steady < 600) return { kind: 'long', title: 'Long run', effort: 'easy', blocks: [one(step('run', 'easy', durationS))] };
  return {
    kind: 'long',
    title: 'Long run, steady finish',
    effort: 'easy',
    blocks: [one(step('run', 'easy', durationS - steady), step('run', 'steady', steady))],
  };
}

/** Warm-up and cool-down for a hard session, by how long it is. */
function bookends(targetS: number): [number, number] {
  if (targetS <= 1800) return [300, 300];
  return [600, targetS >= 2700 ? 600 : 300];
}

function tempoRun(targetS: number, tpl: PlanTemplate): Built {
  const [wu, cd] = bookends(targetS);
  const main = Math.max(600, targetS - wu - cd);
  const work = Math.min(floorMin(main), tpl.maxTempoMin * 60);
  const warm = wu + Math.max(0, main - work);
  if (work <= 1200) {
    return {
      kind: 'tempo',
      title: `Tempo run: ${timeLabel(work)}`,
      effort: 'tempo',
      blocks: [one(step('warmup', 'easy', warm)), one(step('work', 'tempo', work)), one(step('cooldown', 'easy', cd))],
    };
  }
  const rep = floorMin((work - 120) / 2);
  return {
    kind: 'tempo',
    title: `Tempo run: 2 × ${timeLabel(rep)}`,
    effort: 'tempo',
    blocks: [
      one(step('warmup', 'easy', warm + (work - 120 - 2 * rep))),
      one(step('work', 'tempo', rep)),
      one(step('recover', 'easy', 120)),
      one(step('work', 'tempo', rep)),
      one(step('cooldown', 'easy', cd)),
    ],
  };
}

function intervals(targetS: number, tpl: PlanTemplate, level: PlanInput['level']): Built {
  const [wu, cd] = bookends(targetS);
  const main = Math.max(0, targetS - wu - cd);
  let [rep, rec] = tpl.intervalS[level];
  let reps = Math.floor(main / (rep + rec));
  if (reps < 2) {
    rep = Math.max(60, floorMin(main / 2 - rec));
    reps = 2;
  }
  reps = Math.min(reps, 10);
  const spare = Math.max(0, main - reps * (rep + rec));
  const extraWarm = Math.min(spare, 600);
  return {
    kind: 'intervals',
    title: `Intervals: ${reps} × ${timeLabel(rep)}`,
    effort: 'interval',
    blocks: [
      one(step('warmup', 'easy', wu + extraWarm)),
      { repeat: reps, steps: [step('work', 'interval', rep), step('recover', 'easy', rec)] },
      one(step('cooldown', 'easy', cd + (spare - extraWarm))),
    ],
  };
}

function steadyRun(targetS: number, tpl: PlanTemplate): Built {
  const [wu, cd] = bookends(targetS);
  const main = Math.max(600, targetS - wu - cd);
  const work = Math.min(floorMin(main), tpl.maxSteadyMin * 60);
  return {
    kind: 'steady',
    title: `Steady run: ${timeLabel(work)}`,
    effort: 'steady',
    blocks: [one(step('warmup', 'easy', wu + Math.max(0, main - work))), one(step('work', 'steady', work)), one(step('cooldown', 'easy', cd))],
  };
}

function runWalk(rung: number): Built {
  const r = RUN_WALK_LADDER[clamp(rung, 0, RUN_WALK_LADDER.length - 1)]!;
  const warm = step('warmup', 'walk', 300);
  const cool = step('cooldown', 'walk', 300);
  if (r.walkS === 0) {
    return { kind: 'run_walk', title: `Run ${timeLabel(r.runS)}`, effort: 'easy', blocks: [one(warm), one(step('run', 'easy', r.runS)), one(cool)] };
  }
  return {
    kind: 'run_walk',
    title: `Run/walk: ${r.repeats} × ${timeLabel(r.runS)}`,
    effort: 'easy',
    blocks: [one(warm), { repeat: r.repeats, steps: [step('run', 'easy', r.runS), step('walk', 'walk', r.walkS)] }, one(cool)],
  };
}

function hardSession(kind: SessionKind, targetS: number, ctx: Context): Built {
  switch (kind) {
    case 'intervals':
      return intervals(targetS, ctx.tpl, ctx.input.level);
    case 'steady':
      return steadyRun(targetS, ctx.tpl);
    default:
      return tempoRun(targetS, ctx.tpl);
  }
}

function toSession(w: WeekState, day: number, built: Built, durationS?: number, distanceM?: number): PlannedSession {
  return {
    id: `w${w.k + 1}-d${day}`,
    date: addDays(w.monday, day),
    week: w.k + 1,
    kind: built.kind,
    title: built.title,
    hard: HARD_KINDS.has(built.kind),
    durationS: durationS ?? blocksDurationS(built.blocks),
    distanceM: distanceM ?? null,
    effort: built.effort,
    blocks: built.blocks,
  };
}

function layoutWeek(ctx: Context, s: Structure, w: WeekState): PlannedSession[] {
  const t = w.t;
  if (!t) return [];
  const { input, tpl } = ctx;
  const level = input.level;
  const L = input.longRunDay;
  const off = (day: number) => {
    const date = addDays(w.monday, day);
    return s.paused.has(date) || date < ctx.firstDay || (ctx.raceDate !== null && date > ctx.raceDate);
  };
  const dayOf = (offset: number) => (L + offset) % 7;
  const maxDays = clamp(Math.min(input.daysPerWeek, tpl.maxDays[level]), 2, 6);
  const sessions: PlannedSession[] = [];

  if (t.rung !== null) {
    for (const o of DAY_PATTERNS[Math.min(maxDays, RUN_WALK_DAYS)]!) {
      if (!off(dayOf(o))) sessions.push(toSession(w, dayOf(o), runWalk(t.rung)));
    }
    return sessions;
  }

  if (t.focus === 'race' && ctx.raceDate && tpl.race) {
    // Race week: a couple of short easy runs, a rest day before the race, then the race.
    const raceDay = isoWeekday(ctx.raceDate);
    const before = DAY_PATTERNS[maxDays]!.map(dayOf)
      .filter((d) => d <= raceDay - 2)
      .sort((a, b) => a - b)
      .slice(-2);
    const easyMin = clamp(round5(w.minutes / (before.length + 1)), 20, 30);
    for (const d of before) if (!off(d)) sessions.push(toSession(w, d, easyRun(easyMin * 60)));
    if (!off(raceDay)) {
      const raceM = EFFORT_DISTANCE_M[tpl.race];
      const built: Built = {
        kind: 'race',
        title: `Race day: ${RACE_NAMES[tpl.race]}`,
        effort: 'race',
        blocks: [{ repeat: 1, steps: [{ kind: 'run', effort: 'race', distanceM: raceM }] }],
      };
      sessions.push(toSession(w, raceDay, built, ctx.raceTimeS ?? undefined, raceM));
    }
    return sessions;
  }

  const M = w.minutes;
  const maxSession = input.maxSessionMin ?? Infinity;
  const historyCap = input.history.longestRunMin > 0 ? round5(input.history.longestRunMin + 10 + 10 * w.active) : Infinity;
  const longCap = Math.max(PROGRESSION.minSessionMin, Math.min(tpl.longRunCapMin[level], historyCap, maxSession));
  const hardMin = clamp(round5(M * PROGRESSION.hardShare), PROGRESSION.hardMinMin, Math.min(PROGRESSION.hardMaxMin, maxSession));
  const hardCap = (days: number) => Math.min(w.hard, days <= 2 ? 0 : days === 3 ? 1 : 2);
  const longFor = (days: number) => {
    const share = days === 2 ? LONG_SHARE[2]! : Math.min(MAX_LONG_SHARE, LONG_SHARE[days]! + tpl.longShareBonus);
    return clamp(round5(M * share), PROGRESSION.minSessionMin, longCap);
  };
  // As many of the runner's days as the week's minutes fill, the other runs at least 15 minutes.
  let days = maxDays;
  while (days > 2) {
    const h = hardCap(days);
    if (longFor(days) + h * hardMin + (days - 1 - h) * PROGRESSION.minEasyMin <= M + 2.5) break;
    days--;
  }
  const pattern = DAY_PATTERNS[days]!;
  const hardOffsets = HARD_OFFSETS.filter((o) => pattern.includes(o)).slice(0, hardCap(days));
  const easyOffsets = pattern.filter((o) => o !== 0 && !hardOffsets.includes(o));
  let longMin = longFor(days);
  // The easy runs take what's left, in five-minute steps, so rounding doesn't add up week to week.
  const easyCap = Math.min(longMin, PROGRESSION.maxEasyMin, maxSession);
  const easyUnits = Math.max(0, Math.round((M - longMin - hardOffsets.length * hardMin) / 5));
  const easyMins = easyOffsets.map((_, i) => {
    const n = easyOffsets.length;
    const units = Math.floor(easyUnits / n) + (i >= n - (easyUnits % n) ? 1 : 0);
    return clamp(units * 5, PROGRESSION.minEasyMin, easyCap);
  });
  // When the other runs are capped, the long run stays no more than half the week.
  const others = hardOffsets.length * hardMin + easyMins.reduce((a, b) => a + b, 0);
  if (days >= 3 && longMin > others) longMin = Math.max(PROGRESSION.minSessionMin, Math.floor(others / 5) * 5);

  const steadyFinish = level !== 'beginner' && t.focus === 'build' && t.step >= ctx.buildWeeks / 2 ? tpl.steadyFinish : 0;
  const hardKinds = [tpl.hardKinds.first, tpl.hardKinds.second].map((list) => list[t.step % list.length]!);
  const beforeRace = ctx.raceDate ? addDays(ctx.raceDate, -2) : null;

  for (const o of pattern) {
    const day = dayOf(o);
    if (off(day)) continue;
    if (o === 0) {
      sessions.push(toSession(w, day, longRun(longMin * 60, steadyFinish)));
      continue;
    }
    const h = hardOffsets.indexOf(o);
    const date = addDays(w.monday, day);
    // Nothing hard in the two days before the race.
    if (h >= 0 && !(beforeRace && date >= beforeRace)) {
      sessions.push(toSession(w, day, hardSession(hardKinds[h]!, hardMin * 60, ctx)));
    } else {
      const easyMin = h >= 0 ? Math.min(hardMin, 30) : (easyMins[easyOffsets.indexOf(o)] ?? PROGRESSION.minEasyMin);
      sessions.push(toSession(w, day, easyRun(easyMin * 60)));
    }
  }
  return sessions;
}

// ---------------------------------------------------------------------------------------------
// Session edits

function originalDate(ctx: Context, id: string): IsoDate | null {
  const m = SESSION_ID.exec(id);
  return m ? addDays(ctx.start, (Number(m[1]) - 1) * 7 + Number(m[2])) : null;
}

function scaleBlocks(blocks: WorkoutBlock[], targetS: number): WorkoutBlock[] {
  const current = blocksDurationS(blocks);
  if (current <= 0) return blocks;
  if (blocks.length === 1 && blocks[0]!.repeat === 1 && blocks[0]!.steps.length === 1) {
    return [one({ ...blocks[0]!.steps[0]!, durationS: targetS })];
  }
  const f = targetS / current;
  const scaled = blocks.map((b) =>
    b.repeat > 1
      ? { ...b, repeat: Math.max(1, Math.round(b.repeat * f)) }
      : { ...b, steps: b.steps.map((st) => (st.durationS ? { ...st, durationS: Math.max(60, Math.round((st.durationS * f) / 10) * 10) } : st)) },
  );
  // Make up the difference in the first single step (the warm-up, or the run itself).
  const diff = targetS - blocksDurationS(scaled);
  const first = scaled.find((b) => b.repeat === 1 && b.steps.length === 1 && b.steps[0]!.durationS);
  if (first && diff !== 0) {
    const st = first.steps[0]!;
    const next = (st.durationS ?? 0) + diff;
    if (next >= 60) first.steps = [{ ...st, durationS: next }];
  }
  return scaled;
}

const KIND_FOR_EFFORT: Partial<Record<Effort, SessionKind>> = { steady: 'steady', tempo: 'tempo', interval: 'intervals' };
const TITLE_FOR_KIND: Record<SessionKind, string> = {
  easy: 'Easy run',
  long: 'Long run',
  tempo: 'Tempo run',
  intervals: 'Intervals',
  steady: 'Steady run',
  run_walk: 'Run/walk',
  race: 'Race',
};

function applySessionEdits(ctx: Context, sessions: PlannedSession[], adjustments: PlanAdjustment[], endDate: IsoDate) {
  // A week-level edit recalculates the plan from its first day, so session edits made before it
  // lapse from that day on.
  const cutoff: (IsoDate | null)[] = [];
  let earliest: IsoDate | null = null;
  for (let i = adjustments.length - 1; i >= 0; i--) {
    cutoff[i] = earliest;
    const from = structuralFrom(ctx, adjustments[i]!);
    if (from !== null && (earliest === null || from < earliest)) earliest = from;
  }
  const byId = new Map(sessions.map((x) => [x.id, x]));
  adjustments.forEach((adj, i) => {
    const cut = cutoff[i] ?? null;
    const live = (id: string) => {
      const x = byId.get(id);
      if (!x) return null;
      if (cut !== null && ((originalDate(ctx, id) ?? x.date) >= cut || x.date >= cut)) return null;
      return x;
    };
    switch (adj.type) {
      case 'move': {
        const x = live(adj.sessionId);
        if (!x || !isDate(adj.toDate) || adj.toDate < ctx.firstDay || adj.toDate > endDate) break;
        if (cut !== null && adj.toDate >= cut) break;
        x.date = adj.toDate;
        x.edited = true;
        break;
      }
      case 'swap': {
        const a = live(adj.a);
        const b = live(adj.b);
        if (!a || !b || a === b) break;
        [a.date, b.date] = [b.date, a.date];
        a.edited = true;
        b.edited = true;
        break;
      }
      case 'set_duration': {
        const x = live(adj.sessionId);
        if (!x || x.kind === 'race' || !Number.isFinite(adj.durationS)) break;
        x.blocks = scaleBlocks(x.blocks, clamp(Math.round(adj.durationS), 300, 6 * 3600));
        x.durationS = blocksDurationS(x.blocks);
        x.edited = true;
        break;
      }
      case 'set_effort': {
        const x = live(adj.sessionId);
        if (!x || x.kind === 'race' || adj.effort === 'race') break;
        x.blocks = x.blocks.map((b) => ({
          ...b,
          steps: b.steps.map((st) => (st.kind === 'run' || st.kind === 'work' ? { ...st, effort: adj.effort } : st)),
        }));
        x.effort = adj.effort;
        const kind = KIND_FOR_EFFORT[adj.effort] ?? (x.kind === 'long' || x.kind === 'run_walk' ? x.kind : 'easy');
        if (kind !== x.kind) x.title = TITLE_FOR_KIND[kind];
        if (adj.effort === 'walk') x.title = 'Walk';
        x.kind = kind;
        x.hard = HARD_KINDS.has(kind);
        x.edited = true;
        break;
      }
      case 'easy_instead': {
        const x = live(adj.sessionId);
        if (!x || x.kind === 'race') break;
        if (x.kind === 'run_walk') {
          x.blocks = x.blocks.map((b) => (b.repeat > 1 ? { ...b, repeat: Math.max(2, Math.round(b.repeat * 0.6)) } : b));
        } else {
          const easy = easyRun(clamp(round5((x.durationS / 60) * 0.7), PROGRESSION.minSessionMin, 40) * 60);
          Object.assign(x, { kind: easy.kind, title: easy.title, effort: easy.effort, blocks: easy.blocks, hard: false, distanceM: null });
        }
        x.durationS = blocksDurationS(x.blocks);
        x.edited = true;
        break;
      }
      case 'rest_instead': {
        const x = live(adj.sessionId);
        if (x) byId.delete(x.id);
        break;
      }
      default:
        break;
    }
  });
  return [...byId.values()];
}

// ---------------------------------------------------------------------------------------------

/** The whole plan from the runner's answers and edits. Throws a RangeError on bad input. */
export function generatePlan(input: PlanInput, adjustments: PlanAdjustment[] = []): Plan {
  const problem = validatePlanInput(input);
  if (problem) throw new RangeError(problem);
  const ctx = context(input);
  const s = structure(ctx, adjustments);
  const states = simulate(ctx, s);
  const lastMonday = mondayOf(ctx, Math.max(0, states.length - 1));
  const endDate = ctx.raceDate ?? addDays(lastMonday, 6);

  // Sessions are built fresh on every call, so the edits below can change them in place.
  const laid = states.flatMap((w) => layoutWeek(ctx, s, w));
  const sessions = applySessionEdits(ctx, laid, adjustments, endDate);

  const weeks: PlanWeek[] = states.map((w) => {
    let daysOff = 0;
    for (let d = 0; d < 7; d++) {
      const date = addDays(w.monday, d);
      if (s.paused.has(date) || date < ctx.firstDay) daysOff++;
    }
    return { index: w.k + 1, startDate: w.monday, focus: w.t ? w.t.focus : 'paused', minutes: 0, daysOff, sessions: [] };
  });
  for (const x of sessions) {
    const k = weekIndexOf(ctx, x.date);
    const week = weeks[k];
    if (!week) continue;
    x.week = k + 1;
    week.sessions.push(x);
  }
  for (const week of weeks) {
    week.sessions.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1));
    week.minutes = Math.round(week.sessions.reduce((sum, x) => sum + x.durationS, 0) / 60);
  }

  const plan: Plan = {
    engineVersion: PLAN_ENGINE_VERSION,
    input,
    adjustments,
    endDate,
    weeks,
    zones: ctx.zones,
    predictedTimeS: ctx.predictedTimeS,
    warnings: [],
  };
  plan.warnings = [...ctx.warnings, ...planWarnings(plan)];
  return plan;
}

/** Every session in the plan, in date order. */
export function planSessions(plan: Plan): PlannedSession[] {
  return plan.weeks.flatMap((w) => w.sessions);
}

/** The sessions on a date: today's workout on Home. */
export function sessionsOn(plan: Plan, date: IsoDate): PlannedSession[] {
  return planSessions(plan).filter((x) => x.date === date);
}
