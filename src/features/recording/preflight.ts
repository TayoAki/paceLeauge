import { RECORDER_V1 } from '@/domain/config';

/**
 * Preflight readiness (REQ-002). "Ready" requires the observed permission state *and* a
 * fresh, accurate enough fix. Foreground-only access is never presented as locked-screen
 * capable, and the recorder stays disabled until the requirements are met.
 */
export type PermissionStatus = 'granted' | 'denied' | 'undetermined';

export interface PreflightState {
  servicesEnabled: boolean;
  foreground: PermissionStatus;
  canAskForeground: boolean;
  /** 'unsupported' on the web preview, which has no background recording. */
  background: PermissionStatus | 'unsupported';
  canAskBackground: boolean;
  /** iOS precise-location authorization; null where the platform does not report it. */
  precise: boolean | null;
  fix: { at: number; accuracyM: number | null; latitude: number; longitude: number } | null;
}

export type Blocker =
  | 'services_off'
  | 'needs_foreground'
  | 'foreground_denied'
  | 'precise_off'
  | 'needs_background'
  | 'background_denied'
  | 'no_fix'
  | 'weak_fix';

export type SignalLevel = 'off' | 'searching' | 'good' | 'fair' | 'weak';

export function signalLevel(state: PreflightState, now: number): SignalLevel {
  if (!state.servicesEnabled || state.foreground !== 'granted') return 'off';
  if (!state.fix || now - state.fix.at > RECORDER_V1.freshFixMaxAgeMs) return 'searching';
  const acc = state.fix.accuracyM;
  if (acc === null || acc > RECORDER_V1.maxHorizontalAccuracyM) return 'weak';
  return acc <= RECORDER_V1.goodAccuracyM ? 'good' : 'fair';
}

export function blocker(state: PreflightState, now: number): Blocker | null {
  if (!state.servicesEnabled) return 'services_off';
  if (state.foreground === 'undetermined') return 'needs_foreground';
  if (state.foreground === 'denied') return 'foreground_denied';
  if (state.precise === false) return 'precise_off';
  if (state.background === 'undetermined') return 'needs_background';
  if (state.background === 'denied') return 'background_denied';
  const signal = signalLevel(state, now);
  if (signal === 'searching') return 'no_fix';
  if (signal === 'weak') return 'weak_fix';
  return null;
}

export const blockerCopy: Record<Blocker, { title: string; body: string; action: 'request_foreground' | 'request_background' | 'settings' | 'wait' }> = {
  services_off: { title: 'Location Services are off.', body: 'Turn on Location Services in Settings to record a run.', action: 'settings' },
  needs_foreground: {
    title: 'Use location to prepare and record your run, including while your screen is locked.',
    body: 'Location is only collected during a run you start. Routes are visible only to you.',
    action: 'request_foreground',
  },
  foreground_denied: { title: 'Location access is off.', body: 'Turn it on in Settings to record runs. Your history and league stay available.', action: 'settings' },
  precise_off: { title: 'Precise location is off.', body: 'Approximate location can’t measure a run. Turn on Precise Location in Settings.', action: 'settings' },
  needs_background: {
    title: 'Allow recording while your screen is locked.',
    body: 'Choose “Change to Always Allow” so your run keeps recording in your pocket. Location is still only used during a run.',
    action: 'request_background',
  },
  background_denied: {
    title: 'Screen-locked tracking is off.',
    body: 'Set PaceLeague’s location access to “Always” in Settings so your run keeps recording with the screen locked.',
    action: 'settings',
  },
  no_fix: { title: 'Finding GPS…', body: 'This usually takes a few seconds outdoors.', action: 'wait' },
  weak_fix: { title: 'GPS is weak.', body: 'Move somewhere with open sky for a better signal.', action: 'wait' },
};
