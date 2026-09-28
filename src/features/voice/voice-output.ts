import { requireOptionalNativeModule } from 'expo';
import * as Speech from 'expo-speech';

/**
 * How cues reach the runner's ears. On a phone build this is the VoiceCue native module
 * (modules/voice-cue), which lowers the runner's music for the length of a cue and hands the
 * audio back afterwards. Without it (web previews, Expo Go) the standard speech engine speaks
 * instead, without ducking.
 */
export type SpeakOutcome = 'spoken' | 'replaced' | 'stopped' | 'unavailable' | 'no_headphones';

export interface SpeakOptions {
  /** 0–1, relative to the phone's media volume. */
  volume: number;
  /** Speak through the phone speaker after headphones disconnect. */
  allowSpeaker: boolean;
}

export interface VoiceOutput {
  /** Forgets the headphones seen on the previous run. */
  beginRun(): void;
  /** Speaks one cue, replacing any cue still speaking. Never rejects. */
  speak(text: string, options: SpeakOptions): Promise<SpeakOutcome>;
  stop(): Promise<void>;
}

interface VoiceCueNative {
  beginRun(): Promise<void>;
  speak(text: string, options: { volume: number; allowSpeaker: boolean; duck: boolean }): Promise<string>;
  stop(): Promise<void>;
}

const OUTCOMES: readonly SpeakOutcome[] = ['spoken', 'replaced', 'stopped', 'unavailable', 'no_headphones'];

function asOutcome(value: unknown): SpeakOutcome {
  return OUTCOMES.includes(value as SpeakOutcome) ? (value as SpeakOutcome) : 'unavailable';
}

export function nativeVoiceOutput(native: VoiceCueNative): VoiceOutput {
  return {
    beginRun: () => void native.beginRun().catch(() => undefined),
    speak: (text, options) =>
      native
        .speak(text, { volume: options.volume, allowSpeaker: options.allowSpeaker, duck: true })
        .then(asOutcome, () => 'unavailable' as const),
    stop: () => native.stop().catch(() => undefined),
  };
}

/** The standard speech engine; used where the native module isn't built in. */
export function speechVoiceOutput(): VoiceOutput {
  let settle: ((outcome: SpeakOutcome) => void) | null = null;
  const finish = (outcome: SpeakOutcome) => {
    const done = settle;
    settle = null;
    done?.(outcome);
  };
  return {
    beginRun: () => undefined,
    speak: (text, options) => {
      finish('replaced');
      void Speech.stop().catch(() => undefined);
      return new Promise<SpeakOutcome>((resolve) => {
        const mine = (outcome: SpeakOutcome) => resolve(outcome);
        settle = mine;
        const end = (outcome: SpeakOutcome) => () => {
          if (settle === mine) finish(outcome);
        };
        try {
          Speech.speak(text, { volume: options.volume, onDone: end('spoken'), onStopped: end('stopped'), onError: end('unavailable') });
        } catch {
          end('unavailable')();
        }
      });
    },
    stop: async () => {
      finish('stopped');
      await Speech.stop().catch(() => undefined);
    },
  };
}

let shared: VoiceOutput | null = null;

export function deviceVoiceOutput(): VoiceOutput {
  if (!shared) {
    const native = requireOptionalNativeModule<VoiceCueNative>('VoiceCue');
    shared = native ? nativeVoiceOutput(native) : speechVoiceOutput();
  }
  return shared;
}
