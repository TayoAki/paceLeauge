import { timingSafeEqual } from 'node:crypto';

import type { RevenueCatConfig } from './config';
import type { Pool } from './db';
import type { Logger } from './log';
import type { Mailer } from './mailer';

/**
 * Pro through RevenueCat (docs/ROADMAP.md 3.6). The App Store sells the subscription; RevenueCat
 * posts each purchase, renewal, cancellation, refund and expiry to our webhook, and we keep the
 * runner's entitlement in private.entitlements (db/migrations/…_pro.sql).
 *
 * With a secret API key the service reads the subscriber's current state after every event, which
 * is what RevenueCat recommends: it is right whatever order events arrive in. Without one, the
 * event itself is applied, ordered by its timestamp.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface EntitlementState {
  active: boolean;
  expires_at: string | null;
  period_type: 'trial' | 'intro' | 'normal' | 'promotional' | null;
  product_id: string | null;
  store: string | null;
  environment: 'sandbox' | 'production' | null;
  will_renew: boolean;
  billing_issue: boolean;
}

export interface RevenueCatApi {
  /** The subscriber's Pro state now; null when RevenueCat doesn't know them. */
  subscriberState(appUserId: string, now: number): Promise<EntitlementState | null>;
}

export class RevenueCatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RevenueCatError';
  }
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function period(v: unknown): EntitlementState['period_type'] {
  const p = typeof v === 'string' ? v.toLowerCase() : null;
  return p === 'trial' || p === 'intro' || p === 'normal' || p === 'promotional' ? p : null;
}

export function createRevenueCatApi(config: RevenueCatConfig, fetchImpl: typeof fetch = fetch): RevenueCatApi | null {
  const key = config.secretKey;
  if (!key) return null;
  return {
    async subscriberState(appUserId, now) {
      let response: Response;
      try {
        response = await fetchImpl(`https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(appUserId)}`, {
          headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
          signal: AbortSignal.timeout(10_000),
        });
      } catch (error) {
        throw new RevenueCatError(`subscriber request failed: ${error instanceof Error ? error.name : 'error'}`);
      }
      if (response.status === 404) return null;
      if (!response.ok) throw new RevenueCatError(`subscriber request rejected (HTTP ${response.status})`);
      const subscriber = obj(obj(await response.json())?.subscriber);
      const entitlement = obj(obj(subscriber?.entitlements)?.[config.entitlement]);
      if (!entitlement) {
        return { active: false, expires_at: null, period_type: null, product_id: null, store: null, environment: null, will_renew: false, billing_issue: false };
      }
      const productId = str(entitlement.product_identifier);
      const sub = productId ? obj(obj(subscriber?.subscriptions)?.[productId]) : null;
      const expires = str(entitlement.expires_date);
      const expiresMs = expires ? Date.parse(expires) : null;
      return {
        active: expiresMs === null || expiresMs > now,
        expires_at: expires,
        period_type: period(sub?.period_type) ?? (expires ? 'normal' : 'promotional'),
        product_id: productId,
        store: str(sub?.store),
        environment: sub ? (sub.is_sandbox === true ? 'sandbox' : 'production') : null,
        will_renew: !!sub && !sub.unsubscribe_detected_at && !!expires,
        billing_issue: !!sub?.billing_issues_detected_at,
      };
    },
  };
}

/** The state an event implies, when there is no API key to read the current one. */
export function stateFromEvent(event: Json, now: number): EntitlementState | null {
  const type = str(event.type);
  const expiresMs = num(event.expiration_at_ms);
  const base = {
    expires_at: expiresMs === null ? null : new Date(expiresMs).toISOString(),
    period_type: period(event.period_type),
    product_id: str(event.product_id),
    store: str(event.store)?.toLowerCase() ?? null,
    environment: str(event.environment)?.toLowerCase() === 'sandbox' ? ('sandbox' as const) : ('production' as const),
  };
  const current = expiresMs === null || expiresMs > now;
  switch (type) {
    case 'INITIAL_PURCHASE':
    case 'RENEWAL':
    case 'UNCANCELLATION':
    case 'PRODUCT_CHANGE':
    case 'SUBSCRIPTION_EXTENDED':
    case 'TEMPORARY_ENTITLEMENT_GRANT':
      return { ...base, active: current, will_renew: true, billing_issue: false };
    case 'NON_RENEWING_PURCHASE':
      return { ...base, active: current, will_renew: false, billing_issue: false };
    case 'CANCELLATION':
      // A refund ends Pro now; any other cancellation runs to the end of the paid period.
      return str(event.cancel_reason) === 'CUSTOMER_SUPPORT'
        ? { ...base, active: false, will_renew: false, billing_issue: false }
        : { ...base, active: current, will_renew: false, billing_issue: false };
    case 'BILLING_ISSUE':
      return { ...base, active: current, will_renew: true, billing_issue: true };
    case 'EXPIRATION':
      return { ...base, active: false, will_renew: false, billing_issue: false };
    default:
      return null;
  }
}

