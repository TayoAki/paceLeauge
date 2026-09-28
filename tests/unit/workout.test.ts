import { Journal, type RawSample } from '@/db/journal';
import type { WorkoutBlock } from '@/domain/plans/types';
import { steadyRun } from '@/domain/synthetic';
import type { TrackPoint } from '@/domain/types';
import {
  advanceWorkout,
  flattenWorkout,
  skipStep,
  stepCueText,
  stepLabel,
  stepPosition,
  WORKOUT_START,
  workoutDurationS,
} from '@/domain/workout';
import { RecorderService } from '@/features/recording/recorder-service';
import type { LocationDriver } from '@/features/recording/types';
import { CueController } from '@/features/voice/cue-controller';
import { DEFAULT_RUN_SETTINGS, RUN_SETTINGS_KEY, RunSettingsStore } from '@/features/voice/run-settings';
import type { SpeakOptions, SpeakOutcome, VoiceOutput } from '@/features/voice/voice-output';
import { WORKOUT_KEY, WorkoutController, type ActiveWorkout } from '@/features/workout/workout-controller';
import type { Clock } from '@/lib/clock';

import { NodeSqliteDatabase } from '../support/node-sqlite';

jest.mock('expo-speech', () => ({ speak: jest.fn(), stop: jest.fn(() => Promise.resolve()) }));

const T0 = Date.parse('2026-09-25T12:00:00Z');

/** 2 min warm-up, 3 × (1 min hard, 1 min easy), 2 min cool-down: 10 minutes. */
const INTERVALS: WorkoutBlock[] = [
  { repeat: 1, steps: [{ kind: 'warmup', effort: 'easy', durationS: 120 }] },
  {
    repeat: 3,
    steps: [
      { kind: 'work', effort: 'interval', durationS: 60 },
      { kind: 'recover', effort: 'easy', durationS: 60 },
    ],
  },
  { repeat: 1, steps: [{ kind: 'cooldown', effort: 'easy', durationS: 120 }] },
];

describe('the workout timeline', () => {
  const steps = flattenWorkout(INTERVALS);

  it('lays out repeats step by step', () => {
    expect(steps.map((s) => stepLabel(s))).toEqual([
      'Warm-up',
      'Hard · 1 of 3',
      'Recover · 1 of 3',
      'Hard · 2 of 3',
      'Recover · 2 of 3',
      'Hard · 3 of 3',
      'Recover · 3 of 3',
      'Cool-down',
    ]);
    expect(workoutDurationS(steps)).toBe(600);
  });

  it('moves on exactly at each step’s end, however late the update', () => {
    let { progress, entered } = advanceWorkout(steps, WORKOUT_START, 119, 300);
    expect(progress.index).toBe(0);
    expect(entered).toEqual([]);
    ({ progress, entered } = advanceWorkout(steps, progress, 250, 700));
    // 250 s is past the warm-up (120 s), the first rep (180 s) and its recovery (240 s): the
    // second rep began at 240 s, not at 250.
    expect(entered).toEqual([1, 2, 3]);
    expect(progress).toEqual({ index: 3, startS: 240, startM: 700 });
    expect(stepPosition(steps, progress, 250, 700)).toMatchObject({ remainingS: 50, done: false });
    ({ progress, entered } = advanceWorkout(steps, progress, 1_000, 3_000));
    expect(progress.index).toBe(steps.length);
    expect(stepPosition(steps, progress, 1_000, 3_000).done).toBe(true);
  });

  it('follows distance steps by distance, and skips on request', () => {
    const race = flattenWorkout([{ repeat: 1, steps: [{ kind: 'run', effort: 'race', distanceM: 5_000 }] }]);
    expect(stepPosition(race, WORKOUT_START, 600, 2_000)).toMatchObject({ remainingM: 3_000, fraction: 0.4 });
    expect(advanceWorkout(race, WORKOUT_START, 1_500, 5_000).progress.index).toBe(1);
    expect(workoutDurationS(race)).toBeNull();
    expect(skipStep(steps, WORKOUT_START, 30, 90)).toEqual({ index: 1, startS: 30, startM: 90 });
  });

  it('says each step in a few words', () => {
    expect(steps.map((s) => stepCueText(s, 'metric'))).toEqual([
      'Warm up: 2 minutes easy.',
      '1 of 3. Go: 1 minute hard.',
      '1 of 3. Recover: 1 minute easy.',
      '2 of 3. Go: 1 minute hard.',
      '2 of 3. Recover: 1 minute easy.',
      '3 of 3. Go: 1 minute hard.',
      '3 of 3. Recover: 1 minute easy.',
      'Cool down: 2 minutes easy.',
    ]);
    const runWalk = flattenWorkout([{ repeat: 7, steps: [{ kind: 'run', effort: 'easy', durationS: 90 }, { kind: 'walk', effort: 'walk', durationS: 90 }] }]);
    expect(stepCueText(runWalk[0]!, 'metric')).toBe('1 of 7. Run easy for 1 and a half minutes.');
    expect(stepCueText(runWalk[1]!, 'metric')).toBe('1 of 7. Walk for 1 and a half minutes.');
    expect(stepCueText(flattenWorkout([{ repeat: 1, steps: [{ kind: 'run', effort: 'race', distanceM: 10_000 }] }])[0]!, 'imperial')).toBe(
      'Race: 6.21 miles. Go well.',
    );
  });
});

