import type { RecorderEvent } from '@/features/recording/recorder-service';
import type { RecorderSnapshot } from '@/features/recording/types';
import { LIVE_SHARE_KEY, LiveShareController, liveLink, mapLinks, NoRunToShareError, seenAgo, type LiveTransport } from '@/features/live-share/live-share';

/** Live location on the phone (docs/ROADMAP.md 4.8): a fix every 30 seconds, and a stop when the run ends. */
function setup(options: { runId?: string | null } = {}) {
  let now = 1_000_000;
  const kv = new Map<string, unknown>();
  const listeners = new Set<() => void>();
  const eventListeners = new Set<(e: RecorderEvent) => void>();
  let snapshot = {
    session: options.runId === null ? null : { runId: options.runId ?? 'run-1', status: 'recording' },
    metrics: { distanceM: 1_200, activeMs: 420_000 },
    lastSaved: null,
    autoPaused: false,
    lastPosition: { lat: 41.9, lon: -87.62, accuracyM: 5, at: now },
  } as unknown as RecorderSnapshot;
  const recorder = {
    getSnapshot: () => snapshot,
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    subscribeEvents: (l: (e: RecorderEvent) => void) => {
      eventListeners.add(l);
      return () => eventListeners.delete(l);
    },
  };
  const posts: { lat: number; atMs: number; distanceM: number }[] = [];
  const ends: string[] = [];
  let online = true;
  let serverLive = true;
  const transport: LiveTransport = {
    startLiveShare: async (minutes) => ({ share_id: 'share-1', token: 'a'.repeat(64), expires_at_ms: now + minutes * 60_000 }),
    postLiveLocation: async (_id, p) => {
      if (!online) throw new Error('network');
      posts.push({ lat: p.lat, atMs: p.atMs, distanceM: p.distanceM });
      return { live: serverLive, expires_at_ms: now + 3_600_000 };
    },
    endLiveShare: async (_id, reason) => {
      if (!online) throw new Error('network');
      ends.push(reason);
    },
  };
  const controller = new LiveShareController({
    kv: {
      getKv: async <T,>(key: string) => (kv.has(key) ? { value: kv.get(key) as T } : null),
      setKv: async (key, value) => void kv.set(key, value),
      deleteKv: async (key) => void kv.delete(key),
    },
    recorder,
    now: () => now,
  });
  controller.start();
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    controller,
    kv,
    posts,
    ends,
    transport,
    flush,
    advance: (ms: number) => {
      now += ms;
    },
    fix: async (lat: number) => {
      snapshot = { ...snapshot, lastPosition: { lat, lon: -87.62, accuracyM: 5, at: now } } as RecorderSnapshot;
      for (const l of listeners) l();
      await flush();
    },
    setSession: async (runId: string | null) => {
      snapshot = { ...snapshot, session: runId ? ({ runId, status: 'recording' } as RecorderSnapshot['session']) : null };
      for (const l of listeners) l();
      await flush();
    },
    emit: async (event: RecorderEvent) => {
      for (const l of eventListeners) l(event);
      await flush();
    },
    setOnline: (value: boolean) => {
      online = value;
    },
    setServerLive: (value: boolean) => {
      serverLive = value;
    },
  };
}

describe('live location on the phone', () => {
  it('posts the first fix at once, then about every 30 seconds', async () => {
    const t = setup();
    t.controller.setTransport(t.transport);
    const link = await t.controller.share(120);
    await t.flush();
    expect(link).toMatchObject({ shareId: 'share-1', runId: 'run-1' });
    expect(t.kv.get(LIVE_SHARE_KEY)).toMatchObject({ shareId: 'share-1' });
    expect(t.posts).toHaveLength(1);
    t.advance(10_000);
    await t.fix(41.91);
    expect(t.posts).toHaveLength(1);
    t.advance(21_000);
    await t.fix(41.92);
    expect(t.posts.map((p) => p.lat)).toEqual([41.9, 41.92]);
    expect(t.posts[1]).toMatchObject({ distanceM: 1_200 });
  });

  it('stops the link when the run is saved, and tries again if the phone was offline', async () => {
    const t = setup();
    t.controller.setTransport(t.transport);
    await t.controller.share(60);
    t.setOnline(false);
    await t.emit({ name: 'run_saved_local', runId: 'run-1', interrupted: false, activeMs: 1, points: 1 });
    // Stopped on the phone at once, and remembered until the server hears.
    expect(t.controller.getSnapshot()).toBeNull();
    expect(t.kv.get(LIVE_SHARE_KEY)).toMatchObject({ ending: 'run_ended' });
    expect(t.ends).toEqual([]);
    t.setOnline(true);
    await t.fix(41.93);
    expect(t.ends).toEqual(['run_ended']);
    expect(t.kv.has(LIVE_SHARE_KEY)).toBe(false);
  });

  it('stops when the run is discarded or another begins, and forgets a link the server stopped', async () => {
    const discarded = setup();
    discarded.controller.setTransport(discarded.transport);
    await discarded.controller.share(60);
    await discarded.setSession(null);
    expect(discarded.ends).toEqual(['run_ended']);

    const replaced = setup();
    replaced.controller.setTransport(replaced.transport);
    await replaced.controller.share(60);
    await replaced.setSession('run-2');
    expect(replaced.ends).toEqual(['run_ended']);

    const server = setup();
    server.controller.setTransport(server.transport);
    server.setServerLive(false);
    await server.controller.share(60);
    await server.flush();
    expect(server.controller.getSnapshot()).toBeNull();
    expect(server.kv.has(LIVE_SHARE_KEY)).toBe(false);
  });

  it('carries on after a relaunch, and lets a link that ran out go', async () => {
    const t = setup();
    t.kv.set(LIVE_SHARE_KEY, { shareId: 'share-9', token: 'b'.repeat(64), expiresAtMs: 2_000_000, runId: 'run-1' });
    await t.controller.restore();
    expect(t.controller.getSnapshot()).toMatchObject({ shareId: 'share-9' });
    t.advance(2_000_000);
    await t.fix(42);
    expect(t.controller.getSnapshot()).toBeNull();
    expect(t.posts).toEqual([]);

    const idle = setup({ runId: null });
    idle.controller.setTransport(idle.transport);
    await expect(idle.controller.share(60)).rejects.toBeInstanceOf(NoRunToShareError);
  });
});

describe('live location helpers', () => {
  it('builds the link, the maps links and the last-seen time', () => {
    expect(liveLink('https://app.paceleague.test/', 'abc')).toBe('https://app.paceleague.test/live/abc');
    expect(liveLink('', 'abc')).toBe('paceleague://live/abc');
    expect(mapLinks(41.9, -87.62)).toEqual({
      apple: 'https://maps.apple.com/?ll=41.90000,-87.62000&q=Runner',
      google: 'https://www.google.com/maps/search/?api=1&query=41.90000,-87.62000',
    });
    expect(seenAgo(0, 3_000)).toBe('just now');
    expect(seenAgo(0, 42_000)).toBe('42 seconds ago');
    expect(seenAgo(0, 61_000)).toBe('1 minute ago');
    expect(seenAgo(0, 300_000)).toBe('5 minutes ago');
  });
});
