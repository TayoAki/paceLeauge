import { useLocalSearchParams, useRouter } from 'expo-router';
import { ShieldCheck } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import { SharedRunCard } from '@/components/social/shared-run-card';
import { TextButton } from '@/components/ui/buttons';
import { InlineStatus } from '@/components/ui/elements';
import { NavHeader, Screen } from '@/components/ui/layout';
import { useMe } from '@/features/data/hooks';
import { VISIBILITY_NAMES, useSharedRun } from '@/features/social/use-social';
import { Text } from '@/design/text';
import { colors, space } from '@/design/tokens';

/** Someone's run as the caller may see it (docs/ROADMAP.md 4.2). */
export default function SharedRunScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const units = useMe().data?.data.profile?.units ?? 'metric';
  const shared = useSharedRun(id ?? null);
  const run = shared.data?.data;

  return (
    <Screen edges={['top', 'bottom']}>
      <NavHeader title={run ? run.owner.alias : 'Run'} />
      {run ? (
        <>
          <SharedRunCard run={run} units={units} />
          <View style={styles.note}>
            <ShieldCheck size={16} color={colors.textSecondary} />
            <Text variant="caption" tone="secondary" style={{ flex: 1 }}>
              Shared with {VISIBILITY_NAMES[run.visibility].toLowerCase()}. Maps never show the first and last 200 m or the runner’s privacy zones.
            </Text>
          </View>
          {!run.is_mine ? (
            <TextButton label={`${run.owner.alias}’s profile`} onPress={() => router.push({ pathname: '/runner/[id]', params: { id: run.owner.public_id } })} />
          ) : null}
        </>
      ) : shared.isError ? (
        <InlineStatus title="This run isn’t available." body="It may have been deleted, or it’s no longer shared with you." />
      ) : (
        <Text variant="label" tone="secondary">
          Loading…
        </Text>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  note: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
});
