import { useRouter } from 'expo-router';
import { CircleHelp, Play } from 'lucide-react-native';
import { useMemo } from 'react';
import { RefreshControl, View } from 'react-native';

import { DistanceBars, GoalCircles, RunRow, TierCard } from '@/components/progress/progress-components';
import { PrimaryButton, SecondaryButton, TextButton } from '@/components/ui/buttons';
import { EmptyState, InlineStatus } from '@/components/ui/elements';
import { Card, LargeHeader, Screen } from '@/components/ui/layout';
import { useLocalRuns, useMe, useProgress, useRunHistory } from '@/features/data/hooks';
import { mergeRunViews } from '@/features/progress/run-views';
import { Text } from '@/design/text';
import { colors, space } from '@/design/tokens';

/** S11 — lifetime tier, this week, four-week distance and run history. */
export default function ProgressScreen() {
  const router = useRouter();
  const me = useMe();
  const progress = useProgress();
  const history = useRunHistory();
  const local = useLocalRuns();
  const units = me.data?.data.profile?.units ?? 'metric';
  const data = progress.data?.data;
  const runs = useMemo(() => mergeRunViews(local, history.data?.pages.flatMap((p) => p.runs) ?? []), [local, history.data]);
  const weeks = (data?.distance_by_week ?? []).map((w) => ({ weekStart: w.week_start, distanceM: w.distance_cm / 100 }));
  const refreshing = (progress.isFetching || history.isFetching) && !progress.isPending;

  return (
    <Screen
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            void progress.refetch();
            void history.refetch();
          }}
          tintColor={colors.textSecondary}
        />
      }>
      <LargeHeader title="Progress" />
      {progress.data?.source === 'cache' ? <InlineStatus title="Offline — showing saved progress." /> : null}
      {progress.isError && !data ? <InlineStatus tone="danger" title="Couldn’t load your progress." body="Pull to try again." /> : null}

      <TierCard lifetimeXp={data?.lifetime_xp ?? me.data?.data.lifetime_xp ?? 0} variant="progress" />
      <GoalCircles active={data?.week.active_days ?? 0} goal={me.data?.data.profile?.goal_days ?? null} />
      {weeks.length > 0 ? <DistanceBars weeks={weeks} units={units} /> : null}

      <Card style={{ paddingBottom: space.sm }}>
        <Text variant="labelStrong" accessibilityRole="header">
          Recent runs
        </Text>
        {runs.length === 0 && !history.isPending ? (
          <EmptyState title="Your first run starts here." body="Saved runs appear here, with private routes only you can see.">
            <PrimaryButton label="Start run" icon={Play} onPress={() => router.push('/run/preflight')} />
          </EmptyState>
        ) : (
          <View>
            {runs.map((r, i) => (
              <RunRow
                key={r.key}
                title={r.title}
                distanceM={r.distanceM}
                activeMs={r.activeMs}
                units={units}
                status={r.status}
                last={i === runs.length - 1 && !history.hasNextPage}
                onPress={() => router.push({ pathname: '/progress/runs/[id]', params: { id: r.key, server: r.serverRunId ?? '' } })}
              />
            ))}
          </View>
        )}
        {history.hasNextPage ? (
          <SecondaryButton label="Show more" loading={history.isFetchingNextPage} onPress={() => void history.fetchNextPage()} style={{ marginVertical: space.sm }} />
        ) : null}
        {history.isError ? <InlineStatus tone="info" title="Only runs saved on this phone are shown while offline." /> : null}
      </Card>
      <TextButton label="How XP works" icon={CircleHelp} onPress={() => router.push('/league/rules')} />
    </Screen>
  );
}
