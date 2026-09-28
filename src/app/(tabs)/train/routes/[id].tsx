import { useLocalSearchParams, useRouter } from 'expo-router';
import { FileDown, Pencil, Play, Trash2, Watch } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';

import { OfflineMapCard } from '@/components/routes/offline-map-card';
import { MakeSegmentCard } from '@/components/segments/make-segment-card';
import { RouteMap } from '@/components/run/route-map';
import { PrimaryButton, SecondaryButton, TextButton } from '@/components/ui/buttons';
import { ConfirmSheet } from '@/components/ui/confirm-sheet';
import { InlineStatus, TextField } from '@/components/ui/elements';
import { Card, NavHeader, Screen } from '@/components/ui/layout';
import { turnLabel } from '@/domain/navigation';
import { ROUTE_LIMITS, routeFileName, routeToGpx } from '@/domain/routes';
import { useMe } from '@/features/data/hooks';
import { RECORDING_AVAILABLE } from '@/features/recording/recording-support';
import { shareRouteFile } from '@/features/routes/route-file';
import { routeDistance, routeSummary } from '@/features/routes/route-text';
import { useRoute, useRouteActions } from '@/features/routes/use-routes';
import { deviceWatchLink } from '@/features/watch/watch-link';
import { sendRouteToWatch } from '@/features/watch/watch-routes';
import { Text } from '@/design/text';
import { space } from '@/design/tokens';

const TURNS_SHOWN = 12;

/**
 * A saved route (docs/ROADMAP.md 5.1): its map and turns, and ways to use it: follow it on a run,
 * send it to the Apple Watch, or share it as a GPX file for other watches and apps. Opened once,
 * it stays on the phone for runs without signal.
 */
