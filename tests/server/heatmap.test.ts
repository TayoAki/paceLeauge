import { inflateSync } from 'node:zlib';

import { crc32, EMPTY_TILE, encodeTile, LINK_TTL_S, renderTile, tileToken, verifyTileToken } from '../../server/src/heatmap';
import { signIn, startTestApi, type TestApi } from './harness';

/**
 * Heatmap tiles (docs/ROADMAP.md 5.4): the API service draws the published cells as PNG tiles,
 * keeps them until the next build, and serves them only through signed links that expire.
 */

/** The palette index of each pixel of a tile the service drew. */
function pixels(png: Buffer): Uint8Array {
  expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const idat: Buffer[] = [];
  let at = 8;
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const type = png.toString('ascii', at + 4, at + 8);
    const data = png.subarray(at + 8, at + 8 + length);
    expect(png.readUInt32BE(at + 8 + length)).toBe(crc32(png.subarray(at + 4, at + 8 + length)));
    if (type === 'IHDR') expect([data.readUInt32BE(0), data.readUInt32BE(4), data[8], data[9]]).toEqual([256, 256, 8, 3]);
    if (type === 'IDAT') idat.push(data);
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const out = new Uint8Array(256 * 256);
  for (let y = 0; y < 256; y++) {
    expect(raw[y * 257]).toBe(0);
    out.set(raw.subarray(y * 257 + 1, y * 257 + 257), y * 256);
  }
  return out;
}

describe('drawing tiles', () => {
  it('draws each cell as a square close up, and the brightest of several cells per pixel further out', () => {
    // Zoom 18: 8 cells a side, 32 pixels each. The tile at (x 5, y 7) starts at cell (40, 56).
    const near = pixels(encodeTile(renderTile(18, 5, 7, [{ x: 41, y: 58, level: 3 }])));
    expect(near[64 * 256 + 32]).toBe(3);
    expect(near[95 * 256 + 63]).toBe(3);
    expect(near[96 * 256 + 32]).toBe(0);
    expect(near.filter((p) => p === 3).length).toBe(32 * 32);
    // Zoom 10: 2,048 cells a side, 8 to a pixel; the brightest wins.
    const far = pixels(encodeTile(renderTile(10, 0, 0, [{ x: 16, y: 8, level: 1 }, { x: 17, y: 9, level: 4 }, { x: 800, y: 8, level: 2 }])));
    expect(far[1 * 256 + 2]).toBe(4);
    expect(far[1 * 256 + 100]).toBe(2);
    expect(far.filter((p) => p > 0).length).toBe(2);
    expect(pixels(EMPTY_TILE).every((p) => p === 0)).toBe(true);
  });

  it('signs links for one build until they expire', () => {
    const now = 1_790_000_000;
    const token = tileToken('secret', 7, now + LINK_TTL_S);
    expect(verifyTileToken('secret', 7, token, now)).toBe(true);
    expect(verifyTileToken('secret', 8, token, now)).toBe(false);
    expect(verifyTileToken('other', 7, token, now)).toBe(false);
    expect(verifyTileToken('secret', 7, token, now + LINK_TTL_S + 1)).toBe(false);
    expect(verifyTileToken('secret', 7, `${now + LINK_TTL_S}.${'A'.repeat(32)}`, now)).toBe(false);
    // A link can't be made to last longer than a day.
    expect(verifyTileToken('secret', 7, tileToken('secret', 7, now + 30 * LINK_TTL_S), now)).toBe(false);
    expect(verifyTileToken('secret', 7, null, now)).toBe(false);
  });
});

