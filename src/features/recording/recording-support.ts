import { Platform } from 'react-native';

/**
 * Runs are recorded in the phone app (docs/ROADMAP.md P.2): a browser can't keep GPS going in a
 * pocket. The web app shows history, leagues, plans and settings. Development builds on the web
 * keep a preview recorder for the browser walkthrough.
 */
export const RECORDING_AVAILABLE = Platform.OS !== 'web' || __DEV__;
