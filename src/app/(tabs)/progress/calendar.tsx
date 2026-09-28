import { useRouter } from 'expo-router';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { Pressable, RefreshControl, StyleSheet, View } from 'react-native';

import type { ServerRun } from '@/api/schemas';
import { RunRow } from '@/components/progress/progress-components';
import { IconButton } from '@/components/ui/buttons';
import { ChoiceChips, EmptyState, InlineStatus, TextField } from '@/components/ui/elements';
import { Card, NavHeader, Screen } from '@/components/ui/layout';
import { addDays, competitionDate, isoDateFromParts, parseIsoDate, startOfDay } from '@/domain/calendar';
import { describeDistance, formatDistance } from '@/domain/format';
import type { IsoDate } from '@/domain/types';
import { useMe, useRunsBetween } from '@/features/data/hooks';
import { ACTIVITY_FILTERS, ACTIVITY_LABEL, activityCount, type ActivityFilter } from '@/features/progress/activities';
import { addMonths, monthGrid, monthTitle } from '@/features/progress/stats-ranges';
import { useNow } from '@/lib/use-now';
import { Text } from '@/design/text';
import { colors, layout, space } from '@/design/tokens';

const FILTER_OPTIONS: { value: ActivityFilter; label: string }[] = [{ value: 'all', label: 'All' }, ...ACTIVITY_FILTERS];

const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
/** The server returns at most 400 days per query; search looks back this far. */
const SEARCH_DAYS = 399;