describe('serving tiles', () => {
  let api: TestApi;
  beforeAll(async () => {
    api = await startTestApi();
  });
  afterAll(async () => {
    await api.close();
  });

  it('gives signed-in adults links to the current build, and serves its tiles', async () => {
    const anon = await api.client().rpc('get_heatmap_tiles');
    expect(anon.error?.message).toBe('not_authenticated');
    const { client: noProfile } = await signIn(api);
    expect((await noProfile.rpc('get_heatmap_tiles')).error?.message).toBe('profile_required');
    const { client, session } = await signIn(api);
    await client.rpc('save_profile', { p_alias: 'Tile Tess', p_units: 'metric', p_goal_days: 3, p_notification_tz: 'America/Chicago', p_ack_eligibility: true });
    // Nothing built yet.
    expect((await client.rpc('get_heatmap_tiles')).error?.message).toBe('not_available');

    // A build with one busy cell near (45.07, 7.66).
    await api.db.sql(`insert into private.heatmap_cells (x, y, runners) select c.x, c.y, 12 from private.heatmap_cell(45.07, 7.66) c`);
    const build = await api.db.one<{ id: string }>(`insert into private.heatmap_builds (runs, runners, cells) values (40, 12, 1) returning id`);
    const links = await client.rpc('get_heatmap_tiles');
    expect(links.error).toBeNull();
    expect(links.data).toMatchObject({ build_id: Number(build.id), min_zoom: 10, max_zoom: 18, expires_at_ms: expect.any(Number) });
    expect(links.data.path_template).toMatch(new RegExp(`^/heatmap/${build.id}/\\{z\\}/\\{x\\}/\\{y\\}\\.png\\?t=\\d+\\.[A-Za-z0-9_-]{32}$`));
    // The link names no runner.
    expect(links.data.path_template).not.toContain(session.user.id);

    const cell = await api.db.one<{ x: number; y: number }>('select x, y from private.heatmap_cell(45.07, 7.66)');
    const z = 16;
    const [tx, ty] = [cell.x >> 5, cell.y >> 5];
    const tile = (path: string) => fetch(`${api.url}${path}`);
    const at = (zz: number, x: number, y: number) => links.data.path_template.replace('{z}', String(zz)).replace('{x}', String(x)).replace('{y}', String(y));
    const res = await tile(at(z, tx, ty));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toBe('private, max-age=86400');
    const drawn = pixels(Buffer.from(await res.arrayBuffer()));
    // Zoom 16: 32 cells a side, 8 pixels each; 12 runners is level 2.
    expect(drawn[(cell.y - (ty << 5)) * 8 * 256 + (cell.x - (tx << 5)) * 8]).toBe(2);
    expect(drawn.filter((p) => p > 0).length).toBe(64);
    // Kept for next time.
    expect(await api.db.sql('select 1 from private.heatmap_tiles where build_id = $1 and z = $2 and x = $3 and y = $4', [build.id, z, tx, ty])).toHaveLength(1);
    // An empty tile is served, not kept.
    expect((await tile(at(z, tx + 3, ty))).status).toBe(200);
    expect(await api.db.sql('select 1 from private.heatmap_tiles where x = $1', [tx + 3])).toEqual([]);

    // Tampered, expired, out of range, or an old build.
    const [path, token] = at(z, tx, ty).split('?t=') as [string, string];
    expect((await tile(`${path}?t=${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`)).status).toBe(403);
    expect((await tile(path)).status).toBe(403);
    expect((await tile(at(9, tx >> 7, ty >> 7))).status).toBe(404);
    expect((await tile(at(19, tx << 3, ty << 3))).status).toBe(404);
    await api.db.sql(`insert into private.heatmap_builds (runs, runners, cells) values (41, 12, 1)`);
    expect((await tile(at(z, tx, ty))).status).toBe(404);
    const fresh = await client.rpc('get_heatmap_tiles');
    expect(fresh.data.build_id).toBe(Number(build.id) + 1);
  });

  it('refuses teens', async () => {
    await api.db.sql(`select private.set_flag('teen_accounts_enabled', true, 'heatmap test', 'test')`);
    const { client, session } = await signIn(api);
    await client.rpc('save_profile', { p_alias: 'Tile Teen', p_units: 'metric', p_goal_days: 3, p_notification_tz: 'America/Chicago', p_ack_eligibility: true });
    await api.db.sql(`update public.profiles set age_signal = 'teen_16_17' where user_id = $1`, [session.user.id]);
    expect((await client.rpc('get_heatmap_tiles')).error?.message).toBe('teen_restricted');
  });
});
