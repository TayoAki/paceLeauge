import { haversineM, type LatLon } from './geo';
import { bearingDeg, cumulativeM, localXY, toLatLon, turnAngle, type RouteCue, type RoutePoint } from './routes';
import type { Units } from './types';

/**
 * Following a planned route (docs/ROADMAP.md 5.1 and 5.2): where the runner is along it, the
 * next turn, and what to say. It needs nothing but the route and the phone's GPS, so it works in
 * airplane mode.
 *
 *  - Each fix is matched to the route near where the runner last was, so a route that runs along
 *    the same street twice (out and back, or a loop's shared start and finish) is followed in
 *    order, with the runner's direction deciding between the two ways.
 *  - A turn is announced once, about 60 m before it; two turns close together are announced
 *    together ("turn left, then right").
 *  - More than 45 m from the route for 8 seconds is off the route, said with which way the route
 *    is, and again every minute; rejoining anywhere is noticed, and so is running it backwards.
 *  - GPS error is allowed for: fixes worse than 50 m are ignored, and the distances grow a
 *    little with each fix's own error.
 */
export interface NavRoute {
  points: RoutePoint[];
  cues: RouteCue[];
}

export interface NavFix {
  lat: number;
  lon: number;
  accuracyM: number | null;
  at: number;
}

export const NAV = {
  onRouteM: 25,
  offRouteM: 45,
  offRouteMs: 8_000,
  /** How far along the route from the last place a fix may match. */
  lookAheadM: 400,
  lookBackM: 40,
  /** How far along a fix may move the runner: this, plus a fast runner's speed since the last fix. */
  reachM: 25,
  maxSpeedMs: 7,
  turnCueM: 60,
  turnNowM: 20,
  thenM: 50,
  /** Turns closer than this to the one before are part of the same move. */
  sameMoveM: 12,
  offReminderMs: 60_000,
  offRemindersMax: 5,
  wrongWayMs: 10_000,
  finishM: 30,
  ignoreAccuracyM: 50,
  /** Movement needed to know which way the runner is heading. */
  headingMinM: 15,
} as const;

export type NavSide = 'left' | 'right' | 'ahead' | 'behind';

export type NavEvent =
  | { kind: 'turn'; cue: RouteCue; inM: number; then: RouteCue | null }
  | { kind: 'off_route'; distanceM: number; side: NavSide | null }
  | { kind: 'back_on_route' }
  | { kind: 'wrong_way' }
  | { kind: 'finished' };

/** What the run screen shows. */
export interface NavView {
  /** On the route yet (runners often start a little way from it). */
  joined: boolean;
  /** Before joining: how far the route's start is. */
  toStartM: number | null;
  progressM: number;
  remainingM: number;
  totalM: number;
  offRoute: boolean;
  /** How far the runner is from the route, when known. */
  fromRouteM: number | null;
  nextTurn: { cue: RouteCue; inM: number } | null;
  finished: boolean;
}

/** What is kept across a relaunch mid-run. */
export interface NavSaved {
  joined: boolean;
  progressM: number;
  nextCue: number;
  announced: number;
  finished: boolean;
  offRoute: boolean;
}

interface Match {
  segment: number;
  distanceM: number;
  alongM: number;
  bearing: number;
}

export class Navigator {
  readonly totalM: number;
  private readonly cum: number[];
  private readonly cueAt: number[];
  private joined = false;
  private progressM = 0;
  private nextCue = 0;
  private announced = 0;
  private finished = false;
  private offRoute = false;
  private farSince: number | null = null;
  private offReminders = 0;
  private lastOffSaidAt = 0;
  /** A jump along the route (a shortcut, or back to redo a stretch) needs two fixes to agree. */
  private pendingJump: Match | null = null;
  private wrongSince: number | null = null;
  private wrongSaid = false;
  private heading: number | null = null;
  private lastFix: NavFix | null = null;
  private readonly recent: NavFix[] = [];
  private fromRouteM: number | null = null;
  private toStartM: number | null = null;

  constructor(
    private readonly route: NavRoute,
    saved?: NavSaved | null,
  ) {
    this.cum = cumulativeM(route.points);
    this.totalM = this.cum[this.cum.length - 1] ?? 0;
    this.cueAt = route.cues.map((c) => this.cum[Math.min(c.i, this.cum.length - 1)] ?? 0);
    if (saved) {
      this.joined = saved.joined;
      this.progressM = Math.max(0, Math.min(this.totalM, saved.progressM));
      this.nextCue = saved.nextCue;
      this.announced = saved.announced;
      this.finished = saved.finished;
      this.offRoute = saved.offRoute;
    }
  }

