import { steadyRun } from '@/domain/synthetic';
import { AppleHealthSync, HEALTH_WORKOUTS_KEY, healthActivity, healthRunFrom, type HealthKitPort, type HealthRunInput } from '@/features/health/apple-health';

const T0 = Date.UTC(2026, 8, 25, 12);

class FakeHealth implements HealthKitPort {
  allowed = true;
  saved = new Map<string, HealthRunInput>();
  deleted: string[] = [];
  private next = 1;
  isAvailable = () => true;
  canWrite = () => this.allowed;
  requestWrite = async () => this.allowed;
  saveRun = async (input: HealthRunInput) => {
    const uuid = `W${this.next++}`;
    this.saved.set(uuid, input);
    return uuid;
  };
  deleteWorkout = async (uuid: string) => {
    this.deleted.push(uuid);
    this.saved.delete(uuid);
  };
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

function setup(enabled = true) {
  const port = new FakeHealth();
  const kv = new MemoryKv();
  const state = { enabled };
  const sync = new AppleHealthSync({ kv, port, enabled: () => state.enabled });
  const run = steadyRun(T0, 5_000, 1_500);
  const build = async () => healthRunFrom({ id: 'run-1', activity: 'running', segments: run.segments, points: run.points });
  return { port, kv, state, sync, build };
}

describe('Apple Health', () => {
  it('writes a finished run once, with its distance per segment and its route', async () => {
    const { port, kv, sync, build } = setup();
    expect(await sync.saveRun('run-1', build)).toBe('saved');
    expect(await sync.saveRun('run-1', build)).toBe('skipped');
    expect(port.saved.size).toBe(1);
    const [workout] = [...port.saved.values()];
    expect(workout).toMatchObject({ activity: 'running', externalId: 'run-1' });
    expect(workout!.distanceM).toBeCloseTo(5_000, -1);
    expect(workout!.segments).toHaveLength(1);
    expect(workout!.route.length).toBeGreaterThan(1_000);
    expect(kv.values.get(HEALTH_WORKOUTS_KEY)).toEqual({ 'run-1': 'W1' });
  });

  it('writes nothing while switched off or not allowed', async () => {
    const off = setup(false);
    expect(await off.sync.saveRun('run-1', off.build)).toBe('skipped');
    const denied = setup();
    denied.port.allowed = false;
    expect(await denied.sync.saveRun('run-1', denied.build)).toBe('skipped');
    expect(denied.port.saved.size).toBe(0);
  });

  it('removes the workout with the run and rewrites it after a fix', async () => {
    const { port, sync, build } = setup();
    await sync.saveRun('run-1', build);
    await sync.replace('run-1', build);
    expect(port.deleted).toEqual(['W1']);
    expect([...port.saved.keys()]).toEqual(['W2']);
    await sync.remove('run-1');
    expect(port.deleted).toEqual(['W1', 'W2']);
    expect(port.saved.size).toBe(0);
    // A fix to a run that was never written doesn't write it.
    await sync.replace('run-2', build);
    expect(port.saved.size).toBe(0);
  });

  it('maps activity types', () => {
    expect(healthActivity('walk')).toBe('walking');
    expect(healthActivity('ride')).toBe('cycling');
    expect(healthActivity(undefined)).toBe('running');
  });
});
