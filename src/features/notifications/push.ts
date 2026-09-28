import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import type { PaceApi } from '@/api/pace-api';
import { notificationsAllowed } from '@/features/reminders/reminders';

/**
 * Remote notifications (docs/ROADMAP.md 4.9): kudos, comments, follows, cheers and weekly results,
 * sent by the API service through Expo's push service. This phone's token is registered only
 * while the runner allows notifications and the server sends them; what arrives is chosen per
 * type in Profile › Privacy › Notifications.
 */

/** The Android channel the API service sends to (server/src/push.ts). */
export const ACTIVITY_CHANNEL = 'activity';
/** The account journal key holding the token this phone registered, and when. */
export const PUSH_TOKEN_KEY = 'push:token';
const REFRESH_MS = 24 * 3_600_000;

interface Kv {
  getKv<T>(key: string): Promise<{ value: T } | null>;
  setKv(key: string, value: unknown): Promise<void>;
}

interface StoredToken {
  token: string;
  at: number;
}

export const pushSupported = Platform.OS === 'ios' || Platform.OS === 'android';

export async function ensureActivityChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(ACTIVITY_CHANNEL, {
    name: 'Friends and league',
    description: 'Kudos, comments, follows, cheers and weekly results you chose in PaceLeague.',
    importance: Notifications.AndroidImportance.DEFAULT,
    sound: null,
    vibrationPattern: null,
    enableVibrate: false,
    showBadge: false,
  });
}

function easProjectId(): string | null {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
  return extra?.eas?.projectId ?? Constants.easConfig?.projectId ?? null;
}

async function expoPushToken(): Promise<string | null> {
  const projectId = easProjectId();
  if (!pushSupported || !projectId) return null;
  try {
    return (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  } catch {
    // Simulators without push support, or no connection to Expo right now.
    return null;
  }
}

/**
 * Registers this phone for pushes when allowed: at sign-in, when the token changes and once a day
 * otherwise (so the server knows the phone is still in use). `force` skips the daily check, for
 * right after the runner turns notifications on.
 */
export async function syncPushRegistration(
  api: Pick<PaceApi, 'getNotificationSettings' | 'registerPushToken'>,
  journal: Kv,
  options: { force?: boolean; now?: number } = {},
): Promise<'registered' | 'unchanged' | 'off'> {
  if (!pushSupported || !(await notificationsAllowed())) return 'off';
  const now = options.now ?? Date.now();
  const stored = (await journal.getKv<StoredToken>(PUSH_TOKEN_KEY))?.value;
  if (!options.force && stored && now - stored.at < REFRESH_MS) return 'unchanged';
  const settings = await api.getNotificationSettings();
  if (!settings.available) return 'off';
  await ensureActivityChannel();
  const token = await expoPushToken();
  if (!token) return 'off';
  await api.registerPushToken(token, Platform.OS === 'android' ? 'android' : 'ios');
  await journal.setKv(PUSH_TOKEN_KEY, { token, at: now } satisfies StoredToken);
  return 'registered';
}

/** At sign-out: this phone stops getting the account's pushes. Never holds sign-out up for long. */
export async function unregisterPush(api: Pick<PaceApi, 'unregisterPushToken'>, journal: Kv): Promise<void> {
  const stored = (await journal.getKv<StoredToken>(PUSH_TOKEN_KEY).catch(() => null))?.value;
  if (!stored) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    api.unregisterPushToken(stored.token).catch(() => false),
    new Promise((resolve) => {
      timer = setTimeout(resolve, 3_000);
    }),
  ]);
  clearTimeout(timer);
}
