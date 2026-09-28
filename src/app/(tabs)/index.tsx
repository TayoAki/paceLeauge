import { useFocusEffect, useRouter } from 'expo-router';
import { ChevronRight, Play, Radio, Users, Watch } from 'lucide-react-native';
import { useCallback, useMemo } from 'react';
import { Pressable, RefreshControl, StyleSheet, View } from 'react-native';

import { Monogram } from '@/components/art/art';
import { RunRow, TierCard, WeeklyGoal } from '@/components/progress/progress-components';
import { FriendsActivity } from '@/components/social/friends-activity';
import { TodaysWorkoutCard } from '@/components/train/train-components';
import { PrimaryButton, TextButton } from '@/components/ui/buttons';
import { InlineStatus } from '@/components/ui/elements';
import { Card, LargeHeader, Screen } from '@/components/ui/layout';
import { formatDistance, formatDuration, ordinal } from '@/domain/format';
import { useAccount } from '@/features/account/account-provider';
import { useIndoorSession, useLeague, useLocalRuns, useMe, useRecorder, useRunHistory, useSyncStatus, useWeek } from '@/features/data/hooks';
import { pendingInvite } from '@/features/leagues/pending-invite';
import { pendingFollow } from '@/features/social/pending-follow';
import { useWatchWorkout } from '@/features/watch/use-watch';
import { useTodaysPlan } from '@/features/plans/use-plan';
import { mergeRunViews } from '@/features/progress/run-views';
import { useWeekGoalDays } from '@/features/progress/use-week-goal';
import { Text } from '@/design/text';
import { colors, layout, space } from '@/design/tokens';
import { useNow } from '@/lib/use-now';

function todayLabel(now: number): string {
  return new Date(now)
    .toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    })
    .toUpperCase();
}

