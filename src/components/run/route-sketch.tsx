import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Circle, Defs, Line, Pattern, Polyline, Rect } from 'react-native-svg';

import { colors, radius } from '@/design/tokens';

import type { LatLng } from './route-lines';

export interface RouteSketchProps {
  /** Recorded lines, drawn in the accent colour. */
  lines: LatLng[][];
  /** A planned route to follow, drawn beneath in a quieter colour. */
  guide?: LatLng[] | null;
  /** Points the runner placed while planning. */
  markers?: LatLng[];
  current?: LatLng | null;
  height: number;
  /** The drawing's width, for small previews; full-width sketches scale a 350-wide drawing. */
  width?: number;
  /** Omit the grid and frame, for small previews in lists. */
  bare?: boolean;
  accessibilityLabel?: string;
}

/**
 * A route drawn on a plain grid, with no map tiles or place names: on the web app, in lists, and
 * on Android builds without a Google Maps key. Native screens otherwise use RouteMap.
 */
export function RouteSketch({ lines, guide, markers, current, height, width = 350, bare = false, accessibilityLabel }: RouteSketchProps) {
  const projected = useMemo(() => {
    const all: LatLng[] = [...lines.flat(), ...(guide ?? []), ...(markers ?? []), ...(current ? [current] : [])];
    if (all.length === 0) return null;
    const lat0 = all.reduce((s, p) => s + p.latitude, 0) / all.length;
    const k = Math.cos((lat0 * Math.PI) / 180);
    const xs = all.map((p) => p.longitude * k);
    const ys = all.map((p) => p.latitude);
    const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const span = Math.max(maxX - minX, maxY - minY, 0.002);
    const pad = bare ? 6 : 28;
    const scale = Math.min((width - pad * 2) / span, (height - pad * 2) / span);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const toXY = (p: LatLng) => ({ x: width / 2 + (p.longitude * k - cx) * scale, y: height / 2 - (p.latitude - cy) * scale });
    const path = (l: LatLng[]) =>
      l
        .map((p) => {
          const q = toXY(p);
          return `${q.x.toFixed(1)},${q.y.toFixed(1)}`;
        })
        .join(' ');
    const first = lines[0]?.[0] ?? guide?.[0] ?? null;
    return {
      lines: lines.filter((l) => l.length > 1).map(path),
      guide: guide && guide.length > 1 ? path(guide) : null,
      markers: (markers ?? []).map(toXY),
      current: current ? toXY(current) : null,
      start: first ? toXY(first) : null,
    };
  }, [lines, guide, markers, current, height, width, bare]);

  return (
    <View
      style={[bare ? null : styles.frame, { height }]}
      accessible={!!accessibilityLabel}
      accessibilityRole={accessibilityLabel ? 'image' : undefined}
      accessibilityLabel={accessibilityLabel}>
      <Svg width="100%" height="100%" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio={bare ? 'xMidYMid meet' : 'xMidYMid slice'}>
        {bare ? null : (
          <>
            <Defs>
              <Pattern id="grid" width={28} height={28} patternUnits="userSpaceOnUse">
                <Line x1={0} y1={0} x2={28} y2={0} stroke={colors.decorativeDivider} strokeWidth={1} opacity={0.5} />
                <Line x1={0} y1={0} x2={0} y2={28} stroke={colors.decorativeDivider} strokeWidth={1} opacity={0.5} />
              </Pattern>
            </Defs>
            <Rect width={width} height={height} fill={colors.surface} />
            <Rect width={width} height={height} fill="url(#grid)" />
          </>
        )}
        {projected?.guide ? (
          <Polyline points={projected.guide} fill="none" stroke={lines.length > 0 ? colors.textSecondary : colors.accent} strokeWidth={bare ? 2.5 : lines.length > 0 ? 4 : 5} strokeLinecap="round" strokeLinejoin="round" opacity={lines.length > 0 ? 0.6 : 1} />
        ) : null}
        {projected?.lines.map((points, i) => (
          <Polyline key={i} points={points} fill="none" stroke={colors.accent} strokeWidth={5} strokeLinecap="round" strokeLinejoin="round" />
        ))}
        {projected?.markers.map((m, i) => (
          <Circle key={i} cx={m.x} cy={m.y} r={5} fill={colors.background} stroke={colors.accent} strokeWidth={2} />
        ))}
        {projected?.start && !projected.current ? (
          <Circle cx={projected.start.x} cy={projected.start.y} r={bare ? 3 : 7} fill={colors.background} stroke={colors.textPrimary} strokeWidth={bare ? 1.5 : 3} />
        ) : null}
        {projected?.current ? (
          <>
            <Circle cx={projected.current.x} cy={projected.current.y} r={14} fill={colors.accent} opacity={0.25} />
            <Circle cx={projected.current.x} cy={projected.current.y} r={7} fill={colors.accent} stroke={colors.background} strokeWidth={2} />
          </>
        ) : null}
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { borderRadius: radius.card, overflow: 'hidden', backgroundColor: colors.surface },
});
