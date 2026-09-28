import Constants from 'expo-constants';
import { Platform } from 'react-native';

import { env } from '@/config/env';

/**
 * Mapbox (docs/ROADMAP.md 5.2), for map areas kept on the phone and the maps of runs that follow
 * a route. Only in builds made with PL_MAPBOX=1 and a public token (app.config.ts); elsewhere the
 * module is never loaded, and the app uses Apple Maps or Google Maps as before.
 */
export type MapboxModule = typeof import('@rnmapbox/maps');

const extra = Constants.expoConfig?.extra as { mapbox?: boolean } | undefined;

export const MAPBOX_ENABLED = Platform.OS !== 'web' && extra?.mapbox === true && env.mapboxToken.length > 0;

let loaded: MapboxModule | null | undefined;

/** The Mapbox SDK, set up once with our token and its telemetry off; null in builds without it. */
export function mapbox(): MapboxModule | null {
  if (loaded !== undefined) return loaded;
  loaded = null;
  if (!MAPBOX_ENABLED) return loaded;
  try {
    // Loaded lazily: the native side exists only in builds made with PL_MAPBOX=1.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const lib = require('@rnmapbox/maps') as MapboxModule;
    void lib.setAccessToken(env.mapboxToken);
    // Mapbox would otherwise send location and usage events of its own.
    lib.setTelemetryEnabled(false);
    loaded = lib;
  } catch {
    loaded = null;
  }
  return loaded;
}
