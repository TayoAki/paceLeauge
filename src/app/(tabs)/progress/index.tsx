import { useRouter } from 'expo-router';
import { Award, CalendarDays, ChartColumn, CircleHelp, Play, Trophy } from 'lucide-react-native';
import { useMemo } from 'react';
import { RefreshControl, View } from 'react-native';

import { DistanceBars, GoalCircles, RunRow, TierCard } from '@/components/progress/progress-components';
import { StreakCard } from '@/components/progress/progress-extras';
import { PrimaryButton, SecondaryButton, TextButton } from '@/components/ui/buttons';
import { EmptyState, InlineStatus, Row, RowGroup } from '@/components/ui/elements';
import { Card, LargeHeader, Screen } from '@/components/ui/layout';
import { useBadges, useLocalRuns, useMe, usePersonalRecords, useProgress, useRunHistory, useStreak } from '@/features/data/hooks';
import { formatEffort } from '@/features/progress/records';
import { mergeRunViews } from '@/features/progress/run-views';
import { Text } from '@/design/text';
import { colors, space } from '@/design/tokens';

/** S11 — lifetime tier, this week, streak, four-week distance, records, badges, stats and run history. */
export default function ProgressScreen() {
  const router = useRouter();
  const me = useMe();
  const progress = useProgress();
  const history = useRunHistory();
  const local = useLocalRuns();
  const streak = useStreak();
  const records = usePersonalRecords();
  const badges = useBadges();
  const units = me.data?.data.profile?.units ?? 'metric';
  const data = progress.data?.data;
  const runs = useMemo(() => mergeRunViews(local, history.data?.pages.flatMap((p) => p.runs) ?? []), [local, history.data]);
  const weeks = (data?.distance_by_week ?? []).map((w) => ({ weekStart: w.week_start, distanceM: w.distance_cm / 100 }));
  const refreshing = (progress.isFetching || history.isFetching) && !progress.isPending;
  const best5k = records.data?.data.records.find((r) => r.effort === '5k')?.best;
  const recordCount = records.data?.data.records.filter((r) => r.best).length ?? 0;
  const recordSummary = best5k ? `5K ${formatEffort(best5k.elapsed_ms)}` : records.data ? (recordCount > 0 ? `${recordCount} set` : 'None yet') : undefined;
  const badgeSummary = badges.data ? `${badges.data.data.earned.length} earned` : undefined;

  return (
    <Screen
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            void progress.refetch();
            void history.refetch();
            void streak.refetch();
            void records.refetch();
            void badges.refetch();
          }}
          tintColor={colors.textSecondary}
        />
      }>
      <LargeHeader title="Progress" />
      {progress.data?.source === 'cache' ? <InlineStatus title="Offline — showing saved progress." /> : null}
      {progress.isError && !data ? <InlineStatus tone="danger" title="Couldn’t load your progress." body="Pull to try again." /> : null}

      <TierCard lifetimeXp={data?.lifetime_xp ?? me.data?.data.lifetime_xp ?? 0} variant="progress" />
      <GoalCircles active={data?.week.active_days ?? 0} goal={me.data?.data.profile?.goal_days ?? null} />
      {streak.data ? <StreakCard streak={streak.data.data} /> : null}
      {weeks.length > 0 ? <DistanceBars weeks={weeks} units={units} /> : null}

      <RowGroup>
        <Row icon={Trophy} label="Personal records" value={recordSummary} onPress={() => router.push('/progress/records')} testID="progress-records" />
        <Row icon={Award} label="Badges" value={badgeSummary} onPress={() => router.push('/progress/badges')} testID="progress-badges" />
        <Row icon={ChartColumn} label="Stats and trends" onPress={() => router.push('/progress/stats')} testID="progress-stats" />
        <Row icon={CalendarDays} label="Calendar" onPress={() => router.push('/progress/calendar')} last testID="progress-calendar" />
      </RowGroup>

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
