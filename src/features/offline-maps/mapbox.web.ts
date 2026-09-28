/** The web app has no offline map areas; it draws routes on a grid. */
export type MapboxModule = never;
export const MAPBOX_ENABLED = false;
export function mapbox(): MapboxModule | null {
  return null;
}
