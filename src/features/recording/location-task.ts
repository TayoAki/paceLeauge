import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';

import { openAccountRuntime, recordingAccountId } from '@/features/account/runtime';

import { LOCATION_TASK } from './constants';
import { recorderForTask, setHeadlessResolver } from './registry';

/**
 * Module-scope background task definition (imported first by index.ts). It must exist
 * before any route renders, including when iOS relaunches the app in the background.
 */
if (Platform.OS !== 'web') {
  setHeadlessResolver(async () => {
    const accountId = await recordingAccountId();
    if (!accountId) return null;
    return (await openAccountRuntime(accountId)).recorder;
  });

  TaskManager.defineTask<{ locations: Location.LocationObject[] }>(LOCATION_TASK, async ({ data, error }) => {
    const recorder = await recorderForTask().catch(() => null);
    if (!recorder) {
      // Nothing is recording for any account on this device: stop stray updates.
      await Location.stopLocationUpdatesAsync(LOCATION_TASK).catch(() => undefined);
      return;
    }
    if (error) {
      // kCLErrorDenied: permission was revoked while recording.
      if ((error as { code?: string | number }).code === 1 || /denied/i.test(error.message)) {
        await recorder.interruptForPermission();
      }
      return;
    }
    const locations = data?.locations ?? [];
    await recorder.ingest(
      locations.map((l) => ({
        timestamp: l.timestamp,
        latitude: l.coords.latitude,
        longitude: l.coords.longitude,
        accuracy: l.coords.accuracy,
      })),
    );
  });
}
