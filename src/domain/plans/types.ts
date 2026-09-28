import type { IsoDate } from '../types';

/**
 * Training plans (docs/ROADMAP.md 3.1, 3.2 and Part B). A plan is a pure function of what the
 * runner told us (the input) and what they changed since (the adjustments), so it can be
 * recalculated from any edit onward and tested with golden cases, like scoring. No generative AI:
 * the numbers are rules. Every template waits for the coach's review before launch.
 */
export const PLAN_ENGINE_VERSION = 1;

export type PlanType = 'start_running' | '5k' | '10k' | 'half' | 'marathon' | 'consistency' | 'return';
export type PlanLevel = 'beginner' | 'intermediate' | 'advanced';
export type SessionKind = 'easy' | 'long' | 'tempo' | 'intervals' | 'steady' | 'run_walk' | 'race';
export type Effort = 'easy' | 'steady' | 'tempo' | 'interval' | 'race' | 'walk';

/** Seconds per kilometre; `fast` is the lower number. */
export interface PaceRange {
  fastSPerKm: number;
  slowSPerKm: number;
}

export type PaceZones = Record<Exclude<Effort, 'walk'>, PaceRange>;

export interface WorkoutStep {
  kind: 'warmup' | 'run' | 'walk' | 'work' | 'recover' | 'cooldown';
  effort: Effort;
  durationS?: number;
  distanceM?: number;
}

/** Steps done `repeat` times in a row. */
export interface WorkoutBlock {
  repeat: number;
  steps: WorkoutStep[];
}

export interface PlannedSession {
  /** Stable within a plan: the week and the original day, e.g. "w3-d1". */
  id: string;
  date: IsoDate;
  week: number;
  kind: SessionKind;
  title: string;
  hard: boolean;
  /** Everything, warm-up and cool-down included. */
  durationS: number;
  /** Set when the session is a distance (a race). */
  distanceM: number | null;
  effort: Effort;
  blocks: WorkoutBlock[];
  /** The runner changed this session. */
  edited?: boolean;
}

/** `base` holds steady before a race plan's usual build, when the race is further off than usual. */
export type WeekFocus = 'base' | 'build' | 'lighter' | 'taper' | 'race' | 'paused';

export interface PlanWeek {
  index: number;
  /** A Monday. */
  startDate: IsoDate;
  focus: WeekFocus;
  /** Planned minutes: the sum of the week's sessions. */
  minutes: number;
  /** Days without training because of a pause, or before the plan began. */
  daysOff: number;
  sessions: PlannedSession[];
}

export type EffortKey = '1k' | '1mi' | '5k' | '10k' | 'half' | 'marathon';

export interface PlanHistory {
  /** Minutes run in each of the last four weeks, oldest first. */
  weeklyMinutes: number[];
  longestRunMin: number;
  /** Best times in seconds, from personal records (1.4). */
  bestEfforts: Partial<Record<EffortKey, number>>;
}

export interface PlanInput {
  type: PlanType;
  level: PlanLevel;
  /** A Monday. */
  startDate: IsoDate;
  /** The first day with sessions, when the plan starts partway through its first week. */
  firstDay?: IsoDate | null;
  /** Race plans; null means "the usual length". */
  raceDate: IsoDate | null;
  /** Null is a finish-only goal. */
  goalTimeS: number | null;
  /** 2 to 6. */
  daysPerWeek: number;
  /** 0 = Monday … 6 = Sunday. */
  longRunDay: number;
  /** The longest session the runner will do. */
  maxSessionMin: number | null;
  recentInjury: boolean;
  history: PlanHistory;
}

/** What the runner changed, applied in order. The plan is recalculated from them. */
export type PlanAdjustment =
  | { type: 'lighten'; week: number; factor: number }
  | { type: 'pause'; from: IsoDate; to: IsoDate }
  | { type: 'repeat_week'; week: number }
  | { type: 'skip_week'; week: number }
  | { type: 'move'; sessionId: string; toDate: IsoDate }
  | { type: 'swap'; a: string; b: string }
  | { type: 'set_duration'; sessionId: string; durationS: number }
  | { type: 'set_effort'; sessionId: string; effort: Effort }
  | { type: 'easy_instead'; sessionId: string }
  | { type: 'rest_instead'; sessionId: string };

export type PlanWarningCode =
  | 'goal_ambitious'
  | 'short_runway'
  | 'two_hard_days'
  | 'too_many_hard'
  | 'big_jump'
  | 'long_run_share'
  | 'over_max_session';

export interface PlanWarning {
  code: PlanWarningCode;
  week?: number;
  sessionId?: string;
}

export interface Plan {
  engineVersion: number;
  input: PlanInput;
  adjustments: PlanAdjustment[];
  /** The race day, or the last day of the last week. */
  endDate: IsoDate;
  weeks: PlanWeek[];
  /** Null when there are no best efforts: train by effort. */
  zones: PaceZones | null;
  /** Race time predicted from current fitness, for race plans with best efforts. */
  predictedTimeS: number | null;
  warnings: PlanWarning[];
}
