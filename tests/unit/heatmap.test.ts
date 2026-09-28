import { heatmapSchema, heatmapTileUrl, heatmapUrlTemplate, type Hotspot } from '@/api/heatmap-api';
import { fitView, tilesAround, worldPixel } from '@/features/heatmap/tile-grid';
import { destinationPoint, haversineM, type LatLon } from '@/domain/geo';
import { routeRun } from '@/domain/synthetic';
import { PATH_FACTOR, pickLoops, planSuggestion } from '@/features/heatmap/suggest';

/** Suggested loops and the heatmap's tiles on the web (docs/ROADMAP.md 5.4). */
const START: LatLon = { lat: 52.2053, lon: 0.1218 };
const spot = (bearing: number, m: number, level = 1): Hotspot => ({ ...destinationPoint(START, bearing, m), level, distance_m: m });

describe('suggested loops', () => {
  it('goes through two busy places in different directions, about the distance asked for once paths wind', () => {
    const spots = [spot(0, 1100, 2), spot(10, 1150, 1), spot(90, 1100, 1), spot(200, 3000, 1)];
    const [best, ...rest] = pickLoops(START, spots, 5000, 3);
    expect(best!.via).toHaveLength(2);
    // Not the two places almost in line (0° and 10°).
    expect(best!.via.map((p) => Math.round(haversineM(START, p)))).toEqual([1100, 1100]);
    expect(Math.abs(best!.straightM * PATH_FACTOR - 5000) / 5000).toBeLessThan(0.3);
    // No place is used twice.
    const used = [best!, ...rest].flatMap((l) => l.via.map((p) => `${p.lat},${p.lon}`));
    expect(new Set(used).size).toBe(used.length);
    // Plain points for the planner.
    expect(Object.keys(best!.via[0]!).sort()).toEqual(['lat', 'lon']);
  });

  it('goes out to one place and back when that fits, and suggests nothing that doesn’t', () => {
    const loops = pickLoops(START, [spot(45, 1900, 3)], 5000);
    expect(loops).toEqual([{ via: [{ lat: expect.any(Number), lon: expect.any(Number) }], straightM: 3800, busy: 3 }]);
    expect(pickLoops(START, [spot(45, 400)], 21_100)).toEqual([]);
    expect(pickLoops(START, [], 5000)).toEqual([]);
  });

  it('plans each loop as stretches along paths, joined', async () => {
    const asked: [LatLon, LatLon][] = [];
    const api = {
      planLeg: async (from: LatLon, to: LatLon) => {
        asked.push([from, to]);
        return { distance_m: haversineM(from, to), ascent_m: 5, points: [[from.lat, from.lon], [to.lat, to.lon]] as [number, number][], cues: [], within_tolerance: null };
      },
    };
    const [plan] = pickLoops(START, [spot(0, 1100, 2), spot(90, 1100, 1)], 5000);
    const route = await planSuggestion(api, START, plan!);
    expect(asked).toHaveLength(3);
    expect(asked[0]![0]).toEqual(START);
    expect(asked[2]![1]).toEqual(START);
    expect(route.points[0]).toEqual([START.lat, START.lon]);
    expect(route.points[route.points.length - 1]).toEqual([START.lat, START.lon]);
    expect(Math.round(route.distanceM)).toBe(Math.round(1100 + haversineM(plan!.via[0]!, plan!.via[1]!) + 1100));
    expect(route.ascentM).toBe(15);
  });
});

describe('heatmap tiles', () => {
  it('lays out the tiles around the runner on the web map grid', () => {
    // Zoom 0: the whole world in one 256-pixel tile, the equator across the middle.
    expect(worldPixel(0, 0, 0)).toEqual({ x: 128, y: 128 });
    const z = 15;
    const c = worldPixel(START.lat, START.lon, z);
    const { tiles, left, top } = tilesAround(START, z, 390, 320);
    expect(left).toBeCloseTo(c.x - 195);
    expect(top).toBeCloseTo(c.y - 160);
    // The tile under the runner is placed so the runner is in the middle of the view.
    const under = tiles.find((t) => t.x === Math.floor(c.x / 256) && t.y === Math.floor(c.y / 256))!;
    expect(under.left + (c.x % 256)).toBeCloseTo(195);
    expect(under.top + (c.y % 256)).toBeCloseTo(160);
    expect(tiles.length).toBeGreaterThanOrEqual(4);
    expect(tiles.length).toBeLessThanOrEqual(9);
  });

  it('frames a loop at the closest zoom it fits', () => {
    const loop = [START, destinationPoint(START, 0, 1200), destinationPoint(START, 90, 1200)];
    const view = fitView(loop, 390, 320)!;
    const a = worldPixel(Math.max(...loop.map((p) => p.lat)), START.lon, view.zoom);
    const b = worldPixel(START.lat, Math.max(...loop.map((p) => p.lon)), view.zoom);
    expect(b.x - a.x).toBeLessThanOrEqual(390 - 48);
    expect(b.y - a.y).toBeLessThanOrEqual(320 - 48);
    // One closer and it wouldn't.
    const c = worldPixel(Math.max(...loop.map((p) => p.lat)), START.lon, view.zoom + 1);
    const d = worldPixel(START.lat, Math.max(...loop.map((p) => p.lon)), view.zoom + 1);
    expect(d.x - c.x > 390 - 48 || d.y - c.y > 320 - 48).toBe(true);
    expect(fitView([], 390, 320)).toBeNull();
  });

  it('builds tile links from the API address and the signed template', () => {
    const tiles = { path_template: '/heatmap/3/{z}/{x}/{y}.png?t=1790000000.abc' };
    expect(heatmapTileUrl('https://api.example.test/', tiles, 15, 16395, 10891)).toBe('https://api.example.test/heatmap/3/15/16395/10891.png?t=1790000000.abc');
    expect(heatmapUrlTemplate('https://api.example.test', tiles)).toBe('https://api.example.test/heatmap/3/{z}/{x}/{y}.png?t=1790000000.abc');
    expect(heatmapSchema.parse({ contributing: false, contributing_since_ms: null, min_runners: 5, window_days: 365, min_zoom: 10, max_zoom: 18, build: null }).build).toBeNull();
  });

  it('builds synthetic runs through waypoints, a fix a second', () => {
    const run = routeRun(0, [START, destinationPoint(START, 90, 400), destinationPoint(START, 0, 400)], 4);
    expect(run.points[0]!.t).toBe(0);
    expect(run.points).toHaveLength(1 + 100 + Math.round(haversineM(destinationPoint(START, 90, 400), destinationPoint(START, 0, 400)) / 4));
    expect(run.segments).toEqual([{ index: 0, startAt: 0, endAt: run.endedAt }]);
  });
});
