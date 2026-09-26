import * as Haptics from 'expo-haptics';
import * as Location from 'expo-location';
import { useFocusEffect, useRouter } from 'expo-router';
import { Info, Lock, MapPin, Satellite } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { AppState, Linking, Platform, StyleSheet, View } from 'react-native';

import { RouteMap } from '@/components/run/route-map';
import { PrimaryButton, TextButton } from '@/components/ui/buttons';
import { InlineStatus, Row, RowGroup } from '@/components/ui/elements';
import { NavHeader, Screen } from '@/components/ui/layout';
import { RECORDER_V1 } from '@/domain/config';
import { useAccountServices } from '@/features/account/account-provider';
import { locationDriver } from '@/features/recording/location-driver';
import { blocker, blockerCopy, signalLevel, type PermissionStatus, type PreflightState } from '@/features/recording/preflight';
import { ActiveRunExistsError } from '@/features/recording/recorder-service';
import { Text } from '@/design/text';
import { colors, space } from '@/design/tokens';
import { useNow } from '@/lib/use-now';

const INITIAL: PreflightState = {
  servicesEnabled: true,
  foreground: 'undetermined',
  canAskForeground: true,
  background: locationDriver.supportsBackground ? 'undetermined' : 'unsupported',
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

  const refresh = useCallback(async () => {
    const services = await Location.hasServicesEnabledAsync().catch(() => true);
    const fg = await Location.getForegroundPermissionsAsync();
    const bg = locationDriver.supportsBackground ? await Location.getBackgroundPermissionsAsync().catch(() => null) : null;
    setPf((prev) => ({
      ...prev,
      servicesEnabled: services,
      foreground: fg.status as PermissionStatus,
      canAskForeground: fg.canAskAgain,
      background: locationDriver.supportsBackground ? ((bg?.status as PermissionStatus | undefined) ?? 'undetermined') : 'unsupported',
      canAskBackground: bg?.canAskAgain ?? false,
      precise: Platform.OS === 'ios' && fg.ios?.accuracy ? fg.ios.accuracy === 'full' : null,
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

  const copy = block ? blockerCopy[block] : null;
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
    pf.background === 'granted'
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
          <TextButton label="Not now" onPress={() => router.back()} />
        </>
      }>
      <NavHeader title="Ready to run?" />
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

const styles = StyleSheet.create({
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
