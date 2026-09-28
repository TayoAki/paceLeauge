import { z } from 'zod';

import type { Call } from './social-api';

/**
 * The heatmap (docs/ROADMAP.md 5.4): popular running paths, drawn only where at least 5 different
 * runners have run, from runners who contribute. Field names mirror
 * db/migrations/20261004000300_heatmap.sql and server/src/heatmap.ts.
 */
export const heatmapSchema = z.object({
  contributing: z.boolean(),
  contributing_since_ms: z.number().nullable(),
  min_runners: z.number(),
  window_days: z.number(),
  min_zoom: z.number(),
  max_zoom: z.number(),
  build: z.object({ id: z.number(), built_at_ms: z.number(), cells: z.number() }).nullable(),
});
export type Heatmap = z.infer<typeof heatmapSchema>;

/** Signed tile links, relative to the API's address; they expire after a day. */
export const heatmapTilesSchema = z.object({
  build_id: z.number(),
  path_template: z.string(),
  expires_at_ms: z.number(),
  min_zoom: z.number(),
  max_zoom: z.number(),
});
export type HeatmapTiles = z.infer<typeof heatmapTilesSchema>;

/** A busy place on the map near the runner: 1 (at least 5 runners) to 4 (50 or more). */
export const hotspotSchema = z.object({ lat: z.number(), lon: z.number(), level: z.number(), distance_m: z.number() });
export type Hotspot = z.infer<typeof hotspotSchema>;

export interface HeatmapApi {
  getHeatmap(): Promise<Heatmap>;
  setHeatmapContribution(on: boolean): Promise<Heatmap>;
  getHeatmapTiles(): Promise<HeatmapTiles>;
  getHeatmapHotspots(lat: number, lon: number): Promise<Hotspot[]>;
}

export function heatmapApi(call: Call): HeatmapApi {
  return {
    getHeatmap: () => call('get_heatmap', {}, heatmapSchema),
    setHeatmapContribution: (on) => call('set_heatmap_contribution', { p_on: on }, heatmapSchema),
    getHeatmapTiles: () => call('get_heatmap_tiles', {}, heatmapTilesSchema),
    getHeatmapHotspots: (lat, lon) => call('get_heatmap_hotspots', { p_lat: lat, p_lon: lon }, z.array(hotspotSchema)),
  };
}

/** A tile link the map can load, from the API's address and the signed template. */
export function heatmapTileUrl(apiUrl: string, tiles: Pick<HeatmapTiles, 'path_template'>, z: number, x: number, y: number): string {
  return `${apiUrl.replace(/\/+$/, '')}${tiles.path_template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y))}`;
}

/** The template for map views that fill in {z}/{x}/{y} themselves. */
export function heatmapUrlTemplate(apiUrl: string, tiles: Pick<HeatmapTiles, 'path_template'>): string {
  return `${apiUrl.replace(/\/+$/, '')}${tiles.path_template}`;
}
