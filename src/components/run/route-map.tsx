import { useEffect, useMemo, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import MapView, { Marker, Polyline } from 'react-native-maps';

import { LocationDot } from '@/components/art/art';
import { colors, radius } from '@/design/tokens';
import { NATIVE_MAPS } from '@/features/routes/maps-support';

import type { LatLng } from './route-lines';
import { RouteSketch } from './route-sketch';

export interface RouteMapProps {
  lines: LatLng[][];
  height: number;
  current?: LatLng | null;
  interactive?: boolean;
  accessibilityLabel: string;
  follow?: boolean;
  /** A planned route to follow (docs/ROADMAP.md 5.1), drawn beneath the run. */
  guide?: LatLng[] | null;
}

/**
 * Private route map (owner-only screens). Apple Maps on iOS keeps its own attribution and
 * legal link; the route is never rendered on league or share surfaces. Android builds without a
 * Google Maps key draw the route on a grid instead.
 */
export function RouteMap(props: RouteMapProps) {
  if (!NATIVE_MAPS) {
    return <RouteSketch lines={props.lines} guide={props.guide} current={props.current} height={props.height} accessibilityLabel={props.accessibilityLabel} />;
  }
  return <NativeRouteMap {...props} />;
}

function NativeRouteMap({ lines, height, current, interactive = false, accessibilityLabel, follow = false, guide }: RouteMapProps) {
  const ref = useRef<MapView>(null);
  const all = useMemo(() => (lines.length > 0 ? lines.flat() : (guide ?? [])), [lines, guide]);
  const focus = follow && current ? [current] : all;
  const focusKey = follow && current ? `${current.latitude.toFixed(4)},${current.longitude.toFixed(4)}` : String(all.length);

  useEffect(() => {
    if (focus.length === 1 && focus[0]) {
      ref.current?.animateToRegion({ ...focus[0], latitudeDelta: 0.006, longitudeDelta: 0.006 }, 0);
    } else if (focus.length > 1) {
      ref.current?.fitToCoordinates(focus, { edgePadding: { top: 36, right: 36, bottom: 36, left: 36 }, animated: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey]);

  const start = lines[0]?.[0] ?? guide?.[0];
  return (
    <View style={[styles.frame, { height }]} accessible accessibilityRole="image" accessibilityLabel={accessibilityLabel}>
      <MapView
        ref={ref}
        style={StyleSheet.absoluteFill}
        userInterfaceStyle="dark"
        mapType="mutedStandard"
        pitchEnabled={false}
        rotateEnabled={false}
        scrollEnabled={interactive}
        zoomEnabled={interactive}
        showsPointsOfInterests={false}
        showsCompass={false}
        toolbarEnabled={false}
        initialRegion={focus[0] ? { ...focus[0], latitudeDelta: 0.01, longitudeDelta: 0.01 } : undefined}>
        {guide && guide.length > 1 ? (
          <Polyline
            coordinates={guide}
            strokeColor={lines.length > 0 ? colors.textSecondary : colors.accent}
            strokeWidth={lines.length > 0 ? 4 : 5}
            lineCap="round"
            lineJoin="round"
          />
        ) : null}
        {lines.map((line, i) =>
          line.length > 1 ? <Polyline key={i} coordinates={line} strokeColor={colors.accent} strokeWidth={5} lineCap="round" lineJoin="round" /> : null,
        )}
        {start && !current ? (
          <Marker coordinate={start} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={false}>
            <View style={styles.start} />
          </Marker>
        ) : null}
        {current ? (
          <Marker coordinate={current} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={false}>
            <LocationDot />
          </Marker>
        ) : null}
      </MapView>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { borderRadius: radius.card, overflow: 'hidden', backgroundColor: colors.surface },
  start: { width: 16, height: 16, borderRadius: 8, borderWidth: 3, borderColor: colors.textPrimary, backgroundColor: colors.background },
});
