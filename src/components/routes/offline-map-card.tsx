import { CloudDownload, CloudOff, Trash2 } from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { SecondaryButton, TextButton } from '@/components/ui/buttons';
import { InlineStatus } from '@/components/ui/elements';
import { Card } from '@/components/ui/layout';
import type { RoutePoint } from '@/domain/routes';
import { offlineMaps } from '@/features/offline-maps/offline-maps';
import { megabytes, routeArea } from '@/features/offline-maps/regions';
import { useOfflineAreas } from '@/features/offline-maps/use-offline-maps';
import { Text } from '@/design/text';
import { colors, space } from '@/design/tokens';

/**
 * A route's map area for runs without a signal (docs/ROADMAP.md 5.2). The route itself is already
 * on the phone once opened; this keeps the map beneath it too. Only in builds with Mapbox.
 */
export function OfflineMapCard({ routeId, name, points }: { routeId: string; name: string; points: RoutePoint[] }) {
  const { available, areas } = useOfflineAreas();
  const [error, setError] = useState<string | null>(null);
  if (!available) return null;
  const area = areas.find((a) => a.routeId === routeId) ?? null;
  const planned = routeArea(points);

  const download = async () => {
    setError(null);
    if (!planned) {
      setError('This route covers too big an area to keep as one map. Its turns still work without a signal.');
      return;
    }
    try {
      await offlineMaps().download(routeId, name, planned);
    } catch {
      setError('Couldn’t start the download. Check your connection and try again.');
    }
  };

  return (
    <Card style={styles.card}>
      <View style={styles.row}>
        {area?.state === 'complete' ? <CloudOff size={20} color={colors.accent} /> : <CloudDownload size={20} color={colors.textSecondary} />}
        <Text variant="labelStrong" accessibilityRole="header" style={styles.fill}>
          Map for runs without signal
        </Text>
      </View>
      {area?.state === 'complete' ? (
        <Text variant="body" tone="secondary">
          The map around this route is on this phone ({megabytes(area.bytes)}).
        </Text>
      ) : area?.state === 'downloading' ? (
        <Text variant="body" tone="secondary" accessibilityLiveRegion="polite">
          Downloading… {Math.round(area.percentage)}%
        </Text>
      ) : (
        <Text variant="body" tone="secondary">
          Turns and off-route alerts already work without a signal. Keep the map too
          {planned ? `: about ${megabytes(planned.estimatedBytes)}` : ''}.
        </Text>
      )}
      {area?.state === 'stopped' ? <InlineStatus tone="warning" title="The download stopped." body="Try again with a connection." /> : null}
      {error ? <InlineStatus tone="warning" title={error} /> : null}
      {area?.state === 'complete' || area?.state === 'downloading' ? (
        <TextButton label={area.state === 'complete' ? 'Remove from this phone' : 'Cancel download'} icon={Trash2} tone="danger" onPress={() => void offlineMaps().remove(routeId)} />
      ) : (
        <SecondaryButton label={area ? 'Try again' : 'Download map'} icon={CloudDownload} onPress={() => void download()} testID="download-map" />
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: space.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  fill: { flex: 1 },
});
