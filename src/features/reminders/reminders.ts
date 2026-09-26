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

/** The account journal key holding this account's reminder choice. */
export const REMINDER_KEY = 'settings:reminder';

function isHourMinute(hour: unknown, minute: unknown): boolean {
  return Number.isInteger(hour) && Number.isInteger(minute) && (hour as number) >= 0 && (hour as number) < 24 && (minute as number) >= 0 && (minute as number) < 60;
}

export function parseReminderSettings(value: unknown): ReminderSettings {
  const v = value as Partial<ReminderSettings> | null | undefined;
  if (!v || typeof v.enabled !== 'boolean' || !isHourMinute(v.hour, v.minute)) return DEFAULT_REMINDER;
  return { enabled: v.enabled, hour: v.hour as number, minute: v.minute as number };
}

let queue: Promise<unknown> = Promise.resolve();

/** Runs reminder changes one at a time, app-wide, so a late restore can never undo a newer choice. */
export function queueReminderChange<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task, task);
  queue = result.catch(() => undefined);
  return result;
}

interface KvReader {
  getKv<T>(key: string): Promise<{ value: T } | null>;
}

/** Signing out cancels the reminder; this puts the account's saved choice back after sign-in. */
export function restoreReminder(journal: KvReader): Promise<ReminderSettings> {
  return queueReminderChange(async () => {
    const settings = parseReminderSettings((await journal.getKv<unknown>(REMINDER_KEY))?.value);
    if (settings.enabled && (await notificationsAllowed().catch(() => false))) await scheduleReminder(settings.hour, settings.minute);
    return settings;
  });
}

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
