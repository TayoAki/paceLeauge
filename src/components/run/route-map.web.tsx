import { RouteSketch } from './route-sketch';
import type { RouteMapProps } from './route-map';

/**
 * Web app: the route drawn on a plain grid (no map tiles or place labels). iOS uses Apple Maps
 * and Android Google Maps (route-map.tsx).
 */
export function RouteMap({ lines, guide, height, current, accessibilityLabel }: RouteMapProps) {
  return <RouteSketch lines={lines} guide={guide} current={current} height={height} accessibilityLabel={accessibilityLabel} />;
}
