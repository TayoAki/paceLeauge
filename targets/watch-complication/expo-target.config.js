/**
 * The watch face complication (docs/ROADMAP.md 2.2): league rank and this week's active days, from
 * what the phone last told the watch. Built with the watch app only when PL_WATCH=1.
 *
 * @type {import('@bacons/apple-targets/app.plugin').ConfigFunction}
 */
module.exports = (config) => ({
  type: 'watch-widget',
  name: 'PaceLeagueComplication',
  displayName: 'PaceLeague',
  bundleIdentifier: '.watchkitapp.complication',
  deploymentTarget: '10.0',
  frameworks: ['SwiftUI', 'WidgetKit'],
  colors: {
    $accent: '#D5FF45',
  },
  entitlements: {
    'com.apple.security.application-groups': [`group.${config.ios.bundleIdentifier}`],
  },
});
