import type { Effort, WorkoutBlock, WorkoutStep } from '@/domain/plans/types';
import { flattenWorkout, workoutDurationS } from '@/domain/workout';
import type { CoachLine } from '@/features/workout/workout-controller';

/**
 * Audio-guided runs (docs/ROADMAP.md 3.4). Each run is a workout plus coaching lines placed on its
 * timeline. These scripts are drafts for the running coach to rewrite and approve; until voice
 * talent records them, the phone's speech voice reads them (decision 5 plans human voices).
 * Everything here ships with the app, so guided runs work offline.
 *
 * A line is anchored to a step: [step index, seconds into that step, words], so a timing change
 * in the workout moves its lines with it.
 */

export type GuidedKind = 'first_run' | 'easy' | 'recovery' | 'tempo' | 'intervals' | 'long' | 'mindful';

export interface GuidedRun {
  id: string;
  title: string;
  kind: GuidedKind;
  level: 'new' | 'all' | 'experienced';
  /** In the free starter set; the rest need Pro (decision 4). */
  free: boolean;
  summary: string;
  blocks: WorkoutBlock[];
  script: [step: number, afterS: number, text: string][];
}

export const GUIDED_KIND_NAMES: Record<GuidedKind, string> = {
  first_run: 'First run',
  easy: 'Easy',
  recovery: 'Recovery',
  tempo: 'Tempo',
  intervals: 'Intervals',
  long: 'Long run',
  mindful: 'Mindful',
};

const MIN = 60;
const step = (kind: WorkoutStep['kind'], effort: Effort, minutes: number): WorkoutStep => ({ kind, effort, durationS: Math.round(minutes * MIN) });
const one = (...steps: WorkoutStep[]): WorkoutBlock => ({ repeat: 1, steps });
const warm = (min: number, effort: Effort = 'easy') => one(step('warmup', effort, min));
const cool = (min: number, effort: Effort = 'easy') => one(step('cooldown', effort, min));
const run = (min: number, effort: Effort = 'easy') => one(step('run', effort, min));
const reps = (n: number, workMin: number, effort: Effort, restMin: number, restKind: 'recover' | 'walk' = 'recover'): WorkoutBlock => ({
  repeat: n,
  steps: [step(restKind === 'walk' ? 'run' : 'work', effort, workMin), step(restKind, restKind === 'walk' ? 'walk' : 'easy', restMin)],
});

