// Learn more: https://docs.expo.dev/guides/customizing-metro/
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// expo-sqlite's web build (development preview only) ships a WebAssembly SQLite. The app uses
// only the asynchronous SQLite API, which does not need SharedArrayBuffer or COOP/COEP headers.
config.resolver.assetExts.push('wasm');

module.exports = config;
