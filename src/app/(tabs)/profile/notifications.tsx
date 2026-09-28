import { useCalendars } from 'expo-localization';
import { Bell, BellOff, Check, Minus, Plus, Settings } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { AppState, Linking, Pressable, StyleSheet, View } from 'react-native';

import { Monogram } from '@/components/art/art';
import { ActivityNotifications } from '@/components/social/activity-notifications';
import { IconButton, SecondaryButton } from '@/components/ui/buttons';
import { InlineStatus } from '@/components/ui/elements';
import { Card, NavHeader, Screen } from '@/components/ui/layout';
import { useAccount } from '@/features/account/account-provider';
import {
  cancelReminder,
  DEFAULT_REMINDER,
  notificationsAllowed,
  parseReminderSettings,
  queueReminderChange,
  REMINDER_KEY,
  requestNotificationPermission,
  scheduleReminder,
  type ReminderSettings,
} from '@/features/reminders/reminders';
import { Text } from '@/design/text';
import { colors, layout, radius, space } from '@/design/tokens';

const STEP_MINUTES = 15;
const DAY_MINUTES = 24 * 60;
const PRESETS = [
  { hour: 6, minute: 0 },
  { hour: 7, minute: 0 },
  { hour: 12, minute: 0 },
  { hour: 17, minute: 30 },
  { hour: 19, minute: 0 },
] as const;

type Permission = 'unknown' | 'granted' | 'not_granted';

function formatClock(hour: number, minute: number, uses24h: boolean): string {
  const mm = String(minute).padStart(2, '0');
  if (uses24h) return `${String(hour).padStart(2, '0')}:${mm}`;
  return `${hour % 12 === 0 ? 12 : hour % 12}:${mm} ${hour < 12 ? 'AM' : 'PM'}`;
}

