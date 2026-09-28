import { useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Merge, Scissors, Undo2 } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { toApiError } from '@/api/errors';
import type { ActivityType, RunEditResult, ServerRun } from '@/api/schemas';
import { routeLines } from '@/components/run/route-lines';
import { RouteMap } from '@/components/run/route-map';
import { PrimaryButton, SecondaryButton, TextButton } from '@/components/ui/buttons';
import { ConfirmSheet } from '@/components/ui/confirm-sheet';
import { ChoiceChips, InlineStatus, SwitchRow, RowGroup } from '@/components/ui/elements';
import { Card, NavHeader, Screen } from '@/components/ui/layout';
import { describeDistance, describeDuration, formatDistance, formatDuration } from '@/domain/format';
import { fromCompact } from '@/domain/route-codec';
import { findStops, MIN_KEPT_MS, previewEdit, type RunEdit, type StopSection } from '@/domain/run-fix';
import type { TrackPoint } from '@/domain/types';
import { useAccountServices } from '@/features/account/account-provider';
import { useMe, useRunHistory, useRunRoute, useServerRun } from '@/features/data/hooks';
import { fixErrorCopy, recordFixLocally } from '@/features/progress/run-fixes';
import { Text } from '@/design/text';
import { colors, space } from '@/design/tokens';

const ACTIVITIES: { value: ActivityType; label: string }[] = [
  { value: 'run', label: 'Run' },
  { value: 'walk', label: 'Walk' },
  { value: 'hike', label: 'Hike' },
  { value: 'ride', label: 'Ride' },
  { value: 'other', label: 'Other' },
];
const MERGE_WINDOW_MS = 6 * 60 * 60_000;
const STEPS = [
  { label: '−1 min', ms: -60_000 },
  { label: '−10 s', ms: -10_000 },
  { label: '+10 s', ms: 10_000 },
  { label: '+1 min', ms: 60_000 },
];

type Pending = { kind: 'save' } | { kind: 'undo' } | { kind: 'merge'; other: ServerRun } | null;

function clock(ms: number): string {
  return formatDuration(Math.max(0, Math.round(ms / 1000) * 1000));
}

