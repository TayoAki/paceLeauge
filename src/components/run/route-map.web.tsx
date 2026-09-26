import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Circle, Defs, Line, Pattern, Polyline, Rect } from 'react-native-svg';

import { colors, radius } from '@/design/tokens';

import type { LatLng } from './route-lines';
import type { RouteMapProps } from './route-map';

/**
 * Web development preview: the route drawn on a plain grid (no map tiles or place labels).
 * iOS uses Apple Maps (route-map.tsx).
 */
export function RouteMap({ lines, height, current, accessibilityLabel }: RouteMapProps) {
  const width = 350;
  const projected = useMemo(() => {
    const all: LatLng[] = [...lines.flat(), ...(current ? [current] : [])];
    if (all.length === 0) return { lines: [] as string[], current: null as { x: number; y: number } | null, start: null as { x: number; y: number } | null };
    const lat0 = all.reduce((s, p) => s + p.latitude, 0) / all.length;
    const k = Math.cos((lat0 * Math.PI) / 180);
    const xs = all.map((p) => p.longitude * k);
    const ys = all.map((p) => p.latitude);
    const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const span = Math.max(maxX - minX, maxY - minY, 0.002);
    const pad = 28;
    const scale = Math.min((width - pad * 2) / span, (height - pad * 2) / span);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const toXY = (p: LatLng) => ({ x: width / 2 + (p.longitude * k - cx) * scale, y: height / 2 - (p.latitude - cy) * scale });
    return {
      lines: lines.filter((l) => l.length > 1).map((l) => l.map((p) => { const q = toXY(p); return `${q.x.toFixed(1)},${q.y.toFixed(1)}`; }).join(' ')),
      current: current ? toXY(current) : null,
      start: lines[0]?.[0] ? toXY(lines[0][0]) : null,
    };
  }, [lines, current, height]);

  return (
    <View style={[styles.frame, { height }]} accessible accessibilityRole="image" accessibilityLabel={accessibilityLabel}>
      <Svg width="100%" height="100%" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid slice">
        <Defs>
          <Pattern id="grid" width={28} height={28} patternUnits="userSpaceOnUse">
            <Line x1={0} y1={0} x2={28} y2={0} stroke={colors.decorativeDivider} strokeWidth={1} opacity={0.5} />
            <Line x1={0} y1={0} x2={0} y2={28} stroke={colors.decorativeDivider} strokeWidth={1} opacity={0.5} />
          </Pattern>
        </Defs>
        <Rect width={width} height={height} fill={colors.surface} />
        <Rect width={width} height={height} fill="url(#grid)" />
        {projected.lines.map((points, i) => (
          <Polyline key={i} points={points} fill="none" stroke={colors.accent} strokeWidth={5} strokeLinecap="round" strokeLinejoin="round" />
        ))}
        {projected.start && !projected.current ? (
          <Circle cx={projected.start.x} cy={projected.start.y} r={7} fill={colors.background} stroke={colors.textPrimary} strokeWidth={3} />
        ) : null}
        {projected.current ? (
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
