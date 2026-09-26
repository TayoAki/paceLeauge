import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * Expo app configuration.
 *
 * Public runtime values come from EXPO_PUBLIC_* environment variables (see .env.example).
 * Only the public API key may appear here: it identifies the app, and every RPC is
 * protected by row-level security and server-side identity checks. No privileged key may
 * ever be referenced by app code — `npm run check:secrets` enforces this.
 */
const APP_ENV = process.env.EXPO_PUBLIC_APP_ENV ?? 'development';
const IS_PROD = APP_ENV === 'production';

const LOCATION_ALWAYS_COPY =
  'PaceLeague records your run’s route while your screen is locked. Location is only collected during a run you start.';
const LOCATION_WHEN_IN_USE_COPY = 'PaceLeague uses your location to prepare and record your run.';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: IS_PROD ? 'PaceLeague' : `PaceLeague (${APP_ENV})`,
  slug: 'paceleague',
  scheme: 'paceleague',
  version: '0.1.0',
  orientation: 'portrait',
  icon: './assets/images/icon.png',
  userInterfaceStyle: 'dark',
  backgroundColor: '#101315',
  ios: {
    bundleIdentifier: process.env.IOS_BUNDLE_IDENTIFIER ?? 'com.example.paceleague.dev',
    supportsTablet: false,
    usesAppleSignIn: true,
    config: { usesNonExemptEncryption: false },
    infoPlist: {
      NSLocationWhenInUseUsageDescription: LOCATION_WHEN_IN_USE_COPY,
      NSLocationAlwaysAndWhenInUseUsageDescription: LOCATION_ALWAYS_COPY,
      NSPhotoLibraryAddUsageDescription: 'Save your stats-only share image to your photo library.',
      UIBackgroundModes: ['location'],
    },
  },
  android: {
    // Android is a later increment (F11). The package id exists so development builds work,
    // but background location on Android is intentionally not enabled yet.
    package: process.env.ANDROID_PACKAGE ?? 'com.example.paceleague.dev',
    adaptiveIcon: {
      backgroundColor: '#101315',
      foregroundImage: './assets/images/adaptive-icon.png',
    },
    predictiveBackGestureEnabled: false,
  },
  web: {
    output: 'single',
    favicon: './assets/images/favicon.png',
    backgroundColor: '#101315',
  },
  plugins: [
    'expo-router',
    [
      'expo-location',
      {
        locationAlwaysAndWhenInUsePermission: LOCATION_ALWAYS_COPY,
        locationWhenInUsePermission: LOCATION_WHEN_IN_USE_COPY,
        isIosBackgroundLocationEnabled: true,
        isAndroidBackgroundLocationEnabled: false,
        isAndroidForegroundServiceEnabled: false,
      },
    ],
    ['expo-sqlite', { useSQLCipher: true }],
    'expo-secure-store',
    'expo-apple-authentication',
    'expo-web-browser',
    [
      'expo-notifications',
      {
        color: '#D5FF45',
      },
    ],
    [
      'expo-media-library',
      {
        photosPermission: false,
        savePhotosPermission: 'Save your stats-only share image to your photo library.',
        isAccessMediaLocationEnabled: false,
      },
    ],
    [
      'expo-splash-screen',
      {
        backgroundColor: '#101315',
        image: './assets/images/splash-icon.png',
        imageWidth: 120,
      },
    ],
  ],
  experiments: {
    typedRoutes: true,
    reactCompiler: true,
  },
  extra: {
    appEnv: APP_ENV,
    eas: process.env.EAS_PROJECT_ID ? { projectId: process.env.EAS_PROJECT_ID } : undefined,
  },
});