export const GUIDED_RUNS: GuidedRun[] = [
  {
    id: 'first-run',
    title: 'Your first run',
    kind: 'first_run',
    level: 'new',
    free: true,
    summary: 'Six one-minute runs with walks between. Slow is perfect.',
    blocks: [warm(4, 'walk'), reps(6, 1, 'easy', 1.5, 'walk'), cool(3, 'walk')],
    script: [
      [0, 0, 'Welcome to your first run. We’ll mix short runs with walks, so you finish feeling good.'],
      [0, 60, 'Walk tall, shoulders relaxed, and let your arms swing.'],
      [0, 200, 'Your first run starts soon. Keep it slow enough to talk.'],
      [1, 30, 'Short, light steps. There’s no pace to hit today.'],
      [5, 20, 'Breathing hard? Slow down a little. Easy is the whole idea.'],
      [7, 10, 'Three runs done, three to go.'],
      [13, 10, 'That’s every run done. Walk it out and let your breathing settle.'],
    ],
  },
  {
    id: 'easy-20',
    title: 'Easy 20',
    kind: 'easy',
    level: 'all',
    free: true,
    summary: 'Twenty minutes at a pace you could chat at.',
    blocks: [run(20)],
    script: [
      [0, 0, 'Twenty easy minutes. If you can talk in full sentences, you’re at the right pace.'],
      [0, 300, 'Check in with your shoulders. Let them drop.'],
      [0, 600, 'Halfway. Easy runs build the engine for everything else.'],
      [0, 900, 'Five minutes left. Stay relaxed, stay easy.'],
    ],
  },
  {
    id: 'recovery-25',
    title: 'Recovery run',
    kind: 'recovery',
    level: 'all',
    free: true,
    summary: 'Gentle running the day after a hard one. Slower than you think.',
    blocks: [run(25)],
    script: [
      [0, 0, 'A recovery run. The goal is to finish fresher than you started, so go slower than feels necessary.'],
      [0, 240, 'Soft landings, quiet feet.'],
      [0, 600, 'If anything feels sore, walk for a minute. That counts too.'],
      [0, 1200, 'Five minutes to go. Keep it gentle.'],
    ],
  },
  {
    id: 'easy-30',
    title: 'Easy 30',
    kind: 'easy',
    level: 'all',
    free: true,
    summary: 'Half an hour of relaxed running.',
    blocks: [run(30)],
    script: [
      [0, 0, 'Thirty easy minutes. Start slower than you want to.'],
      [0, 480, 'Find a rhythm you could hold all day.'],
      [0, 900, 'Halfway. Relax your hands, as if you’re holding crisps you don’t want to break.'],
      [0, 1500, 'Last five minutes. Tall posture, easy breathing.'],
    ],
  },
  {
    id: 'first-intervals',
    title: 'First intervals',
    kind: 'intervals',
    level: 'all',
    free: true,
    summary: 'Six one-minute efforts with easy running between.',
    blocks: [warm(10), reps(6, 1, 'interval', 1, 'recover'), cool(6)],
    script: [
      [0, 0, 'Today: six short efforts. Warm up easy for ten minutes first.'],
      [0, 480, 'Two minutes until the first effort. Hard means strong, not a sprint.'],
      [1, 20, 'Quick arms, quick feet. Stay controlled.'],
      [2, 10, 'Easy now. Let your breathing come back.'],
      [7, 20, 'Last three. Keep the same effort as the first ones.'],
      [13, 20, 'All six done. Cool down easy.'],
    ],
  },
  {
    id: 'mindful-25',
    title: 'Mindful run',
    kind: 'mindful',
    level: 'all',
    free: true,
    summary: 'Easy running with your attention on breath, body and surroundings.',
    blocks: [run(25)],
    script: [
      [0, 0, 'This run is about attention, not pace. Run easy and notice what’s around you.'],
      [0, 120, 'Notice your breathing. In for three steps, out for three, if that feels natural.'],
      [0, 420, 'Notice your feet. How do they land? Let them be light.'],
      [0, 720, 'Look up. Find three things you haven’t noticed before on this route.'],
      [0, 1020, 'Notice your hands, jaw and shoulders. Let go of any tension.'],
      [0, 1320, 'For the last few minutes, just run. Nothing to do but this.'],
    ],
  },
  {
    id: 'easy-45',
    title: 'Easy 45',
    kind: 'easy',
    level: 'all',
    free: false,
    summary: 'Forty-five minutes of relaxed, aerobic running.',
    blocks: [run(45)],
    script: [
      [0, 0, 'Forty-five easy minutes. Settle in.'],
      [0, 900, 'Fifteen minutes in. Check your pace: can you still talk?'],
      [0, 1800, 'Two thirds done. Relaxed face, relaxed shoulders.'],
      [0, 2400, 'Five to go. Finish as easy as you started.'],
    ],
  },
  {
    id: 'tempo-30',
    title: 'Tempo 30',
    kind: 'tempo',
    level: 'all',
    free: false,
    summary: 'Fifteen minutes comfortably hard, between an easy warm-up and cool-down.',
    blocks: [warm(10), one(step('work', 'tempo', 15)), cool(5)],
    script: [
      [0, 0, 'Tempo today. Ten easy minutes to warm up.'],
      [1, 60, 'Comfortably hard: you could say a few words, not a sentence.'],
      [1, 450, 'Halfway through the tempo. Hold it steady.'],
      [1, 780, 'Two minutes left. Stay smooth.'],
      [2, 20, 'Tempo done. Easy now.'],
    ],
  },
  {
    id: 'tempo-45',
    title: 'Tempo 2 × 12',
    kind: 'tempo',
    level: 'experienced',
    free: false,
    summary: 'Two twelve-minute tempo blocks with a short easy jog between.',
    blocks: [warm(12), one(step('work', 'tempo', 12)), one(step('recover', 'easy', 3)), one(step('work', 'tempo', 12)), cool(8)],
    script: [
      [0, 0, 'Two blocks of tempo today. Warm up easy.'],
      [1, 120, 'Find the effort you could hold for about an hour.'],
      [2, 30, 'Jog easy before the second block.'],
      [3, 360, 'Halfway through the second block. Run tall.'],
      [4, 20, 'Done. Cool down easy.'],
    ],
  },
  {
    id: 'speed-8x1',
    title: 'Speed: 8 × 1 min',
    kind: 'intervals',
    level: 'all',
    free: false,
    summary: 'Eight one-minute efforts with ninety seconds easy between.',
    blocks: [warm(10), reps(8, 1, 'interval', 1.5, 'recover'), cool(10)],
    script: [
      [0, 0, 'Eight fast minutes today, one at a time. Warm up easy.'],
      [1, 15, 'Strong and quick. Relaxed face.'],
      [8, 10, 'Halfway. Same effort, not faster.'],
      [15, 15, 'Last one. Finish strong.'],
      [17, 20, 'Great work. Ten minutes easy to finish.'],
    ],
  },
  {
    id: 'intervals-5x3',
    title: 'Intervals: 5 × 3 min',
    kind: 'intervals',
    level: 'experienced',
    free: false,
    summary: 'Five three-minute efforts at a hard, controlled pace.',
    blocks: [warm(10), reps(5, 3, 'interval', 2, 'recover'), cool(10)],
    script: [
      [0, 0, 'Five three-minute efforts. Warm up for ten easy minutes.'],
      [1, 60, 'Hard but controlled. You should finish each one able to do another.'],
      [2, 30, 'Jog easy. Shake out your arms.'],
      [9, 90, 'Last one. Hold your form.'],
      [11, 30, 'All done. Cool down easy.'],
    ],
  },
  {
    id: 'pyramid',
    title: 'Pyramid',
    kind: 'intervals',
    level: 'experienced',
    free: false,
    summary: 'One, two, three, two and one minute hard, with equal easy running between.',
    blocks: [
      warm(10),
      one(step('work', 'interval', 1), step('recover', 'easy', 1)),
      one(step('work', 'interval', 2), step('recover', 'easy', 2)),
      one(step('work', 'tempo', 3), step('recover', 'easy', 3)),
      one(step('work', 'interval', 2), step('recover', 'easy', 2)),
      one(step('work', 'interval', 1), step('recover', 'easy', 1)),
      cool(8),
    ],
    script: [
      [0, 0, 'Up the pyramid and back down. Warm up easy.'],
      [5, 60, 'The top. A little gentler than the short ones, but steady.'],
      [7, 30, 'On the way down now.'],
      [11, 20, 'That’s the pyramid. Cool down easy.'],
    ],
  },
  {
    id: 'hill-repeats',
    title: 'Hill repeats',
    kind: 'intervals',
    level: 'all',
    free: false,
    summary: 'Six hard minutes uphill, jogging or walking back down. Find a steady hill.',
    blocks: [warm(10), reps(6, 1, 'interval', 2, 'recover'), cool(10)],
    script: [
      [0, 0, 'Hill repeats. Warm up easy on the way to your hill.'],
      [1, 10, 'Up the hill: lean from the ankles, drive your arms, short steps.'],
      [2, 10, 'Easy back down. Walk if you need to.'],
      [11, 10, 'Last climb. Strong arms.'],
      [13, 20, 'Hills done. They build strength you’ll feel on the flat. Cool down easy.'],
    ],
  },
  {
    id: 'progression-40',
    title: 'Progression run',
    kind: 'tempo',
    level: 'all',
    free: false,
    summary: 'Start easy, finish strong: forty minutes that get quicker.',
    blocks: [run(20, 'easy'), run(12, 'steady'), run(8, 'tempo')],
    script: [
      [0, 0, 'A progression run: easy, then steady, then comfortably hard.'],
      [0, 600, 'Stay easy for now. The work comes later.'],
      [1, 30, 'Pick it up a little: steady, a few words at a time.'],
      [2, 30, 'Last eight minutes. Comfortably hard.'],
      [2, 420, 'One minute left. Finish smooth, not sprinting.'],
    ],
  },
  {
    id: 'long-60',
    title: 'Long run 60',
    kind: 'long',
    level: 'all',
    free: false,
    summary: 'An hour of easy running, with the last ten minutes steady.',
    blocks: [run(50, 'easy'), run(10, 'steady')],
    script: [
      [0, 0, 'An hour today. Start slow; the long run is about time on your feet.'],
      [0, 900, 'Fifteen minutes in. Sip some water if you brought it.'],
      [0, 1800, 'Halfway. Still easy? Good.'],
      [1, 30, 'Last ten minutes. Pick it up to steady if you feel good.'],
    ],
  },
  {
    id: 'long-90',
    title: 'Long run 90',
    kind: 'long',
    level: 'experienced',
    free: false,
    summary: 'Ninety easy minutes for longer races.',
    blocks: [run(90)],
    script: [
      [0, 0, 'Ninety minutes. Slower than you think, especially early on.'],
      [0, 1800, 'Thirty minutes in. Time for a drink or a gel if you use them.'],
      [0, 3600, 'An hour done. Check your form: tall, relaxed, light.'],
      [0, 4800, 'Ten minutes to go. You’ve got this.'],
    ],
  },
  {
    id: 'mindful-45',
    title: 'Mindful long run',
    kind: 'mindful',
    level: 'all',
    free: false,
    summary: 'Forty-five unhurried minutes with prompts to notice, breathe and let go.',
    blocks: [run(45)],
    script: [
      [0, 0, 'A long, mindful run. No pace, no targets.'],
      [0, 300, 'Count ten breaths. Then let the counting go.'],
      [0, 900, 'Listen. What can you hear besides your footsteps?'],
      [0, 1500, 'Notice anything tense, and let it soften.'],
      [0, 2100, 'Think of one thing that went well this week.'],
      [0, 2520, 'Last few minutes. Enjoy them.'],
    ],
  },
  {
    id: 'sharpener-5k',
    title: '5K sharpener',
    kind: 'intervals',
    level: 'experienced',
    free: false,
    summary: 'Three three-minute efforts at 5K race effort, for the week before a race.',
    blocks: [warm(12), reps(3, 3, 'race', 2, 'recover'), cool(10)],
    script: [
      [0, 0, 'A sharpener for race week. Warm up easy.'],
      [1, 30, 'Race effort: strong, rhythmic, controlled.'],
      [2, 20, 'Easy jog. Stay loose.'],
      [5, 60, 'Last one. Imagine the final kilometre.'],
      [7, 20, 'Sharp and ready. Cool down easy.'],
    ],
  },
];

