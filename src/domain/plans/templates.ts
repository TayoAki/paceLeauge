import type { EffortKey, PlanLevel, PlanType, SessionKind } from './types';

/**
 * Plan templates (docs/ROADMAP.md Part B). These are starting points for the coach's review, not
 * final numbers: the coach sets the weeks, volumes and sessions before launch (3.1), and every
 * change here shows up in the golden tests.
 */

type ByLevel<T> = Record<PlanLevel, T>;

export interface RunWalkRung {
  runS: number;
  walkS: number;
  repeats: number;
}

/** From one-minute runs to 30 minutes without stopping, one rung a week. */
export const RUN_WALK_LADDER: RunWalkRung[] = [
  { runS: 60, walkS: 90, repeats: 8 },
  { runS: 90, walkS: 90, repeats: 7 },
  { runS: 120, walkS: 90, repeats: 6 },
  { runS: 180, walkS: 90, repeats: 5 },
  { runS: 300, walkS: 120, repeats: 4 },
  { runS: 480, walkS: 90, repeats: 3 },
  { runS: 900, walkS: 60, repeats: 2 },
  { runS: 1800, walkS: 0, repeats: 1 },
];

export interface PlanTemplate {
  type: PlanType;
  /** The race a plan builds to; null for plans without one. */
  race: EffortKey | null;
  /** The usual length in weeks. Race plans stretch or shrink to the race date. */
  weeks: ByLevel<number>;
  /** Fewer weeks than this before the race draws a warning. */
  minWeeks: number;
  /** Weekly running minutes to start from without history, and the most the plan builds to. */
  startMin: ByLevel<number>;
  peakMin: ByLevel<number>;
  /** Hard sessions in a full week. */
  hardPerWeek: ByLevel<number>;
  /** The first week with a hard session. */
  hardFromWeek: ByLevel<number>;
  /** The first hard session of a week alternates through `first`; a second one uses `second`. */
  hardKinds: { first: SessionKind[]; second: SessionKind[] };
  /** Weeks of taper, the race week included. */
  taperWeeks: number;
  longRunCapMin: ByLevel<number>;
  /** Added to the long run's share of the week, for the longer races. */
  longShareBonus: number;
  /** The fewest run days a week the plan works with, and the most it uses. */
  minDays: number;
  maxDays: ByLevel<number>;
  /** Run/walk weeks at the start: the first rung for each level, and for how many weeks. */
  runWalk: {
    startRung: ByLevel<number>;
    /** Null runs the ladder to its end. */
    weeks: number | null;
    /** `beginner_or_injury` only uses the ladder for beginners and after an injury. */
    when: 'always' | 'beginner_or_injury';
  } | null;
  /** Interval repetitions: work and recovery, in seconds. */
  intervalS: ByLevel<[number, number]>;
  /** The longest continuous steady or tempo work in one session, in minutes. */
  maxSteadyMin: number;
  maxTempoMin: number;
  /** A steady finish on long runs in the second half of the build (not for beginners). */
  steadyFinish: number;
}

const all = <T>(value: T): ByLevel<T> => ({ beginner: value, intermediate: value, advanced: value });

