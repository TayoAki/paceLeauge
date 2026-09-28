import { useRouter } from 'expo-router';
import { ChevronDown, ChevronUp, Trophy } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, RefreshControl, StyleSheet, View } from 'react-native';

import type { EffortKey, PersonalRecords } from '@/api/schemas';
import { EmptyState, InlineStatus } from '@/components/ui/elements';
import { Card, NavHeader, Screen } from '@/components/ui/layout';
import { describeDistance, describeDuration, formatDistance } from '@/domain/format';
import type { Units } from '@/domain/types';
import { useMe, usePersonalRecords, useRecordHistory } from '@/features/data/hooks';
import { effortLabel, effortSpoken, formatEffort, shortDate } from '@/features/progress/records';
import { Text } from '@/design/text';
import { colors, space } from '@/design/tokens';

type RecordRow = PersonalRecords['records'][number];

/** Personal records (docs/ROADMAP.md 1.4): fastest 1K, mile, 5K, 10K, half and marathon, and the longest run. */
export default function RecordsScreen() {
  const router = useRouter();
  const records = usePersonalRecords();
  const units = useMe().data?.data.profile?.units ?? 'metric';
  const [open, setOpen] = useState<EffortKey | null>(null);
  const data = records.data?.data;
  const any = data?.records.some((r) => r.best) ?? false;

  return (
    <Screen
      edges={['top', 'bottom']}
      refreshControl={<RefreshControl refreshing={records.isFetching && !records.isPending} onRefresh={() => void records.refetch()} tintColor={colors.textSecondary} />}>
      <NavHeader title="Personal records" />
      {records.data?.source === 'cache' ? <InlineStatus title="Offline — showing saved records." /> : null}
      {records.isError && !data ? <InlineStatus tone="danger" title="Couldn’t load your records." body="Pull to try again." /> : null}
      <Text variant="body" tone="secondary">
        Your fastest time for each distance within any run that counted, measured along your route. Records don’t change your XP.
      </Text>

      {data && !any ? (
        <EmptyState icon={Trophy} title="No records yet." body="Run a kilometer or more and your first records appear here." />
      ) : null}

      {data?.longest_run ? (
        <Card>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Longest run, ${describeDistance(data.longest_run.distance_m, units)}, ${data.longest_run.title}, ${shortDate(data.longest_run.started_at_ms)}`}
            onPress={() => router.push({ pathname: '/progress/runs/[id]', params: { id: data.longest_run!.run_id, server: data.longest_run!.run_id } })}
            style={({ pressed }) => [styles.longest, pressed && { opacity: 0.7 }]}>
            <View style={{ flex: 1 }}>
              <Text variant="eyebrow" tone="secondary">
                Longest run
              </Text>
              <Text variant="metric">
                {formatDistance(data.longest_run.distance_m, units).value} {formatDistance(data.longest_run.distance_m, units).unit}
              </Text>
              <Text variant="label" tone="secondary" numberOfLines={1}>
                {data.longest_run.title} · {shortDate(data.longest_run.started_at_ms)}
              </Text>
            </View>
          </Pressable>
        </Card>
      ) : null}

      {data && any ? (
        <Card style={{ paddingVertical: space.sm }}>
          {data.records.map((r, i) => (
            <RecordItem
              key={r.effort}
              record={r}
              units={units}
              open={open === r.effort}
              onToggle={() => setOpen(open === r.effort ? null : r.effort)}
              onOpenRun={(runId) => router.push({ pathname: '/progress/runs/[id]', params: { id: runId, server: runId } })}
              last={i === data.records.length - 1}
            />
          ))}
        </Card>
      ) : null}
    </Screen>
  );
}

function RecordItem({
  record,
  units,
  open,
  onToggle,
  onOpenRun,
  last,
}: {
  record: RecordRow;
  units: Units;
  open: boolean;
  onToggle: () => void;
  onOpenRun: (runId: string) => void;
  last: boolean;
}) {
  const best = record.best;
  const label = effortLabel(record.effort);
  const a11y = best
    ? `${effortSpoken(record.effort)} record, ${describeDuration(best.elapsed_ms)}, ${shortDate(best.started_at_ms)}. ${record.efforts} ${record.efforts === 1 ? 'effort' : 'efforts'}.`
    : `${effortSpoken(record.effort)}: no record yet.`;
  return (
    <View style={[styles.item, !last && styles.divider]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={a11y}
        accessibilityHint={best ? (open ? 'Hides the history' : 'Shows how this record improved') : undefined}
        accessibilityState={{ expanded: open, disabled: !best }}
        disabled={!best}
        onPress={onToggle}
        style={({ pressed }) => [styles.itemRow, pressed && { opacity: 0.7 }]}>
        <Text variant="bodyStrong" style={styles.effort}>
          {label}
        </Text>
        <View style={{ flex: 1 }}>
          <Text variant="metric" tone={best ? 'primary' : 'secondary'} style={styles.time}>
            {best ? formatEffort(best.elapsed_ms) : '—'}
          </Text>
          {best ? (
            <Text variant="caption" tone="secondary" numberOfLines={1}>
              {shortDate(best.started_at_ms)} · {formatPaceFor(best.elapsed_ms, record.distance_m, units)}
            </Text>
          ) : null}
        </View>
        {best ? open ? <ChevronUp size={20} color={colors.textSecondary} /> : <ChevronDown size={20} color={colors.textSecondary} /> : null}
      </Pressable>
      {open ? <RecordHistory effort={record.effort} onOpenRun={onOpenRun} /> : null}
    </View>
  );
}

function formatPaceFor(elapsedMs: number, distanceM: number, units: Units): string {
  const perUnit = units === 'imperial' ? 1609.344 : 1000;
  const seconds = Math.round(elapsedMs / 1000 / (distanceM / perUnit));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} /${units === 'imperial' ? 'mi' : 'km'}`;
}

function RecordHistory({ effort, onOpenRun }: { effort: EffortKey; onOpenRun: (runId: string) => void }) {
  const history = useRecordHistory(effort);
  const rows = history.data?.data ?? [];
  if (history.isPending) {
    return (
      <Text variant="label" tone="secondary" style={styles.historyNote}>
        Loading…
      </Text>
    );
  }
  if (history.isError) return <InlineStatus tone="info" title="Couldn’t load the history." />;
  return (
    <View style={styles.history}>
      <Text variant="caption" tone="secondary">
        Each time this record improved
      </Text>
      {[...rows].reverse().map((h, i) => (
        <Pressable
          key={h.run_id}
          accessibilityRole="button"
          accessibilityLabel={`${describeDuration(h.elapsed_ms)} on ${shortDate(h.started_at_ms)}, ${h.title}${i === 0 ? ', current record' : ''}`}
          onPress={() => onOpenRun(h.run_id)}
          style={({ pressed }) => [styles.historyRow, pressed && { opacity: 0.7 }]}>
          <Text variant="bodyStrong" style={styles.time}>
            {formatEffort(h.elapsed_ms)}
          </Text>
          <Text variant="label" tone="secondary" numberOfLines={1} style={{ flex: 1 }}>
            {shortDate(h.started_at_ms)} · {h.title}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  longest: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  item: { paddingVertical: space.sm },
  divider: { borderBottomWidth: 1, borderBottomColor: colors.decorativeDivider },
  itemRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 56 },
  effort: { width: 110 },
  time: { fontVariant: ['tabular-nums'] },
  history: { gap: space.xs, paddingLeft: 110 + space.md, paddingBottom: space.sm },
  historyRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 36 },
  historyNote: { paddingLeft: 110 + space.md },
});