/** Coaching lines at active seconds, from the script's step anchors. */
export function guidedLines(run: GuidedRun): CoachLine[] {
  const steps = flattenWorkout(run.blocks);
  const starts: number[] = [];
  let t = 0;
  for (const s of steps) {
    starts.push(t);
    t += s.durationS ?? 0;
  }
  return run.script
    .map(([index, after, text]) => ({ atS: (starts[index] ?? 0) + after, text }))
    .sort((a, b) => a.atS - b.atS);
}

export function guidedMinutes(run: GuidedRun): number {
  return Math.round((workoutDurationS(flattenWorkout(run.blocks)) ?? 0) / 60);
}

export function guidedRun(id: string): GuidedRun | null {
  return GUIDED_RUNS.find((r) => r.id === id) ?? null;
}

export type LengthFilter = 'all' | 'short' | 'medium' | 'long';
export const LENGTH_NAMES: Record<LengthFilter, string> = { all: 'Any length', short: 'Up to 25 min', medium: '26–45 min', long: 'Over 45 min' };

export function filterGuided(runs: GuidedRun[], kind: GuidedKind | 'all', length: LengthFilter, query = ''): GuidedRun[] {
  const q = query.trim().toLowerCase();
  return runs.filter((r) => {
    const min = guidedMinutes(r);
    const lengthOk = length === 'all' || (length === 'short' ? min <= 25 : length === 'medium' ? min > 25 && min <= 45 : min > 45);
    const text = `${r.title} ${r.summary} ${GUIDED_KIND_NAMES[r.kind]}`.toLowerCase();
    return (kind === 'all' || r.kind === kind) && lengthOk && (!q || text.includes(q));
  });
}
