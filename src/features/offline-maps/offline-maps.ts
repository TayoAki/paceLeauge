import { Emitter } from '@/lib/emitter';

import { mapbox, MAPBOX_ENABLED, type MapboxModule } from './mapbox';
import { mapboxBounds, packName, type MapArea } from './regions';

/**
 * Map areas kept on the phone for routes (docs/ROADMAP.md 5.2), as Mapbox offline packs: one per
 * route, named after it, downloaded when the runner asks and kept until they delete it or sign
 * out. The route itself is kept on the phone when opened (features/routes), so following it needs
 * no signal; this adds the map beneath it. Mapbox keeps packs for the whole phone, so each is
 * marked with its account and only that account sees it. Off in builds without Mapbox.
 */
export interface OfflineArea {
  routeId: string;
  /** The route's name when the area was downloaded. */
  name: string;
  state: 'downloading' | 'complete' | 'stopped';
  percentage: number;
  bytes: number;
  createdAtMs: number;
}

/** What the store needs from Mapbox (a fake in tests). */
export interface OfflinePackPort {
  list(): Promise<{ name: string; metadata: Record<string, unknown>; percentage: number; bytes: number; complete: boolean }[]>;
  create(
    input: { name: string; bounds: [[number, number], [number, number]]; minZoom: number; maxZoom: number; metadata: Record<string, unknown> },
    onProgress: (status: { percentage: number; bytes: number; complete: boolean }) => void,
    onError: (message: string) => void,
  ): Promise<void>;
  remove(name: string): Promise<void>;
}

export function mapboxPackPort(lib: MapboxModule): OfflinePackPort {
  const complete = (state: unknown) => state === lib.OfflinePackDownloadState.Complete;
  return {
    list: async () => {
      const packs = await lib.offlineManager.getPacks();
      return Promise.all(
        packs.map(async (p) => {
          const status = await p.status().catch(() => null);
          const metadata = typeof p.metadata === 'string' ? (JSON.parse(p.metadata) as Record<string, unknown>) : ((p.metadata ?? {}) as Record<string, unknown>);
          return {
            name: String(p.name),
            metadata,
            percentage: status?.percentage ?? 0,
            bytes: status?.completedResourceSize ?? 0,
            complete: complete(status?.state),
          };
        }),
      );
    },
    create: (input, onProgress, onError) =>
      lib.offlineManager.createPack(
        { name: input.name, styleURL: String(lib.StyleURL.Outdoors), bounds: input.bounds, minZoom: input.minZoom, maxZoom: input.maxZoom, metadata: input.metadata },
        (_pack, status) => onProgress({ percentage: status.percentage, bytes: status.completedResourceSize, complete: complete(status.state) }),
        (_pack, error) => onError(error.message),
      ),
    remove: (name) => lib.offlineManager.deletePack(name),
  };
}

export class OfflineMaps {
  private areas = new Map<string, OfflineArea>();
  private loaded = false;
  private readonly changes = new Emitter<void>();
  private snapshot: OfflineArea[] = [];

  private accountId: string | null = null;

  constructor(private readonly port: OfflinePackPort | null) {}

  /** The signed-in account, whose areas these are. */
  setAccount(accountId: string | null): void {
    if (accountId === this.accountId) return;
    this.accountId = accountId;
    this.areas = new Map();
    this.loaded = false;
    this.emit();
    if (accountId) void this.refresh().catch(() => undefined);
  }

  get available(): boolean {
    return this.port !== null;
  }

  getSnapshot = (): OfflineArea[] => this.snapshot;

  subscribe = (listener: () => void): (() => void) => this.changes.subscribe(listener);

  area(routeId: string): OfflineArea | null {
    return this.areas.get(routeId) ?? null;
  }

  async refresh(): Promise<void> {
    if (!this.port || !this.accountId) return;
    const packs = await this.port.list();
    const next = new Map<string, OfflineArea>();
    for (const p of packs) {
      const routeId = typeof p.metadata.routeId === 'string' ? p.metadata.routeId : null;
      if (!routeId || p.name !== packName(routeId) || p.metadata.accountId !== this.accountId) continue;
      const current = this.areas.get(routeId);
      next.set(routeId, {
        routeId,
        name: typeof p.metadata.name === 'string' ? p.metadata.name : 'Route',
        state: p.complete ? 'complete' : current?.state === 'downloading' ? 'downloading' : 'stopped',
        percentage: p.percentage,
        bytes: p.bytes,
        createdAtMs: typeof p.metadata.createdAtMs === 'number' ? p.metadata.createdAtMs : 0,
      });
    }
    this.areas = next;
    this.loaded = true;
    this.emit();
  }

  /** Downloads the map area for a route, replacing an older one. Resolves when it's under way. */
  async download(routeId: string, name: string, area: MapArea, now = Date.now()): Promise<void> {
    const accountId = this.accountId;
    if (!this.port || !accountId) throw new Error('offline maps unavailable');
    if (!this.loaded) await this.refresh();
    if (this.areas.has(routeId)) await this.remove(routeId);
    const createdAtMs = now;
    this.areas.set(routeId, { routeId, name, state: 'downloading', percentage: 0, bytes: 0, createdAtMs });
    this.emit();
    await this.port.create(
      { name: packName(routeId), bounds: mapboxBounds(area.bounds), minZoom: area.minZoom, maxZoom: area.maxZoom, metadata: { accountId, routeId, name, createdAtMs } },
      (status) => {
        const current = this.areas.get(routeId);
        if (!current) return;
        this.areas.set(routeId, { ...current, percentage: status.percentage, bytes: status.bytes, state: status.complete ? 'complete' : 'downloading' });
        this.emit();
      },
      () => {
        const current = this.areas.get(routeId);
        if (!current) return;
        this.areas.set(routeId, { ...current, state: 'stopped' });
        this.emit();
      },
    );
  }

  async remove(routeId: string): Promise<void> {
    if (!this.port) return;
    await this.port.remove(packName(routeId)).catch(() => undefined);
    this.areas.delete(routeId);
    this.emit();
  }

  /** Signing out: the account's areas leave the phone. */
  async removeAll(): Promise<void> {
    if (!this.port || !this.accountId) return;
    if (!this.loaded) await this.refresh();
    for (const routeId of [...this.areas.keys()]) await this.remove(routeId);
  }

  private emit(): void {
    this.snapshot = [...this.areas.values()].sort((a, b) => b.createdAtMs - a.createdAtMs);
    this.changes.emit();
  }
}

let shared: OfflineMaps | null = null;

/** The phone's offline map areas (shared by every account on it, as Mapbox keeps them). */
export function offlineMaps(): OfflineMaps {
  if (shared) return shared;
  const lib = MAPBOX_ENABLED ? mapbox() : null;
  shared = new OfflineMaps(lib ? mapboxPackPort(lib) : null);
  return shared;
}