export default function RouteScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  // Set while deleting, so the route isn't fetched again once it's gone.
  const [removing, setRemoving] = useState(false);
  const query = useRoute(typeof id === 'string' && !removing ? id : null);
  const route = query.data?.data;
  const me = useMe().data?.data;
  const units = me?.profile?.units ?? 'metric';
  const actions = useRouteActions();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [allTurns, setAllTurns] = useState(false);
  const [note, setNote] = useState<{ tone: 'success' | 'warning'; text: string } | null>(null);
  const guide = useMemo(() => (route ? route.points.map((p) => ({ latitude: p[0], longitude: p[1] })) : []), [route]);
  const watch = Platform.OS === 'ios' ? deviceWatchLink() : null;
  const watchPaired = watch?.status().paired ?? false;

  const sendToWatch = () => {
    if (!route) return;
    const result = sendRouteToWatch(watch, route, units);
    setNote(
      result === 'sent'
        ? { tone: 'success', text: 'Sent to your Apple Watch. It shows the route on a map during your next run there.' }
        : result === 'not_installed'
          ? { tone: 'warning', text: 'Install PaceLeague on your Apple Watch first, from the Watch app on this iPhone.' }
          : { tone: 'warning', text: 'Couldn’t reach your Apple Watch. Open PaceLeague on it and try again.' },
    );
  };

  const exportGpx = async () => {
    if (!route) return;
    try {
      const shared = await shareRouteFile(routeFileName(route.name), routeToGpx(route.name, route.points));
      if (!shared) setNote({ tone: 'warning', text: 'Sharing files isn’t available on this device.' });
    } catch {
      setNote({ tone: 'warning', text: 'Couldn’t create the file. Try again.' });
    }
  };

  const rename = async () => {
    if (!route) return;
    const done = await actions.rename(route.id, name);
    if (done) setRenaming(false);
  };

  const remove = async () => {
    if (!route) return;
    const routeId = route.id;
    setRemoving(true);
    const done = await actions.remove(routeId);
    setConfirmDelete(false);
    if (done === null) {
      setRemoving(false);
      return;
    }
    router.back();
  };

  const turns = route ? (allTurns ? route.cues : route.cues.slice(0, TURNS_SHOWN)) : [];

  return (
    <Screen edges={['top', 'bottom']}>
      <NavHeader title={route?.name ?? 'Route'} />
      {query.isPending ? (
        <Text variant="label" tone="secondary">
          Loading…
        </Text>
      ) : null}
      {query.isError && !route ? <InlineStatus tone="danger" title="Couldn’t load this route." body="Check your connection and try again." /> : null}
      {query.data?.source === 'cache' ? <InlineStatus title="Saved on this phone." body="You’re offline; you can still follow this route." /> : null}
      {route ? (
        <>
          <RouteMap lines={[]} guide={guide} height={300} interactive offline accessibilityLabel={`Map of ${route.name}, ${routeDistance(route.distance_m, units)}. Visible only to you.`} />
          <Text variant="body" tone="secondary">
            {routeSummary(route, units)}
          </Text>
          {route.kind !== 'drawn' ? (
            <Text variant="caption" tone="secondary">
              Paths from OpenStreetMap. © OpenStreetMap contributors.
            </Text>
          ) : null}

          {RECORDING_AVAILABLE ? (
            <PrimaryButton
              label="Run this route"
              icon={Play}
              onPress={() => router.push({ pathname: '/run/preflight', params: { route: route.id } })}
              testID="run-route"
            />
          ) : (
            <InlineStatus title="Follow this route on a run in the PaceLeague app on your phone." body="It speaks each turn and tells you if you go off the route." />
          )}
          {watchPaired ? <SecondaryButton label="Send to Apple Watch" icon={Watch} onPress={sendToWatch} /> : null}
          <SecondaryButton label={Platform.OS === 'web' ? 'Download GPX file' : 'Share as GPX file'} icon={FileDown} onPress={() => void exportGpx()} testID="route-gpx" />
          <Text variant="caption" tone="secondary">
            A GPX file opens in Garmin Connect, COROS, Suunto and most other watch apps as a course.
          </Text>
          {note ? <InlineStatus tone={note.tone} title={note.text} /> : null}
          {actions.error && !renaming ? <InlineStatus tone="danger" title={actions.error} /> : null}

          <OfflineMapCard routeId={route.id} name={route.name} points={route.points} />

          {route.cues.length > 0 ? (
            <Card style={styles.card}>
              <Text variant="labelStrong" accessibilityRole="header">
                Turn by turn
              </Text>
              {turns.map((c) => (
                <View key={`${c.i}`} style={styles.turn} accessible>
                  <Text variant="label" tone="secondary" style={styles.at}>
                    {routeDistance(c.at_m, units)}
                  </Text>
                  <Text variant="body" style={styles.fill}>
                    {turnLabel(c)}
                  </Text>
                </View>
              ))}
              {route.cues.length > TURNS_SHOWN ? (
                <TextButton label={allTurns ? 'Show fewer' : `Show all ${route.cues.length} turns`} onPress={() => setAllTurns((v) => !v)} />
              ) : null}
            </Card>
          ) : null}

          {me?.is_staff ? <MakeSegmentCard route={route} /> : null}

          <Card style={styles.card}>
            {renaming ? (
              <>
                <TextField label="Name" value={name} onChangeText={setName} maxLength={ROUTE_LIMITS.nameLength} testID="rename-route" />
                {actions.error ? <InlineStatus tone="danger" title={actions.error} /> : null}
                <View style={styles.buttons}>
                  <SecondaryButton label="Save name" onPress={() => void rename()} loading={actions.busy} disabled={name.trim().length === 0} style={styles.fill} />
                  <TextButton label="Cancel" onPress={() => setRenaming(false)} />
                </View>
              </>
            ) : (
              <TextButton
                label="Rename"
                icon={Pencil}
                onPress={() => {
                  setName(route.name);
                  setRenaming(true);
                }}
              />
            )}
            <TextButton label="Delete route" icon={Trash2} tone="danger" onPress={() => setConfirmDelete(true)} />
          </Card>
        </>
      ) : null}
      <ConfirmSheet
        visible={confirmDelete}
        title="Delete this route?"
        body="It goes from your routes on every device. Runs you did on it stay."
        confirmLabel="Delete route"
        destructive
        busy={actions.busy}
        onConfirm={() => void remove()}
        onCancel={() => setConfirmDelete(false)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: { gap: space.sm },
  turn: { flexDirection: 'row', gap: space.md, alignItems: 'baseline' },
  at: { width: 64 },
  fill: { flex: 1 },
  buttons: { flexDirection: 'row', alignItems: 'center', gap: space.md },
});
