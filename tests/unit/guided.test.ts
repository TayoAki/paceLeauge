import { Journal, type RawSample } from '@/db/journal';
import { steadyRun } from '@/domain/synthetic';
import type { TrackPoint } from '@/domain/types';
import { flattenWorkout } from '@/domain/workout';
import { filterGuided, GUIDED_KIND_NAMES, GUIDED_RUNS, guidedLines, guidedMinutes, guidedRun, type GuidedKind } from '@/features/guided/catalog';
import { RecorderService } from '@/features/recording/recorder-service';
import type { LocationDriver } from '@/features/recording/types';
import { CueController } from '@/features/voice/cue-controller';
import { DEFAULT_RUN_SETTINGS, RUN_SETTINGS_KEY, RunSettingsStore } from '@/features/voice/run-settings';
import type { SpeakOptions, SpeakOutcome, VoiceOutput } from '@/features/voice/voice-output';
import { WorkoutController } from '@/features/workout/workout-controller';
import type { Clock } from '@/lib/clock';

import { NodeSqliteDatabase } from '../support/node-sqlite';

jest.mock('expo-speech', () => ({ speak: jest.fn(), stop: jest.fn(() => Promise.resolve()) }));

describe('the guided-run library', () => {
  it('has 12 to 20 runs covering every kind, with a free starter set', () => {
    expect(GUIDED_RUNS.length).toBeGreaterThanOrEqual(12);
    expect(GUIDED_RUNS.length).toBeLessThanOrEqual(20);
    expect(new Set(GUIDED_RUNS.map((r) => r.id)).size).toBe(GUIDED_RUNS.length);
    expect(new Set(GUIDED_RUNS.map((r) => r.kind))).toEqual(new Set(Object.keys(GUIDED_KIND_NAMES)));
    const free = GUIDED_RUNS.filter((r) => r.free);
    expect(free.length).toBeGreaterThanOrEqual(5);
    expect(free.map((r) => r.kind)).toContain('first_run');
  });

  it('places every line inside the step it belongs to, in order, with room to breathe', () => {
    const problems: string[] = [];
    for (const run of GUIDED_RUNS) {
      const steps = flattenWorkout(run.blocks);
      for (const [index, after, text] of run.script) {
        const step = steps[index];
        if (!step) problems.push(`${run.id}: no step ${index}`);
        else if (after >= (step.durationS ?? 0)) problems.push(`${run.id}: "${text}" falls after step ${index} ends`);
        if (text.length < 5 || text.length > 160 || !/[.!?]$/.test(text)) problems.push(`${run.id}: "${text}"`);
        if (/cool down easy/i.test(text) && step?.kind !== 'cooldown') problems.push(`${run.id}: "${text}" isn't in the cool-down`);
        if (/^last (one|climb)/i.test(text)) {
          const lastWork = steps.map((s) => s.kind).lastIndexOf('work');
          if (index !== lastWork) problems.push(`${run.id}: "${text}" isn't on the last effort`);
        }
      }
      const lines = guidedLines(run);
      for (let i = 1; i < lines.length; i++) {
        if (lines[i]!.atS - lines[i - 1]!.atS < 20) problems.push(`${run.id}: lines ${i - 1} and ${i} are too close`);
      }
      if (lines[0]?.atS !== 0) problems.push(`${run.id}: no welcome line`);
    }
    expect(problems).toEqual([]);
  });

  it('filters by kind, length and words', () => {
    const minutes = (ids: string[]) => ids.map((id) => guidedMinutes(guidedRun(id)!));
    expect(minutes(['first-run', 'easy-20', 'long-90'])).toEqual([22, 20, 90]);
    const kinds = (kind: GuidedKind | 'all') => filterGuided(GUIDED_RUNS, kind, 'all').map((r) => r.id);
    expect(kinds('mindful')).toEqual(['mindful-25', 'mindful-45']);
    expect(filterGuided(GUIDED_RUNS, 'all', 'short').every((r) => guidedMinutes(r) <= 25)).toBe(true);
    expect(filterGuided(GUIDED_RUNS, 'all', 'long').map((r) => r.id)).toEqual(['tempo-45', 'long-60', 'long-90']);
    expect(filterGuided(GUIDED_RUNS, 'all', 'all', 'HILL').map((r) => r.id)).toEqual(['hill-repeats']);
  });
});

// ---------------------------------------------------------------------------------------------

const T0 = Date.parse('2026-09-25T12:00:00Z');

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

class FakeVoice implements VoiceOutput {
  texts: string[] = [];
  beginRun() {}
  speak(text: string, _options: SpeakOptions): Promise<SpeakOutcome> {
    this.texts.push(text);
    return Promise.resolve('spoken');
  }
  async stop() {}
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

const driver: LocationDriver = { supportsBackground: true, start: async () => undefined, stop: async () => undefined, isRunning: async () => true };

describe('a guided run', () => {
  it('speaks its lines at their times, joined with the steps and splits due at the same moment', async () => {
    const clock = new FakeClock(T0);
    const journal = await Journal.open(new NodeSqliteDatabase(), clock);
    const kv = new MemoryKv();
    kv.values.set(RUN_SETTINGS_KEY, { ...DEFAULT_RUN_SETTINGS, autoPause: false });
    const settings = new RunSettingsStore(kv);
    await settings.load();
    const voice = new FakeVoice();
    const recorder = new RecorderService({ journal, location: driver, clock, newRunId: () => '00000000-0000-4000-8000-000000000001', autoPause: () => false });
    const workout = new WorkoutController(kv);
    new CueController(recorder, voice, settings, workout).start();
    await recorder.init();

    const run = guidedRun('easy-20')!;
    workout.prepare({ source: { kind: 'guided', guidedId: run.id }, title: run.title, blocks: run.blocks, zones: null, lines: guidedLines(run) });
    await recorder.start();
    const points = steadyRun(T0, 3_600, 1_210).points;
    for (let i = 0; i < points.length; i += 5) {
      const slice = points.slice(i, i + 5);
      clock.advance(slice[slice.length - 1]!.t - clock.wall);
      await recorder.ingest(slice.map((p: TrackPoint) => ({ timestamp: p.t, latitude: p.lat, longitude: p.lon, accuracy: p.accuracyM }) as RawSample));
    }
    expect(voice.texts[0]).toBe('Run started. Run easy for 20 minutes. Twenty easy minutes. If you can talk in full sentences, you’re at the right pace.');
    const lines = guidedLines(run).slice(1).map((l) => l.text);
    const spokenLines = voice.texts.filter((t) => lines.some((l) => t.includes(l)));
    expect(spokenLines).toHaveLength(3);
    expect(voice.texts.some((t) => t.includes('Workout complete.'))).toBe(true);
  });
});