// ---------------------------------------------------------------------------------------------
// A run that follows a workout, with the real recorder and voice cues.

class FakeClock implements Clock {
  constructor(
    public wall: number,
    public mono = 0,
  ) {}
  now = () => this.wall;
  monotonic = () => this.mono;
  advance(ms: number) {
    this.wall += ms;
    this.mono += ms;
  }
}

const driver: LocationDriver = { supportsBackground: true, start: async () => undefined, stop: async () => undefined, isRunning: async () => true };

class FakeVoice implements VoiceOutput {
  said: { text: string; options: SpeakOptions }[] = [];
  beginRun() {}
  speak(text: string, options: SpeakOptions): Promise<SpeakOutcome> {
    this.said.push({ text, options });
    return Promise.resolve('spoken');
  }
  async stop() {}
  get texts() {
    return this.said.map((s) => s.text);
  }
}

class MemoryKv {
  values = new Map<string, unknown>();
  async getKv<T>(key: string) {
    return this.values.has(key) ? { value: this.values.get(key) as T } : null;
  }
  async setKv(key: string, value: unknown) {
    this.values.set(key, value);
  }
}

async function stream(recorder: RecorderService, clock: FakeClock, points: TrackPoint[], batch = 5) {
  for (let i = 0; i < points.length; i += batch) {
    const slice = points.slice(i, i + batch);
    const last = slice[slice.length - 1] as TrackPoint;
    clock.advance(last.t - clock.wall);
    await recorder.ingest(slice.map((p) => ({ timestamp: p.t, latitude: p.lat, longitude: p.lon, accuracy: p.accuracyM }) as RawSample));
  }
}

const WORKOUT: ActiveWorkout = { source: { kind: 'plan', planId: 'p1', sessionId: 'w1-d1' }, title: 'Intervals', blocks: INTERVALS, zones: null };

async function setup(cuesOn = true) {
  const clock = new FakeClock(T0);
  const journal = await Journal.open(new NodeSqliteDatabase(), clock);
  const kv = new MemoryKv();
  kv.values.set(RUN_SETTINGS_KEY, { ...DEFAULT_RUN_SETTINGS, autoPause: false, cues: { ...DEFAULT_RUN_SETTINGS.cues, enabled: cuesOn } });
  const settings = new RunSettingsStore(kv);
  await settings.load();
  const voice = new FakeVoice();
  const make = async () => {
    const recorder = new RecorderService({ journal, location: driver, clock, newRunId: () => '00000000-0000-4000-8000-000000000001', autoPause: () => false });
    const workout = new WorkoutController(kv);
    await workout.restore();
    new CueController(recorder, voice, settings, workout).start();
    return { recorder, workout };
  };
  return { clock, kv, voice, make, ...(await make()) };
}