  saved(): NavSaved {
    return { joined: this.joined, progressM: this.progressM, nextCue: this.nextCue, announced: this.announced, finished: this.finished, offRoute: this.offRoute };
  }

  view(): NavView {
    const cue = this.route.cues[this.nextCue];
    return {
      joined: this.joined,
      toStartM: this.joined ? null : this.toStartM,
      progressM: this.progressM,
      remainingM: Math.max(0, this.totalM - this.progressM),
      totalM: this.totalM,
      offRoute: this.offRoute,
      fromRouteM: this.fromRouteM,
      nextTurn: cue && this.joined && !this.finished ? { cue, inM: Math.max(0, this.cueAt[this.nextCue]! - this.progressM) } : null,
      finished: this.finished,
    };
  }

  /** A new GPS fix; returns what to say, in order. */
  update(fix: NavFix): NavEvent[] {
    if (this.route.points.length < 2 || this.finished) return [];
    if (fix.accuracyM !== null && fix.accuracyM > NAV.ignoreAccuracyM) return [];
    if (this.lastFix && fix.at <= this.lastFix.at) return [];
    this.updateHeading(fix);
    const error = Math.min(fix.accuracyM ?? 10, 25);
    const onM = NAV.onRouteM + error * 0.4;
    const offM = NAV.offRouteM + error * 0.6;
    const events: NavEvent[] = [];

    this.toStartM = haversineM(fix, toLatLon(this.route.points[0]!));
    const everywhere = this.matches(fix, 0, this.totalM);
    const nearest = everywhere.reduce<Match | null>((b, m) => (!b || m.distanceM < b.distanceM ? m : b), null);
    const anywhere = this.best(everywhere.filter((m) => m.distanceM <= onM));
    if (!this.joined) {
      this.fromRouteM = nearest?.distanceM ?? null;
      if (!anywhere) {
        this.lastFix = fix;
        return events;
      }
      this.joined = true;
      this.moveTo(anywhere.alongM);
    }

    // No further along than the runner could have got since the last fix: where a route passes
    // the same spot twice (a spur, a figure of eight), the later pass waits its turn.
    const sinceS = this.lastFix ? (fix.at - this.lastFix.at) / 1000 : Infinity;
    const reachM = Math.min(NAV.lookAheadM, NAV.reachM + NAV.maxSpeedMs * sinceS);
    const window = everywhere.filter((m) => m.alongM >= this.progressM - NAV.lookBackM && m.alongM <= this.progressM + reachM);
    const here = this.best(window.filter((m) => m.distanceM <= onM));
    const windowNearestM = window.reduce((d, m) => Math.min(d, m.distanceM), Infinity);
    const backwards = (m: Match) => this.heading !== null && Math.abs(turnAngle(m.bearing, this.heading)) > 135;
    // Clear of where the runner was, rather than a little GPS drift beside it.
    const leftWindow = windowNearestM > offM;
    if (here && !this.offRoute) {
      this.fromRouteM = here.distanceM;
      this.farSince = null;
      this.pendingJump = null;
      this.progressM = Math.max(this.progressM, here.alongM);
      events.push(...this.checkWrongWay(fix, here));
    } else if (anywhere && backwards(anywhere) && leftWindow && !this.offRoute) {
      // On the route, but further back along it and heading the wrong way.
      this.fromRouteM = anywhere.distanceM;
      this.farSince = null;
      events.push(...this.checkWrongWay(fix, anywhere));
    } else if (anywhere && (leftWindow || this.offRoute)) {
      // Back on it somewhere else (a shortcut, or back to redo a stretch), once two fixes agree.
      this.fromRouteM = anywhere.distanceM;
      if (this.pendingJump && Math.abs(this.pendingJump.alongM - anywhere.alongM) < 60) {
        this.pendingJump = null;
        this.farSince = null;
        this.moveTo(anywhere.alongM);
        if (this.offRoute) {
          this.offRoute = false;
          this.offReminders = 0;
          events.push({ kind: 'back_on_route' });
        }
      } else {
        this.pendingJump = anywhere;
      }
    } else {
      this.fromRouteM = Math.min(windowNearestM, nearest?.distanceM ?? Infinity);
      if (!Number.isFinite(this.fromRouteM)) this.fromRouteM = null;
      this.pendingJump = null;
      if (leftWindow || this.offRoute) {
        this.farSince ??= fix.at;
        const due = this.offRoute
          ? fix.at - this.lastOffSaidAt >= NAV.offReminderMs && this.offReminders < NAV.offRemindersMax
          : fix.at - this.farSince >= NAV.offRouteMs;
        if (due && nearest) {
          this.offRoute = true;
          this.offReminders += 1;
          this.lastOffSaidAt = fix.at;
          events.push({ kind: 'off_route', distanceM: nearest.distanceM, side: this.sideOf(fix, nearest) });
        }
      }
    }

    if (!this.offRoute) events.push(...this.turnsDue());
    if (!this.offRoute && this.totalM - this.progressM <= NAV.finishM) {
      this.finished = true;
      events.push({ kind: 'finished' });
    }
    this.lastFix = fix;
    return events;
  }

