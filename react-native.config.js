/**
 * Mapbox (docs/ROADMAP.md 5.2, offline map areas) is linked into native builds only when PL_MAPBOX=1
 * (see app.config.ts). Without it the SDK stays out of the iOS and Android projects, and the app's
 * JavaScript never loads it.
 */
module.exports = {
  dependencies:
    process.env.PL_MAPBOX === '1'
      ? {}
      : {
          '@rnmapbox/maps': { platforms: { ios: null, android: null } },
        },
};
