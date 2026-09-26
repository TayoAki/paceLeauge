/** Web development fallback (not a secure store; the web build is a preview only). */
function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export const deviceStore = {
  get: async (key: string) => storage()?.getItem(key) ?? null,
  set: async (key: string, value: string) => storage()?.setItem(key, value),
  remove: async (key: string) => storage()?.removeItem(key),
};
