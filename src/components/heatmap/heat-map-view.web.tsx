import type { HeatMapViewProps } from './heat-map-types';
import { HeatTiles } from './heat-tiles';

/** The web app has no map tiles of its own: the heatmap's tiles are laid out on a grid. */
export function HeatMapView(props: HeatMapViewProps) {
  return <HeatTiles {...props} />;
}