/** Run calendar with search and filter (docs/ROADMAP.md 1.10). Days follow the league calendar. */
export default function CalendarScreen() {
  const router = useRouter();
  const units = useMe().data?.data.profile?.units ?? 'metric';
  // Re-reads the date once a minute, so the screen follows midnight.
  const today = competitionDate(useNow(60_000));
  const now = parseIsoDate(today);
  const [month, setMonth] = useState({ year: now.year, month: now.month });
  const [selected, setSelected] = useState<IsoDate | null>(null);
  const [filter, setFilter] = useState<ActivityFilter>('all');
  const [query, setQuery] = useState('');
  const searching = query.trim().length >= 2;

  const next = addMonths(month.year, month.month, 1);
  const fromMs = startOfDay(isoDateFromParts(month.year, month.month, 1));
  const toMs = startOfDay(isoDateFromParts(next.year, next.month, 1));
  const activity = filter === 'all' ? null : filter;
  const monthRuns = useRunsBetween(fromMs, toMs, activity);
  const searchFrom = startOfDay(addDays(today, -SEARCH_DAYS));
  const searchTo = startOfDay(addDays(today, 1));
  const searchRuns = useRunsBetween(searchFrom, searchTo, activity, searching);

  const runs = useMemo(() => monthRuns.data?.data ?? [], [monthRuns.data]);
  const byDay = useMemo(() => {
    const map = new Map<IsoDate, ServerRun[]>();
    for (const r of runs) {
      const day = competitionDate(r.started_at_ms);
      map.set(day, [...(map.get(day) ?? []), r]);
    }
    return map;
  }, [runs]);
  const results = useMemo(() => {
    if (!searching) return [];
    const q = query.trim().toLowerCase();
    return (searchRuns.data?.data ?? []).filter((r) => r.title.toLowerCase().includes(q) || (r.notes ?? '').toLowerCase().includes(q));
  }, [searching, query, searchRuns.data]);

  const grid = monthGrid(month.year, month.month);
  const shown = searching ? results : selected ? (byDay.get(selected) ?? []) : runs;
  const monthDistance = runs.reduce((sum, r) => sum + r.distance_m, 0);
  const md = formatDistance(monthDistance, units);
  // With everything shown, running stays apart from the rest (docs/ROADMAP.md 2.7).
  const monthRunning = runs.filter((r) => (r.activity_type ?? 'run') === 'run');
  const runningDistance = formatDistance(
    monthRunning.reduce((sum, r) => sum + r.distance_m, 0),
    units,
  );
  const otherCount = runs.length - monthRunning.length;
  const monthSummary =
    filter === 'all'
      ? `${activityCount('run', monthRunning.length)} · ${runningDistance.value} ${runningDistance.unit}${otherCount ? ` · ${otherCount} other` : ''}`
      : `${activityCount(filter, runs.length)} · ${md.value} ${md.unit}`;
  const atCurrentMonth = month.year === now.year && month.month === now.month;

  const step = (delta: number) => {
    setMonth(addMonths(month.year, month.month, delta));
    setSelected(null);
  };

  const open = (r: ServerRun) => router.push({ pathname: '/progress/runs/[id]', params: { id: r.client_run_id, server: r.id } });

  return (
    <Screen
      edges={['top', 'bottom']}
      refreshControl={<RefreshControl refreshing={monthRuns.isFetching && !monthRuns.isPending} onRefresh={() => void monthRuns.refetch()} tintColor={colors.textSecondary} />}>
      <NavHeader title="Calendar" />
      <TextField
        label="Search runs"
        value={query}
        onChangeText={setQuery}
        placeholder="Title or note"
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        hint="Searches the last 13 months."
      />
      <ChoiceChips<ActivityFilter> label="Show" value={filter} onChange={setFilter} options={FILTER_OPTIONS} />

      {!searching ? (
        <Card>
          <View style={styles.monthHeader}>
            <IconButton icon={ChevronLeft} label="Previous month" tone="plain" onPress={() => step(-1)} />
            <View style={{ flex: 1 }} accessible accessibilityRole="header" accessibilityLabel={`${monthTitle(month.year, month.month)}. ${monthSummary.replaceAll(' · ', ', ')}.`}>
              <Text variant="section" align="center">
                {monthTitle(month.year, month.month)}
              </Text>
              <Text variant="caption" tone="secondary" align="center">
                {monthSummary}
              </Text>
            </View>
            <IconButton icon={ChevronRight} label="Next month" tone="plain" onPress={() => step(1)} disabled={atCurrentMonth} />
          </View>
          <View style={styles.weekRow} aria-hidden>
            {WEEKDAYS.map((d, i) => (
              <Text key={i} variant="caption" tone="secondary" align="center" style={styles.cell}>
                {d}
              </Text>
            ))}
          </View>
          {grid.map((week, wi) => (
            <View key={wi} style={styles.weekRow}>
              {week.map((day, di) => {
                if (!day) return <View key={di} style={styles.cell} />;
                const dayRuns = byDay.get(day) ?? [];
                const distance = dayRuns.reduce((s, r) => s + r.distance_m, 0);
                const isSelected = selected === day;
                const isToday = day === today;
                const dayNumber = parseIsoDate(day).day;
                return (
                  <Pressable
                    key={day}
                    accessibilityRole="button"
                    accessibilityLabel={`${dayNumber} ${monthTitle(month.year, month.month)}${dayRuns.length ? `, ${dayRuns.length} ${dayRuns.length === 1 ? 'activity' : 'activities'}, ${describeDistance(distance, units)}` : ', no activity'}${isToday ? ', today' : ''}`}
                    accessibilityState={{ selected: isSelected }}
                    onPress={() => setSelected(isSelected ? null : day)}
                    style={[styles.cell, styles.day]}>
                    <View style={[styles.dayCircle, dayRuns.length > 0 && styles.dayActive, isSelected && styles.daySelected, isToday && !dayRuns.length && styles.dayToday]}>
                      <Text variant="labelStrong" style={{ color: dayRuns.length > 0 ? colors.onAccent : colors.textPrimary }} maxFontSizeMultiplier={1.2}>
                        {dayNumber}
                      </Text>
                    </View>
                    <Text variant="caption" tone="secondary" maxFontSizeMultiplier={1.1} numberOfLines={1}>
                      {dayRuns.length ? formatDistance(distance, units).value : ' '}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          ))}
        </Card>
      ) : null}

      {monthRuns.data?.source === 'cache' ? <InlineStatus title="Offline — showing saved runs." /> : null}
      {monthRuns.isError && !monthRuns.data ? <InlineStatus tone="danger" title="Couldn’t load this month." body="Pull to try again." /> : null}

      <Card style={{ paddingBottom: space.sm }}>
        <Text variant="labelStrong" accessibilityRole="header">
          {searching ? `Results for “${query.trim()}”` : selected ? `Activities on ${parseIsoDate(selected).day} ${monthTitle(month.year, month.month)}` : 'This month'}
        </Text>
        {shown.length === 0 ? (
          <EmptyState icon={searching ? Search : undefined} title={searching ? (searchRuns.isPending ? 'Searching…' : 'No matching runs.') : 'Nothing here yet.'} />
        ) : (
          shown.map((r, i) => (
            <View key={r.id}>
              <RunRow
                title={r.title}
                distanceM={r.distance_m}
                activeMs={r.active_ms}
                units={units}
                status={r.status}
                onPress={() => open(r)}
                last={i === shown.length - 1}
              />
              {r.activity_type && r.activity_type !== 'run' ? (
                <Text variant="caption" tone="secondary" style={styles.kind}>
                  {ACTIVITY_LABEL[r.activity_type]} · {new Date(r.started_at_ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </Text>
              ) : null}
            </View>
          ))
        )}
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  monthHeader: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginHorizontal: -space.sm },
  weekRow: { flexDirection: 'row' },
  cell: { flex: 1, alignItems: 'center' },
  day: { minHeight: layout.minimumTapTarget + 14, gap: 2, paddingVertical: 2 },
  dayCircle: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  dayActive: { backgroundColor: colors.accent },
  daySelected: { borderWidth: 2, borderColor: colors.textPrimary },
  dayToday: { borderWidth: 1.5, borderColor: colors.controlOutline },
  kind: { marginTop: -space.sm, marginBottom: space.sm, marginLeft: 52 },
});
