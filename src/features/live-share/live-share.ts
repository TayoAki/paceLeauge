import type { LiveApi } from '@/api/live-api';
import type { RecorderEvent } from '@/features/recording/recorder-service';
import type { RecorderSnapshot } from '@/features/recording/types';
import { Emitter } from '@/lib/emitter';

/**
 * Live location for the run in progress (docs/ROADMAP.md 4.8). While a link is open, the latest
 * fix goes to the server about every 30 seconds; the link stops when the run ends (finished,
 * discarded, or replaced by another run), when the runner stops sharing, or when its time runs
 * out. The link is kept on the phone so a relaunch mid-run carries on, and a stop that couldn't
 * reach the server is sent again with the next fix or connection.
 */
export const LIVE_SHARE_KEY = 'live-share';
export const LIVE_POST_INTERVAL_MS = 30_000;
export const LIVE_DURATIONS_MIN = [60, 120, 180, 360] as const;

export interface LiveShareState {
  shareId: string;
  token: string;
  expiresAtMs: number;
  /** The run this link is for. */
  runId: string;
  /** Stopped on the phone; the server hasn't been told yet. */
  ending?: 'run_ended' | 'stopped';
}

interface Kv {
  getKv<T>(key: string): Promise<{ value: T } | null>;
  setKv(key: string, value: unknown): Promise<void>;
  deleteKv(key: string): Promise<void>;
}

interface RecorderLike {
  getSnapshot(): RecorderSnapshot;
  subscribe(listener: () => void): () => void;
  subscribeEvents(listener: (event: RecorderEvent) => void): () => void;
}

export type LiveTransport = Pick<LiveApi, 'startLiveShare' | 'postLiveLocation' | 'endLiveShare'>;

export class NoRunToShareError extends Error {
  constructor() {
    super('Start a run to share your live location.');
    this.name = 'NoRunToShareError';
  }
}

export class LiveShareController {
  private state: LiveShareState | null = null;
  private transport: LiveTransport | null = null;
  private lastPostAt = 0;
  private posting = false;
  private endingNow = false;
  private offs: (() => void)[] = [];
  private readonly changes = new Emitter<void>();

  constructor(private readonly deps: { kv: Kv; recorder: RecorderLike; now?: () => number; intervalMs?: number }) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** The open link, if any (null once stopped, even before the server has heard). */
  getSnapshot = (): LiveShareState | null => (this.state && !this.state.ending ? this.state : null);

  subscribe = (listener: () => void): (() => void) => this.changes.subscribe(listener);

  async restore(): Promise<void> {
    const saved = await this.deps.kv.getKv<LiveShareState>(LIVE_SHARE_KEY).catch(() => null);
    this.state = saved?.value ?? null;
    if (this.state && !this.state.ending && this.state.expiresAtMs <= this.now()) await this.clear();
    this.changes.emit();
  }

  start(): void {
    this.offs.push(this.deps.recorder.subscribe(() => void this.tick()));
    this.offs.push(
      this.deps.recorder.subscribeEvents((event) => {
        if (event.name === 'run_saved_local') void this.stop('run_ended');
      }),
    );
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs = [];
  }

  /** The API while signed in and connected; null otherwise. */
  setTransport(transport: LiveTransport | null): void {
    this.transport = transport;
    void this.tick();
  }

  /** Opens a link for the run in progress, replacing any other. */
  async share(minutes: number): Promise<LiveShareState> {
    const runId = this.deps.recorder.getSnapshot().session?.runId;
    if (!runId) throw new NoRunToShareError();
    if (!this.transport) throw new Error('offline');
    const link = await this.transport.startLiveShare(minutes);
    this.state = { shareId: link.share_id, token: link.token, expiresAtMs: link.expires_at_ms, runId };
    await this.deps.kv.setKv(LIVE_SHARE_KEY, this.state);
    this.lastPostAt = 0;
    this.changes.emit();
    void this.tick();
    return this.state;
  }

  async stop(reason: 'run_ended' | 'stopped' = 'stopped'): Promise<void> {
    if (!this.state) return;
    if (!this.state.ending) {
      this.state = { ...this.state, ending: reason };
      await this.deps.kv.setKv(LIVE_SHARE_KEY, this.state).catch(() => undefined);
      this.changes.emit();
    }
    await this.sendEnd();
  }

  private async sendEnd(): Promise<void> {
    const state = this.state;
    if (!state?.ending || !this.transport || this.endingNow) return;
    this.endingNow = true;
    try {
      await this.transport.endLiveShare(state.shareId, state.ending);
      if (this.state?.shareId === state.shareId) await this.clear();
    } catch {
      // Offline: sent again with the next fix or connection. The link also runs out on its own.
    } finally {
      this.endingNow = false;
    }
  }

  private async clear(): Promise<void> {
    this.state = null;
    await this.deps.kv.deleteKv(LIVE_SHARE_KEY).catch(() => undefined);
    this.changes.emit();
  }

  /** On each recorder update: stop a link whose run is over, and post a fix every 30 seconds. */
  private async tick(): Promise<void> {
    const state = this.state;
    if (!state) return;
    if (state.ending) return this.sendEnd();
    if (state.expiresAtMs <= this.now()) return this.clear();
    const snapshot = this.deps.recorder.getSnapshot();
    if (!snapshot.session || snapshot.session.runId !== state.runId) return this.stop('run_ended');
    const position = snapshot.lastPosition;
    if (!position || !this.transport || this.posting) return;
    if (this.now() - this.lastPostAt < (this.deps.intervalMs ?? LIVE_POST_INTERVAL_MS)) return;
    this.posting = true;
    this.lastPostAt = this.now();
    try {
      const result = await this.transport.postLiveLocation(state.shareId, {
        lat: position.lat,
        lon: position.lon,
        accuracyM: position.accuracyM,
        atMs: position.at,
        distanceM: snapshot.metrics.distanceM,
        elapsedMs: snapshot.metrics.activeMs,
      });
      // Stopped or run out on the server (another phone started a link, or time was up).
      if (!result.live && this.state?.shareId === state.shareId) await this.clear();
    } catch {
      // Offline or too frequent: the next fix tries again.
    } finally {
      this.posting = false;
    }
  }
}

/** The link to send: the web app when it's configured, the app's own link otherwise. */
export function liveLink(webUrl: string, token: string): string {
  return webUrl ? `${webUrl.replace(/\/$/, '')}/live/${token}` : `paceleague://live/${token}`;
}

/** Links that open a position in the viewer's maps app. */
export function mapLinks(lat: number, lon: number): { apple: string; google: string } {
  const at = `${lat.toFixed(5)},${lon.toFixed(5)}`;
  return { apple: `https://maps.apple.com/?ll=${at}&q=${encodeURIComponent('Runner')}`, google: `https://www.google.com/maps/search/?api=1&query=${at}` };
}

/** "12 seconds ago", "3 minutes ago". */
export function seenAgo(atMs: number, nowMs: number): string {
  const s = Math.max(0, Math.round((nowMs - atMs) / 1000));
  if (s < 60) return s <= 5 ? 'just now' : `${s} seconds ago`;
  const m = Math.round(s / 60);
  return m === 1 ? '1 minute ago' : `${m} minutes ago`;
}
