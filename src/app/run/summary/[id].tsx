import * as Network from 'expo-network';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { CalendarCheck, Share2, ShieldCheck } from 'lucide-react-native';
import { useEffect, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';

import { MetricBlock, XpPanel, useAnnounce } from '@/components/run/run-components';
import { routeLines } from '@/components/run/route-lines';
import { RouteMap } from '@/components/run/route-map';
import { PrimaryButton, SecondaryButton } from '@/components/ui/buttons';
import { Card, Screen } from '@/components/ui/layout';
import { describeDistance, describeDuration, describePace, formatDistance, formatDuration, formatPace } from '@/domain/format';
import { useAccountServices } from '@/features/account/account-provider';
import { useLocalRun, useMe, useRefreshAccountData, useWeek } from '@/features/data/hooks';
import { useWeekGoalDays } from '@/features/progress/use-week-goal';
import { useRunPoints } from '@/features/recording/use-run-points';
import { xpPanelState } from '@/features/recording/xp-state';
import { serverRunOf } from '@/features/sync/sync-engine';
import { Text } from '@/design/text';
import { colors, space } from '@/design/tokens';

/** S07 — the durable local save comes first; XP appears only once the server accepts it. */
export default function RunSummaryScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { engine } = useAccountServices();
  const run = useLocalRun(id ?? null);
  const me = useMe();
  const week = useWeek();
  const refresh = useRefreshAccountData();
  const network = Network.useNetworkState();
  const units = me.data?.data.profile?.units ?? 'metric';
  const server = run ? serverRunOf(run) : null;
  const points = useRunPoints(id ?? null);
  const lines = useMemo(() => routeLines(points), [points]);
  const days = useWeekGoalDays(week.data?.data);
  const goal = me.data?.data.profile?.goal_days ?? null;

  useAnnounce(run ? 'Run saved' : null);

  // Sync right away; refresh progress once the server has answered.
  useEffect(() => {
    void engine?.run();
  }, [engine]);
  useEffect(() => {
    if (run?.syncState === 'synced') void refresh();
  }, [run?.syncState, refresh]);

  if (run === undefined) return <View style={styles.blank} />;
  if (run === null) {
    return (
      <Screen edges={['top', 'bottom']} footer={<PrimaryButton label="Done" onPress={() => router.dismissTo('/')} />}>
        <Text variant="title">Run not found</Text>
      </Screen>
    );
  }

  const distanceM = server?.distance_m ?? run.distanceM;
  const activeMs = server?.active_ms ?? run.activeMs;
  const distance = formatDistance(distanceM, units);
  const pace = formatPace(activeMs, distanceM, units);
  const offline = network.isConnected === false || network.isInternetReachable === false;
  const xp = xpPanelState(run, server, offline);
  const active = days.filter((d) => d.active).length;
  const pending = days.filter((d) => !d.active && d.pending).length;
  const complete = goal !== null && active >= goal;

  return (
    <Screen
      edges={['top', 'bottom']}
      footer={
        <>
          <PrimaryButton label="Done" onPress={() => router.dismissTo('/')} testID="summary-done" />
          <SecondaryButton label="Share stats" icon={Share2} onPress={() => router.push({ pathname: '/share/[id]', params: { id: run.runId } })} />
          <View style={styles.private} accessible>
            <ShieldCheck size={18} color={colors.textSecondary} />
            <Text variant="label" tone="secondary">
              Your route stays private
            </Text>
          </View>
        </>
      }>
      <View>
        <Text variant="title" accessibilityRole="header">
          Run saved
        </Text>
        <Text variant="body" tone="secondary">
          {run.title}
          {run.interrupted ? ' · Interrupted' : ''}
        </Text>
      </View>

      <Card>
        <View accessible accessibilityLabel={`Distance, ${describeDistance(distanceM, units)}`} style={styles.distanceRow}>
          <Text variant="hero" testID="summary-distance">
            {distance.value}
          </Text>
          <Text variant="title"> {distance.unit}</Text>
        </View>
        <View style={styles.metricRow}>
          <MetricBlock value={formatDuration(activeMs)} label="Time" align="flex-start" accessibilityLabel={`Active time, ${describeDuration(activeMs)}`} />
          <View style={styles.divider} />
          <MetricBlock
            value={pace.value}
            label={pace.unit.replace('/', '/ ')}
            align="flex-start"
            accessibilityLabel={`Average pace, ${describePace(activeMs, distanceM, units)}`}
          />
        </View>
        {lines.length > 0 ? <RouteMap lines={lines} height={150} accessibilityLabel="Map of this run’s route. Visible only to you." /> : null}
      </Card>

      <View testID="xp-panel">
        <XpPanel state={xp} />
      </View>

      <Card style={styles.goal}>
        <CalendarCheck size={34} color={colors.textPrimary} />
        <View style={{ flex: 1 }} accessible>
          <Text variant="label" tone="secondary">
            {goal ? `${Math.min(active, 7)} of ${goal} active days` : `${active} active days this week`}
            {pending ? ` · ${pending} pending` : ''}
          </Text>
          <Text variant="section">{complete ? 'Week complete' : pending ? 'Counts once your run is checked' : 'Rest days keep your rank'}</Text>
        </View>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  blank: { flex: 1, backgroundColor: colors.background },
  distanceRow: { flexDirection: 'row', alignItems: 'baseline' },
  metricRow: { flexDirection: 'row', alignItems: 'center', gap: space.lg },
  divider: { width: 1, alignSelf: 'stretch', backgroundColor: colors.decorativeDivider },
  goal: { flexDirection: 'row', alignItems: 'center', gap: space.lg },
  private: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm, minHeight: 32 },
});
