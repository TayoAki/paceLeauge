import { useMemo, useState } from 'react';
import { RefreshControl, StyleSheet, View } from 'react-native';

import type { Stats } from '@/api/schemas';
import { BarChart, StatTiles } from '@/components/progress/progress-extras';
import { ChoiceChips, InlineStatus, SegmentedControl, TextField } from '@/components/ui/elements';
import { Card, NavHeader, Screen } from '@/components/ui/layout';
import { competitionDate } from '@/domain/calendar';
import { describeDistance, describeDuration, formatDistance, formatDuration, formatPace } from '@/domain/format';
import type { Units } from '@/domain/types';
import { useMe, useStats } from '@/features/data/hooks';
import { bucketLabel, bucketLabelLong, rangeFor, type RangeKey } from '@/features/progress/stats-ranges';
import { useNow } from '@/lib/use-now';
import { Text } from '@/design/text';
import { colors, space } from '@/design/tokens';

type Activity = 'run' | 'walk' | 'all';

const RANGES: { value: RangeKey; label: string }[] = [
  { value: '12w', label: '12 weeks' },
  { value: '12m', label: '12 months' },
  { value: 'ytd', label: 'This year' },
  { value: '5y', label: '5 years' },
  { value: 'custom', label: 'Custom' },
];

function change(now: number, before: number): string | undefined {
  if (before <= 0) return now > 0 ? 'Nothing a year earlier' : undefined;
  const pct = Math.round(((now - before) / before) * 100);
  return `${pct >= 0 ? '+' : ''}${pct}% vs a year ago`;
}

/** Stats and trends (docs/ROADMAP.md 1.7): totals by week, month or year, the same range a year earlier, and pace over time. */
export default function StatsScreen() {
  const units = useMe().data?.data.profile?.units ?? 'metric';
  // Re-reads the date once a minute, so the screen follows midnight.
  const today = competitionDate(useNow(60_000));
  const [rangeKey, setRangeKey] = useState<RangeKey>('12w');
  const [activity, setActivity] = useState<Activity>('run');
  const [custom, setCustom] = useState({ from: `${today.slice(0, 4)}-01-01`, to: today });
  const range = useMemo(() => rangeFor(rangeKey, today, custom) ?? rangeFor('12w', today)!, [rangeKey, today, custom]);
  const customValid = rangeKey !== 'custom' || rangeFor('custom', today, custom) !== null;
  const stats = useStats({ from: range.from, to: range.to, bucket: range.bucket, activity });
  const data = stats.data?.data;

  return (
    <Screen
      edges={['top', 'bottom']}
      refreshControl={<RefreshControl refreshing={stats.isFetching && !stats.isPending} onRefresh={() => void stats.refetch()} tintColor={colors.textSecondary} />}>
      <NavHeader title="Stats and trends" />
      <ChoiceChips<RangeKey> label="Date range" value={rangeKey} onChange={setRangeKey} options={RANGES} />
      {rangeKey === 'custom' ? (
        <View style={styles.custom}>
          <View style={{ flex: 1 }}>
            <TextField label="From" value={custom.from} onChangeText={(from) => setCustom((c) => ({ ...c, from }))} placeholder="YYYY-MM-DD" autoCapitalize="none" autoCorrect={false} />
          </View>
          <View style={{ flex: 1 }}>
            <TextField label="To" value={custom.to} onChangeText={(to) => setCustom((c) => ({ ...c, to }))} placeholder="YYYY-MM-DD" autoCapitalize="none" autoCorrect={false} />
          </View>
        </View>
      ) : null}
      {!customValid ? <InlineStatus tone="warning" title="Enter two dates as YYYY-MM-DD, up to ten years apart." body="Showing the last 12 weeks until then." /> : null}
      <SegmentedControl<Activity>
        label="Activity"
        value={activity}
        onChange={setActivity}
        options={[
          { value: 'run', label: 'Runs' },
          { value: 'walk', label: 'Walks' },
          { value: 'all', label: 'All' },
        ]}
      />

      {stats.data?.source === 'cache' ? <InlineStatus title="Offline — showing saved stats." /> : null}
      {stats.isError && !data ? <InlineStatus tone="danger" title="Couldn’t load your stats." body="Pull to try again." /> : null}
      {data ? <StatsBody stats={data} units={units} /> : null}
    </Screen>
  );
}

