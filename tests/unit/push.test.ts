import * as Notifications from 'expo-notifications';

import type { Comment } from '@/api/feed-schemas';
import { PUSH_TOKEN_KEY, syncPushRegistration, unregisterPush } from '@/features/notifications/push';
import { pushRoute } from '@/features/notifications/push-routes';
import { countComments, timeAgo } from '@/features/social/use-feed';

jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn(),
  setNotificationChannelAsync: jest.fn(),
  AndroidImportance: { DEFAULT: 3 },
}));
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: { eas: { projectId: 'project-1' } } } } }));

const mocked = Notifications as jest.Mocked<typeof Notifications>;
const TOKEN = 'ExponentPushToken[abcdefghijklmnopqrstuv]';
const RUN = '0b6c2d1e-9a7f-4c3b-8e21-5f4a3d2c1b0a';

function memoryJournal(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    store,
    async getKv<T>(key: string): Promise<{ value: T } | null> {
      return store.has(key) ? { value: store.get(key) as T } : null;
    },
    async setKv(key: string, value: unknown): Promise<void> {
      store.set(key, value);
    },
  };
}

function fakeApi(available = true) {
  return {
    getNotificationSettings: jest.fn(async () => ({ available, prefs: { kudos: true, comments: true, follows: true, cheers: true, results: true, league: true }, devices: 0 })),
    registerPushToken: jest.fn(async () => ({ available, prefs: { kudos: true, comments: true, follows: true, cheers: true, results: true, league: true }, devices: 1 })),
    unregisterPushToken: jest.fn(async () => true),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mocked.getPermissionsAsync.mockResolvedValue({ granted: true, canAskAgain: true } as never);
  mocked.getExpoPushTokenAsync.mockResolvedValue({ type: 'expo', data: TOKEN });
});

describe('push registration', () => {
  it('registers once allowed, then at most daily unless forced', async () => {
    const api = fakeApi();
    const journal = memoryJournal();
    expect(await syncPushRegistration(api, journal, { now: 1_000 })).toBe('registered');
    expect(api.registerPushToken).toHaveBeenCalledWith(TOKEN, 'ios');
    expect(mocked.getExpoPushTokenAsync).toHaveBeenCalledWith({ projectId: 'project-1' });
    expect(journal.store.get(PUSH_TOKEN_KEY)).toEqual({ token: TOKEN, at: 1_000 });

    expect(await syncPushRegistration(api, journal, { now: 1_000 + 3_600_000 })).toBe('unchanged');
    expect(await syncPushRegistration(api, journal, { now: 1_000 + 3_600_000, force: true })).toBe('registered');
    expect(await syncPushRegistration(api, journal, { now: 1_000 + 25 * 3_600_000 })).toBe('registered');
    expect(api.registerPushToken).toHaveBeenCalledTimes(3);
  });

  it('does nothing without permission, or when the server sends no pushes', async () => {
    const journal = memoryJournal();
    mocked.getPermissionsAsync.mockResolvedValueOnce({ granted: false, canAskAgain: true } as never);
    const api = fakeApi();
    expect(await syncPushRegistration(api, journal)).toBe('off');
    expect(api.getNotificationSettings).not.toHaveBeenCalled();

    const off = fakeApi(false);
    expect(await syncPushRegistration(off, journal)).toBe('off');
    expect(off.registerPushToken).not.toHaveBeenCalled();
    expect(mocked.getExpoPushTokenAsync).not.toHaveBeenCalled();
  });

  it('unregisters the stored token at sign-out, and skips it when there is none', async () => {
    const api = fakeApi();
    await unregisterPush(api, memoryJournal());
    expect(api.unregisterPushToken).not.toHaveBeenCalled();
    await unregisterPush(api, memoryJournal({ [PUSH_TOKEN_KEY]: { token: TOKEN, at: 1 } }));
    expect(api.unregisterPushToken).toHaveBeenCalledWith(TOKEN);
  });
});

describe('push routes', () => {
  it('opens only the app’s own screens', () => {
    expect(pushRoute({ url: `/shared/${RUN}` })).toBe(`/shared/${RUN}`);
    expect(pushRoute({ url: `/runner/${RUN}` })).toBe(`/runner/${RUN}`);
    expect(pushRoute({ url: '/league' })).toBe('/league');
    expect(pushRoute({ url: '/profile/people' })).toBe('/profile/people');
    for (const url of ['https://example.test', '/shared/../profile/delete-account', '/profile/delete-account', `/shared/${RUN}?x=1`, 42, '']) {
      expect(pushRoute({ url })).toBeNull();
    }
    expect(pushRoute(null)).toBeNull();
    expect(pushRoute('string')).toBeNull();
  });
});

describe('feed helpers', () => {
  it('counts comments the way the server does', () => {
    const reply = { id: 'r', author: null, body: 'x', created_at_ms: 0, is_mine: false, can_delete: false, removed: false };
    const threads: Comment[] = [
      { ...reply, id: 'a', replies: [reply, reply] },
      { ...reply, id: 'b', removed: true, body: null, replies: [reply] },
    ];
    expect(countComments(threads)).toBe(4);
  });

  it('says how long ago', () => {
    const now = Date.parse('2026-10-02T12:00:00Z');
    expect(timeAgo(now - 20_000, now)).toBe('just now');
    expect(timeAgo(now - 5 * 60_000, now)).toBe('5 min');
    expect(timeAgo(now - 3 * 3_600_000, now)).toBe('3 h');
    expect(timeAgo(now - 2 * 86_400_000, now)).toBe('2 d');
    expect(timeAgo(Date.parse('2026-09-01T12:00:00Z'), now)).toBe('Sep 1');
  });
});
