import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';

import type { LatLng } from '@/components/run/route-lines';
import type { RouteMapProps } from '@/components/run/route-map';
import { colors, radius } from '@/design/tokens';
import { mapbox } from '@/features/offline-maps/mapbox';

const line = (points: LatLng[]) => ({
  type: 'Feature' as const,
  properties: {},
  geometry: { type: 'LineString' as const, coordinates: points.map((p) => [p.longitude, p.latitude]) },
});

/**
 * A route and the run on it, drawn by Mapbox (docs/ROADMAP.md 5.2), which uses the map areas kept
 * on the phone when there's no signal. Only in builds with Mapbox (features/offline-maps/mapbox).
 */
export function MapboxRouteMap({ lines, guide, current, height, follow = false, interactive = false, accessibilityLabel }: RouteMapProps) {
  const lib = mapbox();
  const guideShape = useMemo(() => (guide && guide.length > 1 ? line(guide) : null), [guide]);
  const runShape = useMemo(() => ({ type: 'FeatureCollection' as const, features: lines.filter((l) => l.length > 1).map(line) }), [lines]);
  const bounds = useMemo(() => {
    const all = lines.length > 0 ? lines.flat() : (guide ?? []);
    if (all.length === 0) return null;
    const lats = all.map((p) => p.latitude);
    const lons = all.map((p) => p.longitude);
    return { ne: [Math.max(...lons), Math.max(...lats)], sw: [Math.min(...lons), Math.min(...lats)] };
  }, [lines, guide]);
  if (!lib) return null;
  const { MapView, Camera, ShapeSource, LineLayer, LocationPuck } = lib;
  const following = follow && current;

  return (
    <View style={[styles.frame, { height }]} accessible accessibilityRole="image" accessibilityLabel={accessibilityLabel}>
      <MapView
        style={StyleSheet.absoluteFill}
        styleURL={String(lib.StyleURL.Outdoors)}
        scaleBarEnabled={false}
        compassEnabled={false}
        pitchEnabled={false}
        rotateEnabled={false}
        scrollEnabled={interactive}
        zoomEnabled={interactive}>
        {following ? (
          <Camera centerCoordinate={[current.longitude, current.latitude]} zoomLevel={15.5} animationDuration={600} />
        ) : bounds ? (
          <Camera bounds={bounds} padding={{ paddingTop: 36, paddingRight: 36, paddingBottom: 36, paddingLeft: 36 }} animationDuration={0} />
        ) : null}
        {guideShape ? (
          <ShapeSource id="followed-route" shape={guideShape}>
            <LineLayer
              id="followed-route-line"
              style={{ lineColor: lines.length > 0 ? colors.textSecondary : colors.accent, lineWidth: lines.length > 0 ? 4 : 5, lineCap: 'round', lineJoin: 'round' }}
            />
          </ShapeSource>
        ) : null}
        <ShapeSource id="run-so-far" shape={runShape}>
          <LineLayer id="run-so-far-line" style={{ lineColor: colors.accent, lineWidth: 5, lineCap: 'round', lineJoin: 'round' }} />
        </ShapeSource>
        {current ? <LocationPuck puckBearingEnabled={false} /> : null}
      </MapView>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { borderRadius: radius.card, overflow: 'hidden', backgroundColor: colors.surface },
});
