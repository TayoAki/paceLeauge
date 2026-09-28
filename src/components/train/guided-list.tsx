import { useRouter } from 'expo-router';
import { Lock } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { ChoiceChips, EmptyState, Pill, TextField } from '@/components/ui/elements';
import { filterGuided, GUIDED_KIND_NAMES, GUIDED_RUNS, guidedMinutes, LENGTH_NAMES, type GuidedKind, type LengthFilter } from '@/features/guided/catalog';
import { usePro } from '@/features/pro/use-pro';
import { Text } from '@/design/text';
import { colors, radius, space } from '@/design/tokens';

const KINDS: (GuidedKind | 'all')[] = ['all', 'first_run', 'easy', 'recovery', 'tempo', 'intervals', 'long', 'mindful'];

/** Guided runs (docs/ROADMAP.md 3.4): search and filter by type and length. */
export function GuidedList() {
  const router = useRouter();
  const { pro } = usePro();
  const [kind, setKind] = useState<GuidedKind | 'all'>('all');
  const [length, setLength] = useState<LengthFilter>('all');
  const [query, setQuery] = useState('');
  const runs = filterGuided(GUIDED_RUNS, kind, length, query);
  return (
    <View style={styles.list}>
      <Text variant="body" tone="secondary">
        A coach in your ear, over your own music. Works offline.
      </Text>
      <TextField label="Search" placeholder="Tempo, hills, mindful…" value={query} onChangeText={setQuery} autoCorrect={false} returnKeyType="search" />
      <ChoiceChips options={KINDS.map((k) => ({ value: k, label: k === 'all' ? 'All' : GUIDED_KIND_NAMES[k] }))} value={kind} onChange={setKind} label="Type" />
      <ChoiceChips options={(Object.keys(LENGTH_NAMES) as LengthFilter[]).map((l) => ({ value: l, label: LENGTH_NAMES[l] }))} value={length} onChange={setLength} label="Length" />
      {runs.length === 0 ? <EmptyState title="No guided runs match." body="Try another type or length." /> : null}
      {runs.map((run) => {
        const locked = !run.free && !pro;
        return (
          <Pressable
            key={run.id}
            onPress={() => router.push({ pathname: '/train/guided/[id]', params: { id: run.id } })}
            accessibilityRole="button"
            accessibilityLabel={`${run.title}, ${guidedMinutes(run)} minutes, ${GUIDED_KIND_NAMES[run.kind]}${locked ? ', Pro' : ''}. ${run.summary}`}
            style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.surfaceElevated }]}
            testID={`guided-${run.id}`}>
            <View style={styles.minutes}>
              <Text variant="section">{guidedMinutes(run)}</Text>
              <Text variant="caption" tone="secondary">
                min
              </Text>
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <View style={styles.title}>
                <Text variant="bodyStrong" style={{ flexShrink: 1 }}>
                  {run.title}
                </Text>
                {locked ? <Lock size={16} color={colors.textSecondary} /> : null}
              </View>
              <Text variant="label" tone="secondary" numberOfLines={2}>
                {run.summary}
              </Text>
              <View style={styles.pills}>
                <Pill label={GUIDED_KIND_NAMES[run.kind]} tone="neutral" />
                {!run.free ? <Pill label="Pro" tone={pro ? 'neutral' : 'accent'} /> : null}
              </View>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: space.md },
  row: { flexDirection: 'row', gap: space.md, backgroundColor: colors.surface, borderRadius: radius.card, padding: space.lg },
  minutes: { width: 48, alignItems: 'center' },
  title: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  pills: { flexDirection: 'row', gap: space.sm, marginTop: space.xs },
});
