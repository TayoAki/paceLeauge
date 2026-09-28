import { createHmac, timingSafeEqual } from 'node:crypto';
import { deflateSync } from 'node:zlib';

import type { Pool } from './db';

/**
 * Heatmap tiles (docs/ROADMAP.md 5.4). The database keeps the published cells (each run through
 * by at least 5 different contributors, db/migrations/20261004000300_heatmap.sql); this renders
 * them as 256-pixel PNG map tiles, keeps each rendered tile until the next weekly build, and
 * signs the links the app loads them with. A link names no runner: it carries the build and an
 * expiry, signed with a key derived from the service's signing secret.
 */
export const CELL_ZOOM = 21;
export const MIN_ZOOM = 10;
export const MAX_ZOOM = 18;
const TILE = 256;
/** How long a tile link works. */
export const LINK_TTL_S = 24 * 3600;

/** Brightness levels 1 (5–9 runners) to 4 (50 or more): red-orange to yellow, more opaque. */
const PALETTE: [number, number, number, number][] = [
  [0, 0, 0, 0],
  [226, 72, 32, 120],
  [242, 104, 32, 170],
  [252, 156, 44, 215],
  [255, 222, 92, 255],
];

export interface TileCell {
  x: number;
  y: number;
  level: number;
}

/** The level of each of the tile's 256 × 256 pixels (the brightest cell wins where cells share one). */
export function renderTile(z: number, tileX: number, tileY: number, cells: TileCell[]): Uint8Array {
  const levels = new Uint8Array(TILE * TILE);
  const shift = CELL_ZOOM - z;
  const x0 = tileX * 2 ** shift;
  const y0 = tileY * 2 ** shift;
  const put = (px: number, py: number, level: number) => {
    if (px < 0 || py < 0 || px >= TILE || py >= TILE) return;
    const i = py * TILE + px;
    if (level > levels[i]!) levels[i] = level;
  };
  for (const c of cells) {
    const level = Math.max(0, Math.min(4, Math.round(c.level)));
    if (shift <= 8) {
      // Each cell is a square of pixels.
      const size = 2 ** (8 - shift);
      const left = (c.x - x0) * size;
      const top = (c.y - y0) * size;
      for (let dy = 0; dy < size; dy++) for (let dx = 0; dx < size; dx++) put(left + dx, top + dy, level);
    } else {
      // Several cells share each pixel.
      const per = 2 ** (shift - 8);
      put(Math.floor((c.x - x0) / per), Math.floor((c.y - y0) / per), level);
    }
  }
  return levels;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const body = Buffer.concat([head.subarray(4), Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head.subarray(0, 4), body, crc]);
}

/** An indexed-colour PNG of the levels, with the palette's transparency. */
export function encodeTile(levels: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(TILE, 0);
  ihdr.writeUInt32BE(TILE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 3; // indexed colour
  const plte = Buffer.from(PALETTE.flatMap(([r, g, b]) => [r, g, b]));
  const trns = Buffer.from(PALETTE.map(([, , , a]) => a));
  const raw = Buffer.alloc((TILE + 1) * TILE);
  for (let y = 0; y < TILE; y++) {
    raw[y * (TILE + 1)] = 0; // no filter
    raw.set(levels.subarray(y * TILE, (y + 1) * TILE), y * (TILE + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('PLTE', plte),
    chunk('tRNS', trns),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/** A tile with nothing on it. */
export const EMPTY_TILE = encodeTile(new Uint8Array(TILE * TILE));

function linkKey(secret: string): Buffer {
  return createHmac('sha256', secret).update('pl-heatmap-tiles-v1').digest();
}

function signature(secret: string, build: number, expiresAtS: number): string {
  return createHmac('sha256', linkKey(secret)).update(`${build}.${expiresAtS}`).digest('base64url').slice(0, 32);
}

/** The `t` parameter of a build's tile links: when it stops working, and a signature. */
export function tileToken(secret: string, build: number, expiresAtS: number): string {
  return `${expiresAtS}.${signature(secret, build, expiresAtS)}`;
}

export function verifyTileToken(secret: string, build: number, token: string | null, nowS: number): boolean {
  const match = token ? /^(\d{9,11})\.([A-Za-z0-9_-]{32})$/.exec(token) : null;
  if (!match) return false;
  const expiresAtS = Number(match[1]);
  if (expiresAtS < nowS || expiresAtS > nowS + LINK_TTL_S + 60) return false;
  const expected = Buffer.from(signature(secret, build, expiresAtS));
  const given = Buffer.from(match[2]!);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** The tile links the app gets from `get_heatmap_tiles`, relative to the API's address. */
export async function heatmapLinks(
  pool: Pool,
  secret: string,
  userId: string,
  nowS = Math.floor(Date.now() / 1000),
): Promise<{ build_id: number; path_template: string; expires_at_ms: number; min_zoom: number; max_zoom: number }> {
  const { rows } = await pool.query<{ build: string }>('select private.heatmap_tiles_check($1) as build', [userId]);
  const build = Number(rows[0]!.build);
  const expiresAtS = nowS + LINK_TTL_S;
  return {
    build_id: build,
    path_template: `/heatmap/${build}/{z}/{x}/{y}.png?t=${tileToken(secret, build, expiresAtS)}`,
    expires_at_ms: expiresAtS * 1000,
    min_zoom: MIN_ZOOM,
    max_zoom: MAX_ZOOM,
  };
}

/**
 * One tile of the current build: from the kept tiles, or rendered and kept. Null when the build
 * isn't the current one (the app asks for new links after a rebuild).
 */
export async function heatmapTile(pool: Pool, build: number, z: number, x: number, y: number): Promise<Buffer | null> {
  const current = await pool.query<{ id: string | null }>('select private.heatmap_current_build() as id');
  if (current.rows[0]?.id === null || Number(current.rows[0]?.id) !== build) return null;
  const kept = await pool.query<{ png: Buffer }>('select png from private.heatmap_tiles where build_id = $1 and z = $2 and x = $3 and y = $4', [build, z, x, y]);
  if (kept.rows[0]) return kept.rows[0].png;
  const { rows } = await pool.query<TileCell>('select x, y, level from private.heatmap_tile_cells($1, $2, $3)', [z, x, y]);
  // Most tiles are empty; those aren't worth keeping.
  if (rows.length === 0) return EMPTY_TILE;
  const png = encodeTile(renderTile(z, x, y, rows));
  await pool.query('insert into private.heatmap_tiles (build_id, z, x, y, png) values ($1, $2, $3, $4, $5) on conflict do nothing', [build, z, x, y, png]);
  return png;
}
