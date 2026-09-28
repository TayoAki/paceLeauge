/**
 * The PaceLeague Apple Watch app (docs/ROADMAP.md 2.2): record a run on the watch without the
 * phone. Built by @bacons/apple-targets during prebuild, only when PL_WATCH=1 (app.config.ts).
 * watchOS 10 is the floor: it brings workout mirroring to the phone.
 *
 * @type {import('@bacons/apple-targets/app.plugin').ConfigFunction}
 */
module.exports = (config) => ({
  type: 'watch',
  name: 'PaceLeagueWatch',
  displayName: 'PaceLeague',
  // <app bundle id>.watchkitapp; the phone recognises the watch's Health workouts by it.
  bundleIdentifier: '.watchkitapp',
  deploymentTarget: '10.0',
  frameworks: ['SwiftUI', 'HealthKit', 'CoreLocation', 'WatchConnectivity', 'AVFoundation', 'WidgetKit', 'MapKit'],
  colors: {
    $accent: '#D5FF45',
  },
  entitlements: {
    'com.apple.developer.healthkit': true,
    // The complication reads the week and league from here.
    'com.apple.security.application-groups': [`group.${config.ios.bundleIdentifier}`],
  },
});
