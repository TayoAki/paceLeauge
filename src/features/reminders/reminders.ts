import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

/**
 * One optional local reminder at a runner-chosen time (REQ-012). Opt-in only; calm copy
 * with no rank-loss threats, pace pressure or sensitive lock-screen detail. No remote pushes.
 */
const IDENTIFIER = 'pl-daily-reminder';

export interface ReminderSettings {
  enabled: boolean;
  hour: number;
  minute: number;
}

export const DEFAULT_REMINDER: ReminderSettings = { enabled: false, hour: 7, minute: 0 };

export async function notificationsAllowed(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  const current = await Notifications.getPermissionsAsync();
  return current.granted;
}

/** Asks only when the runner turns reminders on. Returns false if they decline. */
export async function requestNotificationPermission(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  if (!current.canAskAgain) return false;
  const result = await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowSound: false, allowBadge: false } });
  return result.granted;
}

/** Replaces any existing reminder (never duplicates); the OS handles time zones and DST. */
export async function scheduleReminder(hour: number, minute: number): Promise<void> {
  if (Platform.OS === 'web') return;
  await cancelReminder();
  await Notifications.scheduleNotificationAsync({
    identifier: IDENTIFIER,
    content: { title: 'PaceLeague', body: 'A good time for a run?', sound: false },
    trigger: { type: Notifications.SchedulableTriggerInputTypes.DAILY, hour, minute },
  });
}

export async function cancelReminder(): Promise<void> {
  if (Platform.OS === 'web') return;
  await Notifications.cancelScheduledNotificationAsync(IDENTIFIER).catch(() => undefined);
}
