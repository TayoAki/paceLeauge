import { Platform } from 'react-native';

/** How purchases read for the store this build sells through (docs/ROADMAP.md 3.6 and P.1). */
export const STORE =
  Platform.OS === 'android'
    ? {
        /** Mid-sentence: "Couldn't reach Google Play." */
        name: 'Google Play',
        /** Starting a sentence. */
        Name: 'Google Play',
        account: 'Google account',
        billing:
          'Payment is charged to your Google Play account. Subscriptions renew automatically until you cancel them in Google Play › Payments & subscriptions › Subscriptions, and Pro stays on until the end of the period you’ve paid for.',
      }
    : {
        name: 'the App Store',
        Name: 'The App Store',
        account: 'Apple ID',
        billing:
          'Payment is charged to your App Store account. Subscriptions renew automatically unless cancelled at least 24 hours before the end of the current period, in Settings › your name › Subscriptions.',
      };
