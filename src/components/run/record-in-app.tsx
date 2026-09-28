import { useRouter } from 'expo-router';
import { Smartphone } from 'lucide-react-native';

import { SecondaryButton } from '@/components/ui/buttons';
import { EmptyState } from '@/components/ui/elements';
import { NavHeader, Screen } from '@/components/ui/layout';

/** The web app's answer to "Start run": recording happens in the phone app (P.2). */
export function RecordInApp() {
  const router = useRouter();
  return (
    <Screen edges={['top', 'bottom']}>
      <NavHeader title="Record a run" />
      <EmptyState
        icon={Smartphone}
        title="Record runs with the PaceLeague app."
        body="Recording needs your phone’s GPS in your pocket. Get PaceLeague for iPhone or Android and sign in with this account: your runs, league and plan are the same everywhere.">
        <SecondaryButton label="Back" onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
      </EmptyState>
    </Screen>
  );
}