export function webhookAuthorized(config: RevenueCatConfig, header: string | undefined): boolean {
  const a = Buffer.from(header ?? '');
  const b = Buffer.from(config.webhookAuth);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Applies one webhook delivery. Returns false for deliveries that change nothing (a repeat, a test,
 * another entitlement, someone who isn't a PaceLeague account).
 */
export async function handleRevenueCatEvent(
  deps: { pool: Pool; log: Logger; config: RevenueCatConfig; api: RevenueCatApi | null; now?: () => number },
  body: unknown,
): Promise<boolean> {
  const now = deps.now ?? Date.now;
  const event = obj(obj(body)?.event);
  const id = str(event?.id);
  const type = str(event?.type);
  if (!event || !id || !type || type === 'TEST') return false;
  const entitlements = Array.isArray(event.entitlement_ids) ? event.entitlement_ids : null;
  if (entitlements && entitlements.length > 0 && !entitlements.includes(deps.config.entitlement)) return false;

  const ids = (list: unknown) => (Array.isArray(list) ? list.filter((v): v is string => typeof v === 'string' && UUID.test(v)) : []);
  const users =
    type === 'TRANSFER'
      ? { gaining: ids(event.transferred_to), losing: ids(event.transferred_from) }
      : { gaining: ids([event.app_user_id, event.original_app_user_id, ...(Array.isArray(event.aliases) ? event.aliases : [])]).slice(0, 1), losing: [] };
  const everyone = [...new Set([...users.gaining, ...users.losing])];
  const { rows } = await deps.pool.query<{ seen: boolean }>('select private.billing_event_seen($1, $2, $3) as seen', [
    id.slice(0, 100),
    everyone[0] ?? null,
    type,
  ]);
  if (rows[0]?.seen || everyone.length === 0) return false;

  const eventAt = num(event.event_timestamp_ms) ?? now();
  for (const user of everyone) {
    let state: EntitlementState | null;
    let at = eventAt;
    if (deps.api) {
      state = await deps.api.subscriberState(user, now());
      at = now();
    } else if (type === 'TRANSFER') {
      // Without the API, a transfer can only take Pro away; the new owner's own event grants it.
      state = users.losing.includes(user) ? { active: false, expires_at: null, period_type: null, product_id: null, store: null, environment: null, will_renew: false, billing_issue: false } : null;
    } else {
      state = stateFromEvent(event, now());
    }
    if (!state) continue;
    await deps.pool.query('select private.apply_entitlement($1, $2, to_timestamp($3::double precision / 1000))', [user, state, at]);
  }
  deps.log.info('revenuecat event', { type, users: everyone.length, source: deps.api ? 'api' : 'event' });
  return true;
}

// ---------------------------------------------------------------------------------------------
// Trial reminders (decision 4): two days before a trial turns into a paid year, with a cancel link.

const CANCEL_LINKS: Record<string, string> = {
  app_store: 'https://apps.apple.com/account/subscriptions',
  mac_app_store: 'https://apps.apple.com/account/subscriptions',
  play_store: 'https://play.google.com/store/account/subscriptions',
};

export function trialReminder(expiresAt: Date, store: string | null, timeZone: string | null): { subject: string; text: string } {
  let date: string;
  try {
    date = new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: timeZone ?? 'UTC' }).format(expiresAt);
  } catch {
    date = new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'UTC' }).format(expiresAt);
  }
  const link = CANCEL_LINKS[store ?? 'app_store'] ?? CANCEL_LINKS.app_store!;
  const where =
    store === 'play_store'
      ? 'open Google Play, tap your profile, then Payments & subscriptions, then Subscriptions'
      : 'open Settings on your iPhone, tap your name, then Subscriptions';
  return {
    subject: 'Your PaceLeague Pro trial ends in 2 days',
    text:
      `Your free trial of PaceLeague Pro ends on ${date}. After that, the subscription you chose starts and the store charges you for it.\n\n` +
      `To cancel before then, ${where}, or go to ${link}\n\n` +
      'If you want to keep Pro, there is nothing to do. Everything in the free app stays free either way.',
  };
}

export interface BillingWorker {
  runOnce(): Promise<{ reminders: number; failed: number; events_purged: number }>;
}

export function createBillingWorker(deps: { pool: Pool; mailer: Mailer; log: Logger }): BillingWorker {
  return {
    async runOnce() {
      const { rows } = await deps.pool.query<{ user_id: string; email: string; expires_at: Date; store: string | null; time_zone: string | null }>(
        'select * from private.trial_reminders_due()',
      );
      let reminders = 0;
      let failed = 0;
      for (const row of rows) {
        try {
          await deps.mailer.sendNotice({ to: row.email, ...trialReminder(new Date(row.expires_at), row.store, row.time_zone) });
          await deps.pool.query('select private.mark_trial_reminded($1)', [row.user_id]);
          reminders++;
        } catch (error) {
          failed++;
          deps.log.warn('trial reminder failed', { error: error instanceof Error ? error.message : String(error) });
        }
      }
      const { rows: purged } = await deps.pool.query<{ n: number }>('select private.purge_billing_events() as n');
      return { reminders, failed, events_purged: purged[0]?.n ?? 0 };
    },
  };
}
