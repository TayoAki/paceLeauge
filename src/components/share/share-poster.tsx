import { forwardRef } from 'react';
import { StyleSheet, View } from 'react-native';

import { PosterLanes } from '@/components/art/art';
import { formatDistance, formatDuration, formatPace } from '@/domain/format';
import type { Units } from '@/domain/types';
import { Text } from '@/design/text';
import { colors, radius } from '@/design/tokens';

export type PosterFormat = 'post' | 'story';

export interface PosterStats {
  distanceM: number;
  activeMs: number;
  units: Units;
}

/**
 * The stats-only share composition (REQ-009): distance, active time, pace and the brand.
 * It is rendered separately from any private screen, so no map, route, place, start time or
 * coordinates can ever be captured into the image.
 */
export const SharePoster = forwardRef<View, { stats: PosterStats; format: PosterFormat; width: number }>(function SharePoster(
  { stats, format, width },
  ref,
) {
  const distance = formatDistance(stats.distanceM, stats.units);
  const pace = formatPace(stats.activeMs, stats.distanceM, stats.units);
  const height = format === 'post' ? (width * 5) / 4 : (width * 16) / 9;
  // Every size scales with the width and has an explicit line height, so the composition
  // fits the card at any width and never depends on font metrics (budget ≈ 380 of 412 units).
  const s = width / 330;
  const artWidth = width - 48 * s;
  return (
    <View ref={ref} collapsable={false} style={[styles.poster, { width, height, padding: 24 * s }]}>
      <Text style={[styles.headline, { fontSize: 46 * s, lineHeight: 44 * s }]} maxFontSizeMultiplier={1} numberOfLines={2}>
        {'ONE MORE\nGOOD RUN.'}
      </Text>
      <View style={[styles.art, { marginVertical: 10 * s }, format === 'story' ? { flex: 1 } : { height: 136 * s }]}>
        <PosterLanes width={artWidth} height={format === 'story' ? height - 300 * s : 118 * s} />
      </View>
      <View style={styles.stats}>
        <Text style={[styles.distance, { fontSize: 50 * s, lineHeight: 56 * s }]} maxFontSizeMultiplier={1} numberOfLines={1} adjustsFontSizeToFit>
          {distance.value} {distance.unit}
        </Text>
        <Text style={[styles.detail, { fontSize: 18 * s, lineHeight: 24 * s }]} maxFontSizeMultiplier={1} numberOfLines={1}>
          {formatDuration(stats.activeMs)} · {pace.value} {pace.unit}
        </Text>
        <Text
          style={[
            styles.brand,
            {
              fontSize: 13 * s,
              lineHeight: 18 * s,
              marginTop: 8 * s,
              letterSpacing: 3 * s,
            },
          ]}
          maxFontSizeMultiplier={1}>
          PACELEAGUE
        </Text>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  poster: {
    backgroundColor: colors.textPrimary,
    borderRadius: radius.card,
    justifyContent: 'space-between',
    overflow: 'hidden',
  },
  headline: { color: colors.onAccent, fontWeight: '900', letterSpacing: -1.5 },
  art: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  stats: { alignItems: 'center' },
  distance: {
    color: colors.onAccent,
    fontWeight: '800',
    letterSpacing: -1.5,
    fontVariant: ['tabular-nums'],
  },
  detail: {
    color: colors.onAccent,
    fontWeight: '500',
    fontVariant: ['tabular-nums'],
  },
  brand: { color: colors.onAccent, fontWeight: '800' },
});
