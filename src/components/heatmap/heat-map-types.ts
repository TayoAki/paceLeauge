import type { HeatmapTiles } from '@/api/heatmap-api';
import type { LatLng } from '@/components/run/route-lines';

export interface HeatMapViewProps {
  /** Where the runner is; the map opens around it. */
  center: { lat: number; lon: number };
  tiles: HeatmapTiles;
  height: number;
  /** A suggested loop, drawn over the heat. */
  route?: LatLng[] | null;
  accessibilityLabel: string;
}