function shifted(settings: ReminderSettings, deltaMinutes: number): { hour: number; minute: number } {
  const total = (((settings.hour * 60 + settings.minute + deltaMinutes) % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  return { hour: Math.floor(total / 60), minute: total % 60 };
}

/**
 * REQ-012 — one optional local reminder at a runner-chosen time. Opt-in; calm copy only. Below it,
 * the pushes about friends and the league (docs/ROADMAP.md 4.9), each switchable.
 */
export default function NotificationsScreen() {
  const { state } = useAccount();
  const journal = state.status === 'ready' ? state.runtime.journal : null;
  const uses24h = useCalendars()[0]?.uses24hourClock ?? false;
  const [settings, setSettings] = useState<ReminderSettings | null>(null);
  const [permission, setPermission] = useState<Permission>('unknown');
  const [declined, setDeclined] = useState(false);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Load this account's choice and the OS permission (AccountProvider already restored the
  // schedule after sign-in; every change below goes through the shared ordered queue).
  useEffect(() => {
    if (!journal) return;
    let alive = true;
    void Promise.all([journal.getKv<unknown>(REMINDER_KEY), notificationsAllowed().catch(() => false)])
      .then(([saved, allowed]) => {
        const loaded = parseReminderSettings(saved?.value);
        if (!alive) return;
        setSettings(loaded);
        setPermission(allowed ? 'granted' : 'not_granted');
      })
      .catch(() => alive && setSettings(DEFAULT_REMINDER));
    return () => {
      alive = false;
    };
  }, [journal]);

  // Returning from Settings: pick up a permission change and reschedule if needed.
  useEffect(() => {
    if (!settings) return;
    const subscription = AppState.addEventListener('change', (next) => {
      if (next !== 'active') return;
      void notificationsAllowed()
        .catch(() => false)
        .then((allowed) => {
          setPermission(allowed ? 'granted' : 'not_granted');
          if (allowed) setDeclined(false);
          if (allowed && settings.enabled) {
            void queueReminderChange(() => scheduleReminder(settings.hour, settings.minute)).catch(() => undefined);
          }
        });
    });
    return () => subscription.remove();
  }, [settings]);

  /** Saves the choice and updates the OS schedule. */
  const apply = (next: ReminderSettings, allowed: boolean) => {
    setSettings(next);
    setError(null);
    void queueReminderChange(async () => {
      await journal?.setKv(REMINDER_KEY, next);
      if (next.enabled && allowed) await scheduleReminder(next.hour, next.minute);
      else await cancelReminder();
    }).catch(() => setError('Couldn’t update your reminder. Try again.'));
  };

  const toggle = async () => {
    if (!settings || asking) return;
    if (settings.enabled) {
      apply({ ...settings, enabled: false }, permission === 'granted');
      return;
    }
    setAsking(true);
    const granted = await requestNotificationPermission().catch(() => false);
    setAsking(false);
    setPermission(granted ? 'granted' : 'not_granted');
    setDeclined(!granted);
    if (granted) apply({ ...settings, enabled: true }, true);
  };

  const setTime = (time: { hour: number; minute: number }) => {
    if (settings) apply({ ...settings, ...time }, permission === 'granted');
  };

  const current = settings ?? DEFAULT_REMINDER;
  const enabled = settings?.enabled === true;
  const time = formatClock(current.hour, current.minute, uses24h);
  const blocked = declined || (enabled && permission === 'not_granted');

  return (
    <Screen edges={['top', 'bottom']}>
      <NavHeader title="Notifications" />
      <Text variant="body" tone="secondary">
        One optional reminder a day, at a time you choose. No streaks and no pressure — rest days keep your rank.
      </Text>

      <Pressable
        accessibilityRole="switch"
        accessibilityLabel="Daily run reminder"
        accessibilityHint={enabled ? undefined : 'Asks for notification permission the first time'}
        accessibilityState={{ checked: enabled, disabled: !settings || asking }}
        aria-checked={enabled}
        aria-disabled={!settings || asking}
        disabled={!settings || asking}
        onPress={() => void toggle()}
        style={({ pressed }) => [styles.switchRow, pressed && { backgroundColor: colors.surfaceElevated }]}
        testID="reminder-switch">
        {enabled ? <Bell size={22} color={colors.textPrimary} /> : <BellOff size={22} color={colors.textSecondary} />}
        <View style={styles.fill}>
          <Text variant="body">Daily reminder</Text>
          <Text variant="caption" tone="secondary">
            {enabled ? `On · ${time}` : 'Off'}
          </Text>
        </View>
        <View style={[styles.track, enabled && styles.trackOn]}>
          <View style={[styles.thumb, enabled && styles.thumbOn]} />
        </View>
      </Pressable>

      {blocked ? (
        <View style={styles.statusGroup}>
          <InlineStatus
            tone="warning"
            icon={BellOff}
            title="Notifications are off for PaceLeague. You can turn them on in Settings."
            body="Everything else in PaceLeague works without them."
          />
          <SecondaryButton label="Open Settings" icon={Settings} onPress={() => void Linking.openSettings()} />
        </View>
      ) : null}
      {error ? <InlineStatus tone="danger" title={error} /> : null}

      <Card>
        <Text variant="labelStrong" accessibilityRole="header">
          Reminder time
        </Text>
        <View style={styles.stepper}>
          <IconButton icon={Minus} label={`${STEP_MINUTES} minutes earlier`} onPress={() => setTime(shifted(current, -STEP_MINUTES))} disabled={!settings} />
          <View
            style={styles.fill}
            accessible
            accessibilityRole="adjustable"
            accessibilityLabel="Reminder time"
            aria-valuenow={current.hour * 60 + current.minute}
            aria-valuemin={0}
            aria-valuemax={DAY_MINUTES - 1}
            aria-valuetext={time}
            accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
            onAccessibilityAction={(event) =>
              setTime(shifted(current, event.nativeEvent.actionName === 'increment' ? STEP_MINUTES : -STEP_MINUTES))
            }>
            <Text variant="metric" align="center">
              {time}
            </Text>
          </View>
          <IconButton icon={Plus} label={`${STEP_MINUTES} minutes later`} onPress={() => setTime(shifted(current, STEP_MINUTES))} disabled={!settings} />
        </View>
        <View style={styles.chips}>
          {PRESETS.map((preset) => {
            const selected = preset.hour === current.hour && preset.minute === current.minute;
            const label = formatClock(preset.hour, preset.minute, uses24h);
            return (
              <Pressable
                key={label}
                accessibilityRole="button"
                accessibilityLabel={`Remind me at ${label}`}
                accessibilityState={{ selected, disabled: !settings }}
                disabled={!settings}
                onPress={() => setTime(preset)}
                style={({ pressed }) => [styles.chip, selected && styles.chipOn, pressed && { opacity: 0.8 }]}>
                {selected ? <Check size={16} color={colors.onAccent} strokeWidth={3} /> : null}
                <Text variant="labelStrong" style={{ color: selected ? colors.onAccent : colors.textPrimary }}>
                  {label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </Card>

      <View style={styles.preview} accessible accessibilityLabel="Reminder preview. PaceLeague: A good time for a run?">
        <View style={styles.previewIcon}>
          <Monogram size={24} background={colors.surfaceElevated} />
        </View>
        <View style={styles.fill}>
          <Text variant="labelStrong">PaceLeague</Text>
          <Text variant="label" tone="secondary">
            A good time for a run?
          </Text>
        </View>
      </View>
      <Text variant="caption" tone="secondary">
        The reminder is scheduled on this phone only. It stops when you turn it off or sign out.
      </Text>

      <ActivityNotifications />
    </Screen>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: 64,
    paddingHorizontal: layout.cardPadding,
    paddingVertical: space.md,
    borderRadius: radius.card,
    backgroundColor: colors.surface,
  },
  track: {
    width: 52,
    height: 32,
    borderRadius: 16,
    padding: 3,
    justifyContent: 'center',
    backgroundColor: colors.surfaceElevated,
    borderWidth: 1.5,
    borderColor: colors.controlOutline,
  },
  trackOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  thumb: { width: 23, height: 23, borderRadius: 12, backgroundColor: colors.textPrimary },
  thumbOn: { alignSelf: 'flex-end', backgroundColor: colors.onAccent },
  statusGroup: { gap: space.sm },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    minHeight: layout.minimumTapTarget,
    paddingHorizontal: space.lg,
    borderRadius: 999,
    borderWidth: 1.5,
    borderColor: colors.controlOutline,
  },
  chipOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  preview: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.lg,
    borderRadius: radius.control,
    backgroundColor: colors.surfaceElevated,
  },
  previewIcon: {
    width: 40,
    height: 40,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceElevated,
    borderWidth: 1,
    borderColor: colors.decorativeDivider,
  },
});
