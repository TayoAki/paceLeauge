import { deviceStore } from '@/lib/device-store';

/**
 * An invitation opened before sign-in. It is remembered across the sign-in round trip so
 * the runner returns to the preview and joins explicitly — never automatically.
 */
const KEY = 'pl.pending.invite';

export const pendingInvite = {
  get: () => deviceStore.get(KEY).catch(() => null),
  set: (code: string) => deviceStore.set(KEY, code).catch(() => undefined),
  clear: () => deviceStore.remove(KEY).catch(() => undefined),
};
