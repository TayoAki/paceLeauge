import type { Hotspot } from '@/api/heatmap-api';
import type { RoutesApi } from '@/api/routes-api';
import { haversineM, type LatLon } from '@/domain/geo';
import { bearingDeg, joinLegs, turnAngle, type JoinedRoute } from '@/domain/routes';
import { plannedLeg } from '@/features/routes/planner';

/**
 * Suggested routes (docs/ROADMAP.md 5.4): loops from the runner through the busiest places the
 * heatmap shows nearby, planned along paths by the route planner. The server gives the places
 * (only cells at least 5 runners share); the choice of loops happens here.
 */

/** Paths wind: a loop along them is about this much longer than the straight lines between its turns. */
export const PATH_FACTOR = 1.3;

export interface LoopPlan {
  /** Start → these → back to the start. */
  via: LatLon[];
  /** The straight-line length, which paths make about 30 % longer. */
  straightM: number;
  /** How busy its places are: the sum of their levels. */
  busy: number;
}

/**
 * Up to `count` loops of about `distanceM`: start → A → B → start through two busy places in
 * different directions (at least 40° apart, so it isn't there and back), or out to one place and
 * back when that's all there is. Brighter places first; loops share no place.
 */
export function pickLoops(start: LatLon, hotspots: Hotspot[], distanceM: number, count = 3): LoopPlan[] {
  const target = distanceM / PATH_FACTOR;
  const fit = (straight: number) => Math.abs(straight - target) / target;
  const candidates: (LoopPlan & { score: number; keys: string[] })[] = [];
  const key = (h: Hotspot) => `${h.lat},${h.lon}`;
  const at = (h: Hotspot): LatLon => ({ lat: h.lat, lon: h.lon });
  for (let i = 0; i < hotspots.length; i++) {
    const a = hotspots[i]!;
    for (let j = i + 1; j < hotspots.length; j++) {
      const b = hotspots[j]!;
      if (Math.abs(turnAngle(bearingDeg(start, a), bearingDeg(start, b))) < 40) continue;
      const straightM = a.distance_m + haversineM(a, b) + b.distance_m;
      if (fit(straightM) > 0.3) continue;
      candidates.push({ via: [at(a), at(b)], straightM, busy: a.level + b.level, score: a.level + b.level - 4 * fit(straightM), keys: [key(a), key(b)] });
    }
    const outAndBack = 2 * a.distance_m;
    if (fit(outAndBack) <= 0.3) {
      candidates.push({ via: [at(a)], straightM: outAndBack, busy: a.level, score: a.level - 1 - 4 * fit(outAndBack), keys: [key(a)] });
    }
  }
  candidates.sort((x, y) => y.score - x.score);
  const used = new Set<string>();
  const chosen: LoopPlan[] = [];
  for (const c of candidates) {
    if (chosen.length >= count) break;
    if (c.keys.some((k) => used.has(k))) continue;
    c.keys.forEach((k) => used.add(k));
    chosen.push({ via: c.via, straightM: c.straightM, busy: c.busy });
  }
  return chosen;
}

/** Plans a loop along paths: one stretch to each place and one back. */
export async function planSuggestion(api: Pick<RoutesApi, 'planLeg'>, start: LatLon, plan: LoopPlan): Promise<JoinedRoute> {
  const stops = [start, ...plan.via, start];
  const legs = [];
  for (let k = 1; k < stops.length; k++) legs.push(plannedLeg(await api.planLeg(stops[k - 1]!, stops[k]!)));
  return joinLegs(legs);
}
