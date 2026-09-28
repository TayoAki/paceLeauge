import { DEFAULT_CUE_SETTINGS, type CueField, type CueSettings } from '@/domain/cues';
import type { Units } from '@/domain/types';
import { Emitter } from '@/lib/emitter';

/**
 * Per-account run settings kept on this phone (docs/ROADMAP.md 1.1 and 1.3): voice cues and
 * auto-pause. The recorder and the cue controller read them synchronously at every sample, so a
 * change made mid-run applies straight away.
 */
export type CueVolume = 'quiet' | 'normal' | 'loud';

/** Numbers the run screen can show under the distance (docs/ROADMAP.md 1.2). */
export type RunScreenField = 'time' | 'currentPace' | 'averagePace' | 'lapPace' | 'lapTime';
export const RUN_SCREEN_FIELDS: RunScreenField[] = ['time', 'currentPace', 'averagePace', 'lapPace', 'lapTime'];
export const MAX_SCREEN_FIELDS = 3;

export interface RunSettings {
  autoPause: boolean;
  cues: CueSettings;
  cueVolume: CueVolume;
  /** When headphones disconnect mid-run, keep speaking through the phone speaker. */
  speakerFallback: boolean;
  /** Write finished runs to Apple Health (iOS; asks permission when switched on). */
  appleHealth: boolean;
  /** One to three numbers under the distance on the run screen, in this order. */
  screenFields: RunScreenField[];
}

export const DEFAULT_RUN_SETTINGS: RunSettings = {
  autoPause: true,
  cues: DEFAULT_CUE_SETTINGS,
  cueVolume: 'normal',
  speakerFallback: false,
  appleHealth: false,
  screenFields: ['time', 'currentPace', 'averagePace'],
};

/** The account journal key holding this account's run settings. */
export const RUN_SETTINGS_KEY = 'settings:run';

export const CUE_VOLUME: Record<CueVolume, number> = { quiet: 0.6, normal: 0.85, loud: 1 };

const FIELDS: CueField[] = ['time', 'distance', 'averagePace', 'currentPace', 'split', 'heartRate'];

function parseTrigger(value: unknown): CueSettings['trigger'] {
  const v = value as { kind?: unknown; every?: unknown; everyMinutes?: unknown } | null | undefined;
  if (v?.kind === 'distance' && (v.every === 0.5 || v.every === 1)) return { kind: 'distance', every: v.every };
  if (v?.kind === 'time' && (v.everyMinutes === 1 || v.everyMinutes === 5 || v.everyMinutes === 10)) return { kind: 'time', everyMinutes: v.everyMinutes };
  return DEFAULT_CUE_SETTINGS.trigger;
}

function parseScreenFields(value: unknown): RunScreenField[] {
  if (!Array.isArray(value)) return DEFAULT_RUN_SETTINGS.screenFields;
  const fields = [...new Set(value.filter((f): f is RunScreenField => RUN_SCREEN_FIELDS.includes(f as RunScreenField)))].slice(0, MAX_SCREEN_FIELDS);
  return fields.length > 0 ? fields : DEFAULT_RUN_SETTINGS.screenFields;
}

/** Reads a stored value field by field, so one bad field never resets the rest. */
export function parseRunSettings(value: unknown): RunSettings {
  const v = (value ?? {}) as Partial<Record<keyof RunSettings, unknown>>;
  const cues = (v.cues ?? {}) as Partial<Record<keyof CueSettings, unknown>>;
  const fields = (cues.fields ?? {}) as Partial<Record<CueField, unknown>>;
  return {
    autoPause: typeof v.autoPause === 'boolean' ? v.autoPause : DEFAULT_RUN_SETTINGS.autoPause,
    cues: {
      enabled: typeof cues.enabled === 'boolean' ? cues.enabled : DEFAULT_CUE_SETTINGS.enabled,
      trigger: parseTrigger(cues.trigger),
      mode: cues.mode === 'important' || cues.mode === 'full' ? cues.mode : DEFAULT_CUE_SETTINGS.mode,
      fields: Object.fromEntries(
        FIELDS.map((f) => [f, typeof fields[f] === 'boolean' ? fields[f] : DEFAULT_CUE_SETTINGS.fields[f]]),
      ) as Record<CueField, boolean>,
    },
    cueVolume: v.cueVolume === 'quiet' || v.cueVolume === 'normal' || v.cueVolume === 'loud' ? v.cueVolume : DEFAULT_RUN_SETTINGS.cueVolume,
    speakerFallback: typeof v.speakerFallback === 'boolean' ? v.speakerFallback : DEFAULT_RUN_SETTINGS.speakerFallback,
    appleHealth: typeof v.appleHealth === 'boolean' ? v.appleHealth : DEFAULT_RUN_SETTINGS.appleHealth,
    screenFields: parseScreenFields(v.screenFields),
  };
}

interface KvStore {
  getKv<T>(key: string): Promise<{ value: T } | null>;
  setKv(key: string, value: unknown): Promise<void>;
}

/** The profile copy cached by the `me` query; it carries the runner's units. */
const ME_CACHE_KEY = 'q:me';

export class RunSettingsStore {
  private settings: RunSettings = DEFAULT_RUN_SETTINGS;
  private unitsValue: Units = 'metric';
  readonly changes = new Emitter<RunSettings>();

  constructor(private readonly kv: KvStore) {}

  /** Loads the saved settings and the last known units; defaults when nothing is saved. */
  async load(): Promise<void> {
    const [saved, me] = await Promise.all([
      this.kv.getKv<unknown>(RUN_SETTINGS_KEY).catch(() => null),
      this.kv.getKv<{ profile?: { units?: unknown } | null }>(ME_CACHE_KEY).catch(() => null),
    ]);
    this.settings = parseRunSettings(saved?.value);
    const units = me?.value.profile?.units;
    if (units === 'metric' || units === 'imperial') this.unitsValue = units;
    this.changes.emit(this.settings);
  }

  get(): RunSettings {
    return this.settings;
  }

  get units(): Units {
    return this.unitsValue;
  }

  /** Follows the profile's units (they can change in Edit profile). */
  setUnits(units: Units): void {
    if (units === this.unitsValue) return;
    this.unitsValue = units;
    this.changes.emit(this.settings);
  }

  async save(next: RunSettings): Promise<void> {
    this.settings = next;
    this.changes.emit(next);
    await this.kv.setKv(RUN_SETTINGS_KEY, next);
  }

  subscribe = (listener: () => void): (() => void) => this.changes.subscribe(() => listener());
  getSnapshot = (): RunSettings => this.settings;
}
