import { CornerUpRight, Flag, Navigation, TriangleAlert } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import { Card } from '@/components/ui/layout';
import { turnLabel } from '@/domain/navigation';
import type { Units } from '@/domain/types';
import { routeDistance, shortDistance } from '@/features/routes/route-text';
import { useFollowedRoute } from '@/features/routes/use-routes';
import { Text } from '@/design/text';
import { colors, space } from '@/design/tokens';

/**
 * The route the run follows (docs/ROADMAP.md 5.1 and 5.2): the next turn and how far it is, how
 * much of the route is left, and a clear warning when the runner is off it. The same things are
 * spoken as they happen.
 */
export function RoutePanel({ units }: { units: Units }) {
  const follow = useFollowedRoute();
  const view = follow?.view;
  if (!follow || !view) return null;
  const { route } = follow;

  const status = view.finished
    ? { icon: Flag, tone: 'accent' as const, text: 'Route complete' }
    : !view.joined
      ? { icon: Navigation, tone: 'secondary' as const, text: view.toStartM !== null ? `Route starts ${shortDistance(view.toStartM, units)} away` : 'Head to the start of the route' }
      : view.offRoute
        ? { icon: TriangleAlert, tone: 'danger' as const, text: view.fromRouteM !== null ? `Off the route · ${shortDistance(view.fromRouteM, units)} away` : 'Off the route' }
        : view.nextTurn
          ? { icon: CornerUpRight, tone: 'primary' as const, text: `${turnLabel(view.nextTurn.cue)} · in ${shortDistance(view.nextTurn.inM, units)}` }
          : { icon: Navigation, tone: 'secondary' as const, text: 'No more turns' };
  const Icon = status.icon;
  const iconColor = status.tone === 'danger' ? colors.danger : status.tone === 'accent' ? colors.accent : status.tone === 'primary' ? colors.textPrimary : colors.textSecondary;

  return (
    <Card style={styles.card}>
      <View style={styles.row}>
        <Text variant="labelStrong" numberOfLines={1} style={styles.fill}>
          {route.name}
        </Text>
        <Text variant="label" tone="secondary">
          {view.finished ? routeDistance(view.totalM, units) : `${routeDistance(view.remainingM, units)} to go`}
        </Text>
      </View>
      <View style={styles.row} accessible accessibilityLiveRegion="polite" accessibilityLabel={status.text}>
        <Icon size={22} color={iconColor} />
        <Text variant="bodyStrong" style={[styles.fill, status.tone === 'danger' ? { color: colors.danger } : null]} testID="route-status">
          {status.text}
        </Text>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: space.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  fill: { flex: 1 },
});
