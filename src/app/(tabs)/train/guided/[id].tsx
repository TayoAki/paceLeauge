import { useLocalSearchParams, useRouter } from 'expo-router';
import { Lock, Play } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import { PrimaryButton, SecondaryButton } from '@/components/ui/buttons';
import { InlineStatus, Pill } from '@/components/ui/elements';
import { Card, NavHeader, Screen } from '@/components/ui/layout';
import { GUIDED_KIND_NAMES, guidedMinutes, guidedRun } from '@/features/guided/catalog';
import { describeBlocks } from '@/features/plans/plan-client';
import { usePro } from '@/features/pro/use-pro';
import { Text } from '@/design/text';
import { space } from '@/design/tokens';

const LEVELS = { new: 'New runners', all: 'Everyone', experienced: 'Experienced runners' } as const;

/** One guided run: what it is, its steps, and starting it (docs/ROADMAP.md 3.4). */
export default function GuidedRunScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { pro } = usePro();
  const run = id ? guidedRun(id) : null;
  if (!run) {
    return (
      <Screen edges={['top', 'bottom']}>
        <NavHeader title="Guided run" />
        <InlineStatus title="This guided run isn’t available." />
      </Screen>
    );
  }
  const locked = !run.free && !pro;
  return (
    <Screen edges={['top', 'bottom']}>
      <NavHeader title="Guided run" />
      <Text variant="title">{run.title}</Text>
      <View style={styles.pills}>
        <Pill label={`${guidedMinutes(run)} min`} tone="neutral" />
        <Pill label={GUIDED_KIND_NAMES[run.kind]} tone="neutral" />
        <Pill label={LEVELS[run.level]} tone="neutral" />
        {!run.free ? <Pill label="Pro" /> : null}
      </View>
      <Text variant="body" tone="secondary">
        {run.summary}
      </Text>
      <Card style={styles.card}>
        <Text variant="eyebrow" tone="secondary">
          The run
        </Text>
        {describeBlocks(run.blocks).map((line, i) => (
          <Text key={i} variant="body">
            {line.charAt(0).toUpperCase() + line.slice(1)}
          </Text>
        ))}
      </Card>
      <Text variant="caption" tone="secondary">
        The coach talks over your music, which dips while they speak. Headphones on, volume up, and you can lock your phone.
      </Text>
      {locked ? (
        <>
          <InlineStatus icon={Lock} title="This run is part of Pro." body="The starter set of guided runs is free for everyone." />
          <PrimaryButton label="See Pro" size="large" onPress={() => router.push('/pro')} testID="guided-see-pro" />
        </>
      ) : (
        <PrimaryButton
          label="Start guided run"
          icon={Play}
          size="large"
          onPress={() => router.push({ pathname: '/run/preflight', params: { guided: run.id } })}
          testID="guided-start"
        />
      )}
      <SecondaryButton label="All guided runs" onPress={() => router.back()} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  pills: { flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' },
  card: { gap: space.sm },
});
