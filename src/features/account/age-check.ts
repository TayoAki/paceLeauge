import * as AgeRange from 'expo-age-range';
import { Platform } from 'react-native';

/**
 * Age assurance (docs/ROADMAP.md Phase 0, decision 3). PaceLeague is for adults, and Texas and
 * other states require apps to use the app store's age signal. The store answer is recorded with
 * the profile; outside regulated regions the runner's own adult declaration stands.
 */
export type AgeSignal = 'adult' | 'not_required' | 'minor';

export type AgeCheck =
  /** Continue: the store says 18+, or age rules don't apply / the store has no answer outside a regulated region. */
  | { outcome: 'allowed'; signal: 'adult' | 'not_required'; source: string }
  /** The store says the runner is under 18. */
  | { outcome: 'minor'; source: string }
  /** A regulated region, but no usable answer: the runner has to share (or verify) their age first. */
  | { outcome: 'needs_age'; reason: 'declined' | 'unavailable' | 'verification_required' };

export type AgeCheckMode =
  /** Creating a profile: ask whenever the platform can answer, unless it says rules don't apply. */
  | 'sign_up'
  /** An existing profile: ask only where the platform confirms age rules apply, so nobody else sees a prompt. */
  | 'existing';

export interface AgeRangeAnswer {
  lowerBound: number | null;
  upperBound: number | null;
  source: string | null;
}

/** The platform calls, injectable for tests. */
export interface AgePort {
  platform: 'ios' | 'android' | 'web';
  /** iOS major version (26 for "26.2"); null elsewhere. */
  iosMajor: number | null;
  /** true: regulation applies; false: it doesn't; null: unknown. */
  isEligible(): Promise<boolean | null>;
  /** Android only: whether Play will share age signals. */
  signalsAccess(): Promise<'SHARED' | 'NOT_SHARED' | 'VERIFICATION_REQUIRED' | null>;
  requestRange(): Promise<AgeRangeAnswer>;
}

export const ADULT_AGE = 18;

/** Store sources are enum-like tokens; anything else is dropped rather than sent to the server. */
function sourceToken(value: string | null | undefined, fallback: string): string {
  return value && /^[A-Za-z0-9_]{1,32}$/.test(value) ? value : fallback;
}

/** What a store answer means for an adults-only app. Null when the answer is empty. */
export function classifyRange(answer: AgeRangeAnswer): 'adult' | 'minor' | null {
  if (answer.lowerBound !== null && answer.lowerBound >= ADULT_AGE) return 'adult';
  if (answer.upperBound !== null && answer.upperBound < ADULT_AGE) return 'minor';
  if (answer.lowerBound !== null && answer.upperBound !== null && answer.upperBound < ADULT_AGE) return 'minor';
  return null;
}

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : '';
}

async function safeEligible(port: AgePort): Promise<boolean | null> {
  try {
    return await port.isEligible();
  } catch {
    return null;
  }
}

export async function checkAge(port: AgePort, mode: AgeCheckMode): Promise<AgeCheck> {
  const notRequired = (source: string): AgeCheck => ({ outcome: 'allowed', signal: 'not_required', source });
  if (port.platform === 'web') return notRequired('web');

  if (port.platform === 'android') {
    let access: Awaited<ReturnType<AgePort['signalsAccess']>> = null;
    try {
      access = await port.signalsAccess();
    } catch {
      return notRequired('unavailable');
    }
    if (access === 'VERIFICATION_REQUIRED') return { outcome: 'needs_age', reason: 'verification_required' };
    if (access !== 'SHARED') return notRequired(access === 'NOT_SHARED' ? 'not_shared' : 'unavailable');
    try {
      const answer = await port.requestRange();
      const kind = classifyRange(answer);
      if (kind === 'adult') return { outcome: 'allowed', signal: 'adult', source: sourceToken(answer.source, 'play') };
      if (kind === 'minor') return { outcome: 'minor', source: sourceToken(answer.source, 'play') };
      return notRequired('unavailable');
    } catch {
      return notRequired('unavailable');
    }
  }

  // iOS: the Declared Age Range framework needs iOS 26; earlier versions return a placeholder adult.
  if (port.iosMajor === null || port.iosMajor < 26) return notRequired('os_unsupported');
  const eligible = await safeEligible(port);
  if (eligible === false) return notRequired('not_regulated');
  if (mode === 'existing' && eligible !== true) return notRequired('not_confirmed');

  try {
    const answer = await port.requestRange();
    const kind = classifyRange(answer);
    if (kind === 'adult') return { outcome: 'allowed', signal: 'adult', source: sourceToken(answer.source, 'declared') };
    if (kind === 'minor') return { outcome: 'minor', source: sourceToken(answer.source, 'declared') };
    return eligible === true ? { outcome: 'needs_age', reason: 'unavailable' } : notRequired('unavailable');
  } catch (error) {
    const declined = errorCode(error) === 'ERR_AGE_RANGE_USER_DECLINED';
    if (eligible === true) return { outcome: 'needs_age', reason: declined ? 'declined' : 'unavailable' };
    return notRequired(declined ? 'declined' : 'unavailable');
  }
}

/** The real platform, through expo-age-range. */
export const devicePort: AgePort = {
  platform: Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web',
  iosMajor: Platform.OS === 'ios' ? Number.parseInt(String(Platform.Version), 10) || null : null,
  isEligible: () => AgeRange.isEligibleForAgeFeaturesAsync(),
  signalsAccess: () => AgeRange.requestAgeSignalsAccessAsync(),
  requestRange: async () => {
    const response = await AgeRange.requestAgeRangeAsync({ threshold1: ADULT_AGE });
    return {
      lowerBound: response.lowerBound,
      upperBound: response.upperBound,
      source: response.ageRangeDeclaration ?? response.ageRangeSource ?? null,
    };
  },
};

/** Copy for a regulated region without a usable answer. */
export function needsAgeCopy(reason: 'declined' | 'unavailable' | 'verification_required'): { title: string; body: string } {
  switch (reason) {
    case 'declined':
      return {
        title: 'Share your age range to continue.',
        body: 'Where you live, apps must confirm your age with the App Store. PaceLeague only learns whether you’re 18 or older. Tap Check again and choose Share.',
      };
    case 'verification_required':
      return {
        title: 'Google Play needs to confirm your age.',
        body: 'Open Google Play, confirm your age there, then come back and tap Check again.',
      };
    default:
      return {
        title: 'We couldn’t confirm your age.',
        body: 'Make sure you’re signed in to your Apple Account on this phone, then tap Check again.',
      };
  }
}
