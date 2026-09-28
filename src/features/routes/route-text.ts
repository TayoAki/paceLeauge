import type { RouteKind } from '@/domain/routes';
import type { Units } from '@/domain/types';

/** How a route's distance reads: "10.0 km", "6.2 mi". */
export function routeDistance(m: number, units: Units): string {
  const value = units === 'imperial' ? m / 1609.344 : m / 1000;
  return `${value.toFixed(1)} ${units === 'imperial' ? 'mi' : 'km'}`;
}

export function routeClimb(m: number | null, units: Units): string | null {
  if (m === null) return null;
  return units === 'imperial' ? `${Math.round(m * 3.28084)} ft climb` : `${m} m climb`;
}

export const KIND_NAMES: Record<RouteKind, string> = { loop: 'Loop', path: 'Along paths', drawn: 'Drawn' };

/** "10.0 km · Loop · 12 turns · 85 m climb" */
export function routeSummary(route: { distance_m: number; kind: RouteKind; turns: number; ascent_m: number | null }, units: Units): string {
  return [
    routeDistance(route.distance_m, units),
    KIND_NAMES[route.kind],
    route.turns > 0 ? `${route.turns} ${route.turns === 1 ? 'turn' : 'turns'}` : null,
    routeClimb(route.ascent_m, units),
  ]
    .filter(Boolean)
    .join(' · ');
}

/** A short distance for a screen: "350 m", "1.2 km", "380 ft", "0.8 mi". */
export function shortDistance(m: number, units: Units): string {
  if (units === 'imperial') {
    const feet = m * 3.28084;
    return feet < 1000 ? `${Math.round(feet / 10) * 10} ft` : `${(m / 1609.344).toFixed(1)} mi`;
  }
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
}
