import * as Location from 'expo-location';

import { LOCATION_TASK } from './constants';
import type { LocationDriver } from './types';

/**
 * iOS recording driver: continuous high-accuracy updates delivered to the background task
 * (location-task.ts), which keeps working with the screen locked. Samples reach the recorder
 * through the task handler, so the sink argument is not used here.
 */
export const locationDriver: LocationDriver = {
  supportsBackground: true,
  needsBackgroundPermission: true,
  async start() {
    if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)) return;
    await Location.startLocationUpdatesAsync(LOCATION_TASK, {
      accuracy: Location.Accuracy.BestForNavigation,
      activityType: Location.ActivityType.Fitness,
      distanceInterval: 0,
      timeInterval: 1000,
      deferredUpdatesInterval: 0,
      pausesUpdatesAutomatically: false,
      showsBackgroundLocationIndicator: true,
    });
  },
  async stop() {
    if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)) {
      await Location.stopLocationUpdatesAsync(LOCATION_TASK);
    }
  },
  isRunning: () => Location.hasStartedLocationUpdatesAsync(LOCATION_TASK),
};
