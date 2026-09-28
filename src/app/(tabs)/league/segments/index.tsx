import { useRouter } from 'expo-router';
import { LogOut, Timer } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, RefreshControl, StyleSheet, View } from 'react-native';

import type { SegmentSummary } from '@/api/segments-api';
import { RouteSketch } from '@/components/run/route-sketch';
import { PrimaryButton, TextButton } from '@/components/ui/buttons';
import { ConfirmSheet } from '@/components/ui/confirm-sheet';
import { EmptyState, InlineStatus } from '@/components/ui/elements';
import { Card, NavHeader, Screen } from '@/components/ui/layout';
import type { Units } from '@/domain/types';
import { useMe } from '@/features/data/hooks';
import { formatElapsed, segmentSummary } from '@/features/segments/segment-text';
import { useSegmentActions, useSegments } from '@/features/segments/use-segments';
import { Text } from '@/design/text';
import { colors, radius, space } from '@/design/tokens';

function SegmentRow({ segment, units, onPress }: { segment: SegmentSummary; units: Units; onPress: () => void }) {
  const preview = (segment.preview ?? []).map((p) => ({ latitude: p[0], longitude: p[1] }));
  const summary = segmentSummary(segment, units);
  const runners = `${segment.runners} ${segment.runners === 1 ? 'runner' : 'runners'}`;
  const best = segment.my_best_ms !== null ? `Your best ${formatElapsed(segment.my_best_ms)}` : null;
  const line = [best, runners].filter(Boolean).join(' · ');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${segment.name}, ${summary}, ${line}`}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.surfaceElevated }]}
      testID={`segment-${segment.id}`}>
      <View style={styles.thumb}>
        <RouteSketch lines={[]} guide={preview} height={56} width={72} bare />
      </View>
      <View style={styles.fill}>
        <Text variant="bodyStrong" numberOfLines={1}>
          {segment.name}
        </Text>
        <Text variant="caption" tone="secondary">
          {summary}
        </Text>
        <Text variant="caption" tone="secondary">
          {line}
        </Text>
      </View>
    </Pressable>
  );
}

/**
 * Segments (docs/ROADMAP.md 5.3): stretches of path picked by PaceLeague, each with a board of
 * best times and a local regular. Only runners who join are timed, from runs they share with
 * everyone, map included; the boards show a runner name and a time, never a route.
 */
export default function SegmentsScreen() {
  const router = useRouter();
  const query = useSegments();
  const data = query.data?.data;
  const units = useMe().data?.data.profile?.units ?? 'metric';
  const actions = useSegmentActions();
  const [confirmLeave, setConfirmLeave] = useState(false);

  return (
    <Screen
      edges={['top', 'bottom']}
      refreshControl={
        <RefreshControl refreshing={query.isFetching && !query.isPending} onRefresh={() => void query.refetch()} tintColor={colors.textSecondary} />
      }>
      <NavHeader title="Segments" />
      {data && !data.joined ? (
        <Card style={styles.card}>
          <View style={styles.head}>
            <Timer size={20} color={colors.accent} />
            <Text variant="labelStrong" accessibilityRole="header" style={styles.fill}>
              Race the clock on local paths
            </Text>
          </View>
          <Text variant="body" tone="secondary">
            Segments are stretches of path, trail and track picked by PaceLeague. Join, and runs you share with everyone, map included, are timed from each
            segment’s start line to its finish. The boards show your runner name and time, never your route. You can leave any time.
          </Text>
          {data.banned ? (
            <InlineStatus tone="warning" title="A moderator took you off the segment boards." />
          ) : (
            <PrimaryButton label="Join the segment boards" onPress={() => void actions.join()} loading={actions.busy} testID="join-segments" />
          )}
        </Card>
      ) : null}
      {data?.joined ? (
        <Text variant="caption" tone="secondary">
          Your runs shared with everyone, map included, are timed on these segments a few minutes after they upload, when you run the segment’s way.
        </Text>
      ) : null}
      {actions.error ? <InlineStatus tone="danger" title={actions.error} /> : null}
      {query.data?.source === 'cache' ? <InlineStatus title="Showing segments from earlier." body="You’re offline." /> : null}
      {query.isError && !data ? <InlineStatus tone="danger" title="Couldn’t load segments." body="Pull to try again." /> : null}

      {data && data.segments.length === 0 ? (
        <Card>
          <EmptyState icon={Timer} title="No segments yet." body="PaceLeague adds segments on popular paths, in parks and on tracks. Check back soon." />
        </Card>
      ) : null}
      <View style={styles.list}>
        {data?.segments.map((s) => (
          <SegmentRow key={s.id} segment={s} units={units} onPress={() => router.push({ pathname: '/league/segments/[id]', params: { id: s.id } })} />
        ))}
      </View>

      {data?.joined ? (
        <View style={styles.links}>
          <TextButton label="Leave segment boards" icon={LogOut} onPress={() => setConfirmLeave(true)} testID="leave-segments" />
        </View>
      ) : null}
      <ConfirmSheet
        visible={confirmLeave}
        title="Leave the segment boards?"
        body="Every time you have comes off the boards straight away. Your runs, XP and leagues don’t change, and you can join again."
        confirmLabel="Leave segment boards"
        busy={actions.busy}
        onConfirm={() => void actions.leave().then(() => setConfirmLeave(false))}
        onCancel={() => setConfirmLeave(false)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: { gap: space.sm },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  fill: { flex: 1, gap: 2 },
  list: { gap: space.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.sm, borderRadius: radius.card, backgroundColor: colors.surface },
  thumb: { width: 72, height: 56, borderRadius: radius.control, backgroundColor: colors.background, overflow: 'hidden' },
  links: { flexDirection: 'row', flexWrap: 'wrap', gap: space.lg, justifyContent: 'center' },
});
