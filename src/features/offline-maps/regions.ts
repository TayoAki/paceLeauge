import { EARTH_RADIUS_M } from '@/domain/geo';
import type { RoutePoint } from '@/domain/routes';

/**
 * The map area to keep for a route (docs/ROADMAP.md 5.2): the route's bounds and a margin around
 * them, from zoom 10 (the town) to 16 (paths and street names), fewer close-up levels for long
 * routes so an area stays a sensible download.
 */
export const OFFLINE_ZOOM = { min: 10, max: 16, floor: 13 } as const;
/** Map tiles for one area at most; Mapbox limits how many a phone may keep. */
export const MAX_AREA_TILES = 3_000;
export const ROUTE_MARGIN_M = 400;
/** Mapbox's vector tiles average roughly this much each in towns; for estimates only. */
const BYTES_PER_TILE = 30_000;

export interface Bounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface MapArea {
  bounds: Bounds;
  minZoom: number;
  maxZoom: number;
  tiles: number;
  estimatedBytes: number;
}

export function routeBounds(points: readonly RoutePoint[], marginM = ROUTE_MARGIN_M): Bounds {
  let south = 90;
  let north = -90;
  let west = 180;
  let east = -180;
  for (const [lat, lon] of points) {
    south = Math.min(south, lat);
    north = Math.max(north, lat);
    west = Math.min(west, lon);
    east = Math.max(east, lon);
  }
  const dLat = (marginM / EARTH_RADIUS_M) * (180 / Math.PI);
  const mid = ((south + north) / 2) * (Math.PI / 180);
  const dLon = dLat / Math.max(0.01, Math.cos(mid));
  return {
    south: Math.max(-85, south - dLat),
    north: Math.min(85, north + dLat),
    west: Math.max(-180, west - dLon),
    east: Math.min(180, east + dLon),
  };
}

function tileX(lon: number, z: number): number {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}

function tileY(lat: number, z: number): number {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
}

/** Web-map tiles covering the bounds at one zoom level. */
export function tilesAt(bounds: Bounds, z: number): number {
  const xs = tileX(bounds.east, z) - tileX(bounds.west, z) + 1;
  const ys = tileY(bounds.south, z) - tileY(bounds.north, z) + 1;
  return xs * ys;
}

export function tilesFor(bounds: Bounds, minZoom: number, maxZoom: number): number {
  let total = 0;
  for (let z = minZoom; z <= maxZoom; z++) total += tilesAt(bounds, z);
  return total;
}

/** The area to download for a route, or null when even the least detail is too much. */
export function routeArea(points: readonly RoutePoint[]): MapArea | null {
  if (points.length === 0) return null;
  const bounds = routeBounds(points);
  let maxZoom: number = OFFLINE_ZOOM.max;
  let tiles = tilesFor(bounds, OFFLINE_ZOOM.min, maxZoom);
  while (tiles > MAX_AREA_TILES && maxZoom > OFFLINE_ZOOM.floor) {
    maxZoom -= 1;
    tiles = tilesFor(bounds, OFFLINE_ZOOM.min, maxZoom);
  }
  if (tiles > MAX_AREA_TILES) return null;
  return { bounds, minZoom: OFFLINE_ZOOM.min, maxZoom, tiles, estimatedBytes: tiles * BYTES_PER_TILE };
}

/** Mapbox's order: [[east, north], [west, south]]. */
export function mapboxBounds(b: Bounds): [[number, number], [number, number]] {
  return [
    [b.east, b.north],
    [b.west, b.south],
  ];
}

export const packName = (routeId: string) => `route:${routeId}`;

/** "4.2 MB" */
export function megabytes(bytes: number): string {
  const mb = bytes / 1_000_000;
  return mb < 10 ? `${Math.max(0.1, Math.round(mb * 10) / 10)} MB` : `${Math.round(mb)} MB`;
}
