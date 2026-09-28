import { SkipForward } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import { TextButton } from '@/components/ui/buttons';
import { ProgressBar } from '@/components/ui/elements';
import { formatDistance, formatDuration } from '@/domain/format';
import type { Units } from '@/domain/types';
import { stepLabel, type TimelineStep } from '@/domain/workout';
import { formatPaceRange, formatStepLength } from '@/features/plans/plan-client';
import { useWorkout } from '@/features/workout/use-workout';
import { Text } from '@/design/text';
import { colors, radius, space } from '@/design/tokens';

function lengthOf(step: TimelineStep, units: Units): string {
  if (step.distanceM !== null) {
    const d = formatDistance(step.distanceM, units);
    return `${d.value} ${d.unit}`;
  }
  return formatStepLength(step.durationS ?? 0);
}

/** The step the runner is on, what's left of it, and what's next (docs/ROADMAP.md 3.1). */
export function WorkoutPanel({ units, onSkip }: { units: Units; onSkip: () => void }) {
  const snapshot = useWorkout();
  if (!snapshot?.running) return null;
  const { workout, position } = snapshot;
  if (position.done || !position.step) {
    return (
      <View style={styles.panel} accessible accessibilityLabel={`${workout.title} complete. Finish when you’re ready.`}>
        <Text variant="eyebrow" tone="accent">
          {workout.title}
        </Text>
        <Text variant="section">Workout complete</Text>
        <Text variant="label" tone="secondary">
          Keep moving easy, or finish when you’re ready.
        </Text>
      </View>
    );
  }
  const step = position.step;
  const remaining =
    position.remainingS !== null
      ? formatDuration(Math.ceil(position.remainingS) * 1000)
      : position.remainingM !== null
        ? `${formatDistance(position.remainingM, units).value} ${formatDistance(position.remainingM, units).unit}`
        : '';
  const zone = workout.zones && step.effort !== 'walk' ? workout.zones[step.effort] : null;
  return (
    <View style={styles.panel}>
      <View accessible accessibilityLabel={`${stepLabel(step)}. ${remaining} left.${position.next ? ` Next: ${stepLabel(position.next)}.` : ''}`} style={styles.body}>
        <Text variant="eyebrow" tone="accent" numberOfLines={1}>
          {workout.title}
        </Text>
        <View style={styles.row}>
          <Text variant="section" style={{ flex: 1 }} numberOfLines={1}>
            {stepLabel(step)}
          </Text>
          <Text variant="metric" testID="workout-remaining">
            {remaining}
          </Text>
        </View>
        <ProgressBar fraction={position.fraction} label="Through this step" />
        <View style={styles.row}>
          <Text variant="label" tone="secondary" style={{ flex: 1 }} numberOfLines={1}>
            {position.next ? `Next: ${stepLabel(position.next)} · ${lengthOf(position.next, units)}` : 'Last step'}
          </Text>
          {zone ? (
            <Text variant="label" tone="secondary">
              {formatPaceRange(zone, units)}
            </Text>
          ) : null}
        </View>
      </View>
      <TextButton label="Skip step" icon={SkipForward} onPress={onSkip} testID="skip-step" />
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { backgroundColor: colors.surface, borderRadius: radius.card, padding: space.lg, gap: space.xs },
  body: { gap: space.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md },
});
