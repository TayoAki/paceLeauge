import { useLocalSearchParams, useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';

import { PrimaryButton } from '@/components/ui/buttons';
import { InlineStatus } from '@/components/ui/elements';
import { NavHeader, Screen } from '@/components/ui/layout';
import { GARMIN_OUTCOME } from '@/features/connections/connections';

// Like the Strava return (src/app/strava.tsx): completes the web popup, or shows the result when the
// system opened the link directly.
WebBrowser.maybeCompleteAuthSession();

/** Where the Garmin connection widget sends the runner back (docs/ROADMAP.md 2.4). */
export default function GarminReturnScreen() {
  const { garmin } = useLocalSearchParams<{ garmin?: string }>();
  const router = useRouter();
  const outcome = GARMIN_OUTCOME[garmin ?? ''] ?? GARMIN_OUTCOME.error!;
  return (
    <Screen edges={['top', 'bottom']} footer={<PrimaryButton label="Open connections" onPress={() => router.replace('/profile/connections')} />}>
      <NavHeader title="Garmin" />
      <InlineStatus tone={outcome.tone} title={outcome.title} />
    </Screen>
  );
}
