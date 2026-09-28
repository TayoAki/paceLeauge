import { METRES_PER_MILE } from './format';
import type { Units } from './types';

/**
 * Voice cues (docs/ROADMAP.md 1.1, Part C). The scheduler decides *when* to speak and *what*; the
 * audio layer (features/voice) decides how, lowering the runner's music for the length of the cue.
 * Cues are short, never overlap, and a cue that would arrive late (for example after a GPS
 * catch-up crosses two splits at once) is replaced by the newest one rather than played late.
 */
export type CueField = 'time' | 'distance' | 'averagePace' | 'currentPace' | 'split' | 'heartRate';

export interface CueSettings {
  enabled: boolean;
  /** Distance cues every `every` km or mile, or time cues every `everyMinutes`. */
  trigger: { kind: 'distance'; every: 0.5 | 1 } | { kind: 'time'; everyMinutes: 1 | 5 | 10 };
  /** "important" speaks only full splits and status changes, with the fewest words. */
  mode: 'full' | 'important';
  fields: Record<CueField, boolean>;
}

export const DEFAULT_CUE_SETTINGS: CueSettings = {
  enabled: true,
  trigger: { kind: 'distance', every: 1 },
  mode: 'full',
  fields: { time: true, distance: true, averagePace: true, currentPace: false, split: true, heartRate: false },
};

export interface CueMetrics {
  distanceM: number;
  activeMs: number;
  currentPaceSPerKm: number | null;
  heartRateBpm?: number | null;
}

export type Cue =
  | {
      kind: 'progress';
      /** 1 for the first full unit (or interval), 2 for the second… */
      index: number;
      distanceM: number;
      activeMs: number;
      /** Active time for the last full unit; null for time cues and half-unit cues. */
      splitMs: number | null;
      currentPaceSPerKm: number | null;
      heartRateBpm: number | null;
    }
  | { kind: 'started' }
  | { kind: 'paused'; auto: boolean }
  | { kind: 'resumed'; auto: boolean }
  | { kind: 'finished'; distanceM: number; activeMs: number };

function unitMetres(units: Units): number {
  return units === 'imperial' ? METRES_PER_MILE : 1000;
}

export class CueScheduler {
  private last: { distanceM: number; activeMs: number } = { distanceM: 0, activeMs: 0 };
  private nextBoundary: number;
  private step: number;
  private count = 0;
  /** Active time at the last full-unit boundary (for split times). */
  private lastUnitActiveMs = 0;
  private lastUnitIndex = 0;

  constructor(
    private readonly settings: CueSettings,
    private readonly units: Units,
  ) {
    this.step =
      settings.trigger.kind === 'distance'
        ? unitMetres(units) * (settings.mode === 'important' ? 1 : settings.trigger.every)
        : settings.trigger.everyMinutes * 60_000;
    this.nextBoundary = this.step;
  }

  /** Feed the latest metrics; returns a progress cue when a boundary was crossed. */
  update(m: CueMetrics): Cue | null {
    if (!this.settings.enabled) return null;
    const distanceMode = this.settings.trigger.kind === 'distance' || this.settings.mode === 'important';
    const value = distanceMode ? m.distanceM : m.activeMs;
    const previous = distanceMode ? this.last.distanceM : this.last.activeMs;
    let cue: Cue | null = null;
    if (value >= this.nextBoundary && value > previous) {
      // Skip to the newest boundary: several at once means a catch-up, and only the latest matters.
      const crossed = Math.floor(value / this.step);
      const boundary = crossed * this.step;
      const fraction = (boundary - previous) / (value - previous);
      const atActiveMs = distanceMode ? this.last.activeMs + fraction * (m.activeMs - this.last.activeMs) : boundary;
      const atDistanceM = distanceMode ? boundary : this.last.distanceM + fraction * (m.distanceM - this.last.distanceM);
      this.count = crossed;
      this.nextBoundary = boundary + this.step;

      let splitMs: number | null = null;
      if (distanceMode) {
        const unitIndex = Math.floor(atDistanceM / unitMetres(this.units) + 1e-6);
        if (unitIndex > this.lastUnitIndex) {
          splitMs = unitIndex === this.lastUnitIndex + 1 ? Math.round(atActiveMs - this.lastUnitActiveMs) : null;
          this.lastUnitIndex = unitIndex;
          this.lastUnitActiveMs = atActiveMs;
        }
      }
      cue = {
        kind: 'progress',
        index: this.count,
        distanceM: atDistanceM,
        activeMs: Math.round(atActiveMs),
        splitMs,
        currentPaceSPerKm: m.currentPaceSPerKm,
        heartRateBpm: m.heartRateBpm ?? null,
      };
    }
    this.last = { distanceM: m.distanceM, activeMs: m.activeMs };
    return cue;
  }
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** "5 minutes 2 seconds", "1 hour 4 minutes": short enough to speak between strides. */
export function spokenDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return m > 0 ? `${plural(h, 'hour')} ${plural(m, 'minute')}` : plural(h, 'hour');
  if (m > 0) return s > 0 ? `${plural(m, 'minute')} ${plural(s, 'second')}` : plural(m, 'minute');
  return plural(s, 'second');
}

