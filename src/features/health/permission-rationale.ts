import { requireOptionalNativeModule, type EventSubscription } from 'expo-modules-core';
import { Platform } from 'react-native';

/**
 * Health Connect's permission screen links to the app's privacy policy by opening the app with
 * one of these actions (Android 13 and earlier, then 14 and later). The app answers with its
 * Privacy Policy, as Health Connect requires.
 */
const RATIONALE_ACTIONS = new Set(['androidx.health.ACTION_SHOW_PERMISSIONS_RATIONALE', 'android.intent.action.VIEW_PERMISSION_USAGE']);

interface LaunchIntentNative {
  initialAction(): string | null;
  addListener(event: 'onIntent', listener: (event: { action: string | null }) => void): EventSubscription;
}

let handledInitial = false;

/** Calls `show` when Health Connect asks for the privacy policy: at launch, and while open. */
export function watchPermissionRationale(show: () => void): () => void {
  if (Platform.OS !== 'android') return () => undefined;
  const native = requireOptionalNativeModule<LaunchIntentNative>('LaunchIntent');
  if (!native) return () => undefined;
  if (!handledInitial) {
    handledInitial = true;
    if (RATIONALE_ACTIONS.has(native.initialAction() ?? '')) show();
  }
  const subscription = native.addListener('onIntent', (event) => {
    if (RATIONALE_ACTIONS.has(event.action ?? '')) show();
  });
  return () => subscription.remove();
}
