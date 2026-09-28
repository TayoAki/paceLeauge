import { randomUUID } from 'node:crypto';

import { loadConfig } from '../../server/src/config';
import { createExpoPushApi, type ExpoMessage, type ExpoPushApi, type ExpoReceipt, type ExpoTicket } from '../../server/src/push';
import type { TestUser } from '../backend/helpers/db';
import { startTestApi, type TestApi } from './harness';

/**
 * Push notifications through Expo's push service (docs/ROADMAP.md 4.9): the API service drains
 * the outbox the database fills, records tickets, and forgets devices whose app is gone.
 */
class FakeExpo implements ExpoPushApi {
  sent: ExpoMessage[] = [];
  gone = new Set<string>();
  failNext = false;
  receiptErrors = new Map<string, string>();
  private tickets = new Map<string, string>();

  async send(messages: ExpoMessage[]): Promise<ExpoTicket[]> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('Expo push /push/send failed with HTTP 503');
    }
    this.sent.push(...messages);
    return messages.map((m) => {
      if (this.gone.has(m.to)) return { status: 'error', message: 'not registered', details: { error: 'DeviceNotRegistered' } };
      const id = randomUUID();
      this.tickets.set(id, m.to);
      return { status: 'ok', id };
    });
  }

  async receipts(ids: string[]): Promise<Record<string, ExpoReceipt>> {
    const out: Record<string, ExpoReceipt> = {};
    for (const id of ids) {
      const token = this.tickets.get(id);
      if (!token) continue;
      const error = this.receiptErrors.get(token);
      out[id] = error ? { status: 'error', details: { error } } : { status: 'ok' };
    }
    return out;
  }
}

let api: TestApi;
const expo = new FakeExpo();

beforeAll(async () => {
  api = await startTestApi({ PUSH_ENABLED: 'true' }, { pushApi: expo });
});

afterAll(async () => {
  await api.close();
});

