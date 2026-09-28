import { useLocalSearchParams, useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';

import { PrimaryButton } from '@/components/ui/buttons';
import { InlineStatus } from '@/components/ui/elements';
import { NavHeader, Screen } from '@/components/ui/layout';
import { STRAVA_OUTCOME } from '@/features/connections/connections';

// On the web, connecting opens Strava in a popup that ends here; this hands the result back to the
// page that opened it and closes the popup. On a phone the sign-in sheet normally catches the
// return itself, so this screen only shows when the system opened the link directly.
WebBrowser.maybeCompleteAuthSession();

/** Where the service sends the runner after Strava's screen (docs/ROADMAP.md 2.3). */
export default function StravaReturnScreen() {
  const { strava } = useLocalSearchParams<{ strava?: string }>();
  const router = useRouter();
  const outcome = STRAVA_OUTCOME[strava ?? ''] ?? STRAVA_OUTCOME.error!;
  return (
    <Screen edges={['top', 'bottom']} footer={<PrimaryButton label="Open connections" onPress={() => router.replace('/profile/connections')} />}>
      <NavHeader title="Strava" />
      <InlineStatus tone={outcome.tone} title={outcome.title} />
    </Screen>
  );
}
