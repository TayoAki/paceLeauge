import { useRouter } from 'expo-router';
import { CloudOff, Trash2 } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import { IconButton } from '@/components/ui/buttons';
import { EmptyState, Row, RowGroup } from '@/components/ui/elements';
import { Card, NavHeader, Screen } from '@/components/ui/layout';
import { formatDateShort } from '@/domain/format';
import { offlineMaps } from '@/features/offline-maps/offline-maps';
import { megabytes } from '@/features/offline-maps/regions';
import { useOfflineAreas } from '@/features/offline-maps/use-offline-maps';
import { Text } from '@/design/text';
import { space } from '@/design/tokens';

/**
 * Map areas kept on this phone for routes (docs/ROADMAP.md 5.2): how much room each takes, and a
 * way to remove them. They're downloaded from a route's page; signing out removes them.
 */
export default function OfflineMapsScreen() {
  const router = useRouter();
  const { available, areas } = useOfflineAreas();
  const total = areas.reduce((sum, a) => sum + a.bytes, 0);

  return (
    <Screen edges={['top', 'bottom']}>
      <NavHeader title="Offline maps" />
      {!available ? (
        <Card>
          <EmptyState
            icon={CloudOff}
            title="Offline maps aren’t in this version of the app."
            body="Routes you’ve opened are still kept on this phone, and their turns and off-route alerts work without a signal."
          />
        </Card>
      ) : areas.length === 0 ? (
        <Card>
          <EmptyState
            icon={CloudOff}
            title="No maps on this phone yet."
            body="Open a route in Train › Routes and tap Download map, so the map shows on runs without a signal."
          />
        </Card>
      ) : (
        <View style={styles.group}>
          <RowGroup>
            {areas.map((a, i) => (
              <Row
                key={a.routeId}
                label={a.name}
                hint={a.state === 'complete' ? `${megabytes(a.bytes)} · ${formatDateShort(a.createdAtMs)}` : a.state === 'downloading' ? `Downloading… ${Math.round(a.percentage)}%` : 'Download stopped'}
                onPress={() => router.push({ pathname: '/train/routes/[id]', params: { id: a.routeId } })}
                accessory={<IconButton icon={Trash2} label={`Remove the map for ${a.name}`} tone="plain" onPress={() => void offlineMaps().remove(a.routeId)} />}
                last={i === areas.length - 1}
              />
            ))}
          </RowGroup>
          <Text variant="caption" tone="secondary">
            {megabytes(total)} on this phone. Signing out removes them.
          </Text>
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  group: { gap: space.sm },
});
