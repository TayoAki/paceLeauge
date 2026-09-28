import * as Haptics from 'expo-haptics';
import * as Location from 'expo-location';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { CalendarCheck, Headphones, Info, Lock, MapPin, Satellite } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppState, Linking, Platform, StyleSheet, View } from 'react-native';

import { RouteMap } from '@/components/run/route-map';
import { PrimaryButton, TextButton } from '@/components/ui/buttons';
import { InlineStatus, Row, RowGroup } from '@/components/ui/elements';
import { NavHeader, Screen } from '@/components/ui/layout';
import { RECORDER_V1 } from '@/domain/config';
import { heatAdvice, heatZones } from '@/domain/heat';
import { useAccountServices } from '@/features/account/account-provider';
import { locationDriver } from '@/features/recording/location-driver';
import { guidedLines, guidedMinutes, guidedRun } from '@/features/guided/catalog';
import { formatMinutes } from '@/features/plans/plan-client';
import { usePro } from '@/features/pro/use-pro';
import { usePlanState } from '@/features/plans/use-plan';
import { useHeat } from '@/features/training/use-heat';
import { blocker, copyFor, signalLevel, type PermissionStatus, type PreflightState } from '@/features/recording/preflight';
import { ActiveRunExistsError } from '@/features/recording/recorder-service';
import { Text } from '@/design/text';
import { colors, space } from '@/design/tokens';
import { useNow } from '@/lib/use-now';

/** iOS asks for "Always" location; Android's foreground service records on "while in use". */
const NEEDS_BACKGROUND = locationDriver.needsBackgroundPermission ?? locationDriver.supportsBackground;
const BATTERY_TIP_KEY = 'tip:android-battery';

const INITIAL: PreflightState = {
  servicesEnabled: true,
  foreground: 'undetermined',
  canAskForeground: true,
  background: !locationDriver.supportsBackground ? 'unsupported' : NEEDS_BACKGROUND ? 'undetermined' : 'not_needed',
  canAskBackground: true,
  precise: null,
  fix: null,
};

const signalCopy = {
  off: 'Off',
  searching: 'Searching…',
  good: 'Good',
  fair: 'Fair',
  weak: 'Weak',
} as const;

