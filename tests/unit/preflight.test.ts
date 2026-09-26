import { blocker, signalLevel, type PreflightState } from '@/features/recording/preflight';

const NOW = 1_000_000;
const ready: PreflightState = {
  servicesEnabled: true,
  foreground: 'granted',
  canAskForeground: true,
  background: 'granted',
  canAskBackground: true,
  precise: true,
  fix: { at: NOW - 2_000, accuracyM: 8, latitude: 41.88, longitude: -87.63 },
};

describe('preflight readiness', () => {
  it('is ready only with permissions and a fresh, accurate fix', () => {
    expect(blocker(ready, NOW)).toBeNull();
    expect(signalLevel(ready, NOW)).toBe('good');
  });

  it('walks through each blocker in order', () => {
    expect(blocker({ ...ready, servicesEnabled: false }, NOW)).toBe('services_off');
    expect(blocker({ ...ready, foreground: 'undetermined' }, NOW)).toBe('needs_foreground');
    expect(blocker({ ...ready, foreground: 'denied' }, NOW)).toBe('foreground_denied');
    expect(blocker({ ...ready, precise: false }, NOW)).toBe('precise_off');
    expect(blocker({ ...ready, background: 'undetermined' }, NOW)).toBe('needs_background');
    expect(blocker({ ...ready, background: 'denied' }, NOW)).toBe('background_denied');
    expect(blocker({ ...ready, fix: null }, NOW)).toBe('no_fix');
    expect(blocker({ ...ready, fix: { ...ready.fix!, at: NOW - 16_000 } }, NOW)).toBe('no_fix');
    expect(blocker({ ...ready, fix: { ...ready.fix!, accuracyM: 65 } }, NOW)).toBe('weak_fix');
  });

  it('never calls foreground-only access locked-screen capable, but allows the web preview', () => {
    expect(blocker({ ...ready, background: 'denied' }, NOW)).not.toBeNull();
    expect(blocker({ ...ready, background: 'unsupported', precise: null }, NOW)).toBeNull();
    expect(signalLevel({ ...ready, fix: { ...ready.fix!, accuracyM: 35 } }, NOW)).toBe('fair');
    expect(signalLevel({ ...ready, foreground: 'denied' }, NOW)).toBe('off');
  });
});
