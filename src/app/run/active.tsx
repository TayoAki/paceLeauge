import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { ChevronDown, Flag, Play, Radio, RotateCcw, Save, Volume2, VolumeX } from 'lucide-react-native';
import { Fragment, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { BackHandler, StyleSheet, View } from 'react-native';

import { LiveShareSheet } from '@/components/run/live-share-sheet';
import { GpsStatus, MetricBlock, RecordingControls, TouchLockOverlay, useAnnounce } from '@/components/run/run-components';
import { routeLines } from '@/components/run/route-lines';
import { RouteMap } from '@/components/run/route-map';
import { RoutePanel } from '@/components/run/route-panel';
import { WorkoutPanel } from '@/components/run/workout-panel';
import { IconButton, PrimaryButton, SecondaryButton, TextButton } from '@/components/ui/buttons';
import { ConfirmSheet } from '@/components/ui/confirm-sheet';
import { InlineStatus, Pill } from '@/components/ui/elements';
import { Screen } from '@/components/ui/layout';
import { describeDistance, describeDuration, describePace, formatDistance, formatDuration, formatPace } from '@/domain/format';
import { useAccountServices } from '@/features/account/account-provider';
import { useMe, useRecorder } from '@/features/data/hooks';
import { useRunPoints } from '@/features/recording/use-run-points';
import { useFollowedRoute } from '@/features/routes/use-routes';
import type { RunScreenField } from '@/features/voice/run-settings';
import { Text } from '@/design/text';
import { colors, space } from '@/design/tokens';

type Busy = null | 'pause' | 'resume' | 'finish' | 'discard' | 'recover';

function haptic() {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
}

/** S05 recording · S06 paused · interrupted recovery — one durable session, three states. */
export default function ActiveRunScreen() {
  const router = useRouter();
  const { runtime } = useAccountServices();
  const recorder = runtime.recorder;
  const { session, metrics, lastSaved, autoPaused } = useRecorder();
  const runSettings = runtime.runSettings;
  const cuesOn = useSyncExternalStore(runSettings.subscribe, () => runSettings.getSnapshot().cues.enabled);
  const screenFields = useSyncExternalStore(runSettings.subscribe, () => runSettings.getSnapshot().screenFields);
  const units = useMe().data?.data.profile?.units ?? runSettings.units;
  const [locked, setLocked] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // Live location for this run (docs/ROADMAP.md 4.8).
  const liveShare = runtime.liveShare;
  const live = useSyncExternalStore(liveShare.subscribe, liveShare.getSnapshot);
  const [liveOpen, setLiveOpen] = useState(false);
  const points = useRunPoints(session?.runId ?? null, session?.status === 'recording');
  const lines = useMemo(() => routeLines(points), [points]);
  const last = points[points.length - 1];
  // The planned route this run follows (docs/ROADMAP.md 5.1), drawn beneath it.
  const followed = useFollowedRoute();
  const followedPoints = followed?.view ? followed.route.points : null;
  const guide = useMemo(() => (followedPoints ? followedPoints.map((p) => ({ latitude: p[0], longitude: p[1] })) : null), [followedPoints]);

  useAnnounce(session ? { recording: 'Recording', paused: autoPaused ? 'Auto-paused' : 'Paused', interrupted: 'Recording stopped' }[session.status] : null);

  // Cues speak in the runner's units, even when the run was started before the profile loaded.
  useEffect(() => runSettings.setUnits(units), [runSettings, units]);

  const toggleCues = () => {
    const current = runSettings.get();
    void runSettings.save({ ...current, cues: { ...current.cues, enabled: !current.cues.enabled } }).catch(() => undefined);
  };

  // Leaving is only possible through explicit controls while a run exists.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => session?.status === 'recording');
    return () => sub.remove();
  }, [session?.status]);

  useEffect(() => {
    if (!session && busy === null) {
      if (lastSaved) router.replace({ pathname: '/run/summary/[id]', params: { id: lastSaved.runId } });
      else router.dismissTo('/');
    }
  }, [session, busy, lastSaved, router]);

  const act = async (kind: Exclude<Busy, null>, task: () => Promise<void>, failure: string) => {
    setBusy(kind);
    setError(null);
    try {
      await task();
    } catch {
      setError(failure);
    } finally {
      setBusy(null);
    }
  };

  const pause = () =>
    act(
      'pause',
      async () => {
        haptic();
        await recorder.pause();
      },
      'Couldn’t pause. Your recording continues — try again.',
    );
  const resume = () =>
    act(
      'resume',
      async () => {
        haptic();
        if (session?.status === 'interrupted') await recorder.recover();
        await recorder.resume();
      },
      'Couldn’t resume. Check that location access is on, then try again.',
    );
  const finish = () =>
    act(
      'finish',
      async () => {
        if (session?.status === 'interrupted') await recorder.recover();
        const saved = await recorder.finish();
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
        router.replace({ pathname: '/run/summary/[id]', params: { id: saved.runId } });
      },
      'Couldn’t save your run. Your recording is safe on this phone — try again.',
    );
  const discard = () =>
    act(
      'discard',
      async () => {
        if (session?.status === 'interrupted') await recorder.recover();
        await recorder.discard();
        setConfirmDiscard(false);
        router.dismissTo('/');
      },
      'Couldn’t discard the run. Try again.',
    );

  if (!session) return <View style={styles.blank} />;

  const distance = formatDistance(metrics.distanceM, units);
  const pace = formatPace(metrics.activeMs, metrics.distanceM, units);
  const current = metrics.currentPaceSPerKm;
  const currentPace = current === null ? null : formatPace(current * 1000, 1000, units);
  const unitLabel = pace.unit.replace('/', '/ ');
  /** The numbers the runner chose for the row under the distance (Run settings). */
  const fieldMetric = (field: RunScreenField): { value: string; label: string; a11y: string } => {
    switch (field) {
      case 'time':
        return { value: formatDuration(metrics.activeMs), label: 'Time', a11y: `Active time, ${describeDuration(metrics.activeMs)}` };
      case 'currentPace':
        return {
          value: recording && currentPace ? currentPace.value : '--:--',
          label: `Now ${unitLabel}`,
          a11y: recording && current !== null ? `Current pace, ${describePace(current * 1000, 1000, units)}` : 'Current pace not available',
        };
      case 'averagePace':
        return { value: pace.value, label: `Avg ${unitLabel}`, a11y: `Average pace, ${describePace(metrics.activeMs, metrics.distanceM, units)}` };
      case 'lapPace': {
        const lap = formatPace(metrics.lapActiveMs, metrics.lapDistanceM, units);
        return { value: lap.value, label: `Lap ${unitLabel}`, a11y: `Lap pace, ${describePace(metrics.lapActiveMs, metrics.lapDistanceM, units)}` };
      }
      case 'lapTime':
        return { value: formatDuration(metrics.lapActiveMs), label: 'Lap time', a11y: `Lap time, ${describeDuration(metrics.lapActiveMs)}` };
    }
  };
  const recording = session.status === 'recording';
  const title = recording ? 'Running' : session.status === 'paused' ? (autoPaused ? 'Auto-paused' : 'Paused') : 'Recording stopped';

  const metricsBlock = (
    <View style={styles.metrics}>
      <View
        accessible
        accessibilityLabel={`Distance, ${describeDistance(metrics.distanceM, units)}`}
        style={styles.distance}>
        <Text variant="workout" numberOfLines={1} adjustsFontSizeToFit testID="live-distance">
          {distance.value}
        </Text>
        <Text variant="eyebrow" tone="secondary" style={{ letterSpacing: 5 }}>
          {distance.unitLong}
        </Text>
      </View>
      <View style={styles.row}>
        {screenFields.map((field, i) => {
          const m = fieldMetric(field);
          return (
            <Fragment key={field}>
              {i > 0 ? <View style={styles.divider} /> : null}
              <MetricBlock value={m.value} label={m.label} accessibilityLabel={m.a11y} />
            </Fragment>
          );
        })}
      </View>
    </View>
  );

  return (
    <View style={styles.blank}>
      <Screen
        scroll={!recording}
        edges={['top', 'bottom']}
        footer={
          recording ? (
            <RecordingControls onPause={pause} onLock={() => setLocked(true)} pausing={busy === 'pause'} />
          ) : session.status === 'paused' ? (
            <>
              <View style={styles.row}>
                <PrimaryButton label="Resume" icon={Play} size="xl" onPress={resume} loading={busy === 'resume'} style={{ flex: 1 }} testID="resume-button" />
                <SecondaryButton label="Finish" icon={Flag} size="xl" onPress={finish} loading={busy === 'finish'} style={{ flex: 1 }} testID="finish-button" />
              </View>
              <TextButton label="Discard run" tone="danger" onPress={() => setConfirmDiscard(true)} />
            </>
          ) : (
            <>
              <PrimaryButton label="Resume with a new segment" icon={RotateCcw} onPress={resume} loading={busy === 'resume'} />
              <SecondaryButton label="Save partial run" icon={Save} onPress={finish} loading={busy === 'finish'} testID="save-partial" />
              <TextButton label="Discard" tone="danger" onPress={() => setConfirmDiscard(true)} />
            </>
          )
        }>
        <View style={styles.header}>
          <IconButton icon={ChevronDown} label="Minimize run" tone="plain" onPress={() => router.navigate('/')} />
          <Text variant="title" accessibilityRole="header" style={{ flex: 1 }}>
            {title}
          </Text>
          {recording ? <GpsStatus quality={metrics.quality} /> : null}
          {live ? <Pill label="Live" /> : null}
          {session.status !== 'interrupted' ? (
            <IconButton
              icon={Radio}
              label={live ? 'Sharing your live location' : 'Share your live location'}
              tone="plain"
              onPress={() => setLiveOpen(true)}
              testID="live-share"
            />
          ) : null}
          <IconButton
            icon={cuesOn ? Volume2 : VolumeX}
            label={cuesOn ? 'Mute voice cues' : 'Turn on voice cues'}
            tone="plain"
            onPress={toggleCues}
            testID="cues-toggle"
          />
        </View>

        {session.status === 'interrupted' ? (
          <InlineStatus
            tone="warning"
            title="Recording stopped. Your saved portion is here."
            body={
              session.interruptReason === 'permission'
                ? 'Location access was turned off, so recording stopped at that point.'
                : 'PaceLeague was closed while recording. Time without GPS isn’t counted.'
            }
          />
        ) : null}
        {session.status === 'paused' ? (
          <InlineStatus
            title={autoPaused ? 'Auto-paused — you stopped moving.' : 'Paused — time and distance aren’t counting.'}
            body={autoPaused ? 'Recording resumes as soon as you run again. Time stopped doesn’t count.' : undefined}
          />
        ) : null}

        <RoutePanel units={units} />
        <WorkoutPanel units={units} onSkip={() => runtime.workout.skip(units)} />
        {metricsBlock}

        {recording && metrics.quality === 'weak' ? <InlineStatus tone="warning" title="GPS is weak. Distance may be incomplete." /> : null}
        {metrics.pointLimitReached ? (
          <InlineStatus tone="warning" title="Route storage is full for this run." body="Time keeps recording; the route beyond this point won’t upload." />
        ) : null}
        {error ? <InlineStatus tone="danger" title={error} /> : null}

        <View style={recording ? styles.mapFill : undefined}>
          <RouteMap
            lines={lines}
            guide={guide}
            height={recording ? 260 : 200}
            current={recording && last ? { latitude: last.lat, longitude: last.lon } : null}
            follow={recording}
            accessibilityLabel={guide ? `Map of your run so far on ${followed?.route.name ?? 'the planned route'}. Visible only to you.` : 'Map of your route so far. Visible only to you.'}
          />
        </View>
      </Screen>
      {locked && recording ? <TouchLockOverlay onUnlock={() => setLocked(false)} /> : null}
      <LiveShareSheet controller={liveShare} visible={liveOpen} onClose={() => setLiveOpen(false)} />
      <ConfirmSheet
        visible={confirmDiscard}
        title="Discard this run?"
        body="Nothing from this run will be saved."
        confirmLabel="Discard run"
        destructive
        busy={busy === 'discard'}
        onConfirm={discard}
        onCancel={() => setConfirmDiscard(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  blank: { flex: 1, backgroundColor: colors.background },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginLeft: -space.md },
  metrics: { gap: space.lg, alignItems: 'center' },
  distance: { alignItems: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, alignSelf: 'stretch' },
  divider: { width: 1, alignSelf: 'stretch', backgroundColor: colors.decorativeDivider },
  mapFill: { flexGrow: 1 },
});
