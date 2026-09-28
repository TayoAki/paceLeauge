import { useLocalSearchParams, useRouter } from 'expo-router';
import { Minus, Plus } from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import type { ChallengeMetric } from '@/api/challenge-schemas';
import type { GroupTarget } from '@/api/leagues-api';
import { IconButton, PrimaryButton } from '@/components/ui/buttons';
import { ChoiceChips, InlineStatus, SegmentedControl, TextField } from '@/components/ui/elements';
import { NavHeader, Screen } from '@/components/ui/layout';
import { challengeMonth, clampTarget, defaultTitle, fairnessLine, goalLine, monthLabel, targetRange, unit } from '@/features/challenges/challenge-text';
import { useChallengeActions } from '@/features/challenges/use-challenges';
import { Text } from '@/design/text';
import { space } from '@/design/tokens';

const START: Record<ChallengeMetric, number> = { active_days: 12, capped_score: 750 };

/**
 * Set a challenge for a league or a club (docs/ROADMAP.md 4.6): this month or next, counting
 * days or points (each week's best three days), with an optional name.
 */
export default function CreateChallengeScreen() {
  const { leagueId, clubId } = useLocalSearchParams<{ leagueId?: string; clubId?: string }>();
  const router = useRouter();
  const target: GroupTarget | null = clubId ? { clubId } : leagueId ? { leagueId } : null;
  const actions = useChallengeActions();
  const [now] = useState(() => Date.now());
  const [monthOffset, setMonthOffset] = useState<0 | 1>(0);
  const [metric, setMetric] = useState<ChallengeMetric>('active_days');
  const [goal, setGoal] = useState(START.active_days);
  const [title, setTitle] = useState('');

  const month = challengeMonth(now, monthOffset);
  const range = targetRange(metric, month.days);
  const value = clampTarget(metric, month.days, goal);
  const name = title.trim();
  const ready = target !== null && (name.length === 0 || name.length >= 3);
  const amount = `${value.toLocaleString('en-US')} ${unit(metric, value)}`;

  const step = (delta: number) => setGoal(clampTarget(metric, month.days, value + delta));
  const save = async () => {
    if (!target || !ready) return;
    const created = await actions.create(target, { metric, target: value, monthOffset, title: name.length > 0 ? name : null });
    if (created) router.replace({ pathname: '/league/challenges/[id]', params: { id: created.id } });
  };

  return (
    <Screen
      edges={['top', 'bottom']}
      footer={<PrimaryButton label="Start challenge" onPress={() => void save()} disabled={!ready} loading={actions.busy} testID="challenge-save" />}>
      <NavHeader title="Start a challenge" />
      <Text variant="body" tone="secondary">
        Everyone in the {clubId ? 'club' : 'league'} can join and see the board. It counts days or points, never raw distance, and whoever finishes gets a badge.
      </Text>

      <Text variant="labelStrong">When</Text>
      <ChoiceChips<'0' | '1'>
        label="When"
        value={String(monthOffset) as '0' | '1'}
        onChange={(v) => setMonthOffset(v === '1' ? 1 : 0)}
        options={[
          { value: '0', label: `This month (${monthLabel(challengeMonth(now, 0).startsOn)})` },
          { value: '1', label: `Next month (${monthLabel(challengeMonth(now, 1).startsOn)})` },
        ]}
      />

      <Text variant="labelStrong">Count</Text>
      <SegmentedControl<ChallengeMetric>
        label="Count"
        value={metric}
        onChange={(m) => {
          setMetric(m);
          setGoal(START[m]);
        }}
        options={[
          { value: 'active_days', label: 'Days run' },
          { value: 'capped_score', label: 'Points' },
        ]}
      />

      <Text variant="labelStrong">Goal</Text>
      <View style={styles.stepper}>
        <IconButton icon={Minus} label={`Lower the goal by ${range.step}`} onPress={() => step(-range.step)} disabled={value <= range.min} />
        <View
          style={styles.fill}
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel="Goal"
          aria-valuenow={value}
          aria-valuemin={range.min}
          aria-valuemax={range.max}
          aria-valuetext={amount}
          accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
          onAccessibilityAction={(event) => step(event.nativeEvent.actionName === 'increment' ? range.step : -range.step)}>
          <Text variant="metric" align="center">
            {amount}
          </Text>
        </View>
        <IconButton icon={Plus} label={`Raise the goal by ${range.step}`} onPress={() => step(range.step)} disabled={value >= range.max} />
      </View>
      <ChoiceChips
        label="Common goals"
        value={range.presets.includes(value) ? String(value) : ''}
        onChange={(v) => setGoal(Number(v))}
        options={range.presets.map((p) => ({ value: String(p), label: `${p.toLocaleString('en-US')} ${unit(metric, p)}` }))}
      />
      <Text variant="caption" tone="secondary">
        {goalLine(metric, value)} {fairnessLine(metric)}
      </Text>

      <TextField
        label="Name (optional)"
        value={title}
        onChangeText={setTitle}
        maxLength={40}
        placeholder={defaultTitle(metric, value, month.startsOn)}
        hint="Letters, numbers and spaces. Leave it empty to use the name shown."
        testID="challenge-title"
      />
      {actions.error ? <InlineStatus tone="danger" title={actions.error} /> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  stepper: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  fill: { flex: 1 },
});
