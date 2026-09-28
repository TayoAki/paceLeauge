import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Line, Polyline } from 'react-native-svg';

import { Text } from '@/design/text';
import { colors, space } from '@/design/tokens';

export interface LineSeries {
  key: string;
  label: string;
  color: string;
  /** One value per step along the x axis; gaps (null) break the line. */
  values: (number | null)[];
}

/**
 * A small line chart with a text alternative: the chart itself is one image whose label says
 * what it shows, so screen readers get the numbers rather than the lines.
 */
export function LineChart({
  series,
  summary,
  height = 140,
  startLabel,
  endLabel,
  zeroLine = false,
  legend = true,
}: {
  series: LineSeries[];
  summary: string;
  height?: number;
  startLabel?: string;
  endLabel?: string;
  /** Draws the zero line and keeps it in view (for values that go below zero). */
  zeroLine?: boolean;
  legend?: boolean;
}) {
  const [width, setWidth] = useState(0);
  const values = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const steps = Math.max(0, ...series.map((s) => s.values.length));
  let lo = Math.min(...values, zeroLine ? 0 : Infinity);
  let hi = Math.max(...values, zeroLine ? 0 : -Infinity);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    lo = 0;
    hi = 1;
  }
  if (hi - lo < 1e-9) {
    lo -= 1;
    hi += 1;
  }
  const pad = 6;
  const x = (i: number) => (steps <= 1 ? width / 2 : pad + (i / (steps - 1)) * (width - 2 * pad));
  const y = (v: number) => pad + (1 - (v - lo) / (hi - lo)) * (height - 2 * pad);
  /** Unbroken stretches of each line, as [x, y] points. */
  const stretches = (list: (number | null)[]) => {
    const out: [number, number][][] = [];
    let current: [number, number][] = [];
    list.forEach((v, i) => {
      if (v === null) {
        if (current.length) out.push(current);
        current = [];
      } else current.push([x(i), y(v)]);
    });
    if (current.length) out.push(current);
    return out;
  };

  return (
    <View accessible accessibilityRole="image" accessibilityLabel={summary} style={styles.wrap}>
      <View style={{ height }} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
        {width > 0 ? (
          <Svg width={width} height={height}>
            {zeroLine ? <Line x1={0} x2={width} y1={y(0)} y2={y(0)} stroke={colors.decorativeDivider} strokeWidth={1} strokeDasharray="4 4" /> : null}
            {series.map((s) =>
              stretches(s.values).map((pts, i) =>
                pts.length > 1 ? (
                  <Polyline
                    key={`${s.key}-${i}`}
                    points={pts.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(' ')}
                    fill="none"
                    stroke={s.color}
                    strokeWidth={2.5}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                ) : (
                  // A lone reading shows as a short dash rather than disappearing.
                  <Line key={`${s.key}-${i}`} x1={pts[0]![0] - 3} x2={pts[0]![0] + 3} y1={pts[0]![1]} y2={pts[0]![1]} stroke={s.color} strokeWidth={3} strokeLinecap="round" />
                ),
              ),
            )}
          </Svg>
        ) : null}
      </View>
      {startLabel || endLabel ? (
        <View style={styles.ends}>
          <Text variant="caption" tone="secondary">
            {startLabel ?? ''}
          </Text>
          <Text variant="caption" tone="secondary">
            {endLabel ?? ''}
          </Text>
        </View>
      ) : null}
      {legend && series.length > 1 ? (
        <View style={styles.legend}>
          {series.map((s) => (
            <View key={s.key} style={styles.legendItem}>
              <View style={[styles.swatch, { backgroundColor: s.color }]} />
              <Text variant="caption" tone="secondary">
                {s.label}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.xs },
  ends: { flexDirection: 'row', justifyContent: 'space-between' },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: space.lg },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  swatch: { width: 14, height: 4, borderRadius: 2 },
});
