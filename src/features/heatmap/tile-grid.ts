/** The web map grid's tiles (docs/ROADMAP.md 5.4), for laying the heatmap out without a map. */
export const TILE = 256;

/** Where a point falls on the web map grid at zoom `z`, in pixels. */
export function worldPixel(lat: number, lon: number, z: number): { x: number; y: number } {
  const scale = TILE * 2 ** z;
  const phi = (Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180;
  return { x: ((lon + 180) / 360) * scale, y: ((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * scale };
}

/** The tiles that cover a view of `width` × `height` around the centre, with where each goes. */
export function tilesAround(center: { lat: number; lon: number }, z: number, width: number, height: number) {
  const c = worldPixel(center.lat, center.lon, z);
  const left = c.x - width / 2;
  const top = c.y - height / 2;
  const tiles: { x: number; y: number; left: number; top: number }[] = [];
  const max = 2 ** z;
  for (let ty = Math.floor(top / TILE); ty <= Math.floor((top + height) / TILE); ty++) {
    for (let tx = Math.floor(left / TILE); tx <= Math.floor((left + width) / TILE); tx++) {
      if (ty < 0 || ty >= max) continue;
      tiles.push({ x: ((tx % max) + max) % max, y: ty, left: tx * TILE - left, top: ty * TILE - top });
    }
  }
  return { tiles, left, top };
}

/** The closest zoom (and its centre) at which the points fit in the view with some room around them. */
export function fitView(
  points: readonly { lat: number; lon: number }[],
  width: number,
  height: number,
  { pad = 24, minZoom = 10, maxZoom = 16 }: { pad?: number; minZoom?: number; maxZoom?: number } = {},
): { center: { lat: number; lon: number }; zoom: number } | null {
  if (points.length === 0 || width <= 2 * pad || height <= 2 * pad) return null;
  const lats = points.map((p) => p.lat);
  const lons = points.map((p) => p.lon);
  const [south, north, west, east] = [Math.min(...lats), Math.max(...lats), Math.min(...lons), Math.max(...lons)];
  const center = { lat: (south + north) / 2, lon: (west + east) / 2 };
  for (let zoom = maxZoom; zoom > minZoom; zoom--) {
    const a = worldPixel(north, west, zoom);
    const b = worldPixel(south, east, zoom);
    if (b.x - a.x <= width - 2 * pad && b.y - a.y <= height - 2 * pad) return { center, zoom };
  }
  return { center, zoom: minZoom };
}
