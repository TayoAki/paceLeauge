import { Minus, Plus } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { Image, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Circle, Defs, Line, Pattern, Polyline, Rect } from 'react-native-svg';

import { heatmapTileUrl, type HeatmapTiles } from '@/api/heatmap-api';
import { IconButton } from '@/components/ui/buttons';
import { env } from '@/config/env';
import { fitView, TILE, tilesAround, worldPixel } from '@/features/heatmap/tile-grid';
import { colors, radius, space } from '@/design/tokens';

import type { HeatMapViewProps } from './heat-map-types';

/**
 * The heatmap without a map underneath: its tiles laid out around the runner on a plain grid
 * (the web app, and Android builds without a Google Maps key). A suggested loop is framed to fit;
 * the buttons zoom from there.
 */
export function HeatTiles({ center, tiles, height, route, accessibilityLabel }: HeatMapViewProps & { tiles: HeatmapTiles }) {
  const [width, setWidth] = useState(0);
  // Zoom steps the runner took, for the loop on show (a new loop starts from its own framing).
  const routeKey = route && route.length > 1 ? `${route.length}:${route[0]!.latitude}:${route[0]!.longitude}` : '';
  const [steps, setSteps] = useState({ key: '', by: 0 });
  const fit = useMemo(
    () => (route && route.length > 1 ? fitView(route.map((p) => ({ lat: p.latitude, lon: p.longitude })), width, height, { maxZoom: 16 }) : null),
    [route, width, height],
  );
  const by = steps.key === routeKey ? steps.by : 0;
  const zoom = Math.max(tiles.min_zoom, Math.min(tiles.max_zoom, (fit?.zoom ?? 15) + by));
  const focus = fit?.center ?? center;
  const zoomBy = (d: number) => setSteps({ key: routeKey, by: by + d });
  const layout = useMemo(() => (width > 0 ? tilesAround(focus, zoom, width, height) : null), [focus, zoom, width, height]);
  const at = (lat: number, lon: number) => {
    const q = worldPixel(lat, lon, zoom);
    return { x: q.x - (layout?.left ?? 0), y: q.y - (layout?.top ?? 0) };
  };
  const line =
    layout && route && route.length > 1
      ? route
          .map((p) => {
            const q = at(p.latitude, p.longitude);
            return `${q.x.toFixed(1)},${q.y.toFixed(1)}`;
          })
          .join(' ')
      : null;
  const me = at(center.lat, center.lon);

  return (
    <View style={[styles.frame, { height }]} onLayout={(e: LayoutChangeEvent) => setWidth(Math.round(e.nativeEvent.layout.width))}>
      {/* The picture, with the zoom buttons beside it rather than inside it. */}
      <View style={StyleSheet.absoluteFill} accessible accessibilityRole="image" accessibilityLabel={accessibilityLabel}>
        {width > 0 ? (
          <Svg width={width} height={height} style={StyleSheet.absoluteFill}>
            <Defs>
              <Pattern id="heat-grid" width={32} height={32} patternUnits="userSpaceOnUse">
                <Line x1={0} y1={0} x2={32} y2={0} stroke={colors.decorativeDivider} strokeWidth={1} opacity={0.35} />
                <Line x1={0} y1={0} x2={0} y2={32} stroke={colors.decorativeDivider} strokeWidth={1} opacity={0.35} />
              </Pattern>
            </Defs>
            <Rect width={width} height={height} fill="url(#heat-grid)" />
          </Svg>
        ) : null}
        {layout?.tiles.map((t) => (
          <Image
            key={`${zoom}/${t.x}/${t.y}/${Math.round(t.left)}/${Math.round(t.top)}`}
            source={{ uri: heatmapTileUrl(env.apiUrl, tiles, zoom, t.x, t.y) }}
            style={[styles.tile, { left: t.left, top: t.top }]}
            accessibilityIgnoresInvertColors
          />
        ))}
        {layout ? (
          <Svg width={width} height={height} style={StyleSheet.absoluteFill} pointerEvents="none">
            {line ? <Polyline points={line} fill="none" stroke={colors.accent} strokeWidth={4} strokeLinecap="round" strokeLinejoin="round" /> : null}
            <Circle cx={me.x} cy={me.y} r={12} fill={colors.accent} opacity={0.25} />
            <Circle cx={me.x} cy={me.y} r={6} fill={colors.accent} stroke={colors.background} strokeWidth={2} />
          </Svg>
        ) : null}
      </View>
      <View style={styles.zoom}>
        <IconButton icon={Plus} label="Zoom in" onPress={() => zoomBy(1)} disabled={zoom >= tiles.max_zoom} />
        <IconButton icon={Minus} label="Zoom out" onPress={() => zoomBy(-1)} disabled={zoom <= tiles.min_zoom} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { borderRadius: radius.card, overflow: 'hidden', backgroundColor: colors.surface },
  tile: { position: 'absolute', width: TILE, height: TILE },
  zoom: { position: 'absolute', right: space.sm, top: space.sm, gap: space.xs },
});
