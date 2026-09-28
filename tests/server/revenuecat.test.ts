import { randomUUID } from 'node:crypto';

import { trialReminder, type EntitlementState, type RevenueCatApi } from '../../server/src/revenuecat';
import { signIn, startTestApi, type TestApi } from './harness';

/**
 * Pro through RevenueCat (docs/ROADMAP.md 3.6): the webhook's authorization, each kind of store
 * event, events arriving twice or out of order, transfers, reading the subscriber's state instead
 * of trusting the event, and the reminder two days before a trial converts.
 */
const AUTH = 'Bearer rc-webhook-shared-secret-0123456789';
const RC_ENV = { REVENUECAT_WEBHOOK_AUTH: AUTH };

let api: TestApi;

beforeAll(async () => {
  api = await startTestApi(RC_ENV);
});

afterAll(async () => {
  await api.close();
});

const DAY = 86_400_000;

function event(type: string, user: string, fields: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    api_version: '1.0',
    event: {
      id: randomUUID(),
      type,
      app_user_id: user,
      original_app_user_id: user,
      aliases: [user],
      product_id: 'pl_pro_annual',
      entitlement_ids: ['pro'],
      period_type: 'NORMAL',
      purchased_at_ms: now,
      expiration_at_ms: now + 365 * DAY,
      event_timestamp_ms: now,
      environment: 'PRODUCTION',
      store: 'APP_STORE',
      ...fields,
    },
  };
}

