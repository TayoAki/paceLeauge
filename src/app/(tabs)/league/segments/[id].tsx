import { useLocalSearchParams, useRouter } from 'expo-router';
import { Archive, Award } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { Pressable, RefreshControl, StyleSheet, View } from 'react-native';

import type { SegmentBoardRow } from '@/api/segments-api';
import { RouteMap } from '@/components/run/route-map';
import { ReportSheet, type ReportTarget } from '@/components/social/report-sheet';
import { PrimaryButton, TextButton } from '@/components/ui/buttons';
import { ConfirmSheet } from '@/components/ui/confirm-sheet';
import { InlineStatus, Pill, TextField } from '@/components/ui/elements';
import { Card, NavHeader, Screen } from '@/components/ui/layout';
import { ordinal } from '@/domain/format';
import { useMe } from '@/features/data/hooks';
import { routeDistance } from '@/features/routes/route-text';
import { effortDate, effortPace, formatElapsed, myDaysLine, regularLine, segmentSummary } from '@/features/segments/segment-text';
import { useSegment, useSegmentActions } from '@/features/segments/use-segments';
import { Text } from '@/design/text';
import { colors, radius, space } from '@/design/tokens';

function BoardRow({ row, onPress }: { row: SegmentBoardRow; onPress?: () => void }) {
  const name = row.is_me ? 'You' : row.alias;
  const time = formatElapsed(row.elapsed_ms);
  const body = (
    <>
      <Text variant="section" tone="secondary" style={styles.place} maxFontSizeMultiplier={1.3}>
        {row.place}
      </Text>
      <View style={styles.fill}>
        <Text variant="bodyStrong" numberOfLines={1}>
          {name}
        </Text>
        <Text variant="caption" tone="secondary">
          {effortDate(row.run_at_ms)}
        </Text>
      </View>
      <Text variant="section">{time}</Text>
    </>
  );
  const label = `${ordinal(row.place)}, ${name}, ${time}, ${effortDate(row.run_at_ms)}`;
  return onPress ? (
    <Pressable
      style={({ pressed }) => [styles.row, row.is_me && styles.me, pressed && { opacity: 0.8 }]}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint="Report this time"
      onPress={onPress}>
      {body}
    </Pressable>
  ) : (
    <View style={[styles.row, row.is_me && styles.me]} accessible accessibilityLabel={label}>
      {body}
    </View>
  );
}

/**
 * A segment (docs/ROADMAP.md 5.3): its line on the map, the local regular (most different days in
 * the last 90), each runner's best time, and the runner's own times. Staff can retire it.
 */