function gapText(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** Fix a run (docs/ROADMAP.md 1.5): trim, cut out stops, change the activity, merge a split run, or undo. */
export default function FixRunScreen() {
  const { id, local: localRunId } = useLocalSearchParams<{ id: string; local?: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { api, runtime } = useAccountServices();
  const units = useMe().data?.data.profile?.units ?? 'metric';
  const serverRun = useServerRun(id ?? null);
  const route = useRunRoute(id ?? null);
  const history = useRunHistory();
  const run = serverRun.data?.data ?? null;

  const [keepFrom, setKeepFrom] = useState<number | null>(null);
  const [keepTo, setKeepTo] = useState<number | null>(null);
  const [activity, setActivity] = useState<ActivityType | null>(null);
  const [cutStops, setCutStops] = useState<Set<number>>(new Set());
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<RunEditResult | null>(null);

  const points: TrackPoint[] = useMemo(() => route.data?.data.points.map(fromCompact) ?? [], [route.data]);
  const segments = useMemo(() => route.data?.data.segments ?? [], [route.data]);
  const runStart = segments[0]?.startAt ?? run?.started_at_ms ?? 0;
  const runEnd = segments[segments.length - 1]?.endAt ?? run?.ended_at_ms ?? 0;
  const from = keepFrom ?? runStart;
  const to = keepTo ?? runEnd;
  const stops = useMemo(() => findStops(segments, points), [segments, points]);
  const keptStops: StopSection[] = stops.filter((s, i) => cutStops.has(i) && s.fromMs >= from && s.toMs <= to);
  const edit: RunEdit = {
    keepFromMs: keepFrom ?? undefined,
    keepToMs: keepTo ?? undefined,
    cutRanges: keptStops.map((s) => ({ fromMs: s.fromMs, toMs: s.toMs })),
  };
  const shapeChanged = keepFrom !== null || keepTo !== null || keptStops.length > 0;
  const typeChanged = activity !== null && activity !== run?.activity_type;
  const cutKey = keptStops.map((s) => `${s.fromMs}-${s.toMs}`).join(',');
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `edit` is rebuilt each render; these are its inputs.
  const preview = useMemo(() => (shapeChanged ? previewEdit(segments, points, edit) : null), [shapeChanged, segments, points, keepFrom, keepTo, cutKey]);
  const lines = useMemo(() => {
    const kept = points.filter((p) => p.t >= from && p.t <= to && !keptStops.some((s) => p.t > s.fromMs && p.t < s.toMs));
    return routeLines(kept);
  }, [points, from, to, keptStops]);

  const candidates = useMemo(() => {
    if (!run) return [];
    const all = history.data?.pages.flatMap((p) => p.runs) ?? [];
    const type = run.activity_type ?? 'run';
    return all.filter((r) => {
      if (r.id === run.id || (r.activity_type ?? 'run') !== type || r.status === 'uploading') return false;
      const after = r.started_at_ms - run.ended_at_ms;
      const before = run.started_at_ms - r.ended_at_ms;
      return (after >= 0 && after <= MERGE_WINDOW_MS) || (before >= 0 && before <= MERGE_WINDOW_MS);
    });
  }, [history.data, run]);

  if (!run) {
    return (
      <Screen edges={['top', 'bottom']}>
        <NavHeader title="Fix this run" />
        {serverRun.isError ? <InlineStatus tone="danger" title="Couldn’t load this run." body="Fixing a run needs a connection." /> : <Text tone="secondary">Loading…</Text>}
      </Screen>
    );
  }

  const invalid = shapeChanged && preview === null;
  const canSave = (shapeChanged || typeChanged) && !invalid;
  const before = formatDistance(run.distance_m, units);
  const after = preview ? formatDistance(preview.distanceM, units) : null;

  const finish = async (result: RunEditResult) => {
    await recordFixLocally(runtime.journal, result, localRunId || null).catch(() => undefined);
    await queryClient.invalidateQueries();
    setDone(result);
  };

  const run_ = async (task: () => Promise<RunEditResult>) => {
    if (!api) return;
    setBusy(true);
    setError(null);
    try {
      await finish(await task());
      setPending(null);
    } catch (e) {
      setError(fixErrorCopy(toApiError(e).code));
      setPending(null);
    } finally {
      setBusy(false);
    }
  };

  const save = () => run_(() => api!.editRun(run.id, run.version, { ...edit, activityType: typeChanged ? activity! : undefined }));
  const undo = () => run_(() => api!.undoRunEdits(run.id, run.version));
  const merge = (other: ServerRun) => {
    const [first, second] = other.started_at_ms < run.started_at_ms ? [other, run] : [run, other];
    return run_(() => api!.mergeRuns(first.id, second.id));
  };

  if (done) {
    const xpDelta = done.xp_changes.reduce((sum, c) => sum + c.delta, 0);
    const d = formatDistance(done.run.distance_m, units);
    return (
      <Screen edges={['top', 'bottom']} footer={<PrimaryButton label="Done" onPress={() => router.back()} />}>
        <NavHeader title="Run fixed" variant="close" onBack={() => router.back()} />
        <InlineStatus
          tone="success"
          title={`Saved: ${d.value} ${d.unit} in ${clock(done.run.active_ms)}.`}
          body={
            xpDelta === 0
              ? 'Your XP didn’t change.'
              : `Your XP changed by ${xpDelta > 0 ? '+' : '−'}${Math.abs(xpDelta)}. League standings update the same way.`
          }
        />
        {done.run.status === 'review' ? <InlineStatus title="This run is held for a quick review before it counts again." /> : null}
      </Screen>
    );
  }

  return (
    <Screen
      edges={['top', 'bottom']}
      footer={
        <PrimaryButton label="Save fix" icon={Scissors} disabled={!canSave} onPress={() => setPending({ kind: 'save' })} testID="save-fix" />
      }>
      <NavHeader title="Fix this run" />
      <Text variant="body" tone="secondary">
        Fixes can only take distance away, never add it. Your XP and league standings update, and a note shows in your league as for a deletion.
      </Text>

      <Card>
        <View style={styles.compare} accessible accessibilityLabel={`Now ${describeDistance(run.distance_m, units)} in ${describeDuration(run.active_ms)}${preview ? `. After the fix ${describeDistance(preview.distanceM, units)} in ${describeDuration(preview.activeMs)}` : ''}`}>
          <View style={{ flex: 1 }}>
            <Text variant="eyebrow" tone="secondary">
              Now
            </Text>
            <Text variant="metric">
              {before.value} {before.unit}
            </Text>
            <Text variant="label" tone="secondary">
              {clock(run.active_ms)}
            </Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text variant="eyebrow" tone="secondary">
              After
            </Text>
            <Text variant="metric" tone={after ? 'accent' : 'secondary'}>
              {after ? `${after.value} ${after.unit}` : '—'}
            </Text>
            <Text variant="label" tone="secondary">
              {preview ? clock(preview.activeMs) : 'No change yet'}
            </Text>
          </View>
        </View>
        {lines.length > 0 ? <RouteMap lines={lines} height={200} accessibilityLabel="Map of the part of the run that stays." /> : null}
      </Card>
      {invalid ? <InlineStatus tone="warning" title={`A run needs at least ${MIN_KEPT_MS / 60_000} minute left.`} /> : null}

      <Card>
        <Text variant="labelStrong" accessibilityRole="header">
          Activity
        </Text>
        <ChoiceChips<ActivityType> label="Activity type" value={activity ?? run.activity_type ?? 'run'} onChange={setActivity} options={ACTIVITIES} />
        {(activity ?? run.activity_type) !== 'run' ? (
          <Text variant="caption" tone="secondary">
            Only runs earn XP. Other activities stay in your history and stats.
          </Text>
        ) : null}
      </Card>

      <Card>
        <Text variant="labelStrong" accessibilityRole="header">
          Trim
        </Text>
        <Trimmer
          label="Start"
          value={clock(from - runStart)}
          onStep={(ms) => setKeepFrom(Math.min(Math.max(runStart, from + ms), to - MIN_KEPT_MS))}
          onReset={keepFrom !== null ? () => setKeepFrom(null) : undefined}
        />
        <Trimmer
          label="End"
          value={clock(to - runStart)}
          onStep={(ms) => setKeepTo(Math.max(Math.min(runEnd, to + ms), from + MIN_KEPT_MS))}
          onReset={keepTo !== null ? () => setKeepTo(null) : undefined}
        />
        <Text variant="caption" tone="secondary">
          Times count from when you pressed start, pauses included.
        </Text>
      </Card>

      {stops.length > 0 ? (
        <View style={{ gap: space.sm }}>
          <Text variant="labelStrong" accessibilityRole="header">
            Stops recorded as running
          </Text>
          <RowGroup>
            {stops.map((s, i) => (
              <SwitchRow
                key={s.fromMs}
                label={`Cut ${clock(s.toMs - s.fromMs)} stop`}
                hint={`At ${clock(s.fromMs - runStart)} into the run`}
                value={cutStops.has(i)}
                disabled={s.fromMs < from || s.toMs > to}
                onChange={(on) =>
                  setCutStops((prev) => {
                    const next = new Set(prev);
                    if (on) next.add(i);
                    else next.delete(i);
                    return next;
                  })
                }
                last={i === stops.length - 1}
              />
            ))}
          </RowGroup>
        </View>
      ) : null}

      {candidates.length > 0 ? (
        <Card>
          <Text variant="labelStrong" accessibilityRole="header">
            Split by accident?
          </Text>
          <Text variant="caption" tone="secondary">
            Merge with a run of the same kind within 6 hours. The time between them doesn’t count. A merge can’t be undone.
          </Text>
          {candidates.map((c) => {
            const later = c.started_at_ms > run.ended_at_ms;
            const gap = later ? c.started_at_ms - run.ended_at_ms : run.started_at_ms - c.ended_at_ms;
            const d = formatDistance(c.distance_m, units);
            const when = later ? `Started ${gapText(gap)} after this run ended` : `Ended ${gapText(gap)} before this run started`;
            return (
              <View key={c.id} style={styles.candidate}>
                <SecondaryButton
                  icon={Merge}
                  label={`Merge with “${c.title}” · ${d.value} ${d.unit}`}
                  accessibilityHint={when}
                  onPress={() => setPending({ kind: 'merge', other: c })}
                />
                <Text variant="caption" tone="secondary">
                  {when}
                </Text>
              </View>
            );
          })}
        </Card>
      ) : null}

      {run.edited_at_ms ? (
        <TextButton label="Restore the original run" icon={Undo2} onPress={() => setPending({ kind: 'undo' })} testID="undo-fix" />
      ) : null}
      {error ? <InlineStatus tone="danger" title={error} /> : null}

      <ConfirmSheet
        visible={pending !== null}
        title={pending?.kind === 'undo' ? 'Restore the original run?' : pending?.kind === 'merge' ? 'Merge these runs?' : 'Save this fix?'}
        body={
          pending?.kind === 'undo'
            ? 'All fixes to this run are undone and its XP is worked out again.'
            : pending?.kind === 'merge'
              ? `“${pending.other.title}” becomes part of this run. This can’t be undone.`
              : after
                ? `This run becomes ${after.value} ${after.unit}. Your XP and league standings update.`
                : 'Your XP and league standings update.'
        }
        confirmLabel={pending?.kind === 'undo' ? 'Restore' : pending?.kind === 'merge' ? 'Merge runs' : 'Save fix'}
        busy={busy}
        onConfirm={() => void (pending?.kind === 'undo' ? undo() : pending?.kind === 'merge' ? merge(pending.other) : save())}
        onCancel={() => setPending(null)}
      />
    </Screen>
  );
}

function Trimmer({ label, value, onStep, onReset }: { label: string; value: string; onStep: (ms: number) => void; onReset?: () => void }) {
  return (
    <View style={styles.trimmer}>
      <View style={styles.trimHeader}>
        <Text variant="body" style={{ flex: 1 }}>
          {label} <Text variant="bodyStrong">{value}</Text>
        </Text>
        {onReset ? <TextButton label="Reset" onPress={onReset} /> : null}
      </View>
      <View style={styles.steps}>
        {STEPS.map((s) => (
          <Pressable
            key={s.label}
            accessibilityRole="button"
            accessibilityLabel={`${label} ${s.ms > 0 ? 'later' : 'earlier'} by ${Math.abs(s.ms) >= 60_000 ? '1 minute' : '10 seconds'}`}
            onPress={() => onStep(s.ms)}
            style={({ pressed }) => [styles.step, pressed && { backgroundColor: colors.surfaceElevated }]}>
            <Text variant="labelStrong">{s.label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  compare: { flexDirection: 'row', gap: space.md },
  candidate: { gap: space.xs },
  trimmer: { gap: space.sm },
  trimHeader: { flexDirection: 'row', alignItems: 'center' },
  steps: { flexDirection: 'row', gap: space.sm },
  step: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 999,
    borderWidth: 1.5,
    borderColor: colors.controlOutline,
  },
});
