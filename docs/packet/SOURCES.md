# PaceLeague — Sources and research limits

Retrieved 2026-09-26 UTC. Sources are first-party product listings, official documentation, or provider terms. They support only the specific factual claims attributed to them. Proposed features, score rules, timelines, costs, thresholds, and positioning are our planning recommendations, not facts from these sources.

| ID | Source / owner | Use in the packet | Limit |
|---|---|---|---|
| S01 | [Runify official site](https://www.runifyapp.com/) — Runify | Advertised ranked running category and feature pattern | Marketing; not independent outcome evidence |
| S02 | [Runify: Running Tracker](https://apps.apple.com/us/app/runify-running-tracker/id6746146450) — Apple listing / OneDegree Labs | App identity and advertised clubs/social functions | Regional listing; not a hands-on audit |
| S03 | [Expo Location](https://docs.expo.dev/versions/latest/sdk/location/) — Expo | Background recording requirements, permissions, termination limits | Latest-version page changes; exact selected SDK must be checked |
| S04 | [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security) — Supabase | Auth-based row policy approach | Correct application policy and testing still required |
| S05 | [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/) — Apple | UGC, payments, privacy, original product and review preparation | Applicability depends on actual release and storefront |
| S06 | [Offering account deletion in your app](https://developer.apple.com/support/offering-account-deletion-in-your-app/) — Apple | Deletion lifecycle and subscription distinction | Does not define every legal retention obligation |
| S07 | [RevenueCat with Expo](https://www.revenuecat.com/docs/getting-started/installation/expo) — RevenueCat | Native integration and development-build requirement | Configuration and sandbox tests have not happened |
| S08 | [Expo SQLite](https://docs.expo.dev/versions/latest/sdk/sqlite/) — Expo | Local database and SQLCipher option | Encryption/key/background behavior must be verified together |
| S09 | [react-native-maps](https://docs.expo.dev/versions/latest/sdk/map-view/) — Expo | Native map-provider option | Provider setup, attribution and cost need release review |
| S10 | [Access location in the background](https://developer.android.com/develop/sensors-and-location/location/background) — Google | Later Android-specific location work | Android has not been designed or tested in full |
| S11 | [RevenueCat Webhooks](https://www.revenuecat.com/docs/integrations/webhooks) — RevenueCat | Authentication, reconciliation, retries and plan dependency | Verify purchased plan and exact integration mechanism at setup |
| S12 | [Strava API Agreement](https://www.strava.com/legal/api) — Strava, effective June 1, 2026 | Restrictions material to competitive/import features | No permission or approval for PaceLeague has been obtained |
| S13 | [Garmin Connect Developer Program](https://developer.garmin.com/gc-developer-program/overview/) — Garmin | Future integration is a separate cloud/provider project | Access, terms, implementation and compatibility unverified |
| S14 | [Google Play account deletion requirements](https://support.google.com/googleplay/android-developer/answer/13327111) — Google | Later Android account-lifecycle review | Recheck for the actual Android release |

Runify's advertised imports do not prove permission for another app to implement the same integration. The website and App Store have differing review counts; no such number is used to estimate demand. No revenue or retention data was accessible, and no user interviews were simulated. HealthKit/watch integration is a future research task; no native health-data implementation is asserted here.

Evidence IDs and their classifications are in specs/EVIDENCE_LEDGER.csv. E-010 is explicitly our hypothesis. Product decisions D-001 onward are proposed defaults with a named owner role and review point, not fabricated approvals.