describe('a run following a workout', () => {
  it('says the first step with the start, then each step as it begins, in one cue each time', async () => {
    const { recorder, workout, clock, voice } = await setup();
    await recorder.init();
    workout.prepare(WORKOUT);
    expect(workout.getSnapshot()).toMatchObject({ running: false, workout: { title: 'Intervals' } });
    await recorder.start();
    // 2.4 km in 11 minutes: the whole 10-minute workout and the first kilometre and two.
    await stream(recorder, clock, steadyRun(T0, 2_400, 660).points, 5);
    expect(voice.texts[0]).toBe('Run started. Warm up: 2 minutes easy.');
    expect(voice.texts).toContain('1 of 3. Go: 1 minute hard.');
    expect(voice.texts.filter((t) => t.includes('Recover'))).toHaveLength(3);
    expect(voice.texts.some((t) => t.startsWith('Cool down: 2 minutes easy.'))).toBe(true);
    expect(voice.texts.some((t) => t.includes('Workout complete.'))).toBe(true);
    // Never two cues for one moment: a step and a kilometre falling together are one sentence.
    expect(new Set(voice.texts).size).toBe(voice.texts.length);
    expect(workout.getSnapshot()).toMatchObject({ running: true, position: { done: true } });

    await recorder.pause();
    await recorder.finish();
    expect(workout.getSnapshot()).toBeNull();
  });

  it('keeps going through the steps with cues off, for the run screen', async () => {
    const { recorder, workout, clock, voice } = await setup(false);
    await recorder.init();
    workout.prepare(WORKOUT);
    await recorder.start();
    await stream(recorder, clock, steadyRun(T0, 900, 300).points, 5);
    expect(voice.texts).toEqual([]);
    // Five minutes: warm-up, rep, recovery, rep, and into the second recovery.
    expect(workout.getSnapshot()!.progress.index).toBe(4);
  });

  it('picks up the same step after a relaunch, without saying it again', async () => {
    const { recorder, workout, clock, voice, kv, make } = await setup();
    await recorder.init();
    workout.prepare(WORKOUT);
    await recorder.start();
    const route = steadyRun(T0, 2_400, 660).points;
    const before = route.filter((p) => p.t < T0 + 200_000);
    await stream(recorder, clock, before, 5);
    expect((kv.values.get(WORKOUT_KEY) as { progress: { index: number } }).progress.index).toBe(2);
    const spoken = voice.texts.length;

    const second = await make();
    await second.recorder.init();
    expect(second.workout.getSnapshot()).toMatchObject({ running: true, progress: { index: 2 } });
    await stream(second.recorder, clock, route.slice(before.length), 5);
    const after = voice.texts.slice(spoken);
    expect(after[0]).toBe('2 of 3. Go: 1 minute hard.');
    expect(after.filter((t) => t.includes('1 of 3'))).toEqual([]);
  });

  it('skips a step on request and says the next one', async () => {
    const { recorder, workout, clock, voice } = await setup();
    await recorder.init();
    workout.prepare(WORKOUT);
    await recorder.start();
    const route = steadyRun(T0, 2_400, 660).points;
    await stream(recorder, clock, route.filter((p) => p.t < T0 + 30_000), 5);
    workout.skip('metric');
    await stream(recorder, clock, route.filter((p) => p.t >= T0 + 30_000 && p.t < T0 + 40_000), 5);
    expect(voice.texts).toContain('1 of 3. Go: 1 minute hard.');
    expect(workout.getSnapshot()!.progress).toMatchObject({ index: 1 });
  });

  it('forgets a workout left at the start line, and runs without one stay plain', async () => {
    const { recorder, workout, clock, voice } = await setup();
    await recorder.init();
    workout.prepare(WORKOUT);
    workout.cancel();
    await recorder.start();
    await stream(recorder, clock, steadyRun(T0, 300, 100).points, 5);
    expect(voice.texts[0]).toBe('Run started.');
    expect(workout.getSnapshot()).toBeNull();
  });
});
