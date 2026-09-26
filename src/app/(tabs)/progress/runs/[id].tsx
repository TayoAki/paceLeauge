import { useQueryClient } from '@tanstack/react-query';
import * as Network from 'expo-network';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Pencil, Share2, ShieldCheck, Trash2 } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { toApiError } from '@/api/errors';
import { MetricBlock, XpPanel } from '@/components/run/run-components';
import { routeLines } from '@/components/run/route-lines';
import { RouteMap } from '@/components/run/route-map';
import { DangerButton, IconButton, SecondaryButton } from '@/components/ui/buttons';
import { ConfirmSheet } from '@/components/ui/confirm-sheet';
import { InlineStatus, TextField } from '@/components/ui/elements';
import { Card, NavHeader, Screen } from '@/components/ui/layout';
import { fromCompact } from '@/domain/route-codec';
import { PROFILE_RULES } from '@/domain/config';
import { describeDistance, describeDuration, describePace, formatDistance, formatDuration, formatPace } from '@/domain/format';
import { computeSplits } from '@/domain/splits';
import type { TrackPoint } from '@/domain/types';
import { validateRun } from '@/domain/validator';
import { useAccountServices } from '@/features/account/account-provider';
import { useLocalRun, useMe, useRunHistory, useRunRoute } from '@/features/data/hooks';
import { useRunPoints } from '@/features/recording/use-run-points';
import { xpPanelState } from '@/features/recording/xp-state';
import { serverRunOf } from '@/features/sync/sync-engine';
import { Text } from '@/design/text';
import { colors, space } from '@/design/tokens';

