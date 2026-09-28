import { destinationPoint } from '@/domain/geo';
import { toRoutePoint, type RoutePoint } from '@/domain/routes';
import { OfflineMaps, type OfflinePackPort } from '@/features/offline-maps/offline-maps';
import { mapboxBounds, MAX_AREA_TILES, megabytes, packName, routeArea, routeBounds, tilesAt } from '@/features/offline-maps/regions';

/** Map areas kept on the phone for routes (docs/ROADMAP.md 5.2). */
const START = { lat: 51.5007, lon: -0.1246 };
const square = (sideM: number): RoutePoint[] => {
  const out: RoutePoint[] = [toRoutePoint(START)];
  let p = START;
  for (const bearing of [0, 90, 180, 270]) {
    p = destinationPoint(p, bearing, sideM);
    out.push(toRoutePoint(p));
  }
  return out;
};

describe('the area to keep for a route', () => {
  it('covers the route with a margin, in Mapbox’s order', () => {
    const b = routeBounds(square(1000), 400);
    expect(b.south).toBeLessThan(START.lat);
    expect(b.north).toBeGreaterThan(destinationPoint(START, 0, 1000).lat);
    // About 400 m beyond the route on each side.
    expect((START.lat - b.south) * 111_195).toBeCloseTo(400, -1);
    expect(mapboxBounds(b)).toEqual([
      [b.east, b.north],
      [b.west, b.south],
    ]);
  });

  it('counts map tiles the way web maps number them', () => {
    // The whole world is one tile at zoom 0 and four at zoom 1.
    const world = { south: -85, west: -180, north: 85, east: 179.999 };
    expect(tilesAt(world, 0)).toBe(1);
    expect(tilesAt(world, 1)).toBe(4);
  });

  it('keeps a 10 km loop in full detail, drops close-up levels for long routes, and refuses huge ones', () => {
    const loop = routeArea(square(2500))!;
    expect(loop).toMatchObject({ minZoom: 10, maxZoom: 16 });
    expect(loop.tiles).toBeLessThan(MAX_AREA_TILES);
    expect(megabytes(loop.estimatedBytes)).toMatch(/MB$/);
    // A 48 km loop still fits in full detail; a 100 km one keeps less close-up detail.
    expect(routeArea(square(12_000))!.maxZoom).toBe(16);
    const long = routeArea(square(25_000))!;
    expect(long.maxZoom).toBeLessThan(16);
    expect(long.tiles).toBeLessThanOrEqual(MAX_AREA_TILES);
    expect(
      routeArea([
        [48, -1],
        [54, 3],
        [49, 6],
      ]),
    ).toBeNull();
    expect(routeArea([])).toBeNull();
  });
});

class FakePacks implements OfflinePackPort {
  packs = new Map<string, { metadata: Record<string, unknown>; percentage: number; bytes: number; complete: boolean }>();
  progress: ((s: { percentage: number; bytes: number; complete: boolean }) => void) | null = null;
  failed: ((message: string) => void) | null = null;

  async list() {
    return [...this.packs.entries()].map(([name, p]) => ({ name, ...p }));
  }
  async create(
    input: { name: string; metadata: Record<string, unknown> },
    onProgress: (s: { percentage: number; bytes: number; complete: boolean }) => void,
    onError: (message: string) => void,
  ) {
    this.packs.set(input.name, { metadata: input.metadata, percentage: 0, bytes: 0, complete: false });
    this.progress = (s) => {
      this.packs.set(input.name, { metadata: input.metadata, ...s });
      onProgress(s);
    };
    this.failed = onError;
  }
  async remove(name: string) {
    this.packs.delete(name);
  }
}

describe('map areas on the phone', () => {
  const area = routeArea(square(1500))!;

  it('downloads an area with its progress, and removes it', async () => {
    const packs = new FakePacks();
    const store = new OfflineMaps(packs);
    store.setAccount('account-a');
    await store.download('r1', 'River loop', area, 1_000);
    expect(store.getSnapshot()).toEqual([{ routeId: 'r1', name: 'River loop', state: 'downloading', percentage: 0, bytes: 0, createdAtMs: 1_000 }]);
    expect(packs.packs.get(packName('r1'))!.metadata).toEqual({ accountId: 'account-a', routeId: 'r1', name: 'River loop', createdAtMs: 1_000 });
    packs.progress!({ percentage: 40, bytes: 1_200_000, complete: false });
    expect(store.area('r1')).toMatchObject({ state: 'downloading', percentage: 40 });
    packs.progress!({ percentage: 100, bytes: 3_100_000, complete: true });
    expect(store.area('r1')).toMatchObject({ state: 'complete', bytes: 3_100_000 });

    await store.remove('r1');
    expect(store.getSnapshot()).toEqual([]);
    expect(packs.packs.size).toBe(0);
  });

  it('shows each account only its own areas, and signing out removes them', async () => {
    const packs = new FakePacks();
    const store = new OfflineMaps(packs);
    store.setAccount('account-a');
    await store.download('r1', 'Home loop', area);
    packs.progress!({ percentage: 100, bytes: 2_000_000, complete: true });

    store.setAccount('account-b');
    await store.refresh();
    expect(store.getSnapshot()).toEqual([]);
    await store.download('r2', 'Office run', area);

    store.setAccount('account-a');
    await store.refresh();
    expect(store.getSnapshot().map((a) => a.name)).toEqual(['Home loop']);
    await store.removeAll();
    expect([...packs.packs.keys()]).toEqual([packName('r2')]);
  });

  it('says when a download stops, and does nothing without Mapbox', async () => {
    const packs = new FakePacks();
    const store = new OfflineMaps(packs);
    store.setAccount('account-a');
    await store.download('r1', 'Hill repeats', area);
    packs.failed!('network');
    expect(store.area('r1')).toMatchObject({ state: 'stopped' });

    const none = new OfflineMaps(null);
    none.setAccount('account-a');
    expect(none.available).toBe(false);
    await expect(none.download('r1', 'x', area)).rejects.toThrow('offline maps unavailable');
  });
});
