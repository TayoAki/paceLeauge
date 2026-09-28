import { Flame, Snowflake } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import type { Streak } from '@/api/schemas';
import { Card } from '@/components/ui/layout';
import { Text } from '@/design/text';
import { colors, radius, space } from '@/design/tokens';

// ---------------------------------------------------------------------------------------
// Weekly streak (docs/ROADMAP.md 1.8, decision 2: weekly, never daily; calm copy, no threats)
// ---------------------------------------------------------------------------------------
function weeksText(n: number): string {
  return `${n} ${n === 1 ? 'week' : 'weeks'}`;
}

export function streakSummary(streak: Streak): { headline: string; detail: string } {
  const goal = streak.this_week.goal_days ?? 1;
  const days = streak.this_week.active_days;
  const goalText = streak.this_week.goal_days ? `${days} of ${goal} active days` : days > 0 ? 'You’ve run this week' : 'No run yet this week';
  if (streak.this_week.frozen) return { headline: streak.current_weeks > 0 ? `${weeksText(streak.current_weeks)} in a row` : 'Streak paused', detail: 'This week is paused. It won’t count for or against your streak.' };
  if (streak.current_weeks === 0) {
    return {
      headline: streak.this_week.met ? 'Streak started' : 'No streak yet',
      detail: streak.this_week.goal_days
        ? `Meet your weekly goal to start one. This week: ${goalText}.`
        : `Run at least once a week to build one. ${goalText}.`,
    };
  }
  return {
    headline: `${weeksText(streak.current_weeks)} in a row`,
    detail: streak.this_week.met ? `This week’s goal is met. Best: ${weeksText(streak.best_weeks)}.` : `This week: ${goalText}. Best: ${weeksText(streak.best_weeks)}.`,
  };
}

export function StreakCard({ streak }: { streak: Streak }) {
  const { headline, detail } = streakSummary(streak);
  const Icon = streak.this_week.frozen ? Snowflake : Flame;
  const lit = streak.current_weeks > 0 || streak.this_week.met;
  return (
    <Card>
      <View style={styles.streakRow} accessible accessibilityLabel={`Weekly streak. ${headline}. ${detail}`}>
        <View style={[styles.streakIcon, lit && styles.streakIconLit]}>
          <Icon size={26} color={lit ? colors.onAccent : colors.textSecondary} strokeWidth={2.2} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="eyebrow" tone="secondary">
            Weekly streak
          </Text>
          <Text variant="section">{headline}</Text>
          <Text variant="label" tone="secondary">
            {detail}
          </Text>
        </View>
      </View>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------
// Bar chart with a text alternative
// ---------------------------------------------------------------------------------------
export interface Bar {
  key: string;
  label: string;
  value: number;
  /** Shown above the bar; empty for zero. */
  valueLabel: string;
  /** Screen-reader text for this bar. */
  description: string;
}

export function BarChart({ bars, title, highlightLast = true }: { bars: Bar[]; title: string; highlightLast?: boolean }) {
  const max = Math.max(1, ...bars.map((b) => b.value));
  const summary = bars.map((b) => b.description).join('. ');
  // Up to eight bars each get a value and a label; more are too narrow, so only the ends are named.
  const roomy = bars.length <= 8;
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={`${title}. ${summary}.`} style={{ gap: space.md }}>
      <Text variant="labelStrong" tone="secondary">
        {title}
      </Text>
      <View style={styles.bars}>
        {bars.map((b, i) => (
          <View key={b.key} style={styles.barCell}>
            {roomy ? (
              <Text variant="caption" tone="secondary" maxFontSizeMultiplier={1.2} numberOfLines={1}>
                {b.value > 0 ? b.valueLabel : '–'}
              </Text>
            ) : null}
            <View style={styles.barTrack}>
              <View
                style={[
                  styles.bar,
                  { height: `${Math.max(4, (b.value / max) * 100)}%`, opacity: b.value > 0 ? 1 : 0.25 },
                  highlightLast && i < bars.length - 1 && styles.barMuted,
                ]}
              />
            </View>
            {roomy ? (
              <Text variant="caption" tone="secondary" maxFontSizeMultiplier={1.2} numberOfLines={1}>
                {b.label}
              </Text>
            ) : null}
          </View>
        ))}
      </View>
      {!roomy && bars.length > 0 ? (
        <View style={styles.ends}>
          <Text variant="caption" tone="secondary">
            {bars[0]!.label}
          </Text>
          <Text variant="caption" tone="secondary">
            {bars[bars.length - 1]!.label}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------------------
// Stat tiles
// ---------------------------------------------------------------------------------------
export function StatTiles({ tiles }: { tiles: { label: string; value: string; detail?: string; description: string }[] }) {
  return (
    <View style={styles.tiles}>
      {tiles.map((t) => (
        <View key={t.label} style={styles.tile} accessible accessibilityLabel={t.description}>
          <Text variant="eyebrow" tone="secondary">
            {t.label}
          </Text>
          <Text variant="metric" numberOfLines={1} adjustsFontSizeToFit>
            {t.value}
          </Text>
          {t.detail ? (
            <Text variant="caption" tone="secondary">
              {t.detail}
            </Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  streakRow: { flexDirection: 'row', alignItems: 'center', gap: space.lg },
  streakIcon: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceElevated,
  },
  streakIconLit: { backgroundColor: colors.accent },
  bars: { flexDirection: 'row', alignItems: 'flex-end', gap: space.xs, height: 150 },
  barCell: { flex: 1, alignItems: 'center', gap: space.xs, height: '100%' },
  barTrack: { flex: 1, width: '70%', justifyContent: 'flex-end' },
  bar: { width: '100%', backgroundColor: colors.accent, borderRadius: 4 },
  barMuted: { backgroundColor: colors.textSecondary },
  ends: { flexDirection: 'row', justifyContent: 'space-between', marginTop: -space.xs },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: space.md },
  tile: {
    flexGrow: 1,
    flexBasis: '45%',
    gap: 2,
    padding: space.lg,
    borderRadius: radius.control,
    backgroundColor: colors.surfaceElevated,
  },
});