/** S04 — explain, request location in context, confirm a fresh fix, then count down. */
export default function PreflightScreen() {
  const router = useRouter();
  const { runtime } = useAccountServices();
  const [pf, setPf] = useState<PreflightState>(INITIAL);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(1000);

  // An open treadmill run comes first: finish or discard it before a GPS run.
  useEffect(() => {
    if (runtime.indoor.current) router.replace('/run/indoor');
  }, [runtime, router]);

  // A planned session to follow (docs/ROADMAP.md 3.1): ready for the run to start, and let go
  // if the runner leaves without starting.
  const { session: sessionId, guided: guidedId } = useLocalSearchParams<{ session?: string; guided?: string }>();
  const { state: plan } = usePlanState();
  const planned = sessionId && plan?.server.status === 'active' ? (plan.server.sessions.find((s) => s.id === sessionId) ?? null) : null;
  const planId = plan?.server.id ?? null;
  const planZones = plan?.plan?.zones ?? null;
  // Or a guided run (3.4), its coaching placed on the workout's timeline.
  const { pro } = usePro();
  // Pro: the heat the runner gave for today slows the session's spoken paces.
  const { entry: heat } = useHeat(planned?.date ?? null);
  // Undefined: no heat given; null: too hot for set paces, so the steps are spoken by effort alone.
  const slowdown = pro && heat ? heatAdvice(heat).slowdown : undefined;
  const zones = useMemo(
    () => (!planZones || slowdown === undefined || slowdown === 0 ? planZones : slowdown === null ? null : heatZones(planZones, slowdown)),
    [planZones, slowdown],
  );
  const found = guidedId ? guidedRun(guidedId) : null;
  const guided = found && (found.free || pro) ? found : null;
  useEffect(() => {
    if (guided) {
      runtime.workout.prepare({ source: { kind: 'guided', guidedId: guided.id }, title: guided.title, blocks: guided.blocks, zones: planZones, lines: guidedLines(guided) });
    } else if (planned && planId) {
      runtime.workout.prepare({ source: { kind: 'plan', planId, sessionId: planned.id }, title: planned.title, blocks: planned.blocks, zones });
    } else {
      return;
    }
    return () => {
      if (!runtime.recorder.getSnapshot().session) runtime.workout.cancel();
    };
  }, [runtime, planned, planId, zones, planZones, guided]);

  const refresh = useCallback(async () => {
    const services = await Location.hasServicesEnabledAsync().catch(() => true);
    const fg = await Location.getForegroundPermissionsAsync();
    const bg = NEEDS_BACKGROUND ? await Location.getBackgroundPermissionsAsync().catch(() => null) : null;
    setPf((prev) => ({
      ...prev,
      servicesEnabled: services,
      foreground: fg.status as PermissionStatus,
      canAskForeground: fg.canAskAgain,
      background: !locationDriver.supportsBackground
        ? 'unsupported'
        : NEEDS_BACKGROUND
          ? ((bg?.status as PermissionStatus | undefined) ?? 'undetermined')
          : 'not_needed',
      canAskBackground: bg?.canAskAgain ?? false,
      precise:
        Platform.OS === 'ios' && fg.ios?.accuracy
          ? fg.ios.accuracy === 'full'
          : Platform.OS === 'android' && fg.android?.accuracy
            ? fg.android.accuracy === 'fine'
            : null,
    }));
  }, []);

  useFocusEffect(
    useCallback(() => {
      void refresh();
      const sub = AppState.addEventListener('change', (s) => s === 'active' && void refresh());
      return () => sub.remove();
    }, [refresh]),
  );

  // A short-lived current fix, only while preflight is visible (never at app launch).
  const canWatch = pf.foreground === 'granted' && pf.servicesEnabled;
  useFocusEffect(
    useCallback(() => {
      if (!canWatch) return;
      let sub: Location.LocationSubscription | null = null;
      let alive = true;
      Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.BestForNavigation,
          timeInterval: 1000,
          distanceInterval: 0,
        },
        (loc) =>
          setPf((prev) => ({
            ...prev,
            fix: {
              at: loc.timestamp,
              accuracyM: loc.coords.accuracy,
              latitude: loc.coords.latitude,
              longitude: loc.coords.longitude,
            },
          })),
      )
        .then((s) => (alive ? (sub = s) : s.remove()))
        .catch(() => undefined);
      return () => {
        alive = false;
        sub?.remove();
      };
    }, [canWatch]),
  );

  const block = blocker(pf, now);
  const signal = signalLevel(pf, now);

  const requestForeground = async () => {
    const result = await Location.requestForegroundPermissionsAsync();
    runtime.telemetry.track('permission_result', {
      permission: 'foreground',
      result: result.status,
      precise: result.ios?.accuracy ? result.ios.accuracy === 'full' : true,
    });
    await refresh();
  };

  const requestBackground = async () => {
    const result = await Location.requestBackgroundPermissionsAsync();
    runtime.telemetry.track('permission_result', {
      permission: 'background',
      result: result.status,
    });
    await refresh();
  };

  // Cancellable three-second countdown, then start recording.
  useEffect(() => {
    if (countdown === null) return;
    if (countdown === 0) {
      runtime.recorder
        .start()
        .then(() => {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
          router.replace('/run/active');
        })
        .catch((e: unknown) => {
          if (e instanceof ActiveRunExistsError) {
            router.replace('/run/active');
            return;
          }
          setCountdown(null);
          setError('Recording couldn’t start. Check location access and try again.');
          void refresh();
        });
      return;
    }
    const t = setTimeout(() => setCountdown((c) => (c === null ? null : c - 1)), 1000);
    return () => clearTimeout(t);
  }, [countdown, runtime, router, refresh]);

  if (countdown !== null && countdown > 0) {
    return (
      <View style={styles.countdown} accessibilityLiveRegion="assertive">
        <Text variant="eyebrow" tone="secondary">
          Starting in
        </Text>
        <Text variant="workout" style={styles.countdownNumber} accessibilityLabel={`Starting in ${countdown}`}>
          {countdown}
        </Text>
        <TextButton label="Cancel" tone="primary" onPress={() => setCountdown(null)} />
      </View>
    );
  }

  const copy = block
    ? block === 'needs_foreground' && !locationDriver.supportsBackground
      ? { ...copyFor(block, Platform.OS), title: 'Use location to prepare and record your run.' }
      : copyFor(block, Platform.OS)
    : null;
  const primary = (() => {
    if (!copy)
      return {
        label: 'Start run',
        onPress: () => setCountdown(RECORDER_V1.countdownSeconds),
        disabled: false,
      };
    switch (copy.action) {
      case 'request_foreground':
        return pf.canAskForeground
          ? { label: 'Continue', onPress: requestForeground, disabled: false }
          : {
              label: 'Open Settings',
              onPress: () => void Linking.openSettings(),
              disabled: false,
            };
      case 'request_background':
        return pf.canAskBackground
          ? {
              label: 'Allow while locked',
              onPress: requestBackground,
              disabled: false,
            }
          : {
              label: 'Open Settings',
              onPress: () => void Linking.openSettings(),
              disabled: false,
            };
      case 'settings':
        return {
          label: 'Open Settings',
          onPress: () => void Linking.openSettings(),
          disabled: false,
        };
      default:
        return { label: 'Start run', onPress: () => undefined, disabled: true };
    }
  })();

  const lockedValue =
    pf.background === 'granted' || pf.background === 'not_needed'
      ? 'Ready'
      : pf.background === 'unsupported'
        ? 'Not in web preview'
        : pf.background === 'denied'
          ? 'Off'
          : 'Not set up';
  const preciseValue = pf.foreground !== 'granted' ? 'Off' : pf.precise === null ? 'Unknown' : pf.precise ? 'On' : 'Off';

  return (
    <Screen
      edges={['top', 'bottom']}
      footer={
        <>
          <PrimaryButton label={primary.label} onPress={primary.onPress} disabled={primary.disabled} size="large" testID="preflight-primary" />
          <TextButton label="Treadmill or indoors instead" onPress={() => router.replace('/run/indoor')} testID="indoor-run" />
          <TextButton label="Not now" onPress={() => router.back()} />
        </>
      }>
      <NavHeader title="Ready to run?" />
      {planned || guided ? (
        <RowGroup>
          <Row
            icon={guided ? Headphones : CalendarCheck}
            label={guided ? guided.title : planned!.title}
            value={guided ? `${guidedMinutes(guided)} min` : formatMinutes(planned!.duration_s)}
            hint={guided ? 'Guided run. Your coach talks over your music.' : 'Today’s workout. Steps are spoken as you go.'}
            last
          />
        </RowGroup>
      ) : null}
      <RouteMap
        lines={[]}
        height={230}
        current={pf.fix ? { latitude: pf.fix.latitude, longitude: pf.fix.longitude } : null}
        follow
        accessibilityLabel={pf.fix ? 'Map showing your current position' : 'Map, waiting for your position'}
      />
      <RowGroup>
        <Row
          icon={Satellite}
          label="GPS signal"
          value={signalCopy[signal]}
          valueTone={signal === 'good' ? 'accent' : signal === 'weak' ? 'danger' : 'secondary'}
        />
        <Row icon={MapPin} label="Precise location" value={preciseValue} valueTone={preciseValue === 'On' ? 'accent' : 'secondary'} />
        <Row icon={Lock} label="Screen-locked tracking" value={lockedValue} valueTone={lockedValue === 'Ready' ? 'accent' : 'secondary'} last />
      </RowGroup>
      {error ? <InlineStatus tone="danger" title={error} /> : null}
      {Platform.OS === 'android' && !copy ? <BatteryTip /> : null}
      {copy ? (
        <InlineStatus tone={copy.action === 'wait' ? 'info' : 'warning'} title={copy.title} body={copy.body} />
      ) : (
        <View style={styles.info} accessible>
          <Info size={20} color={colors.textSecondary} />
          <Text variant="label" tone="secondary" style={{ flex: 1 }}>
            Location is used to prepare and record your run.
          </Text>
        </View>
      )}
    </Screen>
  );
}