function when(t: number): string {
  return new Date(t).toLocaleString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** S12 — private route, active time, pace, splits and title; rename, share or delete. */
export default function RunDetailScreen() {
  const { id, server: serverParam } = useLocalSearchParams<{
    id: string;
    server?: string;
  }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { api, actions } = useAccountServices();
  const local = useLocalRun(id ?? null);
  const history = useRunHistory();
  const units = useMe().data?.data.profile?.units ?? 'metric';
  const network = Network.useNetworkState();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const serverFromHistory = history.data?.pages.flatMap((p) => p.runs).find((r) => r.client_run_id === id) ?? null;
  const server = (local ? serverRunOf(local) : null) ?? serverFromHistory;
  const serverRunId = server?.id ?? (serverParam || null);
  const localPoints = useRunPoints(local?.routeCached ? (id ?? null) : null);
  const remoteRoute = useRunRoute(localPoints.length === 0 && serverRunId ? serverRunId : null);

  const points: TrackPoint[] = useMemo(
    () => (localPoints.length > 0 ? localPoints : (remoteRoute.data?.data.points.map(fromCompact) ?? [])),
    [localPoints, remoteRoute.data],
  );
  const segments = useMemo(() => local?.segments ?? remoteRoute.data?.data.segments ?? [], [local?.segments, remoteRoute.data]);
  const lines = useMemo(() => routeLines(points), [points]);
  const splits = useMemo(() => {
    if (points.length < 2 || segments.length === 0) return [];
    const start = segments[0]?.startAt ?? 0;
    const end = segments[segments.length - 1]?.endAt ?? start;
    return computeSplits(
      segments,
      validateRun({
        startedAt: start,
        endedAt: end,
        segments,
        points,
        receivedAt: null,
      }).segments,
      units,
    );
  }, [points, segments, units]);

  if (local === undefined && !server) return <View style={styles.blank} />;
  if (!local && !server) {
    return (
      <Screen edges={['top', 'bottom']}>
        <NavHeader title="Run" />
        <InlineStatus title="This run isn’t available." body="It may have been deleted." />
      </Screen>
    );
  }

  const title = local?.title ?? server?.title ?? 'Run';
  const startedAt = local?.startedAt ?? server?.started_at_ms ?? 0;
  const distanceM = server?.distance_m ?? local?.distanceM ?? 0;
  const activeMs = server?.active_ms ?? local?.activeMs ?? 0;
  const distance = formatDistance(distanceM, units);
  const pace = formatPace(activeMs, distanceM, units);
  const offline = network.isConnected === false;
  const xp = xpPanelState(local ?? null, server, offline);

  const saveTitle = async () => {
    if (renaming === null) return;
    const next = renaming.trim();
    if (!next) {
      setError('A title needs at least one character.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (local && actions) await actions.rename(local.runId, next);
      else if (serverRunId && api) await api.renameRun(serverRunId, next);
      await queryClient.invalidateQueries();
      setRenaming(null);
    } catch (e) {
      setError(toApiError(e).code === 'network' ? 'You’re offline. Renaming this run needs a connection.' : 'Couldn’t rename. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      if (actions) await actions.remove(local?.runId ?? id ?? '', serverRunId);
      await queryClient.invalidateQueries();
      setConfirmDelete(false);
      router.back();
    } catch {
      setError('Couldn’t delete the run. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen edges={['top', 'bottom']}>
      <NavHeader
        title="Run"
        right={
          <IconButton
            icon={Share2}
            label="Share stats"
            onPress={() =>
              router.push({
                pathname: '/share/[id]',
                params: local ? { id: local.runId } : { id: serverRunId ?? '', source: 'server' },
              })
            }
          />
        }
      />

      {renaming === null ? (
        <View style={styles.titleRow}>
          <View style={{ flex: 1 }}>
            <Text variant="title">{title}</Text>
            <Text variant="label" tone="secondary">
              {when(startedAt)}
              {local?.interrupted || server?.interrupted ? ' · Interrupted' : ''}
            </Text>
          </View>
          <IconButton icon={Pencil} label="Rename run" onPress={() => setRenaming(title)} />
        </View>
      ) : (
        <View style={{ gap: space.sm }}>
          <TextField
            label="Run title"
            value={renaming}
            onChangeText={setRenaming}
            maxLength={PROFILE_RULES.runTitleMaxLength}
            autoFocus
            error={error}
          />
          <View style={styles.row}>
            <SecondaryButton label="Cancel" onPress={() => setRenaming(null)} style={{ flex: 1 }} />
            <SecondaryButton label="Save title" onPress={saveTitle} loading={busy} style={{ flex: 1 }} />
          </View>
          <Text variant="caption" tone="secondary">
            Only the title can change — distance, time and route stay as recorded.
          </Text>
        </View>
      )}

      <XpPanel state={xp} />

      <Card>
        <View accessible accessibilityLabel={`Distance, ${describeDistance(distanceM, units)}`} style={styles.distanceRow}>
          <Text variant="hero">{distance.value}</Text>
          <Text variant="title"> {distance.unit}</Text>
        </View>
        <View style={styles.row}>
          <MetricBlock
            value={formatDuration(activeMs)}
            label="Time"
            align="flex-start"
            accessibilityLabel={`Active time, ${describeDuration(activeMs)}`}
          />
          <MetricBlock
            value={pace.value}
            label={`Avg ${pace.unit.replace('/', '/ ')}`}
            align="flex-start"
            accessibilityLabel={`Average pace, ${describePace(activeMs, distanceM, units)}`}
          />
        </View>
      </Card>

      {lines.length > 0 ? (
        <View style={{ gap: space.sm }}>
          <RouteMap lines={lines} height={260} interactive accessibilityLabel="Map of this run’s private route." />
          <View style={styles.private}>
            <ShieldCheck size={16} color={colors.textSecondary} />
            <Text variant="caption" tone="secondary">
              Only you can see this route.
            </Text>
          </View>
        </View>
      ) : remoteRoute.isFetching ? (
        <Text variant="label" tone="secondary">
          Loading route…
        </Text>
      ) : (
        <InlineStatus title="No route to show." body={offline ? 'Connect to load the route of older runs.' : 'This run has no usable GPS points.'} />
      )}

      {splits.length > 0 ? (
        <Card>
          <Text variant="labelStrong" accessibilityRole="header">
            Splits
          </Text>
          {splits.map((s) => {
            const d = formatDistance(s.distanceM, units);
            const p = formatPace(s.activeMs, s.distanceM, units);
            return (
              <View
                key={s.index}
                style={styles.split}
                accessible
                accessibilityLabel={`${s.partial ? `Last ${d.value} ${d.unitLong}` : `${units === 'imperial' ? 'Mile' : 'Kilometer'} ${s.index}`}: ${describeDuration(s.activeMs)}`}>
                <Text variant="body" tone="secondary" style={{ width: 80 }}>
                  {s.partial ? `${d.value} ${d.unit}` : `${s.index} ${d.unit}`}
                </Text>
                {/* Whole seconds, rounded like the pace column, so a 5:59.9 split reads 6:00 in both. */}
                <Text variant="bodyStrong" style={{ flex: 1, fontVariant: ['tabular-nums'] }}>
                  {formatDuration(Math.round(s.activeMs / 1000) * 1000)}
                </Text>
                <Text variant="body" tone="secondary" style={{ fontVariant: ['tabular-nums'] }}>
                  {p.value} {p.unit}
                </Text>
              </View>
            );
          })}
        </Card>
      ) : null}

      {error && renaming === null ? <InlineStatus tone="danger" title={error} /> : null}
      <DangerButton label="Delete run" icon={Trash2} onPress={() => setConfirmDelete(true)} />
      <ConfirmSheet
        visible={confirmDelete}
        title="Delete this run and its route? Your XP may change."
        body="It’s removed from your history, progress and league standings."
        confirmLabel="Delete run"
        destructive
        busy={busy}
        onConfirm={remove}
        onCancel={() => setConfirmDelete(false)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  blank: { flex: 1, backgroundColor: colors.background },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  row: { flexDirection: 'row', gap: space.md },
  distanceRow: { flexDirection: 'row', alignItems: 'baseline' },
  private: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    justifyContent: 'center',
  },
  split: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: 40,
  },
});
