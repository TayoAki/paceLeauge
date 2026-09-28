import { useEffect, useMemo, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import MapView, { Marker, Polyline, type MapPressEvent } from 'react-native-maps';

import type { LatLng } from '@/components/run/route-lines';
import { RouteSketch } from '@/components/run/route-sketch';
import { colors, radius } from '@/design/tokens';
import { NATIVE_MAPS } from '@/features/routes/maps-support';

export interface PlannerMapProps {
  route: LatLng[] | null;
  markers: LatLng[];
  /** Where to look before there's a route: the runner, or the start they picked. */
  center: LatLng | null;
  height: number;
  accessibilityLabel: string;
  /** Tapping the map adds a point (drawing); absent, the map only shows the route. */
  onPress?: (point: LatLng) => void;
}

/** Whether routes can be drawn by tapping a map here (not on the web or keyless Android builds). */
export const CAN_DRAW = NATIVE_MAPS;

/** The route planner's map (docs/ROADMAP.md 5.1). */
export function PlannerMap(props: PlannerMapProps) {
  if (!NATIVE_MAPS) {
    return <RouteSketch lines={[]} guide={props.route} markers={props.markers} current={props.route ? null : props.center} height={props.height} accessibilityLabel={props.accessibilityLabel} />;
  }
  return <NativePlannerMap {...props} />;
}

function NativePlannerMap({ route, markers, center, height, accessibilityLabel, onPress }: PlannerMapProps) {
  const ref = useRef<MapView>(null);
  const fitKey = route ? `${route.length}:${route[0]?.latitude.toFixed(5)}:${route[route.length - 1]?.longitude.toFixed(5)}` : center ? `c:${center.latitude.toFixed(3)},${center.longitude.toFixed(3)}` : '';
  const fitRoute = useMemo(() => route, [fitKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // Drawing keeps the view where the runner put it; a planned loop is shown whole.
    if (fitRoute && fitRoute.length > 1 && !onPress) {
      ref.current?.fitToCoordinates(fitRoute, { edgePadding: { top: 40, right: 40, bottom: 40, left: 40 }, animated: true });
    } else if (center && (!fitRoute || fitRoute.length < 2)) {
      ref.current?.animateToRegion({ ...center, latitudeDelta: 0.02, longitudeDelta: 0.02 }, 300);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey]);

  return (
    <View style={[styles.frame, { height }]} accessibilityLabel={accessibilityLabel}>
      <MapView
        ref={ref}
        style={StyleSheet.absoluteFill}
        userInterfaceStyle="dark"
        mapType="mutedStandard"
        pitchEnabled={false}
        rotateEnabled={false}
        showsPointsOfInterests={false}
        showsUserLocation
        showsCompass={false}
        toolbarEnabled={false}
        initialRegion={center ? { ...center, latitudeDelta: 0.02, longitudeDelta: 0.02 } : undefined}
        onPress={onPress ? (e: MapPressEvent) => onPress(e.nativeEvent.coordinate) : undefined}>
        {route && route.length > 1 ? <Polyline coordinates={route} strokeColor={colors.accent} strokeWidth={5} lineCap="round" lineJoin="round" /> : null}
        {markers.map((m, i) => (
          <Marker key={`${i}:${m.latitude}:${m.longitude}`} coordinate={m} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={false}>
            <View style={i === 0 ? styles.start : styles.point} />
          </Marker>
        ))}
      </MapView>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { borderRadius: radius.card, overflow: 'hidden', backgroundColor: colors.surface },
  start: { width: 16, height: 16, borderRadius: 8, borderWidth: 3, borderColor: colors.textPrimary, backgroundColor: colors.background },
  point: { width: 12, height: 12, borderRadius: 6, borderWidth: 2, borderColor: colors.accent, backgroundColor: colors.background },
});