  /**
   * Moves to a place along the route. Forward, the turns passed are done; back more than a few
   * metres, the turns ahead are said again as the runner reaches them.
   */
  private moveTo(alongM: number): void {
    let k = 0;
    while (k < this.cueAt.length && this.cueAt[k]! < alongM + NAV.turnNowM / 2) k++;
    if (alongM < this.progressM - NAV.lookBackM) {
      this.progressM = alongM;
      this.nextCue = k;
      this.announced = k;
    } else {
      this.progressM = Math.max(this.progressM, alongM);
      this.nextCue = Math.max(this.nextCue, k);
      this.announced = Math.max(this.announced, this.nextCue);
    }
  }

  private turnsDue(): NavEvent[] {
    while (this.nextCue < this.cueAt.length && this.cueAt[this.nextCue]! <= this.progressM) this.nextCue++;
    this.announced = Math.max(this.announced, this.nextCue);
    const k = this.nextCue;
    const cue = this.route.cues[k];
    if (!cue || this.announced > k) return [];
    const inM = this.cueAt[k]! - this.progressM;
    if (inM > NAV.turnCueM) return [];
    const following = this.route.cues[k + 1];
    const then = following && this.cueAt[k + 1]! - this.cueAt[k]! <= NAV.thenM ? following : null;
    this.announced = k + (then ? 2 : 1);
    // Turns a few metres after those just said are part of the same move (a junction's kinks):
    // they aren't said on their own.
    while (this.announced < this.cueAt.length && this.cueAt[this.announced]! - this.cueAt[this.announced - 1]! < NAV.sameMoveM) this.announced++;
    return [{ kind: 'turn', cue, inM: Math.max(0, inM), then }];
  }

  private checkWrongWay(fix: NavFix, match: Match): NavEvent[] {
    const backwards = this.heading !== null && Math.abs(turnAngle(match.bearing, this.heading)) > 135;
    if (!backwards) {
      this.wrongSince = null;
      this.wrongSaid = false;
      return [];
    }
    this.wrongSince ??= fix.at;
    if (this.wrongSaid || fix.at - this.wrongSince < NAV.wrongWayMs) return [];
    this.wrongSaid = true;
    return [{ kind: 'wrong_way' }];
  }

  /** Which way the runner is going: from the latest recent fix far enough back, within 20 seconds. */
  private updateHeading(fix: NavFix): void {
    for (let k = this.recent.length - 1; k >= 0; k--) {
      const earlier = this.recent[k]!;
      if (fix.at - earlier.at > 20_000) break;
      if (haversineM(earlier, fix) >= NAV.headingMinM) {
        this.heading = bearingDeg(earlier, fix);
        break;
      }
    }
    this.recent.push(fix);
    if (this.recent.length > 8) this.recent.shift();
  }

  private sideOf(fix: NavFix, match: Match): NavSide | null {
    if (this.heading === null) return null;
    const p = this.pointAt(match);
    const angle = turnAngle(this.heading, bearingDeg(fix, p));
    if (Math.abs(angle) <= 45) return 'ahead';
    if (Math.abs(angle) >= 135) return 'behind';
    return angle < 0 ? 'left' : 'right';
  }

  private pointAt(match: Match): LatLon {
    const a = toLatLon(this.route.points[match.segment]!);
    const b = toLatLon(this.route.points[match.segment + 1]!);
    const len = this.cum[match.segment + 1]! - this.cum[match.segment]!;
    const t = len > 0 ? (match.alongM - this.cum[match.segment]!) / len : 0;
    return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
  }