/**
 * Android: some phones stop apps in a pocket to save battery, whatever the foreground service
 * asks. Shown before runs until the runner says they've got it.
 */
function BatteryTip() {
  const { runtime } = useAccountServices();
  const [shown, setShown] = useState(false);
  useEffect(() => {
    let alive = true;
    runtime.journal
      .getKv<boolean>(BATTERY_TIP_KEY)
      .then((seen) => alive && setShown(!seen?.value))
      .catch(() => alive && setShown(true));
    return () => {
      alive = false;
    };
  }, [runtime]);
  if (!shown) return null;
  return (
    <InlineStatus
      title="Keep recording in your pocket"
      body="Some Android phones stop apps to save battery. If a run ever stops recording, set PaceLeague’s battery use to Unrestricted in Settings."
      action={
        <View style={styles.tipActions}>
          <TextButton label="Open Settings" onPress={() => void Linking.openSettings()} />
          <TextButton
            label="Got it"
            onPress={() => {
              setShown(false);
              void runtime.journal.setKv(BATTERY_TIP_KEY, true).catch(() => undefined);
            }}
          />
        </View>
      }
    />
  );
}

const styles = StyleSheet.create({
  tipActions: { flexDirection: 'row', gap: space.md },
  countdown: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.lg,
  },
  countdownNumber: { fontSize: 160, lineHeight: 176, color: colors.accent },
  info: {
    flexDirection: 'row',
    gap: space.md,
    alignItems: 'center',
    padding: space.lg,
    borderRadius: 12,
    backgroundColor: colors.surface,
  },
});
