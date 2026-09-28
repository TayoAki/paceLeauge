import { Navigator, navCueText, type NavSaved, type NavView } from '@/domain/navigation';
import type { RouteCue, RoutePoint } from '@/domain/routes';
import type { Units } from '@/domain/types';
import { Emitter } from '@/lib/emitter';

/**
 * The route a run follows (docs/ROADMAP.md 5.1 and 5.2). Chosen before the run, bound to it when it
 * starts, and moved along with every GPS fix by the navigator, which works without a connection.
 * Where the runner is along it is saved as they go, so a relaunch mid-run carries on without
 * repeating turns. What to say goes to the voice cues (features/voice/cue-controller), with the
 * run's other cues.
 */
export interface FollowedRoute {
  id: string;
  name: string;
  points: RoutePoint[];
  cues: RouteCue[];
  distanceM: number;
}

export interface RouteFix {
  lat: number;
  lon: number;
  accuracyM: number | null;
  at: number;
}

/** What the voice cues ask of the route. */
export interface RouteCues {
  runStarted(runId: string): void;
  /** The run's latest fix; returns what to say, if anything. */
  update(runId: string, fix: RouteFix | null, units: Units): string | null;
  runEnded(runId: string): void;
}

export interface RouteFollowSnapshot {
  route: FollowedRoute;
  /** Null while it waits for the run to start. */
  view: NavView | null;
}

interface Kv {
  getKv<T>(key: string): Promise<{ value: T } | null>;
  setKv(key: string, value: unknown): Promise<void>;
}

interface Stored {
  runId: string;
  route: FollowedRoute;
  saved: NavSaved;
}

export const ROUTE_FOLLOW_KEY = 'route:active';
/** Saved at least this often as the runner moves along, besides at every turn. */
const SAVE_EVERY_M = 100;

export class RouteController implements RouteCues {
  private pending: FollowedRoute | null = null;
  private active: { runId: string; route: FollowedRoute; nav: Navigator } | null = null;
  private lastFixAt = 0;
  private savedAtM = 0;
  private snapshot: RouteFollowSnapshot | null = null;
  private readonly changes = new Emitter<void>();

  constructor(private readonly kv: Kv) {}

  async restore(): Promise<void> {
    const stored = (await this.kv.getKv<Stored | null>(ROUTE_FOLLOW_KEY).catch(() => null))?.value;
    if (stored && typeof stored.runId === 'string' && Array.isArray(stored.route?.points) && stored.route.points.length >= 2) {
      this.active = { runId: stored.runId, route: stored.route, nav: new Navigator(stored.route, stored.saved) };
      this.savedAtM = stored.saved.progressM;
      this.emit();
    }
  }

  /** The route for the next run. */
  prepare(route: FollowedRoute): void {
    this.pending = route;
    this.emit();
  }

  /** The runner chose no route, or left the start screen without starting. */
  cancel(): void {
    if (!this.pending) return;
    this.pending = null;
    this.emit();
  }

  /** The route chosen for the next run, if any. */
  prepared(): FollowedRoute | null {
    return this.pending;
  }

  runStarted(runId: string): void {
    if (this.active?.runId === runId) return;
    if (!this.pending) {
      // A run without a route: the last run's route is done with.
      if (this.active) this.clear();
      return;
    }
    this.active = { runId, route: this.pending, nav: new Navigator(this.pending) };
    this.pending = null;
    this.savedAtM = 0;
    this.lastFixAt = 0;
    this.persist();
    this.emit();
  }

  update(runId: string, fix: RouteFix | null, units: Units): string | null {
    const active = this.active;
    if (!active || active.runId !== runId || !fix || fix.at <= this.lastFixAt) return null;
    this.lastFixAt = fix.at;
    const before = active.nav.view();
    const events = active.nav.update(fix);
    const after = active.nav.view();
    if (events.length > 0 || after.progressM - this.savedAtM >= SAVE_EVERY_M || after.joined !== before.joined) this.persist();
    // The screen shows distances to the nearest 10 m: publish when one of them changes.
    const tens = (m: number | null) => (m === null ? null : Math.round(m / 10));
    if (
      events.length > 0 ||
      Math.round(after.progressM) !== Math.round(before.progressM) ||
      after.offRoute !== before.offRoute ||
      after.joined !== before.joined ||
      tens(after.fromRouteM) !== tens(before.fromRouteM) ||
      tens(after.toStartM) !== tens(before.toStartM)
    ) {
      this.emit();
    }
    return events.length > 0 ? events.map((e) => navCueText(e, units)).join(' ') : null;
  }

  runEnded(runId: string): void {
    if (this.active?.runId !== runId) return;
    this.clear();
  }

  getSnapshot = (): RouteFollowSnapshot | null => this.snapshot;

  subscribe = (listener: () => void): (() => void) => this.changes.subscribe(listener);

  private clear(): void {
    this.active = null;
    void this.kv.setKv(ROUTE_FOLLOW_KEY, null).catch(() => undefined);
    this.emit();
  }

  private persist(): void {
    const active = this.active;
    if (!active) return;
    const saved = active.nav.saved();
    this.savedAtM = saved.progressM;
    const stored: Stored = { runId: active.runId, route: active.route, saved };
    void this.kv.setKv(ROUTE_FOLLOW_KEY, stored).catch(() => undefined);
  }

  private emit(): void {
    const active = this.active;
    this.snapshot = active ? { route: active.route, view: active.nav.view() } : this.pending ? { route: this.pending, view: null } : null;
    this.changes.emit();
  }
}