/** S03 — tier, weekly goal, Start run, latest run and crew teaser. */
export default function TodayScreen() {
  const router = useRouter();
  const { sessionLapsed } = useAccount();
  const me = useMe();
  const week = useWeek();
  const league = useLeague(0);
  const history = useRunHistory();
  const local = useLocalRuns();
  const { session } = useRecorder();
  const indoor = useIndoorSession();
  const watchRun = useWatchWorkout();
  const sync = useSyncStatus();
  const now = useNow(60_000);
  const days = useWeekGoalDays(week.data?.data, now);
  const workout = useTodaysPlan()?.open ?? null;

  useFocusEffect(
    useCallback(() => {
      void pendingInvite.get().then((code) => {
        if (code) router.push({ pathname: '/invite/[code]', params: { code } });
      });
      // A follow link opened before sign-in (4.3).
      void pendingFollow.get().then((code) => {
        if (code) router.push({ pathname: '/follow/[code]', params: { code } });
      });
    }, [router]),
  );

  const units = me.data?.data.profile?.units ?? 'metric';
  const runs = useMemo(() => mergeRunViews(local, history.data?.pages.flatMap((p) => p.runs) ?? []), [local, history.data]);
  const latest = runs[0];
  const unsynced = local.filter((r) => !r.deleted && r.syncState !== 'synced').length;
  const offline = me.data?.source === 'cache' || week.data?.source === 'cache';
  const leagueView = league.data?.data;
  const refreshing = me.isFetching && !me.isPending;

  const onRefresh = () => {
    void me.refetch();
    void week.refetch();
    void league.refetch();
    void history.refetch();
  };

  return (
    <Screen refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.textSecondary} />}>
      <LargeHeader
        title="Today"
        subtitle={todayLabel(now)}
        action={
          <Pressable accessibilityRole="button" accessibilityLabel="Profile" onPress={() => router.navigate('/profile')} style={styles.monogram}>
            <Monogram size={26} background={colors.surface} />
          </Pressable>
        }
      />

      {session?.status === 'interrupted' ? (
        <Pressable onPress={() => router.push('/run/active')} accessibilityRole="button">
          <InlineStatus
            tone="warning"
            icon={Radio}
            title="Recording stopped. Your saved portion is here."
            body="Resume, save the partial run, or discard it."
          />
        </Pressable>
      ) : null}
      {sessionLapsed ? <InlineStatus tone="warning" title="You’re signed out." body="Finish your run — it syncs after you sign in again." /> : null}
      {offline ? <InlineStatus tone="info" title="Offline — showing saved data." /> : null}
      {unsynced > 0 && !offline ? (
        <InlineStatus
          tone={sync?.needsAttention ? 'danger' : 'info'}
          title={
            sync?.needsAttention
              ? 'A run couldn’t sync. Open it in Progress.'
              : `${unsynced} ${unsynced === 1 ? 'run is' : 'runs are'} saved on this phone and will sync when you’re online.`
          }
        />
      ) : null}

      <TierCard lifetimeXp={me.data?.data.lifetime_xp ?? 0} />
      <WeeklyGoal days={days} goalDays={me.data?.data.profile?.goal_days ?? null} now={now} />
      <TodaysWorkoutCard />

      {watchRun ? (
        <InlineStatus
          icon={Watch}
          title={watchRun.state === 'paused' ? 'Your Apple Watch run is paused.' : 'You’re running with your Apple Watch.'}
          body={
            watchRun.distance_m !== undefined && watchRun.elapsed_s !== undefined
              ? `${formatDistance(watchRun.distance_m, units).value} ${formatDistance(watchRun.distance_m, units).unit} · ${formatDuration(watchRun.elapsed_s * 1000)}. It syncs here when you finish.`
              : 'It syncs here when you finish.'
          }
        />
      ) : null}
      {session ? (
        <PrimaryButton label="Return to run" icon={Radio} size="large" onPress={() => router.push('/run/active')} />
      ) : indoor ? (
        <PrimaryButton label="Return to indoor run" icon={Radio} size="large" onPress={() => router.push('/run/indoor')} testID="return-indoor" />
      ) : (
        <View style={{ gap: space.sm }}>
          {runs.length === 0 && !history.isPending ? (
            <Text variant="section" align="center">
              Your first run starts here.
            </Text>
          ) : null}
          {workout ? (
            <>
              <PrimaryButton
                label="Start workout"
                icon={Play}
                size="large"
                onPress={() => router.push({ pathname: '/run/preflight', params: { session: workout.session.id } })}
                testID="start-workout"
              />
              <TextButton label="Just run" onPress={() => router.push('/run/preflight')} testID="start-run" />
            </>
          ) : (
            <PrimaryButton label="Start run" icon={Play} size="large" onPress={() => router.push('/run/preflight')} testID="start-run" />
          )}
        </View>
      )}

      {latest ? (
        <Card style={{ paddingVertical: space.sm }}>
          <Text variant="eyebrow" tone="secondary" style={{ marginTop: space.sm }}>
            Latest run
          </Text>
          <RunRow
            title={latest.title}
            distanceM={latest.distanceM}
            activeMs={latest.activeMs}
            units={units}
            status={latest.status}
            last
            onPress={() =>
              router.push({
                pathname: '/progress/runs/[id]',
                params: { id: latest.key },
              })
            }
          />
        </Card>
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          leagueView?.league
            ? `${leagueView.league.name}. ${leagueView.me ? `${ordinal(leagueView.me.rank)} this week.` : ''} Open league`
            : 'A little friendly competition. Create or join a league'
        }
        onPress={() => router.navigate('/league')}
        style={({ pressed }) => [styles.teaser, pressed && { opacity: 0.8 }]}>
        <Users size={26} color={colors.textSecondary} />
        <View style={{ flex: 1 }}>
          <Text variant="bodyStrong">{leagueView?.league?.name ?? 'A little friendly competition.'}</Text>
          <Text variant="label" tone="secondary">
            {leagueView?.league
              ? leagueView.me && leagueView.competition_enabled
                ? `#${leagueView.me.rank} this week`
                : `${leagueView.league.member_count} runners`
              : 'Create a league or join with a code'}
          </Text>
        </View>
        <ChevronRight size={20} color={colors.textSecondary} />
      </Pressable>

      <FriendsActivity units={units} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  monogram: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.decorativeDivider,
    alignItems: 'center',
    justifyContent: 'center',
  },
  teaser: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.lg,
    backgroundColor: colors.surface,
    borderRadius: 24,
    padding: layout.cardPadding,
    minHeight: 76,
  },
});
