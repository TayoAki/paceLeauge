import { Platform } from 'react-native';

/** How this phone's health store reads in the app: Apple Health on iPhone, Health Connect on Android. */
export const HEALTH =
  Platform.OS === 'android'
    ? {
        name: 'Health Connect',
        /** Where the runner changes what PaceLeague may read or write. */
        settings: 'Health Connect › App permissions › PaceLeague',
        readTypes: 'Exercise, Distance and Heart rate',
        writeTypes: 'Exercise and Distance',
      }
    : {
        name: 'Apple Health',
        settings: 'the Health app: your profile › Apps › PaceLeague',
        readTypes: 'Workouts and Workout Routes',
        writeTypes: 'Workouts and Workout Routes',
      };
