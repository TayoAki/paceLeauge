import { activeElapsedMs, InvalidTransitionError, transition, type SessionState } from '../recorder-machine';

const T0 = 1_000_000;

function start(): SessionState {
  const r = transition(null, { type: 'start', runId: 'run-1', at: T0 });
  if (!r.state) throw new Error('expected state');
  return r.state;
}

function must(r: ReturnType<typeof transition>): SessionState {
  if (!r.state) throw new Error('expected state');
  return r.state;
}

describe('recorder session machine', () => {
  it('records, pauses and resumes into a new segment', () => {
    let s = start();
    expect(s).toMatchObject({ status: 'recording', openSegment: { index: 0, startAt: T0 } });
    s = must(transition(s, { type: 'pause', at: T0 + 60_000 }));
    expect(s.segments).toEqual([{ index: 0, startAt: T0, endAt: T0 + 60_000 }]);
    expect(activeElapsedMs(s, T0 + 999_999)).toBe(60_000);
    s = must(transition(s, { type: 'resume', at: T0 + 90_000 }));
    expect(s.openSegment).toEqual({ index: 1, startAt: T0 + 90_000 });
    expect(activeElapsedMs(s, T0 + 100_000)).toBe(70_000);
  });

  it('finishes only from paused (or interrupted) and returns the closed segments', () => {
    let s = start();
    expect(() => transition(s, { type: 'finish' })).toThrow(InvalidTransitionError);
    s = must(transition(s, { type: 'pause', at: T0 + 30_000 }));
    const done = transition(s, { type: 'finish' });
    expect(done.state).toBeNull();
    expect(done.finished).toEqual({
      runId: 'run-1',
      startedAt: T0,
      endedAt: T0 + 30_000,
      segments: [{ index: 0, startAt: T0, endAt: T0 + 30_000 }],
      interrupted: false,
    });
  });

  it('closes an interrupted segment at the last durable evidence, not at relaunch time', () => {
    let s = start();
    s = must(transition(s, { type: 'interrupt', at: T0 + 3_600_000, lastEvidenceAt: T0 + 120_000, reason: 'process' }));
    expect(s.status).toBe('interrupted');
    expect(s.segments).toEqual([{ index: 0, startAt: T0, endAt: T0 + 120_000 }]);
    s = must(transition(s, { type: 'recover' }));
    expect(s.status).toBe('paused');
    s = must(transition(s, { type: 'resume', at: T0 + 3_700_000 }));
    s = must(transition(s, { type: 'pause', at: T0 + 3_760_000 }));
    const done = transition(s, { type: 'finish' });
    expect(done.finished?.interrupted).toBe(true);
    expect(done.finished?.segments).toHaveLength(2);
  });

  it('can save a partial run straight from the interrupted state', () => {
    let s = start();
    s = must(transition(s, { type: 'interrupt', at: T0 + 500_000, lastEvidenceAt: T0 + 400_000, reason: 'permission' }));
    const done = transition(s, { type: 'finish' });
    expect(done.finished).toMatchObject({ endedAt: T0 + 400_000, interrupted: true });
  });

  it('discards only after pausing', () => {
    const s = start();
    expect(() => transition(s, { type: 'discard' })).toThrow(InvalidTransitionError);
    const paused = must(transition(s, { type: 'pause', at: T0 + 1 }));
    expect(transition(paused, { type: 'discard' })).toEqual({ state: null, finished: null, discarded: true });
  });

  it('allows only one active session', () => {
    expect(() => transition(start(), { type: 'start', runId: 'run-2', at: T0 })).toThrow('Cannot start while recording');
  });

  it('never produces a negative segment when clocks disagree', () => {
    const s = must(transition(start(), { type: 'pause', at: T0 - 5_000 }));
    expect(s.segments[0]).toEqual({ index: 0, startAt: T0, endAt: T0 });
  });
});