function StatsBody({ stats, units }: { stats: Stats; units: Units }) {
  const total = stats.total;
  const before = stats.previous_year;
  const d = formatDistance(total.distance_m, units);
  const longest = formatDistance(total.longest_m, units);
  const pace = formatPace(total.active_ms, total.distance_m, units);
  const bars = stats.buckets.map((b) => {
    const bd = formatDistance(b.distance_m, units);
    return {
      key: b.start,
      label: bucketLabel(b.start, stats.bucket),
      value: b.distance_m,
      valueLabel: bd.value,
      description: `${bucketLabelLong(b.start, stats.bucket)}: ${describeDistance(b.distance_m, units)}, ${b.runs} ${b.runs === 1 ? 'activity' : 'activities'}`,
    };
  });
  const paced = stats.buckets.filter((b) => b.distance_m >= 100).slice(-6);

  return (
    <>
      <StatTiles
        tiles={[
          {
            label: 'Distance',
            value: `${d.value} ${d.unit}`,
            detail: change(total.distance_m, before.distance_m),
            description: `Distance ${describeDistance(total.distance_m, units)}. ${change(total.distance_m, before.distance_m) ?? ''}`,
          },
          { label: 'Time', value: formatDuration(total.active_ms), description: `Active time ${describeDuration(total.active_ms)}` },
          {
            label: 'Activities',
            value: String(total.runs),
            detail: change(total.runs, before.runs),
            description: `${total.runs} activities. ${change(total.runs, before.runs) ?? ''}`,
          },
          { label: 'Active days', value: String(total.days), description: `${total.days} active days` },
          { label: 'Avg pace', value: `${pace.value} ${pace.unit}`, description: `Average pace ${pace.value} ${pace.unitLong}` },
          { label: 'Longest', value: `${longest.value} ${longest.unit}`, description: `Longest ${describeDistance(total.longest_m, units)}` },
        ]}
      />
      <Card>
        <BarChart title={`Distance by ${stats.bucket}`} bars={bars} />
        <Text variant="caption" tone="secondary">
          A year earlier: {formatDistance(before.distance_m, units).value} {formatDistance(before.distance_m, units).unit} over {before.runs}{' '}
          {before.runs === 1 ? 'activity' : 'activities'}.
        </Text>
      </Card>
      {paced.length > 1 ? (
        <Card>
          <Text variant="labelStrong" accessibilityRole="header">
            Pace trend
          </Text>
          {paced.map((b, i) => {
            const p = formatPace(b.active_ms, b.distance_m, units);
            const prev = paced[i - 1];
            const faster = prev ? b.active_ms / b.distance_m < prev.active_ms / prev.distance_m : null;
            return (
              <View key={b.start} style={styles.paceRow} accessible accessibilityLabel={`${bucketLabelLong(b.start, stats.bucket)}: ${p.value} ${p.unitLong}${faster === null ? '' : faster ? ', faster' : ', slower'}`}>
                <Text variant="body" tone="secondary" style={{ flex: 1 }}>
                  {bucketLabelLong(b.start, stats.bucket)}
                </Text>
                <Text variant="bodyStrong" style={{ fontVariant: ['tabular-nums'] }}>
                  {p.value} {p.unit}
                </Text>
                <Text variant="caption" tone={faster ? 'accent' : 'secondary'} style={styles.trend}>
                  {faster === null ? '' : faster ? '▲ faster' : '▼ slower'}
                </Text>
              </View>
            );
          })}
        </Card>
      ) : null}
      <Text variant="caption" tone="secondary">
        Includes every saved activity, whether or not it counted for your league. Deleted activities are left out.
      </Text>
    </>
  );
}

const styles = StyleSheet.create({
  custom: { flexDirection: 'row', gap: space.md },
  paceRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 36 },
  trend: { width: 70, textAlign: 'right' },
});
