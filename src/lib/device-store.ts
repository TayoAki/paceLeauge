import * as SecureStore from 'expo-secure-store';

/**
 * Small secrets and device-level markers in the iOS Keychain. Readable after the first
 * unlock since boot (never synced off the device) so a background location relaunch can
 * open the recording account's journal while the screen is locked.
 */
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

export const deviceStore = {
  get: (key: string) => SecureStore.getItemAsync(key, OPTIONS),
  set: (key: string, value: string) => SecureStore.setItemAsync(key, value, OPTIONS),
  remove: (key: string) => SecureStore.deleteItemAsync(key, OPTIONS),
};
