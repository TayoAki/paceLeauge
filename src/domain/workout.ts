import { spokenDistance } from './cues';
import type { Effort, WorkoutBlock, WorkoutStep } from './plans/types';
import type { Units } from './types';

/**
 * Following a workout during a run (docs/ROADMAP.md 3.1 and 3.4): a plan session or a guided run
 * is a list of steps ended by active time or by distance. Pauses stop the clock, as they do for
 * the run. The position is a small value that only moves forward, so it can be saved and picked
 * up after a relaunch.
 */

export interface TimelineStep {
  index: number;
  kind: WorkoutStep['kind'];
  effort: Effort;
  durationS: number | null;
  distanceM: number | null;
  /** Which repetition this is, for steps inside repeats. */
  rep: { n: number; of: number } | null;
}

export interface WorkoutProgress {
  /** The current step; the step count once the workout is done. */
  index: number;
  /** Active seconds and metres when the current step began. */
  startS: number;
  startM: number;
}

export const WORKOUT_START: WorkoutProgress = { index: 0, startS: 0, startM: 0 };

export function flattenWorkout(blocks: WorkoutBlock[]): TimelineStep[] {
  const steps: TimelineStep[] = [];
  for (const block of blocks) {
    for (let n = 1; n <= block.repeat; n++) {
      for (const st of block.steps) {
        steps.push({
          index: steps.length,
          kind: st.kind,
          effort: st.effort,
          durationS: st.durationS ?? null,
          distanceM: st.distanceM ?? null,
          rep: block.repeat > 1 ? { n, of: block.repeat } : null,
        });
      }
    }
  }
  return steps;
}

function stepDone(step: TimelineStep, p: WorkoutProgress, activeS: number, distanceM: number): boolean {
  if (step.durationS !== null) return activeS - p.startS >= step.durationS;
  if (step.distanceM !== null) return distanceM - p.startM >= step.distanceM;
  return false;
}

/**
 * Moves through the steps that active time and distance have finished. A time step ends exactly at
 * its length, so the next one starts on time even when updates arrive late.
 */
export function advanceWorkout(
  steps: TimelineStep[],
  progress: WorkoutProgress,
  activeS: number,
  distanceM: number,
): { progress: WorkoutProgress; entered: number[] } {
  let p = progress;
  const entered: number[] = [];
  while (p.index < steps.length) {
    const step = steps[p.index]!;
    if (!stepDone(step, p, activeS, distanceM)) break;
    p = {
      index: p.index + 1,
      startS: step.durationS !== null ? p.startS + step.durationS : activeS,
      startM: step.distanceM !== null ? p.startM + step.distanceM : distanceM,
    };
    entered.push(p.index);
  }
  return { progress: p, entered };
}

/** Ends the current step now (the runner skipped it). */
export function skipStep(steps: TimelineStep[], progress: WorkoutProgress, activeS: number, distanceM: number): WorkoutProgress {
  if (progress.index >= steps.length) return progress;
  return { index: progress.index + 1, startS: activeS, startM: distanceM };
}

export interface StepPosition {
  step: TimelineStep | null;
  next: TimelineStep | null;
  /** Left in the current step. */
  remainingS: number | null;
  remainingM: number | null;
  /** 0–1 through the current step. */
  fraction: number;
  done: boolean;
}

export function stepPosition(steps: TimelineStep[], progress: WorkoutProgress, activeS: number, distanceM: number): StepPosition {
  const step = steps[progress.index] ?? null;
  const next = steps[progress.index + 1] ?? null;
  if (!step) return { step: null, next: null, remainingS: null, remainingM: null, fraction: 1, done: true };
  if (step.durationS !== null) {
    const into = Math.max(0, activeS - progress.startS);
    return { step, next, remainingS: Math.max(0, step.durationS - into), remainingM: null, fraction: Math.min(1, into / step.durationS), done: false };
  }
  if (step.distanceM !== null) {
    const into = Math.max(0, distanceM - progress.startM);
    return { step, next, remainingS: null, remainingM: Math.max(0, step.distanceM - into), fraction: Math.min(1, into / step.distanceM), done: false };
  }
  return { step, next, remainingS: null, remainingM: null, fraction: 0, done: false };
}

/** Whole active seconds a time-only workout takes; null when a step is a distance. */
export function workoutDurationS(steps: TimelineStep[]): number | null {
  let total = 0;
  for (const s of steps) {
    if (s.durationS === null) return null;
    total += s.durationS;
  }
  return total;
}

// ---------------------------------------------------------------------------------------------
// Words

const EFFORT_WORDS: Record<Effort, string> = {
  easy: 'easy',
  steady: 'steady',
  tempo: 'at tempo, comfortably hard',
  interval: 'hard',
  race: 'at race pace',
  walk: 'walking',
};

function spokenLength(step: TimelineStep, units: Units): string {
  if (step.distanceM !== null) return spokenDistance(step.distanceM, units);
  const s = step.durationS ?? 0;
  if (s < 60) return `${s} seconds`;
  const min = Math.floor(s / 60);
  const sec = s % 60;
  const minutes = `${min} ${min === 1 ? 'minute' : 'minutes'}`;
  return sec === 0 ? minutes : sec === 30 ? `${min} and a half minutes` : `${minutes} ${sec} seconds`;
}

/** What to say as a step begins: short, and the effort in words. */
export function stepCueText(step: TimelineStep, units: Units): string {
  const length = spokenLength(step, units);
  const rep = step.rep ? `${step.rep.n} of ${step.rep.of}. ` : '';
  switch (step.kind) {
    case 'warmup':
      return step.effort === 'walk' ? `Warm up: walk for ${length}.` : `Warm up: ${length} easy.`;
    case 'cooldown':
      return step.effort === 'walk' ? `Cool down: walk for ${length}.` : `Cool down: ${length} easy.`;
    case 'recover':
      return `${rep}Recover: ${length} easy.`;
    case 'walk':
      return `${rep}Walk for ${length}.`;
    case 'work':
      return `${rep}Go: ${length} ${EFFORT_WORDS[step.effort]}.`;
    default:
      return step.effort === 'race' ? `Race: ${length}. Go well.` : `${rep}Run ${EFFORT_WORDS[step.effort]} for ${length}.`;
  }
}

export const WORKOUT_DONE_TEXT = 'Workout complete. Well done. Keep moving easy, or finish when you’re ready.';

/** On screen: "Rep 2 of 5 · Hard". */
export function stepLabel(step: TimelineStep): string {
  const names: Record<TimelineStep['kind'], string> = {
    warmup: 'Warm-up',
    cooldown: 'Cool-down',
    recover: 'Recover',
    walk: 'Walk',
    work: 'Work',
    run: 'Run',
  };
  const effort = { easy: 'Easy', steady: 'Steady', tempo: 'Tempo', interval: 'Hard', race: 'Race', walk: 'Walk' }[step.effort];
  const base = step.kind === 'work' || step.kind === 'run' ? effort : names[step.kind];
  return step.rep ? `${base} · ${step.rep.n} of ${step.rep.of}` : base;
}
