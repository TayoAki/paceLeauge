import { deviceStore } from '@/lib/device-store';

/**
 * A follow link opened before sign-in, remembered across the sign-in round trip so the runner
 * comes back to it and follows explicitly (docs/ROADMAP.md 4.3).
 */
const KEY = 'pl.pending.follow';

export const pendingFollow = {
  get: () => deviceStore.get(KEY).catch(() => null),
  set: (code: string) => deviceStore.set(KEY, code).catch(() => undefined),
  clear: () => deviceStore.remove(KEY).catch(() => undefined),
};
