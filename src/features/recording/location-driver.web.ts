import * as Location from 'expo-location';

import type { LocationDriver, SampleSink } from './types';

/**
 * Development preview driver: a foreground watcher. It cannot record with the screen locked
 * and is never presented as locked-screen capable.
 */
let subscription: Location.LocationSubscription | null = null;

export const locationDriver: LocationDriver = {
  supportsBackground: false,
  async start(sink: SampleSink) {
    if (subscription) return;
    subscription = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.BestForNavigation, distanceInterval: 0, timeInterval: 1000 },
      (location) =>
        sink([
          {
            timestamp: location.timestamp,
            latitude: location.coords.latitude,
            longitude: location.coords.longitude,
            accuracy: location.coords.accuracy,
          },
        ]),
    );
  },
  async stop() {
    subscription?.remove();
    subscription = null;
  },
  isRunning: async () => subscription !== null,
};