function zoneAtNoon(): string {
  const offset = ((12 - new Date().getUTCHours() + 36) % 24) - 12;
  return offset === 0 ? 'Etc/GMT' : offset > 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`;
}

async function device(user: TestUser, platform: 'ios' | 'android'): Promise<string> {
  const token = `ExponentPushToken[${randomUUID().replace(/-/g, '').slice(0, 22)}]`;
  await api.db.rpc(user, 'register_push_token', { p_token: token, p_platform: platform });
  await api.db.sql('update public.profiles set notification_tz = $2 where user_id = $1', [user.id, zoneAtNoon()]);
  return token;
}

const publicId = async (user: TestUser) => (await api.db.rpc(user, 'get_social_settings')).public_id as string;

describe('push worker', () => {
  it('sends to every device, records tickets and forgets uninstalled apps', async () => {
    const star = await api.db.createRunner('Push Star');
    const fan = await api.db.createRunner('Push Fan');
    expect((await api.db.rpc(star, 'get_notification_settings')).available).toBe(true);
    const phone = await device(star, 'ios');
    const tablet = await device(star, 'android');
    const old = await device(star, 'ios');
    expo.gone.add(old);

    await api.db.rpc(fan, 'follow_runner', { p_public_id: await publicId(star) });
    const result = await api.push!.runOnce();
    expect(result).toMatchObject({ sent: 1, failed: 0, devices_removed: 1 });
    const toStar = expo.sent.filter((m) => [phone, tablet, old].includes(m.to));
    expect(toStar).toHaveLength(3);
    expect(toStar.find((m) => m.to === phone)).toEqual({
      to: phone,
      title: 'Follow request',
      body: 'Push Fan wants to follow you.',
      data: { url: '/profile/people', kind: 'follows' },
      sound: 'default',
      priority: 'default',
    });
    expect(toStar.find((m) => m.to === tablet)!.channelId).toBe('activity');
    expect((await api.db.rpc(star, 'get_notification_settings')).devices).toBe(2);
    const [row] = await api.db.sql<{ sent_at: Date | null; attempts: number }>('select sent_at, attempts from private.push_outbox where user_id = $1', [star.id]);
    expect(row!.sent_at).not.toBeNull();
    expect(row!.attempts).toBe(1);

    // Nothing is sent twice.
    expo.sent = [];
    expect((await api.push!.runOnce()).sent).toBe(0);
    expect(expo.sent).toEqual([]);

    // A receipt that says the app is gone, checked once Expo has had time to hear back.
    expo.receiptErrors.set(tablet, 'DeviceNotRegistered');
    await api.db.sql(`update private.push_receipts set created_at = now() - interval '20 minutes' where token = any($1)`, [[phone, tablet]]);
    expect(await api.push!.runOnce()).toMatchObject({ receipts_checked: 2, devices_removed: 1 });
    expect((await api.db.rpc(star, 'get_notification_settings')).devices).toBe(1);
    expect(await api.db.sql('select * from private.push_receipts where token = any($1)', [[phone, tablet]])).toEqual([]);
  });

  it('retries later when Expo is down, and gives up after five tries', async () => {
    const quiet = await api.db.createRunner('Push Retry');
    const fan = await api.db.createRunner('Push Retry Fan');
    const phone = await device(quiet, 'ios');
    await api.db.rpc(fan, 'follow_runner', { p_public_id: await publicId(quiet) });

    expo.failNext = true;
    expect(await api.push!.runOnce()).toMatchObject({ failed: 1, sent: 0 });
    const [waiting] = await api.db.sql<{ attempts: number; send_after: Date; last_error: string; sent_at: Date | null }>(
      'select attempts, send_after, last_error, sent_at from private.push_outbox where user_id = $1',
      [quiet.id],
    );
    expect(waiting).toMatchObject({ attempts: 1, sent_at: null, last_error: 'Expo push /push/send failed with HTTP 503' });
    expect(waiting!.send_after.getTime()).toBeGreaterThan(Date.now());

    await api.db.sql(`update private.push_outbox set send_after = now() where user_id = $1`, [quiet.id]);
    expo.sent = [];
    expect((await api.push!.runOnce()).sent).toBe(1);
    expect(expo.sent.map((m) => m.to)).toEqual([phone]);

    // Five failed tries and it's dropped.
    await api.db.rpc(fan, 'unfollow', { p_public_id: await publicId(quiet) });
    const other = await api.db.createRunner('Push Retry Two');
    await api.db.rpc(other, 'follow_runner', { p_public_id: await publicId(quiet) });
    await api.db.sql(`update private.push_outbox set attempts = 5, send_after = now() where user_id = $1 and sent_at is null`, [quiet.id]);
    expect((await api.push!.runOnce()).sent).toBe(0);
    const dropped = await api.db.sql<{ dropped_at: Date | null }>('select dropped_at from private.push_outbox where user_id = $1 and sent_at is null', [quiet.id]);
    expect(dropped.every((d) => d.dropped_at !== null)).toBe(true);
  });
});

describe('Expo push API client', () => {
  it('posts messages to Expo with the access token when there is one', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      const body = JSON.parse(String(init!.body));
      const data = String(url).endsWith('/push/send') ? body.map(() => ({ status: 'ok', id: 'ticket' })) : { ticket: { status: 'ok' } };
      return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const client = createExpoPushApi({ apiUrl: 'https://exp.host/--/api/v2', accessToken: 'expo-token' }, fakeFetch);
    const message: ExpoMessage = { to: 'ExponentPushToken[abc]', title: 'Kudos', body: 'Hi', data: { url: '/league', kind: 'cheers' }, sound: 'default', priority: 'default' };
    expect(await client.send([message])).toEqual([{ status: 'ok', id: 'ticket' }]);
    expect(await client.receipts(['ticket'])).toEqual({ ticket: { status: 'ok' } });
    expect(calls.map((c) => c.url)).toEqual(['https://exp.host/--/api/v2/push/send', 'https://exp.host/--/api/v2/push/getReceipts']);
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer expo-token');

    const failing = createExpoPushApi({ apiUrl: 'https://exp.host/--/api/v2', accessToken: null }, (async () =>
      new Response(JSON.stringify({ errors: [{ code: 'PUSH_TOO_MANY_EXPERIENCE_IDS' }] }), { status: 400 })) as typeof fetch);
    await expect(failing.send([message])).rejects.toThrow(/HTTP 400/);
  });

  it('is off unless PUSH_ENABLED is true, and sends only over https', () => {
    const base = { APP_ENV: 'test', DATABASE_URL: 'postgres://localhost/x' };
    expect(loadConfig(base).push).toBeNull();
    expect(() => loadConfig({ ...base, EXPO_ACCESS_TOKEN: 'x' })).toThrow(/PUSH_ENABLED/);
    expect(loadConfig({ ...base, PUSH_ENABLED: 'true' }).push).toEqual({ apiUrl: 'https://exp.host/--/api/v2', accessToken: null });
    expect(loadConfig({ ...base, PUSH_ENABLED: 'true', EXPO_PUSH_URL: 'http://127.0.0.1:9000/' }).push!.apiUrl).toBe('http://127.0.0.1:9000');
    expect(() => loadConfig({ ...base, APP_ENV: 'staging', PUBLIC_API_KEY: 'k'.repeat(20), EMAIL_PROVIDER: 'log', PUSH_ENABLED: 'true', EXPO_PUSH_URL: 'http://127.0.0.1:9000' })).toThrow(
      /https/,
    );
  });
});
