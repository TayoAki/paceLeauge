import Constants from 'expo-constants';
import { Platform } from 'react-native';

/**
 * Whether this build has real maps (docs/ROADMAP.md 5.1): Apple Maps on iOS; Google Maps on
 * Android only when the build has a Maps SDK key (GOOGLE_MAPS_ANDROID_KEY in app.config.ts),
 * without which the Maps SDK would stop the app. Elsewhere routes are drawn on a grid.
 */
const extra = Constants.expoConfig?.extra as { androidMaps?: boolean } | undefined;

export const NATIVE_MAPS = Platform.OS === 'ios' || (Platform.OS === 'android' && extra?.androidMaps === true);
