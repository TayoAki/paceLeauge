import * as Speech from 'expo-speech';

import { Journal, type RawSample } from '@/db/journal';
import { DEFAULT_CUE_SETTINGS } from '@/domain/cues';
import { buildSyntheticRun, steadyRun } from '@/domain/synthetic';
import type { TrackPoint } from '@/domain/types';
import { RecorderService } from '@/features/recording/recorder-service';
import type { LocationDriver } from '@/features/recording/types';
import { CueController } from '@/features/voice/cue-controller';
import { DEFAULT_RUN_SETTINGS, parseRunSettings, RUN_SETTINGS_KEY, RunSettingsStore } from '@/features/voice/run-settings';
import { speechVoiceOutput, type SpeakOptions, type SpeakOutcome, type VoiceOutput } from '@/features/voice/voice-output';
import type { Clock } from '@/lib/clock';

import { NodeSqliteDatabase } from '../support/node-sqlite';

jest.mock('expo-speech', () => ({ speak: jest.fn(), stop: jest.fn(() => Promise.resolve()) }));

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

const driver: LocationDriver = {
  supportsBackground: true,
  start: async () => undefined,
  stop: async () => undefined,
  isRunning: async () => true,
};

class FakeVoice implements VoiceOutput {
  said: { text: string; options: SpeakOptions }[] = [];
  runsBegun = 0;
  stops = 0;
  beginRun() {
    this.runsBegun += 1;
  }
  speak(text: string, options: SpeakOptions): Promise<SpeakOutcome> {
    this.said.push({ text, options });
    return Promise.resolve('spoken');
  }
  async stop() {
    this.stops += 1;
  }
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

function samples(points: TrackPoint[]): RawSample[] {
  return points.map((p) => ({ timestamp: p.t, latitude: p.lat, longitude: p.lon, accuracy: p.accuracyM }));
}

async function stream(recorder: RecorderService, clock: FakeClock, points: TrackPoint[], batch = 5) {
  for (let i = 0; i < points.length; i += batch) {
    const slice = points.slice(i, i + batch);
    const last = slice[slice.length - 1] as TrackPoint;
    clock.advance(last.t - clock.wall);
    await recorder.ingest(samples(slice));
  }
}

async function setup(stored?: unknown) {
  const clock = new FakeClock(T0);
  const journal = await Journal.open(new NodeSqliteDatabase(), clock);
  const kv = new MemoryKv();
  if (stored !== undefined) kv.values.set(RUN_SETTINGS_KEY, stored);
  const settings = new RunSettingsStore(kv);
  await settings.load();
  const voice = new FakeVoice();
  let ids = 0;
  const make = () => {
    const recorder = new RecorderService({
      journal,
      location: driver,
      clock,
      newRunId: () => `00000000-0000-4000-8000-00000000000${ids++}`,
      autoPause: () => settings.get().autoPause,
    });
    const cues = new CueController(recorder, voice, settings);
    cues.start();
    return { recorder, cues };
  };
  return { clock, journal, kv, settings, voice, make, ...make() };
}

describe('voice cues during a run', () => {
  it('speaks the start, each kilometre with its split, a pause and the finish', async () => {
    const { recorder, clock, voice } = await setup({ ...DEFAULT_RUN_SETTINGS, autoPause: false });
    await recorder.init();
    await recorder.start();
    await stream(recorder, clock, steadyRun(T0, 2_200, 660).points, 10);
    await recorder.pause();
    await recorder.finish();

    expect(voice.runsBegun).toBe(1);
    expect(voice.texts[0]).toBe('Run started.');
    expect(voice.texts[1]).toMatch(/^1 kilometer\. Time 5 minutes\. Split 5 minutes\. Average pace 5 minutes per kilometer\.$/);
    expect(voice.texts[2]).toMatch(/^2 kilometers\. Time 10 minutes\. Split 5 minutes\./);
    expect(voice.texts.slice(3)).toEqual(['Paused.', expect.stringMatching(/^Run finished\. 2\.2 kilometers in 11 minutes\.$/)]);
    expect(voice.said.every((s) => s.options.volume === 0.85 && s.options.allowSpeaker === false)).toBe(true);
  });

  it('stays silent when cues are off, and applies a mid-run change from the next split', async () => {
    const { recorder, clock, voice, settings } = await setup({ ...DEFAULT_RUN_SETTINGS, autoPause: false, cues: { ...DEFAULT_CUE_SETTINGS, enabled: false } });
    await recorder.init();
    await recorder.start();
    const route = steadyRun(T0, 3_300, 990).points;
    const firstHalf = route.filter((p) => p.t < T0 + 450_000);
    await stream(recorder, clock, firstHalf, 10);
    expect(voice.texts).toEqual([]);

    await settings.save({ ...settings.get(), cues: { ...settings.get().cues, enabled: true, mode: 'important' } });
    await stream(recorder, clock, route.slice(firstHalf.length), 10);
    // The first kilometre passed while cues were off and is not replayed.
    expect(voice.texts).toEqual([expect.stringMatching(/^2 kilometers\. Split 5 minutes\.$/), expect.stringMatching(/^3 kilometers\. Split 5 minutes\.$/)]);
  });

  it('never replays passed splits when a run is picked up after a relaunch', async () => {
    const { recorder, clock, voice, make } = await setup({ ...DEFAULT_RUN_SETTINGS, autoPause: false });
    await recorder.init();
    await recorder.start();
    const route = steadyRun(T0, 2_400, 720).points;
    const before = route.filter((p) => p.t < T0 + 450_000);
    await stream(recorder, clock, before, 10);
    expect(voice.texts).toHaveLength(2); // started, 1 km

    // The process restarts; a new recorder and controller pick up the run at 1.5 km.
    const second = make();
    await second.recorder.init();
    await stream(second.recorder, clock, route.slice(before.length), 10);
    expect(voice.texts.slice(2)).toEqual([expect.stringMatching(/^2 kilometers\./)]);
  });

  it('announces auto-pause and the resume', async () => {
    const { recorder, clock, voice } = await setup(DEFAULT_RUN_SETTINGS);
    await recorder.init();
    await recorder.start();
    const route = buildSyntheticRun({
      startAt: T0,
      legs: [
        { kind: 'run', durationS: 120, speedMps: 3 },
        { kind: 'run', durationS: 40, speedMps: 0.001 },
        { kind: 'run', durationS: 60, speedMps: 3 },
      ],
    }).points.map((p) => ({ ...p, segmentIndex: 0 }));
    await stream(recorder, clock, route, 1);
    expect(voice.texts).toEqual(['Run started.', 'Auto-paused.', 'Resumed.']);
  });

  it('uses miles for imperial runners and the chosen volume', async () => {
    const kv = new MemoryKv();
    kv.values.set('q:me', { profile: { units: 'imperial' } });
    kv.values.set(RUN_SETTINGS_KEY, { ...DEFAULT_RUN_SETTINGS, autoPause: false, cueVolume: 'loud', speakerFallback: true });
    const settings = new RunSettingsStore(kv);
    await settings.load();
    expect(settings.units).toBe('imperial');
    const clock = new FakeClock(T0);
    const journal = await Journal.open(new NodeSqliteDatabase(), clock);
    const recorder = new RecorderService({ journal, location: driver, clock, newRunId: () => '00000000-0000-4000-8000-000000000009' });
    const voice = new FakeVoice();
    new CueController(recorder, voice, settings).start();
    await recorder.start();
    await stream(recorder, clock, steadyRun(T0, 1_700, 600).points, 10);
    expect(voice.texts[1]).toMatch(/^1 mile\. /);
    expect(voice.said[1]!.options).toEqual({ volume: 1, allowSpeaker: true });
  });
});

describe('run settings', () => {
  it('falls back field by field', () => {
    expect(parseRunSettings(null)).toEqual(DEFAULT_RUN_SETTINGS);
    const parsed = parseRunSettings({
      autoPause: false,
      cueVolume: 'blaring',
      cues: { enabled: true, trigger: { kind: 'time', everyMinutes: 7 }, mode: 'important', fields: { heartRate: true, time: 'yes' } },
    });
    expect(parsed.autoPause).toBe(false);
    expect(parsed.cueVolume).toBe('normal');
    expect(parsed.cues.trigger).toEqual(DEFAULT_CUE_SETTINGS.trigger);
    expect(parsed.cues.mode).toBe('important');
    expect(parsed.cues.fields).toEqual({ ...DEFAULT_CUE_SETTINGS.fields, heartRate: true });
  });

  it('saves to the account journal and notifies listeners', async () => {
    const kv = new MemoryKv();
    const store = new RunSettingsStore(kv);
    const seen: boolean[] = [];
    store.subscribe(() => seen.push(store.get().autoPause));
    await store.save({ ...DEFAULT_RUN_SETTINGS, autoPause: false });
    expect(kv.values.get(RUN_SETTINGS_KEY)).toMatchObject({ autoPause: false });
    expect(seen).toEqual([false]);
  });
});

describe('speech fallback', () => {
  const speak = Speech.speak as jest.Mock;

  beforeEach(() => speak.mockReset());

  it('resolves when the cue is spoken and replaces a cue still speaking', async () => {
    const voice = speechVoiceOutput();
    const first = voice.speak('1 kilometer.', { volume: 1, allowSpeaker: true });
    const second = voice.speak('2 kilometers.', { volume: 0.6, allowSpeaker: true });
    await expect(first).resolves.toBe('replaced');
    expect(speak.mock.calls[1]![1]).toMatchObject({ volume: 0.6 });
    speak.mock.calls[1]![1].onDone();
    await expect(second).resolves.toBe('spoken');
  });

  it('reports a failed engine instead of throwing', async () => {
    speak.mockImplementation(() => {
      throw new Error('no engine');
    });
    await expect(speechVoiceOutput().speak('Paused.', { volume: 1, allowSpeaker: true })).resolves.toBe('unavailable');
  });
});
