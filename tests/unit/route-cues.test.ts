import { Journal, type RawSample } from '@/db/journal';
import { destinationPoint } from '@/domain/geo';
import { deriveCues, pathLengthM, toRoutePoint } from '@/domain/routes';
import { CHICAGO_LAKEFRONT, steadyRun } from '@/domain/synthetic';
import type { TrackPoint } from '@/domain/types';
import { RecorderService } from '@/features/recording/recorder-service';
import type { LocationDriver } from '@/features/recording/types';
import { RouteController } from '@/features/routes/route-controller';
import { CueController } from '@/features/voice/cue-controller';
import { DEFAULT_RUN_SETTINGS, RUN_SETTINGS_KEY, RunSettingsStore } from '@/features/voice/run-settings';
import type { SpeakOptions, SpeakOutcome, VoiceOutput } from '@/features/voice/voice-output';
import type { Clock } from '@/lib/clock';

import { NodeSqliteDatabase } from '../support/node-sqlite';

/**
 * A run following a planned route (docs/ROADMAP.md 5.1 and 5.2), with the real recorder and voice
 * cues: turns are said first when they fall due with other cues, and going off the route is said.
 */
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

async function stream(recorder: RecorderService, clock: FakeClock, points: TrackPoint[], batch = 3) {
  for (let i = 0; i < points.length; i += batch) {
    const slice = points.slice(i, i + batch);
    const last = slice[slice.length - 1] as TrackPoint;
    clock.advance(last.t - clock.wall);
    await recorder.ingest(slice.map((p) => ({ timestamp: p.t, latitude: p.lat, longitude: p.lon, accuracy: p.accuracyM }) as RawSample));
  }
}

describe('a run following a route', () => {
  it('says the turn before the kilometre when they fall together, and says when the runner goes off the route', async () => {
    const clock = new FakeClock(T0);
    const journal = await Journal.open(new NodeSqliteDatabase(), clock);
    const kv = new MemoryKv();
    kv.values.set(RUN_SETTINGS_KEY, { ...DEFAULT_RUN_SETTINGS, autoPause: false });
    const settings = new RunSettingsStore(kv);
    await settings.load();
    const voice = new FakeVoice();
    const recorder = new RecorderService({ journal, location: driver, clock, newRunId: () => '00000000-0000-4000-8000-000000000007', autoPause: () => false });
    const route = new RouteController(kv);
    new CueController(recorder, voice, settings, null, route).start();
    await recorder.init();

    // East for 1,060 m, then left (north). The runner keeps going east.
    const corner = destinationPoint(CHICAGO_LAKEFRONT, 90, 1_060);
    const points = [toRoutePoint(CHICAGO_LAKEFRONT), toRoutePoint(corner), toRoutePoint(destinationPoint(corner, 0, 600))];
    route.prepare({ id: 'r1', name: 'Lakefront and up', points, cues: deriveCues(points), distanceM: pathLengthM(points) });
    await recorder.start();
    await stream(recorder, clock, steadyRun(T0, 1_600, 480).points);

    const turn = voice.texts.findIndex((t) => t.includes('turn left'));
    expect(turn).toBeGreaterThanOrEqual(0);
    expect(voice.texts[turn]).toMatch(/^In [56]0 meters, turn left\. /);
    expect(voice.texts[turn]).toContain('1 kilometer');
    const off = voice.texts.find((t) => t.startsWith("You're off the route."));
    expect(off).toMatch(/behind you\.$/);
    expect(route.getSnapshot()!.view).toMatchObject({ offRoute: true, joined: true });

    await recorder.pause();
    await recorder.finish();
    expect(route.getSnapshot()).toBeNull();
  });
});
