import { useRouter } from 'expo-router';
import { MapPinned, Route as RouteIcon } from 'lucide-react-native';
import { Pressable, StyleSheet, View } from 'react-native';

import type { RouteSummary } from '@/api/routes-api';
import { RouteSketch } from '@/components/run/route-sketch';
import { PrimaryButton } from '@/components/ui/buttons';
import { EmptyState, InlineStatus } from '@/components/ui/elements';
import { Card } from '@/components/ui/layout';
import { toLatLon } from '@/domain/routes';
import { useMe } from '@/features/data/hooks';
import { routeSummary } from '@/features/routes/route-text';
import { useRoutes } from '@/features/routes/use-routes';
import { Text } from '@/design/text';
import { colors, radius, space } from '@/design/tokens';

/** The runner's saved routes and the way to plan one (docs/ROADMAP.md 5.1), on the Train tab. */
export function RouteList() {
  const router = useRouter();
  const query = useRoutes();
  const data = query.data?.data;
  const units = useMe().data?.data.profile?.units ?? 'metric';

  return (
    <View style={styles.section}>
      {query.data?.source === 'cache' ? <InlineStatus title="Showing your routes from earlier." body="You’re offline. Routes you’ve opened before can still be followed." /> : null}
      {query.isError && !data ? <InlineStatus tone="danger" title="Couldn’t load your routes." body="Pull to try again." /> : null}
      <PrimaryButton label="Plan a route" icon={MapPinned} onPress={() => router.push('/train/routes/plan')} testID="plan-route" />
      {data && !data.planning_available ? (
        <Text variant="caption" tone="secondary">
          Routes are drawn point to point for now; loops of a set distance and routes along paths come when route planning is switched on.
        </Text>
      ) : null}
      {data && data.routes.length === 0 ? (
        <Card>
          <EmptyState icon={RouteIcon} title="No routes yet." body="Plan a loop of the distance you want, or draw one point to point. Then follow it on a run, or send it to your watch." />
        </Card>
      ) : null}
      {data?.routes.map((r) => (
        <RouteRow key={r.id} route={r} summary={routeSummary(r, units)} onPress={() => router.push({ pathname: '/train/routes/[id]', params: { id: r.id } })} />
      ))}
    </View>
  );
}

function RouteRow({ route, summary, onPress }: { route: RouteSummary; summary: string; onPress: () => void }) {
  const preview = (route.preview ?? []).map((p) => {
    const q = toLatLon(p as [number, number]);
    return { latitude: q.lat, longitude: q.lon };
  });
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${route.name}, ${summary}`}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.surfaceElevated }]}
      testID={`route-${route.id}`}>
      <View style={styles.thumb}>
        <RouteSketch lines={[]} guide={preview} height={56} width={72} bare />
      </View>
      <View style={styles.fill}>
        <Text variant="bodyStrong" numberOfLines={1}>
          {route.name}
        </Text>
        <Text variant="caption" tone="secondary">
          {summary}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  section: { gap: space.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.sm, borderRadius: radius.card, backgroundColor: colors.surface },
  thumb: { width: 72, height: 56, borderRadius: radius.control, backgroundColor: colors.background, overflow: 'hidden' },
  fill: { flex: 1, gap: 2 },
});
