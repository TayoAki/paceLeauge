import { Lock } from 'lucide-react-native';
import { Pressable, StyleSheet, View } from 'react-native';

import type { SharedRun } from '@/api/social-schemas';
import type { LatLng } from '@/components/run/route-lines';
import { RouteMap } from '@/components/run/route-map';
import { describeDistance, describeDuration, formatDistance, formatDuration, formatPace } from '@/domain/format';
import type { Units } from '@/domain/types';
import { ACTIVITY_LABEL } from '@/features/progress/activities';
import { Text } from '@/design/text';
import { colors, radius, space } from '@/design/tokens';

export function sharedLines(route: SharedRun['route']): LatLng[][] {
  return (route ?? []).map((line) => line.map(([latitude, longitude]) => ({ latitude, longitude })));
}

function when(ms: number): string {
  return new Date(ms).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/**
 * A run as other people see it (docs/ROADMAP.md 4.2): the numbers always, the map only when the
 * runner shared it, already trimmed on the server around their privacy zones and both ends.
 */
export function SharedRunCard({ run, units, onPress, showOwner = true, showMap = true }: { run: SharedRun; units: Units; onPress?: () => void; showOwner?: boolean; showMap?: boolean }) {
  const distance = formatDistance(run.distance_m, units);
  const pace = formatPace(run.active_ms, run.distance_m, units);
  const lines = showMap ? sharedLines(run.route) : [];
  const label = `${showOwner ? `${run.owner.alias}, ` : ''}${run.title}, ${when(run.started_at_ms)}: ${describeDistance(run.distance_m, units)} in ${describeDuration(run.active_ms)}`;
  const body = (
    <View style={styles.card}>
      <View accessible accessibilityLabel={label} style={styles.head}>
        {showOwner ? (
          <Text variant="labelStrong">
            {run.owner.alias}
            <Text variant="caption" tone="secondary">
              {'  '}
              {run.owner.tier}
            </Text>
          </Text>
        ) : null}
        <Text variant="bodyStrong" numberOfLines={1}>
          {run.title}
        </Text>
        <Text variant="caption" tone="secondary">
          {run.activity_type !== 'run' ? `${ACTIVITY_LABEL[run.activity_type]} · ` : ''}
          {when(run.started_at_ms)}
        </Text>
        <View style={styles.numbers}>
          <Text variant="bodyStrong" style={styles.num}>
            {distance.value} {distance.unit}
          </Text>
          <Text variant="body" tone="secondary" style={styles.num}>
            {formatDuration(run.active_ms)}
          </Text>
          {run.activity_type !== 'ride' ? (
            <Text variant="body" tone="secondary" style={styles.num}>
              {pace.value} {pace.unit}
            </Text>
          ) : null}
        </View>
      </View>
      {lines.length > 0 ? (
        <RouteMap lines={lines} height={170} accessibilityLabel={`Map of ${run.owner.alias}’s ${ACTIVITY_LABEL[run.activity_type].toLowerCase()}, with its start, finish and privacy zones left out.`} />
      ) : showMap && !run.map_shared ? (
        <View style={styles.noMap}>
          <Lock size={14} color={colors.textSecondary} />
          <Text variant="caption" tone="secondary">
            {run.is_mine ? 'Your map isn’t shared.' : 'Map not shared.'}
          </Text>
        </View>
      ) : null}
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityHint="Opens the run" style={({ pressed }) => [pressed && { opacity: 0.85 }]}>
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderRadius: radius.card, padding: space.lg, gap: space.md },
  head: { gap: 2 },
  numbers: { flexDirection: 'row', gap: space.lg, marginTop: space.xs },
  num: { fontVariant: ['tabular-nums'] },
  noMap: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
});
