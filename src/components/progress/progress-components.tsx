import { Check, ChevronRight, Footprints } from 'lucide-react-native';
import { Pressable, StyleSheet, View } from 'react-native';

import { SlantLanes, TierChevron } from '@/components/art/art';
import { Card } from '@/components/ui/layout';
import { Pill, ProgressBar } from '@/components/ui/elements';
import { competitionDate, isoWeekday } from '@/domain/calendar';
import { describeDistance, describeDuration, formatDistance, formatDuration, formatXp } from '@/domain/format';
import { tierProgress } from '@/domain/scoring';
import type { Units } from '@/domain/types';
import { Text } from '@/design/text';
import { colors, space } from '@/design/tokens';
import { useNow } from '@/lib/use-now';

// ---------------------------------------------------------------------------------------
// Tier card (TierCard: tier / XP / next threshold)
// ---------------------------------------------------------------------------------------
export function TierCard({ lifetimeXp, variant = 'today' }: { lifetimeXp: number; variant?: 'today' | 'progress' }) {
  const t = tierProgress(lifetimeXp);
  const next = t.nextTier ? `${formatXp(t.xpToNextTier ?? 0)} to ${t.nextTier}` : 'Top tier reached';
  const a11y = `${t.tier} tier, ${formatXp(lifetimeXp)} XP. ${t.nextTier ? `${formatXp(t.xpToNextTier ?? 0)} XP to ${t.nextTier}.` : 'Top tier reached.'} Rank never drops for rest days.`;

  if (variant === 'progress') {
    return (
      <Card style={styles.tierCard}>
        <View accessible accessibilityLabel={a11y} style={styles.progressTierRow}>
          <SlantLanes />
          <View style={{ flex: 1 }}>
            <Text variant="eyebrow" tone="secondary">
              {t.tier}
            </Text>
            <Text variant="hero" numberOfLines={1} adjustsFontSizeToFit style={styles.tierXp}>
              {formatXp(lifetimeXp)}
              <Text variant="title"> XP</Text>
            </Text>
            <Text variant="body">{next}</Text>
          </View>
        </View>
        <ProgressBar fraction={t.fraction} label={`${Math.round(t.fraction * 1000) / 10} percent through ${t.tier}`} />
        <View style={styles.tierLabels} aria-hidden>
          <Text variant="caption">{t.tier}</Text>
          <Text variant="caption" tone="secondary">
            {t.nextTier ?? 'Elite'}
          </Text>
        </View>
      </Card>
    );
  }

  return (
    <Card style={[styles.tierCard, styles.todayTier]}>
      <View style={styles.chevron} pointerEvents="none">
        <TierChevron />
      </View>
      <View accessible accessibilityLabel={a11y} style={styles.todayTierText}>
        <Text variant="eyebrow" tone="secondary">
          {t.tier}
        </Text>
        <Text variant="hero" numberOfLines={1} adjustsFontSizeToFit style={styles.tierXp}>
          {formatXp(lifetimeXp)}
          <Text variant="title"> XP</Text>
        </Text>
        <Text variant="body">{next}</Text>
      </View>
      <View style={styles.todayBar}>
        <ProgressBar fraction={t.fraction} label={`${Math.round(t.fraction * 1000) / 10} percent through ${t.tier}`} />
      </View>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------
// Weekly goal (completed / target / day markers)
// ---------------------------------------------------------------------------------------
const DAY_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export interface GoalDay {
  date: string;
  active: boolean;
  /** A saved run on this day is still waiting for the server. */
  pending?: boolean;
}

function goalHeadline(active: number, goal: number | null): string {
  if (goal) return `${Math.min(active, 7)} of ${goal} active day${goal === 1 ? '' : 's'}`;
  return `${active} active day${active === 1 ? '' : 's'}`;
}

export function WeeklyGoal({ days, goalDays, now, title = 'Your week' }: { days: GoalDay[]; goalDays: number | null; now?: number; title?: string }) {
  const clock = useNow(60_000);
  const active = days.filter((d) => d.active).length;
  const pending = days.filter((d) => !d.active && d.pending).length;
  const today = competitionDate(now ?? clock);
  const activeNames = days.filter((d) => d.active).map((d) => DAY_NAMES[isoWeekday(d.date)]);
  const a11y = `${title}: ${goalHeadline(active, goalDays)}${pending ? `, ${pending} pending` : ''}. ${
    activeNames.length ? `Active on ${activeNames.join(', ')}.` : 'No active days yet.'
  } Rest days keep your rank.`;
  return (
    <Card>
      <View accessible accessibilityLabel={a11y} style={{ gap: space.lg }}>
        <View style={styles.goalHeader}>
          <Text variant="eyebrow" tone="secondary">
            {title}
          </Text>
          <Text variant="label">
            {goalHeadline(active, goalDays)}
            {pending ? ` · ${pending} pending` : ''}
          </Text>
        </View>
        <View style={styles.dayRow}>
          {days.map((d, i) => (
            <View key={d.date} style={styles.dayCell}>
              <View
                style={[
                  styles.dayMarker,
                  d.active && styles.dayActive,
                  !d.active && d.pending && styles.dayPending,
                  d.date === today && !d.active && styles.dayToday,
                ]}>
                {d.active ? <Check size={20} color={colors.onAccent} strokeWidth={3} /> : null}
              </View>
              <Text variant="caption" tone={d.date === today ? 'primary' : 'secondary'} maxFontSizeMultiplier={1.3}>
                {DAY_LETTERS[i]}
              </Text>
            </View>
          ))}
        </View>
        <Text variant="label" tone="secondary">
          Rest days keep your rank.
        </Text>
      </View>
    </Card>
  );
}

/** Compact goal circles for the Progress screen ("3 of 3 active days"). */
export function GoalCircles({ active, goal }: { active: number; goal: number | null }) {
  const circles = Math.max(goal ?? 0, Math.min(active, 7));
  return (
    <Card>
      <View accessible accessibilityLabel={`This week: ${goalHeadline(active, goal)}`} style={{ gap: space.md }}>
        <Text variant="labelStrong">This week</Text>
        <Text variant="title">{goalHeadline(active, goal)}</Text>
        {circles > 0 ? (
          <View style={styles.circleRow}>
            {Array.from({ length: circles }, (_, i) => (
              <View key={i} style={[styles.dayMarker, i < active && styles.dayActive]}>
                {i < active ? <Check size={20} color={colors.onAccent} strokeWidth={3} /> : null}
              </View>
            ))}
          </View>
        ) : null}
      </View>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------
// Distance — last four weeks (chart with a text summary)
// ---------------------------------------------------------------------------------------
export function DistanceBars({ weeks, units }: { weeks: { weekStart: string; distanceM: number }[]; units: Units }) {
  const max = Math.max(1, ...weeks.map((w) => w.distanceM));
  const summary = weeks.map((w, i) => `Week ${i + 1}: ${describeDistance(w.distanceM, units)}`).join('. ');
  return (
    <Card>
      <View accessible accessibilityRole="image" accessibilityLabel={`Distance, last 4 weeks. ${summary}.`} style={{ gap: space.md }}>
        <Text variant="labelStrong" tone="secondary">
          Distance · last 4 weeks
        </Text>
        <View style={styles.bars}>
          {weeks.map((w, i) => {
            const d = formatDistance(w.distanceM, units);
            return (
              <View key={w.weekStart} style={styles.barCell}>
                <Text variant="caption" tone="secondary" maxFontSizeMultiplier={1.2}>
                  {d.value}
                </Text>
                <View style={styles.barTrack}>
                  <View
                    style={[
                      styles.bar,
                      {
                        height: `${Math.max(4, (w.distanceM / max) * 100)}%`,
                        opacity: w.distanceM > 0 ? 1 : 0.25,
                      },
                    ]}
                  />
                </View>
                <Text variant="caption" tone="secondary" maxFontSizeMultiplier={1.2}>
                  W{i + 1}
                </Text>
              </View>
            );
          })}
        </View>
      </View>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------
// Run rows
// ---------------------------------------------------------------------------------------
export type RunRowStatus = 'accepted' | 'personal_only' | 'review' | 'saved_local' | 'syncing' | 'needs_attention' | 'uploading';

const statusLabel: Partial<Record<RunRowStatus, string>> = {
  personal_only: 'Personal',
  review: 'In review',
  saved_local: 'On this phone',
  syncing: 'Syncing',
  uploading: 'Syncing',
  needs_attention: 'Needs attention',
};

export function RunRow({
  title,
  distanceM,
  activeMs,
  units,
  status,
  onPress,
  last,
}: {
  title: string;
  distanceM: number;
  activeMs: number;
  units: Units;
  status: RunRowStatus;
  onPress?: () => void;
  last?: boolean;
}) {
  const d = formatDistance(distanceM, units);
  const tag = statusLabel[status];
  const a11y = `${title}. ${describeDistance(distanceM, units)}, ${describeDuration(activeMs)}.${tag ? ` ${tag}.` : ''}`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={a11y}
      onPress={onPress}
      style={({ pressed }) => [styles.runRow, !last && styles.runRowDivider, pressed && { opacity: 0.7 }]}>
      <View style={styles.runIcon}>
        <Footprints size={20} color={colors.accent} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="bodyStrong" numberOfLines={1}>
          {title}
        </Text>
        <Text variant="label" tone="secondary">
          {d.value} {d.unit} · {formatDuration(activeMs)}
        </Text>
      </View>
      {tag ? <Pill label={tag} tone={status === 'needs_attention' ? 'danger' : 'neutral'} /> : null}
      <ChevronRight size={20} color={colors.textSecondary} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tierCard: { overflow: 'hidden' },
  todayTier: { minHeight: 196, justifyContent: 'space-between' },
  chevron: {
    position: 'absolute',
    right: -24,
    top: -6,
    bottom: 0,
    justifyContent: 'center',
  },
  todayTierText: { gap: 2, maxWidth: '72%' },
  todayBar: { marginTop: space.lg, maxWidth: '100%' },
  tierXp: { marginVertical: 2 },
  progressTierRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.lg,
  },
  tierLabels: { flexDirection: 'row', justifyContent: 'space-between' },
  goalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: space.sm,
    flexWrap: 'wrap',
  },
  dayRow: { flexDirection: 'row', justifyContent: 'space-between' },
  dayCell: { alignItems: 'center', gap: space.sm },
  dayMarker: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 2,
    borderColor: colors.controlOutline,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dayActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  dayPending: { borderColor: colors.accent, borderStyle: 'dashed' },
  dayToday: { borderColor: colors.textPrimary },
  circleRow: { flexDirection: 'row', gap: space.md },
  bars: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    height: 150,
    gap: space.lg,
  },
  barCell: { flex: 1, alignItems: 'center', gap: space.sm, height: '100%' },
  barTrack: { flex: 1, width: '100%', justifyContent: 'flex-end' },
  bar: { width: '100%', backgroundColor: colors.accent, borderRadius: 6 },
  runRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.md,
    minHeight: 64,
  },
  runRowDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth * 2,
    borderBottomColor: colors.decorativeDivider,
  },
  runIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.surfaceElevated,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
