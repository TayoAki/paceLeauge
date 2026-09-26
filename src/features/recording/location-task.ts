import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';

import { Journal } from '@/db/journal';
import { openAccountDatabase } from '@/db/open';
import { newId } from '@/lib/crypto';
import { deviceStore } from '@/lib/device-store';

import { LOCATION_TASK, RECORDING_ACCOUNT_KEY } from './constants';
import { locationDriver } from './location-driver';
import { RecorderService } from './recorder-service';
import { recorderForTask, setHeadlessResolver } from './registry';

/**
 * Module-scope background task definition (imported first by index.ts). It must exist
 * before any route renders, including when iOS relaunches the app in the background.
 */
if (Platform.OS !== 'web') {
  setHeadlessResolver(async () => {
    const accountId = await deviceStore.get(RECORDING_ACCOUNT_KEY).catch(() => null);
    if (!accountId) return null;
    const journal = await Journal.open(await openAccountDatabase(accountId));
    const recorder = new RecorderService({ journal, location: locationDriver, newRunId: newId });
    await recorder.init();
    return recorder;
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