export const TEMPLATES: Record<PlanType, PlanTemplate> = {
  start_running: {
    type: 'start_running',
    race: null,
    weeks: { beginner: 8, intermediate: 6, advanced: 5 },
    minWeeks: 1,
    startMin: all(30),
    peakMin: all(120),
    hardPerWeek: all(0),
    hardFromWeek: all(99),
    hardKinds: { first: ['steady'], second: ['steady'] },
    taperWeeks: 0,
    longRunCapMin: all(45),
    longShareBonus: 0,
    minDays: 2,
    maxDays: all(3),
    runWalk: { startRung: { beginner: 0, intermediate: 2, advanced: 3 }, weeks: null, when: 'always' },
    intervalS: all([60, 90]),
    maxSteadyMin: 0,
    maxTempoMin: 0,
    steadyFinish: 0,
  },
  '5k': {
    type: '5k',
    race: '5k',
    weeks: all(8),
    minWeeks: 4,
    startMin: { beginner: 60, intermediate: 120, advanced: 180 },
    peakMin: { beginner: 150, intermediate: 210, advanced: 280 },
    hardPerWeek: { beginner: 1, intermediate: 2, advanced: 2 },
    hardFromWeek: { beginner: 2, intermediate: 1, advanced: 1 },
    hardKinds: { first: ['intervals', 'tempo'], second: ['tempo', 'intervals'] },
    taperWeeks: 1,
    longRunCapMin: { beginner: 60, intermediate: 75, advanced: 90 },
    longShareBonus: 0,
    minDays: 2,
    maxDays: all(6),
    runWalk: null,
    intervalS: { beginner: [120, 120], intermediate: [180, 120], advanced: [180, 90] },
    maxSteadyMin: 30,
    maxTempoMin: 25,
    steadyFinish: 0,
  },
  '10k': {
    type: '10k',
    race: '10k',
    weeks: all(10),
    minWeeks: 5,
    startMin: { beginner: 75, intermediate: 140, advanced: 200 },
    peakMin: { beginner: 180, intermediate: 250, advanced: 330 },
    hardPerWeek: { beginner: 1, intermediate: 2, advanced: 2 },
    hardFromWeek: { beginner: 2, intermediate: 1, advanced: 1 },
    hardKinds: { first: ['tempo', 'intervals'], second: ['intervals', 'tempo'] },
    taperWeeks: 1,
    longRunCapMin: { beginner: 75, intermediate: 90, advanced: 105 },
    longShareBonus: 0.02,
    minDays: 2,
    maxDays: all(6),
    runWalk: null,
    intervalS: { beginner: [180, 120], intermediate: [240, 120], advanced: [300, 120] },
    maxSteadyMin: 40,
    maxTempoMin: 30,
    steadyFinish: 0,
  },
  half: {
    type: 'half',
    race: 'half',
    weeks: all(12),
    minWeeks: 6,
    startMin: { beginner: 90, intermediate: 150, advanced: 220 },
    peakMin: { beginner: 220, intermediate: 310, advanced: 420 },
    hardPerWeek: { beginner: 1, intermediate: 2, advanced: 2 },
    hardFromWeek: { beginner: 2, intermediate: 1, advanced: 1 },
    hardKinds: { first: ['tempo', 'intervals'], second: ['steady', 'steady'] },
    taperWeeks: 2,
    longRunCapMin: { beginner: 120, intermediate: 135, advanced: 150 },
    longShareBonus: 0.05,
    minDays: 3,
    maxDays: all(6),
    runWalk: null,
    intervalS: { beginner: [240, 120], intermediate: [300, 120], advanced: [360, 120] },
    maxSteadyMin: 45,
    maxTempoMin: 35,
    steadyFinish: 0.2,
  },
  marathon: {
    type: 'marathon',
    race: 'marathon',
    weeks: { beginner: 18, intermediate: 16, advanced: 16 },
    minWeeks: 10,
    startMin: { beginner: 120, intermediate: 180, advanced: 260 },
    peakMin: { beginner: 280, intermediate: 400, advanced: 520 },
    hardPerWeek: { beginner: 1, intermediate: 2, advanced: 2 },
    hardFromWeek: { beginner: 3, intermediate: 2, advanced: 1 },
    hardKinds: { first: ['steady', 'steady'], second: ['tempo', 'intervals'] },
    taperWeeks: 3,
    longRunCapMin: { beginner: 180, intermediate: 195, advanced: 210 },
    longShareBonus: 0.12,
    minDays: 3,
    maxDays: all(6),
    runWalk: null,
    intervalS: { beginner: [300, 120], intermediate: [360, 120], advanced: [480, 120] },
    maxSteadyMin: 60,
    maxTempoMin: 40,
    steadyFinish: 0.2,
  },
  consistency: {
    type: 'consistency',
    race: null,
    weeks: all(8),
    minWeeks: 1,
    startMin: { beginner: 60, intermediate: 120, advanced: 180 },
    peakMin: { beginner: 120, intermediate: 200, advanced: 300 },
    hardPerWeek: { beginner: 0, intermediate: 1, advanced: 1 },
    hardFromWeek: all(2),
    hardKinds: { first: ['steady', 'tempo'], second: ['intervals'] },
    taperWeeks: 0,
    longRunCapMin: { beginner: 60, intermediate: 90, advanced: 120 },
    longShareBonus: 0,
    minDays: 2,
    maxDays: all(6),
    runWalk: null,
    intervalS: { beginner: [120, 120], intermediate: [180, 120], advanced: [240, 120] },
    maxSteadyMin: 30,
    maxTempoMin: 25,
    steadyFinish: 0,
  },
  return: {
    type: 'return',
    race: null,
    weeks: all(6),
    minWeeks: 1,
    startMin: { beginner: 45, intermediate: 75, advanced: 100 },
    peakMin: { beginner: 100, intermediate: 160, advanced: 220 },
    hardPerWeek: { beginner: 0, intermediate: 1, advanced: 1 },
    hardFromWeek: all(4),
    hardKinds: { first: ['steady'], second: ['steady'] },
    taperWeeks: 0,
    longRunCapMin: { beginner: 45, intermediate: 70, advanced: 90 },
    longShareBonus: 0,
    minDays: 2,
    maxDays: { beginner: 3, intermediate: 4, advanced: 5 },
    runWalk: { startRung: all(3), weeks: 2, when: 'beginner_or_injury' },
    intervalS: all([120, 120]),
    maxSteadyMin: 20,
    maxTempoMin: 0,
    steadyFinish: 0,
  },
};

/** A pace for estimating race and session times when there are no best efforts, seconds per km. */
export const DEFAULT_PACE_S_PER_KM: ByLevel<number> = { beginner: 420, intermediate: 330, advanced: 270 };

export const PLAN_TYPES: PlanType[] = ['start_running', '5k', '10k', 'half', 'marathon', 'consistency', 'return'];
export const PLAN_LEVELS: PlanLevel[] = ['beginner', 'intermediate', 'advanced'];