  /** Every segment overlapping [fromM, toM] along the route, with the fix's distance from it. */
  private matches(fix: LatLon, fromM: number, toM: number): Match[] {
    const out: Match[] = [];
    const points = this.route.points;
    for (let k = 0; k < points.length - 1; k++) {
      if (this.cum[k + 1]! < fromM) continue;
      if (this.cum[k]! > toM) break;
      const a = toLatLon(points[k]!);
      const b = toLatLon(points[k + 1]!);
      const bx = localXY(a, b);
      const px = localXY(a, fix);
      const len2 = bx.x * bx.x + bx.y * bx.y;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (px.x * bx.x + px.y * bx.y) / len2));
      const distanceM = Math.hypot(px.x - bx.x * t, px.y - bx.y * t);
      out.push({ segment: k, distanceM, alongM: this.cum[k]! + (this.cum[k + 1]! - this.cum[k]!) * t, bearing: bearingDeg(a, b) });
    }
    return out;
  }

  private nearest(fix: LatLon): Match | null {
    let best: Match | null = null;
    for (const m of this.matches(fix, 0, this.totalM)) if (!best || m.distanceM < best.distanceM) best = m;
    return best;
  }

  /**
   * The likeliest place among candidates: going the runner's way first, then the closest; among
   * the closest few metres, the one furthest back along the route (a loop's start, not its
   * finish).
   */
  private best(candidates: Match[]): Match | null {
    if (candidates.length === 0) return null;
    const heading = this.heading;
    const withHeading = heading === null ? candidates : candidates.filter((m) => Math.abs(turnAngle(m.bearing, heading)) <= 90);
    const pool = withHeading.length > 0 ? withHeading : candidates;
    const closest = Math.min(...pool.map((m) => m.distanceM));
    const near = pool.filter((m) => m.distanceM <= closest + 10);
    near.sort((a, b) => Math.abs(a.alongM - this.progressM) - Math.abs(b.alongM - this.progressM) || a.distanceM - b.distanceM);
    return near[0]!;
  }
}

// ---------------------------------------------------------------------------------------
// What the voice says
// ---------------------------------------------------------------------------------------

const TURN_WORDS: Record<RouteCue['turn'], string> = {
  left: 'turn left',
  right: 'turn right',
  slight_left: 'bear left',
  slight_right: 'bear right',
  sharp_left: 'turn sharp left',
  sharp_right: 'turn sharp right',
  keep_left: 'keep left',
  keep_right: 'keep right',
  u_turn: 'make a U-turn',
  roundabout: 'at the roundabout',
};

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth'];

function turnPhrase(cue: RouteCue): string {
  if (cue.turn === 'roundabout') {
    const exit = cue.exit ? ORDINALS[cue.exit - 1] : null;
    return exit ? `at the roundabout, take the ${exit} exit` : 'at the roundabout, take your exit';
  }
  const words = TURN_WORDS[cue.turn];
  return cue.street ? `${words} onto ${cue.street}` : words;
}

/** A short distance as spoken: "60 meters", "200 feet", "a quarter mile". */
export function spokenShortDistance(m: number, units: Units): string {
  if (units === 'imperial') {
    const feet = m * 3.28084;
    if (feet < 1000) return `${Math.max(50, Math.round(feet / 50) * 50)} feet`;
    const miles = m / 1609.344;
    return `${miles.toFixed(1)} miles`;
  }
  if (m < 1000) return `${Math.max(10, Math.round(m / 10) * 10)} meters`;
  return `${(m / 1000).toFixed(1)} kilometers`;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function navCueText(event: NavEvent, units: Units): string {
  switch (event.kind) {
    case 'turn': {
      const then = event.then ? `, then ${turnPhrase(event.then)}` : '';
      if (event.inM <= NAV.turnNowM) return `${capitalize(turnPhrase(event.cue))} now${then}.`;
      return `In ${spokenShortDistance(event.inM, units)}, ${turnPhrase(event.cue)}${then}.`;
    }
    case 'off_route': {
      const where = event.side === 'ahead' ? ' ahead of you' : event.side === 'behind' ? ' behind you' : event.side ? ` to your ${event.side}` : '';
      return `You're off the route. It's about ${spokenShortDistance(event.distanceM, units)}${where}.`;
    }
    case 'back_on_route':
      return 'Back on the route.';
    case 'wrong_way':
      return "You're going the wrong way on the route. Turn around.";
    case 'finished':
      return "You've reached the end of the route.";
  }
}

/** A turn as the run screen shows it: "Left onto Elm Street". */
export function turnLabel(cue: RouteCue): string {
  return capitalize(turnPhrase(cue).replace(/^turn /, ''));
}