export default function SegmentScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  // Set while retiring, so the segment isn't fetched again once it's gone.
  const [retiring, setRetiring] = useState(false);
  const query = useSegment(typeof id === 'string' && !retiring ? id : null);
  const segment = query.data?.data;
  const me = useMe().data?.data;
  const units = me?.profile?.units ?? 'metric';
  const actions = useSegmentActions();
  const [report, setReport] = useState<ReportTarget | null>(null);
  const [confirmRetire, setConfirmRetire] = useState(false);
  const [reason, setReason] = useState('');
  const guide = useMemo(() => (segment ? segment.points.map((p) => ({ latitude: p[0], longitude: p[1] })) : []), [segment]);

  const retire = async () => {
    if (!segment) return;
    setRetiring(true);
    const done = await actions.retire(segment.id, reason);
    if (done === null) {
      setRetiring(false);
      return;
    }
    setConfirmRetire(false);
    router.back();
  };

  const mine = segment?.board.find((r) => r.is_me) ?? null;
  const days = segment ? myDaysLine(segment.my_days, segment.legend) : null;

  return (
    <Screen
      edges={['top', 'bottom']}
      refreshControl={
        <RefreshControl refreshing={query.isFetching && !query.isPending} onRefresh={() => void query.refetch()} tintColor={colors.textSecondary} />
      }>
      <NavHeader title={segment?.name ?? 'Segment'} />
      {query.isPending ? (
        <Text variant="label" tone="secondary">
          Loading…
        </Text>
      ) : null}
      {query.isError && !segment ? <InlineStatus tone="danger" title="Couldn’t load this segment." body="It may have been retired. Pull to try again." /> : null}
      {query.data?.source === 'cache' ? <InlineStatus title="Showing this segment from earlier." body="You’re offline." /> : null}
      {segment ? (
        <>
          <RouteMap lines={[]} guide={guide} height={240} interactive accessibilityLabel={`Map of the ${segment.name} segment, ${routeDistance(segment.distance_m, units)}.`} />
          <Text variant="body" tone="secondary">
            {segmentSummary(segment, units)} · timed one way, from the ring on the map to the other end
          </Text>

          {!segment.joined ? (
            <Card style={styles.card}>
              <Text variant="body" tone="secondary">
                Join the segment boards to be timed here, from runs you share with everyone, map included. Only your runner name and time are shown.
              </Text>
              <PrimaryButton label="Join the segment boards" onPress={() => void actions.join()} loading={actions.busy} testID="segment-join" />
            </Card>
          ) : null}
          {actions.error && !confirmRetire ? <InlineStatus tone="danger" title={actions.error} /> : null}

          <Card style={styles.card}>
            <View style={styles.head}>
              <Award size={20} color={colors.accent} />
              <Text variant="labelStrong" accessibilityRole="header" style={styles.fill}>
                Local regular
              </Text>
            </View>
            <Text variant="body">{regularLine(segment.legend)}</Text>
            {days ? (
              <Text variant="caption" tone="secondary">
                {days}
              </Text>
            ) : null}
          </Card>

          {segment.my_best_ms !== null ? (
            <Text variant="body" testID="segment-best">
              Your best: {formatElapsed(segment.my_best_ms)} ({effortPace(segment.my_best_ms, segment.distance_m, units)})
              {mine ? `, ${ordinal(mine.place)} of ${segment.runners}` : ''}
            </Text>
          ) : null}

          <Text variant="labelStrong" accessibilityRole="header">
            Best times
          </Text>
          <View style={styles.board}>
            {segment.board.map((r) => (
              <BoardRow key={r.effort_id} row={r} onPress={r.is_me ? undefined : () => setReport({ kind: 'segment', id: r.effort_id, owner: null })} />
            ))}
            {segment.board.length === 0 ? (
              <Text variant="label" tone="secondary">
                No times yet. Be the first.
              </Text>
            ) : null}
          </View>

          {segment.my_efforts.length > 0 ? (
            <Card style={styles.card}>
              <Text variant="labelStrong" accessibilityRole="header">
                Your times
              </Text>
              {segment.my_efforts.map((e) => (
                <View key={e.effort_id} style={styles.effort} accessible>
                  <Text variant="label" tone="secondary" style={styles.fill}>
                    {effortDate(e.run_at_ms)}
                  </Text>
                  {e.status === 'held' ? <Pill label="Being checked" tone="neutral" /> : null}
                  <Text variant="bodyStrong">{formatElapsed(e.elapsed_ms)}</Text>
                </View>
              ))}
              {segment.my_efforts.some((e) => e.status === 'held') ? (
                <Text variant="caption" tone="secondary">
                  A time faster than a runner could go is checked by a person before it goes on the board.
                </Text>
              ) : null}
            </Card>
          ) : null}

          {me?.is_staff ? (
            <TextButton label="Retire segment" icon={Archive} tone="danger" onPress={() => setConfirmRetire(true)} testID="retire-segment" />
          ) : null}
        </>
      ) : null}

      <ConfirmSheet
        visible={confirmRetire}
        title="Retire this segment?"
        body="It comes off the list and its board for everyone, and runs aren’t matched to it any more. The reason goes in the moderation log."
        confirmLabel="Retire segment"
        destructive
        busy={actions.busy}
        onConfirm={() => void retire()}
        onCancel={() => {
          actions.clearError();
          setConfirmRetire(false);
        }}>
        <TextField label="Reason" value={reason} onChangeText={setReason} maxLength={200} testID="retire-reason" />
        {actions.error ? <InlineStatus tone="danger" title={actions.error} /> : null}
      </ConfirmSheet>
      <ReportSheet target={report} onClose={() => setReport(null)} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: { gap: space.sm },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  fill: { flex: 1 },
  board: { gap: space.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: colors.surface,
    borderRadius: radius.control + 4,
    paddingHorizontal: space.lg,
    minHeight: 56,
    borderWidth: 1.5,
    borderColor: 'transparent',
  },
  me: { borderColor: colors.accent },
  place: { minWidth: 28, textAlign: 'center' },
  effort: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 32 },
});
