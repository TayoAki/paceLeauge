/**
 * The widget extension (docs/ROADMAP.md 1.2 and 1.11): the run Live Activity on the lock screen
 * and in the Dynamic Island, and the "this week" widget for the home and lock screens. Built by
 * @bacons/apple-targets during prebuild.
 *
 * @type {import('@bacons/apple-targets/app.plugin').ConfigFunction}
 */
module.exports = (config) => ({
  type: 'widget',
  name: 'PaceLeagueWidgets',
  displayName: 'PaceLeague',
  // <app bundle id>.widgets; the Swift code derives the shared App Group from it.
  bundleIdentifier: '.widgets',
  deploymentTarget: '16.4',
  frameworks: ['SwiftUI', 'WidgetKit', 'ActivityKit'],
  colors: {
    $accent: '#D5FF45',
    $widgetBackground: '#101315',
  },
  entitlements: {
    'com.apple.security.application-groups': config.ios.entitlements['com.apple.security.application-groups'],
  },
});
