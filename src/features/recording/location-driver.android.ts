import * as Location from 'expo-location';

import { colors } from '@/design/tokens';

import { LOCATION_TASK } from './constants';
import type { LocationDriver } from './types';

/**
 * Android recording driver (docs/ROADMAP.md P.1): high-accuracy updates delivered to the same
 * background task as iOS (location-task.ts), from a location foreground service. The runner
 * starts it by tapping Start, so it keeps recording with the screen off using location allowed
 * "while in use"; Android shows its notification for as long as the run records. Closing the app
 * from recent apps doesn't stop it: only finishing the run does.
 */
export const locationDriver: LocationDriver = {
  supportsBackground: true,
  needsBackgroundPermission: false,
  async start() {
    if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)) return;
    await Location.startLocationUpdatesAsync(LOCATION_TASK, {
      accuracy: Location.Accuracy.BestForNavigation,
      distanceInterval: 0,
      timeInterval: 1000,
      deferredUpdatesInterval: 0,
      foregroundService: {
        notificationTitle: 'Recording your run',
        notificationBody: 'PaceLeague records your route until you finish. Only you can see it.',
        notificationColor: colors.accent,
        killServiceOnDestroy: false,
      },
    });
  },
  async stop() {
    if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)) {
      await Location.stopLocationUpdatesAsync(LOCATION_TASK);
    }
  },
  isRunning: () => Location.hasStartedLocationUpdatesAsync(LOCATION_TASK),
};