async function post(body: unknown, target = api, authorization = AUTH): Promise<Response> {
  return fetch(`${target.url}/integrations/revenuecat/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization },
    body: JSON.stringify(body),
  });
}

async function runner(target = api) {
  const { client, session, email } = await signIn(target);
  const entitlements = async () => {
    const { data, error } = await client.rpc('get_entitlements');
    if (error) throw error;
    return data as { pro: boolean; period: string | null; will_renew: boolean; billing_issue: boolean; expires_at_ms: number | null; source: string | null };
  };
  return { id: session.user.id, email, entitlements };
}

describe('the RevenueCat webhook', () => {
  it('accepts only RevenueCat’s authorization, and ignores test events', async () => {
    const me = await runner();
    expect((await post(event('INITIAL_PURCHASE', me.id), api, 'Bearer wrong')).status).toBe(401);
    expect((await post(event('TEST', me.id))).status).toBe(200);
    expect(await me.entitlements()).toMatchObject({ pro: false, period: null });
  });

  it('follows a trial through purchase, cancellation, renewal and expiry', async () => {
    const me = await runner();
    const trialEnds = Date.now() + 7 * DAY;
    const purchase = event('INITIAL_PURCHASE', me.id, { period_type: 'TRIAL', expiration_at_ms: trialEnds });
    expect((await post(purchase)).status).toBe(200);
    expect(await me.entitlements()).toMatchObject({ pro: true, period: 'trial', will_renew: true, source: 'revenuecat', expires_at_ms: trialEnds });
    // RevenueCat retries until it hears 200: the same event twice changes nothing.
    expect((await post(purchase)).status).toBe(200);

    await post(event('CANCELLATION', me.id, { period_type: 'TRIAL', expiration_at_ms: trialEnds, cancel_reason: 'UNSUBSCRIBE', event_timestamp_ms: Date.now() + 1 }));
    // Cancelling keeps Pro to the end of what was paid for.
    expect(await me.entitlements()).toMatchObject({ pro: true, will_renew: false });

    await post(event('UNCANCELLATION', me.id, { period_type: 'TRIAL', expiration_at_ms: trialEnds, event_timestamp_ms: Date.now() + 2 }));
    await post(event('BILLING_ISSUE', me.id, { event_timestamp_ms: Date.now() + 3 }));
    expect(await me.entitlements()).toMatchObject({ pro: true, billing_issue: true });
    await post(event('EXPIRATION', me.id, { expiration_at_ms: Date.now() - 1000, event_timestamp_ms: Date.now() + 4 }));
    expect(await me.entitlements()).toMatchObject({ pro: false, will_renew: false });
  });

  it('ends Pro at once on a refund', async () => {
    const me = await runner();
    await post(event('INITIAL_PURCHASE', me.id));
    await post(event('CANCELLATION', me.id, { cancel_reason: 'CUSTOMER_SUPPORT', event_timestamp_ms: Date.now() + 1 }));
    expect((await me.entitlements()).pro).toBe(false);
  });

  it('never lets an older event undo a newer one', async () => {
    const me = await runner();
    const now = Date.now();
    await post(event('RENEWAL', me.id, { event_timestamp_ms: now }));
    await post(event('EXPIRATION', me.id, { expiration_at_ms: now - DAY, event_timestamp_ms: now - 60_000 }));
    expect((await me.entitlements()).pro).toBe(true);
  });

  it('moves Pro away from the old account on a transfer, and ignores strangers and other entitlements', async () => {
    const a = await runner();
    const b = await runner();
    await post(event('INITIAL_PURCHASE', a.id));
    await post({ event: { id: randomUUID(), type: 'TRANSFER', transferred_from: [a.id], transferred_to: [b.id], event_timestamp_ms: Date.now() + 1 } });
    expect((await a.entitlements()).pro).toBe(false);

    expect((await post(event('INITIAL_PURCHASE', 'not-a-user'))).status).toBe(200);
    expect((await post(event('INITIAL_PURCHASE', randomUUID()))).status).toBe(200);
    const c = await runner();
    await post(event('INITIAL_PURCHASE', c.id, { entitlement_ids: ['something_else'] }));
    expect((await c.entitlements()).pro).toBe(false);
  });
});

describe('reading the subscriber from RevenueCat', () => {
  it('stores the current state after any event, whatever the event says', async () => {
    const states = new Map<string, EntitlementState>();
    const fake: RevenueCatApi = { subscriberState: async (id) => states.get(id) ?? null };
    const withApi = await startTestApi(RC_ENV, { revenuecatApi: fake });
    try {
      const me = await runner(withApi);
      states.set(me.id, {
        active: true,
        expires_at: new Date(Date.now() + 30 * DAY).toISOString(),
        period_type: 'normal',
        product_id: 'pl_pro_monthly',
        store: 'app_store',
        environment: 'production',
        will_renew: true,
        billing_issue: false,
      });
      // Even an expiry event: the subscriber's state is what counts.
      await post(event('EXPIRATION', me.id), withApi);
      expect(await me.entitlements()).toMatchObject({ pro: true, period: 'normal', will_renew: true });
    } finally {
      await withApi.close();
    }
  });
});

describe('trial reminders', () => {
  it('emails once, two days before a real trial converts, with the way to cancel', async () => {
    const soon = await runner();
    const later = await runner();
    const sandbox = await runner();
    const hours = (h: number) => Date.now() + h * 3_600_000;
    await post(event('INITIAL_PURCHASE', soon.id, { period_type: 'TRIAL', expiration_at_ms: hours(30) }));
    await post(event('INITIAL_PURCHASE', later.id, { period_type: 'TRIAL', expiration_at_ms: hours(24 * 5) }));
    await post(event('INITIAL_PURCHASE', sandbox.id, { period_type: 'TRIAL', expiration_at_ms: hours(30), environment: 'SANDBOX' }));

    const before = api.mailer.notices.length;
    const result = await api.billing.runOnce();
    const sent = api.mailer.notices.slice(before);
    expect(result.reminders).toBe(1);
    expect(sent.map((n) => n.to)).toEqual([soon.email]);
    expect(sent[0]!.subject).toBe('Your PaceLeague Pro trial ends in 2 days');
    expect(sent[0]!.text).toContain('https://apps.apple.com/account/subscriptions');
    expect((await api.billing.runOnce()).reminders).toBe(0);
  });

  it('writes the date in the runner’s time zone, and Google Play’s way to cancel for Android', () => {
    const at = new Date('2026-10-12T03:00:00Z');
    expect(trialReminder(at, 'app_store', 'America/Chicago').text).toContain('October 11, 2026');
    expect(trialReminder(at, 'app_store', null).text).toContain('October 12, 2026');
    expect(trialReminder(at, 'play_store', 'Nowhere/Invalid').text).toContain('https://play.google.com/store/account/subscriptions');
  });
});
