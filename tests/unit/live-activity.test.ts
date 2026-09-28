import { Journal, type RawSample } from '@/db/journal';
import { formatDistance } from '@/domain/format';
import { steadyRun } from '@/domain/synthetic';
import type { TrackPoint } from '@/domain/types';
import { RecorderService } from '@/features/recording/recorder-service';
import type { LocationDriver } from '@/features/recording/types';
import { activityState, FINISHED_VISIBLE_S, LiveActivityController, type RunActivityPort, type RunActivityState } from '@/features/run-activity/live-activity';
import { widgetWeekFrom } from '@/features/widgets/widget-data';
import type { Clock } from '@/lib/clock';

import { NodeSqliteDatabase } from '../support/node-sqlite';

const T0 = Date.parse('2026-09-25T12:00:00Z');

class FakeClock implements Clock {
  constructor(public wall: number) {}
  now = () => this.wall;
  monotonic = () => this.wall;
}

const driver: LocationDriver = { supportsBackground: true, start: async () => undefined, stop: async () => undefined, isRunning: async () => true };

class FakeActivity implements RunActivityPort {
  calls: { kind: 'start' | 'update' | 'end'; state: RunActivityState; dismiss?: number }[] = [];
  isSupported = () => true;
  start = async (state: RunActivityState) => {
    this.calls.push({ kind: 'start', state });
    return true;
  };
  update = async (state: RunActivityState) => {
    this.calls.push({ kind: 'update', state });
  };
  end = async (state: RunActivityState, dismiss: number) => {
    this.calls.push({ kind: 'end', state, dismiss });
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function setup() {
  const clock = new FakeClock(T0);
  const journal = await Journal.open(new NodeSqliteDatabase(), clock);
  const recorder = new RecorderService({ journal, location: driver, clock, newRunId: () => '00000000-0000-4000-8000-000000000001' });
  const port = new FakeActivity();
  const controller = new LiveActivityController(recorder, port, () => 'metric', clock.now);
  controller.start();
  return { clock, recorder, port, controller };
}

async function stream(recorder: RecorderService, clock: FakeClock, points: TrackPoint[]) {
  for (let i = 0; i < points.length; i += 5) {
    const slice = points.slice(i, i + 5);
    clock.wall = slice[slice.length - 1]!.t;
    const samples: RawSample[] = slice.map((p) => ({ timestamp: p.t, latitude: p.lat, longitude: p.lon, accuracy: p.accuracyM }));
    await recorder.ingest(samples);
    await flush();
  }
}

describe('run Live Activity', () => {
  it('starts with the run, updates every few seconds, and ends with the saved numbers', async () => {
    const { clock, recorder, port } = await setup();
    await recorder.start();
    await flush();
    expect(port.calls[0]).toMatchObject({ kind: 'start', state: { status: 'recording', distance: '0.00', clockStartMs: T0 } });

    await stream(recorder, clock, steadyRun(T0, 1_200, 360).points);
    const updates = port.calls.filter((c) => c.kind === 'update');
    // Five-second throttle: about one update per five seconds of running, never one per fix.
    expect(updates.length).toBeGreaterThan(50);
    expect(updates.length).toBeLessThanOrEqual(73);
    expect(updates[updates.length - 1]!.state).toMatchObject({ status: 'recording', distanceUnit: 'km', paceUnit: '/km', pace: '5:00' });

    await recorder.pause();
    await flush();
    expect(port.calls[port.calls.length - 1]).toMatchObject({ kind: 'update', state: { status: 'paused', clockStartMs: null } });

    const saved = await recorder.finish();
    await flush();
    await flush();
    const end = port.calls[port.calls.length - 1]!;
    expect(end).toMatchObject({ kind: 'end', dismiss: FINISHED_VISIBLE_S, state: { status: 'finished', clockStartMs: null } });
    expect(end.state.distance).toBe(formatDistance(saved.distanceM, 'metric').value);
    expect(end.state.activeSeconds).toBe(Math.floor(saved.activeMs / 1000));
  });

  it('removes the activity at once when the run is discarded', async () => {
    const { recorder, port } = await setup();
    await recorder.start();
    await flush();
    await recorder.pause();
    await recorder.discard();
    await flush();
    await flush();
    expect(port.calls[port.calls.length - 1]).toMatchObject({ kind: 'end', dismiss: 0 });
  });

  it('shows the average pace while paused and miles for imperial runners', () => {
    const state = activityState(
      {
        session: { status: 'paused' } as never,
        metrics: { distanceM: 1609.344, activeMs: 480_000, currentPaceSPerKm: 250, pointCount: 0, lastFixAt: null, lastAccuracyM: null, quality: 'good', pointLimitReached: false },
        lastSaved: null,
        autoPaused: true,
      },
      'imperial',
      T0,
    );
    expect(state).toMatchObject({ status: 'auto_paused', distance: '1.00', distanceUnit: 'mi', pace: '8:00', paceUnit: '/mi', activeSeconds: 480, clockStartMs: null });
  });
});

describe('week widget numbers', () => {
  it('takes the week and the league place', () => {
    const week = { week_start: '2026-09-21', starts_at_ms: 1, ends_at_ms: 2, settles_at_ms: 3, days: [], active_days: 2, weekly_xp: 257, goal_days: 3 };
    const league = {
      league: { id: 'l', name: 'Friday Crew', member_count: 8, capacity: 20, is_owner: false, calendar_zone: 'America/Chicago', created_at_ms: 0, joined_at_ms: 0 },
      me: { member_id: 'm', rank: 2, alias: 'Alex', tier: 'Stride', weekly_xp: 257, is_me: true, is_owner: false, hidden: false },
      competition_enabled: true,
    };
    expect(widgetWeekFrom(week, league, 10)).toEqual({
      activeDays: 2,
      goalDays: 3,
      weeklyXp: 257,
      weekEndsAtMs: 2,
      leagueName: 'Friday Crew',
      rank: 2,
      members: 8,
      updatedAtMs: 10,
    });
    expect(widgetWeekFrom(week, null, 10)).toMatchObject({ leagueName: null, rank: null, members: null });
  });
});
