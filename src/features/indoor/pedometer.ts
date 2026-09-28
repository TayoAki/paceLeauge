import { Pedometer } from 'expo-sensors';
import { Platform } from 'react-native';

import type { StepSource } from './indoor-run';

/** Steps from the phone's motion coprocessor (iOS keeps a history, so any range can be asked). */
export function devicePedometer(): StepSource | null {
  if (Platform.OS !== 'ios') return null;
  return {
    stepsBetween: async (from, to) => {
      try {
        if (!(await Pedometer.isAvailableAsync())) return null;
        const permission = await Pedometer.requestPermissionsAsync();
        if (!permission.granted) return null;
        return (await Pedometer.getStepCountAsync(new Date(from), new Date(to))).steps;
      } catch {
        return null;
      }
    },
  };
}
