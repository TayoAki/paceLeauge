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

/** The App Store app (TestFlight and release builds); development builds install alongside it. */
const BUNDLE_ID = process.env.IOS_BUNDLE_IDENTIFIER ?? (APP_ENV === 'development' ? 'com.tayoaki.paceleague.dev' : 'com.tayoaki.paceleague');
/** The Google Play app, named like the iOS app; development builds install alongside it (P.1). */
const ANDROID_PACKAGE =
  process.env.ANDROID_PACKAGE ?? (APP_ENV === 'development' ? 'com.tayoaki.paceleague.dev' : 'com.tayoaki.paceleague');
/** The Expo project @tayom/paceleague. Not a secret: it only tells EAS which project this is. */
const EAS_PROJECT_ID = process.env.EAS_PROJECT_ID ?? '605e184b-7dc5-4cf9-b0a6-878729602fa4';

/**
 * Phase 1 native extras (docs/ROADMAP.md 1.2, 1.6, 1.11). Each can be left out of a build by setting
 * its variable to 0, for example while tracking down a native build problem; the app then hides it.
 *  - PL_WIDGETS: the widget extension (run Live Activity and the "this week" widget).
 *  - PL_HEALTHKIT: saving runs to Apple Health.
 */
const WITH_WIDGETS = process.env.PL_WIDGETS !== '0';
const WITH_HEALTHKIT = process.env.PL_HEALTHKIT !== '0';
/**
 * Phase 2 (docs/ROADMAP.md 2.2): the Apple Watch app and its complication (targets/watch and
 * targets/watch-complication). Off unless PL_WATCH=1 until it has been built and tested on devices.
 */
const WITH_WATCH = process.env.PL_WATCH === '1';
/** Which folders under targets/ @bacons/apple-targets builds. */
const TARGETS = [...(WITH_WIDGETS ? ['widgets'] : []), ...(WITH_WATCH ? ['watch', 'watch-complication'] : [])];
/** Shared by the app and its widget extension (the widget derives the same name from its bundle id). */
const APP_GROUP = `group.${BUNDLE_ID}`;