/** "3 kilometers", "2.5 miles". */
export function spokenDistance(metres: number, units: Units): string {
  const value = Math.floor((metres / unitMetres(units)) * 100 + 1e-6) / 100;
  const text = Number.isInteger(value) ? String(value) : value.toFixed(value * 10 === Math.round(value * 10) ? 1 : 2);
  const word = units === 'imperial' ? 'mile' : 'kilometer';
  return `${text} ${word}${value === 1 ? '' : 's'}`;
}

/** Pace for one unit, e.g. "5 minutes 2 seconds per kilometer"; null when unknown or implausibly slow. */
export function spokenPace(secondsPerKm: number | null, units: Units): string | null {
  if (secondsPerKm === null || !Number.isFinite(secondsPerKm) || secondsPerKm <= 0) return null;
  const perUnit = units === 'imperial' ? secondsPerKm * (METRES_PER_MILE / 1000) : secondsPerKm;
  if (perUnit >= 60 * 60) return null;
  return `${spokenDuration(perUnit * 1000)} per ${units === 'imperial' ? 'mile' : 'kilometer'}`;
}

/** The words for a cue. Sentences stay short; fields the runner switched off are left out. */
export function cueText(cue: Cue, settings: CueSettings, units: Units): string {
  switch (cue.kind) {
    case 'started':
      return 'Run started.';
    case 'paused':
      return cue.auto ? 'Auto-paused.' : 'Paused.';
    case 'resumed':
      return cue.auto ? 'Resumed.' : 'Resumed.';
    case 'finished':
      return `Run finished. ${spokenDistance(cue.distanceM, units)} in ${spokenDuration(cue.activeMs)}.`;
    case 'progress': {
      const f = settings.fields;
      const parts: string[] = [];
      const average = cue.distanceM >= 10 && cue.activeMs > 0 ? cue.activeMs / cue.distanceM : null;
      if (settings.mode === 'important') {
        parts.push(spokenDistance(cue.distanceM, units));
        const split = cue.splitMs !== null ? spokenDuration(cue.splitMs) : null;
        if (split) parts.push(`Split ${split}`);
        return `${parts.join('. ')}.`;
      }
      if (f.distance) parts.push(spokenDistance(cue.distanceM, units));
      if (f.time) parts.push(`Time ${spokenDuration(cue.activeMs)}`);
      if (f.split && cue.splitMs !== null) parts.push(`Split ${spokenDuration(cue.splitMs)}`);
      const avg = f.averagePace ? spokenPace(average, units) : null;
      if (avg) parts.push(`Average pace ${avg}`);
      const current = f.currentPace ? spokenPace(cue.currentPaceSPerKm, units) : null;
      if (current) parts.push(`Current pace ${current}`);
      if (f.heartRate && cue.heartRateBpm) parts.push(`Heart rate ${Math.round(cue.heartRateBpm)}`);
      return parts.length > 0 ? `${parts.join('. ')}.` : '';
    }
  }
}
