import { useRouter } from 'expo-router';
import { Flag, Pause, Play } from 'lucide-react-native';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { StyleSheet, View } from 'react-native';

import { PrimaryButton, SecondaryButton, TextButton } from '@/components/ui/buttons';
import { ConfirmSheet } from '@/components/ui/confirm-sheet';
import { InlineStatus, TextField } from '@/components/ui/elements';
import { Card, NavHeader, Screen } from '@/components/ui/layout';
import { describeDuration, formatDistance, formatDuration, METRES_PER_MILE } from '@/domain/format';
import { useAccountServices } from '@/features/account/account-provider';
import { useMe } from '@/features/data/hooks';
import { activeMsOf } from '@/features/indoor/indoor-run';
import { useNow } from '@/lib/use-now';
import { Text } from '@/design/text';
import { space } from '@/design/tokens';
import { RecordInApp } from '@/components/run/record-in-app';
import { RECORDING_AVAILABLE } from '@/features/recording/recording-support';

/** Treadmill and indoor runs (docs/ROADMAP.md 2.5): a clock, steps and the treadmill's distance. */
/** The web app records nothing: runs come from the phone app (P.2). */
export default function IndoorRunScreenRoute() {
  return RECORDING_AVAILABLE ? <IndoorRunScreen /> : <RecordInApp />;
}

function IndoorRunScreen() {
  const router = useRouter();
  const { runtime, engine } = useAccountServices();
  const indoor = runtime.indoor;
  const session = useSyncExternalStore(
    (listener) => indoor.changes.subscribe(listener),
    () => indoor.current,
  );
  const units = useMe().data?.data.profile?.units ?? 'metric';
  const now = useNow(1000);
  const [steps, setSteps] = useState<number | null>(null);
  const [estimate, setEstimate] = useState<number | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [distanceText, setDistanceText] = useState('');
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const unitM = units === 'imperial' ? METRES_PER_MILE : 1000;
  const unitLabel = units === 'imperial' ? 'mi' : 'km';

  // Steps are read every few seconds while the run is open.
  useEffect(() => {
    if (!session) return;
    let alive = true;
    const read = () =>
      void Promise.all([indoor.steps(), indoor.estimateM()]).then(([s, e]) => {
        if (!alive) return;
        setSteps(s);
        setEstimate(e);
      });
    read();
    const timer = setInterval(read, 5_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [indoor, session]);

  const run = async (task: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const openFinish = () =>
    run(async () => {
      await indoor.pause();
      const e = await indoor.estimateM();
      setDistanceText(e ? (e / unitM).toFixed(2) : '');
      setFinishing(true);
    });

  const save = () =>
    run(async () => {
      const value = Number(distanceText.replace(',', '.'));
      if (!Number.isFinite(value) || value <= 0 || value > 200) throw new Error(`Enter the distance in ${unitLabel}.`);
      const runId = await indoor.finish(value * unitM);
      setFinishing(false);
      void engine?.run();
      router.replace({ pathname: '/run/summary/[id]', params: { id: runId } });
    });

  if (!session) {
    return (
      <Screen
        edges={['top', 'bottom']}
        footer={
          <>
            <PrimaryButton label="Start indoor run" icon={Play} size="large" loading={busy} onPress={() => void run(() => indoor.start())} testID="indoor-start" />
            <TextButton label="Not now" onPress={() => router.back()} />
          </>
        }>
        <NavHeader title="Treadmill or indoors" />
        <Card>
          <Text variant="body">There’s no GPS indoors, so PaceLeague counts your steps to estimate the distance. At the end, you can enter what the treadmill says.</Text>
          <Text variant="body" tone="secondary">
            Indoor runs count for your weekly goal and streak. They don’t earn league XP, because there’s no route to check.
          </Text>
        </Card>
        {error ? <InlineStatus tone="danger" title={error} /> : null}
      </Screen>
    );
  }

  const running = session.openSince !== null;
  const activeMs = activeMsOf(session, now);
  const d = estimate !== null ? formatDistance(estimate, units) : null;

  return (
    <Screen
      edges={['top', 'bottom']}
      footer={
        running ? (
          <PrimaryButton label="Pause" icon={Pause} size="xl" loading={busy} onPress={() => void run(() => indoor.pause())} testID="indoor-pause" />
        ) : (
          <>
            <View style={styles.row}>
              <PrimaryButton label="Resume" icon={Play} size="xl" onPress={() => void run(() => indoor.resume())} style={{ flex: 1 }} />
              <SecondaryButton label="Finish" icon={Flag} size="xl" onPress={() => void openFinish()} style={{ flex: 1 }} testID="indoor-finish" />
            </View>
            <TextButton label="Discard run" tone="danger" onPress={() => setConfirmDiscard(true)} />
          </>
        )
      }>
      <NavHeader title={running ? 'Indoor run' : 'Paused'} variant="close" onBack={() => router.navigate('/')} />
      <View style={styles.clock} accessible accessibilityLabel={`Active time, ${describeDuration(activeMs)}`}>
        <Text variant="workout" numberOfLines={1} adjustsFontSizeToFit>
          {formatDuration(activeMs)}
        </Text>
        <Text variant="eyebrow" tone="secondary">
          Time
        </Text>
      </View>
      <Card>
        <View style={styles.row} accessible accessibilityLabel={`${steps ?? 'Unknown'} steps. Estimated distance ${d ? `${d.value} ${d.unitLong}` : 'unknown'}.`}>
          <View style={styles.metric}>
            <Text variant="metric">{steps ?? '—'}</Text>
            <Text variant="eyebrow" tone="secondary">
              Steps
            </Text>
          </View>
          <View style={styles.metric}>
            <Text variant="metric">{d ? d.value : '—'}</Text>
            <Text variant="eyebrow" tone="secondary">
              Est. {unitLabel}
            </Text>
          </View>
        </View>
        {steps === null ? (
          <Text variant="caption" tone="secondary">
            Step counting isn’t available, so enter the treadmill’s distance at the end.
          </Text>
        ) : null}
      </Card>
      {error && !finishing ? <InlineStatus tone="danger" title={error} /> : null}

      <ConfirmSheet
        visible={finishing}
        title="How far did you run?"
        body={`Enter the treadmill’s distance, or keep the estimate. PaceLeague learns your stride from it.`}
        confirmLabel="Save run"
        busy={busy}
        onConfirm={() => void save()}
        onCancel={() => {
          setFinishing(false);
          setError(null);
        }}>
        <TextField
          label={`Distance (${unitLabel})`}
          value={distanceText}
          onChangeText={setDistanceText}
          error={error}
          keyboardType="decimal-pad"
          autoFocus
          testID="indoor-distance"
        />
      </ConfirmSheet>
      <ConfirmSheet
        visible={confirmDiscard}
        title="Discard this run?"
        body="Nothing from this run will be saved."
        confirmLabel="Discard run"
        destructive
        onConfirm={() =>
          void run(async () => {
            await indoor.discard();
            setConfirmDiscard(false);
            router.navigate('/');
          })
        }
        onCancel={() => setConfirmDiscard(false)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: space.md, alignItems: 'center' },
  clock: { alignItems: 'center', marginVertical: space.xl },
  metric: { flex: 1, alignItems: 'center', gap: 2 },
});