const LOCATION_ALWAYS_COPY = 'PaceLeague records your run’s route while your screen is locked. Location is only collected during a run you start.';
const LOCATION_WHEN_IN_USE_COPY = 'PaceLeague uses your location to prepare and record your run.';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: IS_PROD ? 'PaceLeague' : `PaceLeague (${APP_ENV})`,
  slug: 'paceleague',
  owner: 'tayom',
  scheme: 'paceleague',
  version: '0.1.0',
  orientation: 'portrait',
  icon: './assets/images/icon.png',
  userInterfaceStyle: 'dark',
  backgroundColor: '#101315',
  ios: {
    bundleIdentifier: BUNDLE_ID,
    // Signs the widget extension in local Xcode builds; EAS signs every target from its credentials.
    ...(process.env.APPLE_TEAM_ID ? { appleTeamId: process.env.APPLE_TEAM_ID } : {}),
    supportsTablet: false,
    usesAppleSignIn: true,
    // Apple's Declared Age Range (expo-age-range): age assurance for regulated regions.
    entitlements: {
      'com.apple.developer.declared-age-range': true,
      ...(WITH_WIDGETS ? { 'com.apple.security.application-groups': [APP_GROUP] } : {}),
    },
    config: { usesNonExemptEncryption: false },
    infoPlist: {
      NSLocationWhenInUseUsageDescription: LOCATION_WHEN_IN_USE_COPY,
      NSLocationAlwaysAndWhenInUseUsageDescription: LOCATION_ALWAYS_COPY,
      NSPhotoLibraryAddUsageDescription: 'Save your stats-only share image to your photo library.',
      NSMotionUsageDescription: 'PaceLeague counts your steps during treadmill and indoor runs to estimate the distance.',
      // audio: voice cues speak while the phone is locked in a pocket (docs/ROADMAP.md Part C).
      UIBackgroundModes: ['location', 'audio'],
      // The run on the lock screen and in the Dynamic Island.
      ...(WITH_WIDGETS ? { NSSupportsLiveActivities: true } : {}),
    },
  },
  android: {
    // The Android app (docs/ROADMAP.md P.1). Runs record in a location foreground service the
    // runner starts, so the app never asks for background ("all the time") location.
    package: ANDROID_PACKAGE,
    adaptiveIcon: {
      backgroundColor: '#101315',
      foregroundImage: './assets/images/adaptive-icon.png',
    },
    predictiveBackGestureEnabled: false,
    permissions: [
      'android.permission.ACCESS_COARSE_LOCATION',
      'android.permission.ACCESS_FINE_LOCATION',
      'android.permission.FOREGROUND_SERVICE',
      'android.permission.FOREGROUND_SERVICE_LOCATION',
      // The recording notification and the optional reminder (Android 13+).
      'android.permission.POST_NOTIFICATIONS',
      'android.permission.VIBRATE',
      // Health Connect (P.1), each asked for only when the runner turns on what needs it:
      // importing workouts, heart-rate zones, health trends, and saving runs.
      'android.permission.health.READ_EXERCISE',
      'android.permission.health.READ_EXERCISE_ROUTES',
      'android.permission.health.READ_DISTANCE',
      'android.permission.health.READ_STEPS',
      'android.permission.health.READ_HEART_RATE',
      'android.permission.health.READ_RESTING_HEART_RATE',
      'android.permission.health.READ_HEART_RATE_VARIABILITY',
      'android.permission.health.READ_VO2_MAX',
      'android.permission.health.READ_SLEEP',
      'android.permission.health.READ_HEALTH_DATA_HISTORY',
      'android.permission.health.WRITE_EXERCISE',
      'android.permission.health.WRITE_EXERCISE_ROUTE',
      'android.permission.health.WRITE_DISTANCE',
    ],
    // Never requested, whatever a library adds. Recording doesn't need background location, which
    // would need Google Play's background-location declaration; share images are only saved, which
    // needs no media-read access on Android 13+ (and reading media falls under Play's photo and
    // video policy); the system overlay is only for development tools.
    blockedPermissions: [
      'android.permission.ACCESS_BACKGROUND_LOCATION',
      'android.permission.RECORD_AUDIO',
      'android.permission.READ_MEDIA_IMAGES',
      'android.permission.READ_MEDIA_VIDEO',
      'android.permission.READ_MEDIA_AUDIO',
      'android.permission.READ_MEDIA_VISUAL_USER_SELECTED',
      'android.permission.SYSTEM_ALERT_WINDOW',
    ],
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
        // The run's foreground service (src/features/recording/location-driver.android.ts).
        isAndroidForegroundServiceEnabled: true,
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
        // Saving only: no photo, video or audio reading on Android.
        granularPermissions: [],
      },
    ],
    ...(TARGETS.length > 0 ? [['@bacons/apple-targets', { match: TARGETS.length === 1 ? TARGETS[0] : `@(${TARGETS.join('|')})` }] as [string, unknown]] : []),
    ...(WITH_HEALTHKIT
      ? [
          [
            '@kingstinct/react-native-healthkit',
            {
              NSHealthUpdateUsageDescription: 'When you turn it on, PaceLeague saves your runs to Apple Health with their distance and route.',
              NSHealthShareUsageDescription:
                'Only for what you turn on in PaceLeague: workouts, routes and heart rate, so runs from your watch count and show heart-rate zones; and, if you choose, resting heart rate, heart rate variability, VO2 max and sleep for training trends. Zones and trends stay on your phone.',
              // Health wakes the app for new workouts, so imports sync without opening it (2.1).
              background: true,
            },
          ] as [string, unknown],
        ]
      : []),
    // Health Connect's permission screens link to the Privacy Policy (P.1); it needs Android 8+.
    'react-native-health-connect',
    ['expo-build-properties', { android: { minSdkVersion: 26 } }],
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
    appGroup: WITH_WIDGETS ? APP_GROUP : null,
    eas: { projectId: EAS_PROJECT_ID },
  },
});
