import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams } from 'expo-router';
import { MapPin, Radio } from 'lucide-react-native';
import { Linking, StyleSheet, View } from 'react-native';

import { api } from '@/api/client';
import { SecondaryButton } from '@/components/ui/buttons';
import { EmptyState, InlineStatus, Pill } from '@/components/ui/elements';
import { Card, NavHeader, Screen } from '@/components/ui/layout';
import { formatDistance, formatDuration } from '@/domain/format';
import { mapLinks, seenAgo } from '@/features/live-share/live-share';
import { Text } from '@/design/text';
import { colors, space } from '@/design/tokens';

const POLL_MS = 15_000;

/**
 * A runner's live location (docs/ROADMAP.md 4.8), for the people they sent the link to. No
 * account needed. It shows the runner's name and latest position, and nothing once the run has
 * ended, sharing has stopped or the link's time has run out.
 */
export default function LiveRunScreen() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const live = useQuery({
    queryKey: ['live', token],
    enabled: api !== null && typeof token === 'string' && token.length > 0,
    queryFn: () => api!.getLiveLocation(token ?? ''),
    refetchInterval: (query) => (query.state.data?.state === 'ended' ? false : POLL_MS),
    refetchIntervalInBackground: false,
  });
  const data = live.data;
  const now = live.dataUpdatedAt || 0;

  return (
    <Screen edges={['top', 'bottom']}>
      <NavHeader title="Live run" />
      {live.isPending ? (
        <Text variant="label" tone="secondary">
          Loading…
        </Text>
      ) : null}
      {live.isError && !data ? <InlineStatus tone="danger" title="Couldn’t load this live run." body="Check your connection. The page tries again on its own." /> : null}
      {data?.state === 'ended' ? (
        <Card>
          <EmptyState
            icon={Radio}
            title="This live run has ended."
            body="The runner finished, stopped sharing, or the link’s time ran out. Their location isn’t kept after that."
          />
        </Card>
      ) : null}
      {data?.state === 'live' ? (
        <>
          <View style={styles.head}>
            <Pill label="Live" />
            <Text variant="title" style={styles.fill} numberOfLines={2}>
              {data.alias} is running
            </Text>
          </View>
          <Card style={styles.card}>
            {data.position ? (
              <>
                <View style={styles.row}>
                  <MapPin size={20} color={colors.accent} />
                  <Text variant="bodyStrong" style={styles.fill} accessibilityLiveRegion="polite">
                    Last seen {seenAgo(data.position.at_ms, now)}
                  </Text>
                </View>
                <Text variant="label" tone="secondary" selectable>
                  {data.position.lat.toFixed(5)}, {data.position.lon.toFixed(5)}
                  {data.position.accuracy_m !== null ? ` · within about ${Math.round(data.position.accuracy_m)} m` : ''}
                </Text>
                <SecondaryButton
                  label="Open in Apple Maps"
                  icon={MapPin}
                  onPress={() => void Linking.openURL(mapLinks(data.position!.lat, data.position!.lon).apple).catch(() => undefined)}
                />
                <SecondaryButton
                  label="Open in Google Maps"
                  icon={MapPin}
                  onPress={() => void Linking.openURL(mapLinks(data.position!.lat, data.position!.lon).google).catch(() => undefined)}
                />
              </>
            ) : (
              <Text variant="body" tone="secondary">
                Waiting for the first position. It usually arrives within a minute of the run starting.
              </Text>
            )}
          </Card>
          {data.distance_m !== null || data.elapsed_ms !== null ? (
            <Text variant="label" tone="secondary">
              {data.distance_m !== null ? `${formatDistance(data.distance_m, 'metric').value} km` : ''}
              {data.distance_m !== null && data.elapsed_ms !== null ? ' · ' : ''}
              {data.elapsed_ms !== null ? formatDuration(data.elapsed_ms) : ''} so far
            </Text>
          ) : null}
          <Text variant="caption" tone="secondary">
            This page updates every 15 seconds. It stops showing anything when {data.alias} finishes, stops sharing, or at{' '}
            {new Date(data.expires_at_ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}.
          </Text>
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  card: { gap: space.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  fill: { flex: 1 },
});
