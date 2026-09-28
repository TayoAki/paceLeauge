import type { PushConfig } from './config';
import type { Pool } from './db';
import type { Logger } from './log';

/**
 * Remote notifications (docs/ROADMAP.md 4.9) through Expo's push service, which hands them to
 * Apple and Google. The database decides who gets what (private.notify: the runner's switches,
 * quiet hours, blocks, merged kudos); this worker only drains the outbox it fills, records what
 * Expo said, and forgets devices whose app was uninstalled.
 */
export interface ExpoMessage {
  to: string;
  title: string;
  body: string;
  /** Where a tap takes the runner, checked against the app's routes before it's opened. */
  data: { url: string; kind: string };
  sound: 'default';
  priority: 'default';
  /** Android's channel for these pushes (the app creates it). */
  channelId?: string;
}

export type ExpoTicket = { status: 'ok'; id: string } | { status: 'error'; message?: string; details?: { error?: string } };
export type ExpoReceipt = { status: 'ok' } | { status: 'error'; message?: string; details?: { error?: string } };

export interface ExpoPushApi {
  /** At most 100 messages; the tickets come back in the same order. */
  send(messages: ExpoMessage[]): Promise<ExpoTicket[]>;
  /** At most 1000 ticket ids; tickets without a receipt yet are missing from the answer. */
  receipts(ids: string[]): Promise<Record<string, ExpoReceipt>>;
}

export const ANDROID_CHANNEL = 'activity';
const SEND_BATCH = 100;

export function createExpoPushApi(config: PushConfig, fetchImpl: typeof fetch = fetch): ExpoPushApi {
  const headers: Record<string, string> = { accept: 'application/json', 'content-type': 'application/json' };
  if (config.accessToken) headers.authorization = `Bearer ${config.accessToken}`;
  const post = async (path: string, body: unknown): Promise<{ data?: unknown }> => {
    const res = await fetchImpl(`${config.apiUrl}${path}`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    const json = (await res.json().catch(() => null)) as { data?: unknown } | null;
    if (!res.ok || json === null || typeof json !== 'object') throw new Error(`Expo push ${path} failed with HTTP ${res.status}`);
    return json;
  };
  return {
    async send(messages) {
      const { data } = await post('/push/send', messages);
      if (!Array.isArray(data) || data.length !== messages.length) throw new Error('Expo push returned an unexpected answer');
      return data as ExpoTicket[];
    },
    async receipts(ids) {
      const { data } = await post('/push/getReceipts', { ids });
      return data !== null && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, ExpoReceipt>) : {};
    },
  };
}

/** Tells the app whether this server sends pushes, so it only offers them when it does. */
export async function publishPushSettings(pool: Pool, config: PushConfig | null): Promise<void> {
  await pool.query('select private.set_push_integration($1)', [config !== null]);
}

export interface PushRunResult {
  sent: number;
  failed: number;
  devices_removed: number;
  receipts_checked: number;
}

export interface PushWorker {
  runOnce(): Promise<PushRunResult>;
}

interface Claimed {
  outbox_id: string;
  token: string;
  platform: 'ios' | 'android';
  title: string;
  body: string;
  url: string;
  kind: string;
}

const errorCode = (result: { message?: string; details?: { error?: string } } | undefined): string =>
  result?.details?.error ?? result?.message?.slice(0, 80) ?? 'unknown';

export function createPushWorker(deps: { pool: Pool; api: ExpoPushApi; log: Logger }): PushWorker {
  const { pool, api, log } = deps;
  return {
    async runOnce() {
      const result: PushRunResult = { sent: 0, failed: 0, devices_removed: 0, receipts_checked: 0 };
      const gone = new Set<string>();

      const { rows } = await pool.query<Claimed>('select * from private.claim_push_batch(200)');
      const outcomes = new Map<string, { tickets: { id: string; token: string }[]; errors: string[] }>();
      for (const row of rows) if (!outcomes.has(row.outbox_id)) outcomes.set(row.outbox_id, { tickets: [], errors: [] });
      for (let i = 0; i < rows.length; i += SEND_BATCH) {
        const batch = rows.slice(i, i + SEND_BATCH);
        const messages: ExpoMessage[] = batch.map((row) => ({
          to: row.token,
          title: row.title,
          body: row.body,
          data: { url: row.url, kind: row.kind },
          sound: 'default',
          priority: 'default',
          ...(row.platform === 'android' ? { channelId: ANDROID_CHANNEL } : {}),
        }));
        let tickets: ExpoTicket[];
        try {
          tickets = await api.send(messages);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log.warn('push send failed', { error: message, messages: batch.length });
          for (const row of batch) outcomes.get(row.outbox_id)!.errors.push(message);
          continue;
        }
        batch.forEach((row, j) => {
          const ticket = tickets[j];
          const outcome = outcomes.get(row.outbox_id)!;
          if (ticket?.status === 'ok') {
            outcome.tickets.push({ id: ticket.id, token: row.token });
          } else {
            const code = errorCode(ticket);
            outcome.errors.push(code);
            if (code === 'DeviceNotRegistered') gone.add(row.token);
          }
        });
      }
      for (const [outboxId, outcome] of outcomes) {
        if (outcome.tickets.length > 0) {
          await pool.query('select private.push_delivered($1, $2)', [outboxId, JSON.stringify(outcome.tickets)]);
          result.sent++;
        } else {
          await pool.query('select private.push_failed($1, $2)', [outboxId, [...new Set(outcome.errors)].join(', ')]);
          result.failed++;
        }
      }

      // Receipts: Apple and Google tell Expo later when an app is no longer installed.
      const { rows: due } = await pool.query<{ ticket_id: string; token: string }>('select * from private.push_receipts_due(1000)');
      if (due.length > 0) {
        try {
          const receipts = await api.receipts(due.map((d) => d.ticket_id));
          const checked: string[] = [];
          for (const d of due) {
            const receipt = receipts[d.ticket_id];
            if (!receipt) continue;
            checked.push(d.ticket_id);
            if (receipt.status === 'error') {
              const code = errorCode(receipt);
              if (code === 'DeviceNotRegistered') gone.add(d.token);
              // Credentials or sender problems are the operator's to fix (docs/OPERATIONS.md).
              else log.warn('push receipt error', { error: code });
            }
          }
          if (checked.length > 0) await pool.query('select private.push_receipts_checked($1)', [checked]);
          result.receipts_checked = checked.length;
        } catch (error) {
          log.warn('push receipts failed', { error: error instanceof Error ? error.message : String(error) });
        }
      }

      for (const token of gone) await pool.query('select private.push_token_gone($1)', [token]);
      result.devices_removed = gone.size;
      return result;
    },
  };
}
