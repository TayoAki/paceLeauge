import { useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import MapView, { Polyline, UrlTile } from 'react-native-maps';

import { heatmapUrlTemplate } from '@/api/heatmap-api';
import { env } from '@/config/env';
import { colors, radius } from '@/design/tokens';
import { NATIVE_MAPS } from '@/features/routes/maps-support';

import type { HeatMapViewProps } from './heat-map-types';
import { HeatTiles } from './heat-tiles';

/**
 * The heatmap (docs/ROADMAP.md 5.4) over the phone's own maps: its tiles as an overlay, loaded
 * through signed links. Android builds without a Google Maps key lay the tiles out on a grid.
 */
export function HeatMapView(props: HeatMapViewProps) {
  if (!NATIVE_MAPS) return <HeatTiles {...props} />;
  return <NativeHeatMap {...props} />;
}

function NativeHeatMap({ center, tiles, height, route, accessibilityLabel }: HeatMapViewProps) {
  const ref = useRef<MapView>(null);
  const routeKey = route && route.length > 1 ? `${route.length}:${route[0]!.latitude}` : '';

  useEffect(() => {
    if (route && route.length > 1) {
      ref.current?.fitToCoordinates(route, { edgePadding: { top: 36, right: 36, bottom: 36, left: 36 }, animated: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey]);

  return (
    <View style={[styles.frame, { height }]} accessible accessibilityRole="image" accessibilityLabel={accessibilityLabel}>
      <MapView
        ref={ref}
        style={StyleSheet.absoluteFill}
        userInterfaceStyle="dark"
        mapType="mutedStandard"
        pitchEnabled={false}
        rotateEnabled={false}
        showsUserLocation
        showsPointsOfInterests={false}
        showsCompass={false}
        toolbarEnabled={false}
        initialRegion={{ latitude: center.lat, longitude: center.lon, latitudeDelta: 0.03, longitudeDelta: 0.03 }}>
        <UrlTile
          urlTemplate={heatmapUrlTemplate(env.apiUrl, tiles)}
          minimumZ={tiles.min_zoom}
          maximumZ={tiles.max_zoom}
          maximumNativeZ={tiles.max_zoom}
          tileSize={256}
          zIndex={1}
        />
        {route && route.length > 1 ? (
          <Polyline coordinates={route} strokeColor={colors.accent} strokeWidth={4} lineCap="round" lineJoin="round" zIndex={2} />
        ) : null}
      </MapView>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { borderRadius: radius.card, overflow: 'hidden', backgroundColor: colors.surface },
});
