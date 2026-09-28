import { RouteSketch } from '@/components/run/route-sketch';

import type { PlannerMapProps } from './planner-map';

/** Drawing needs a map to tap; the web app plans loops and shows routes on a grid. */
export const CAN_DRAW = false;

export function PlannerMap({ route, markers, center, height, accessibilityLabel }: PlannerMapProps) {
  return <RouteSketch lines={[]} guide={route} markers={markers} current={route ? null : center} height={height} accessibilityLabel={accessibilityLabel} />;
}
