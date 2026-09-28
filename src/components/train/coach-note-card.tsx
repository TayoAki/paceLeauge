import { MessageCircle } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import { Card } from '@/components/ui/layout';
import { coachNote, type CoachNote } from '@/domain/coach-notes';
import type { Effort, SessionKind } from '@/domain/plans/types';
import type { Split } from '@/domain/splits';
import { useRunEfforts } from '@/features/data/hooks';
import { guidedRun, type GuidedKind } from '@/features/guided/catalog';
import { competitionDate } from '@/domain/calendar';
import { usePlanState } from '@/features/plans/use-plan';
import type { ActiveWorkout } from '@/features/workout/workout-controller';
import { workoutDurationS, flattenWorkout } from '@/domain/workout';
import { Text } from '@/design/text';
import { colors, space } from '@/design/tokens';

const GUIDED_SESSION: Record<GuidedKind, { kind: SessionKind; effort: Effort }> = {
  first_run: { kind: 'run_walk', effort: 'easy' },
  easy: { kind: 'easy', effort: 'easy' },
  recovery: { kind: 'easy', effort: 'easy' },
  mindful: { kind: 'easy', effort: 'easy' },
  tempo: { kind: 'tempo', effort: 'tempo' },
  intervals: { kind: 'intervals', effort: 'interval' },
  long: { kind: 'long', effort: 'easy' },
};

export interface CoachNoteRun {
  /** The local run id or the server's: picks the note's wording. */
  runKey: string;
  serverRunId: string | null;
  activity: string;
  distanceM: number;
  activeMs: number;
  startedAtMs: number;
  splits: Split[];
  /** The workout it followed, known right after the run. */
  workout?: ActiveWorkout | null;
  firstRun?: boolean;
  weekGoalMet?: boolean;
}

/** The coach's note for a run (docs/ROADMAP.md 3.3), from the plan session it was, if any. */
export function useCoachNote(run: CoachNoteRun | null): CoachNote | null {
  const { state } = usePlanState();
  const efforts = useRunEfforts(run?.serverRunId ?? null).data?.data;
  if (!run || run.activity !== 'run') return null;

  let session: { kind: SessionKind; effort: Effort; durationS: number } | null = null;
  const source = run.workout?.source;
  if (source?.kind === 'guided') {
    const guided = guidedRun(source.guidedId);
    if (guided) session = { ...GUIDED_SESSION[guided.kind], durationS: workoutDurationS(flattenWorkout(guided.blocks)) ?? 0 };
  } else if (state) {
    const sessions = state.server.sessions;
    const date = competitionDate(run.startedAtMs, state.server.time_zone);
    const planned =
      (source?.kind === 'plan' ? sessions.find((s) => s.id === source.sessionId) : undefined) ??
      (run.serverRunId ? sessions.find((s) => s.run_id === run.serverRunId) : undefined) ??
      sessions.find((s) => s.date === date && (s.run_id === null || s.run_id === run.serverRunId));
    if (planned) session = { kind: planned.kind, effort: planned.effort, durationS: planned.duration_s };
  }
  const record = efforts?.counts_for_records ? (efforts.efforts.find((e) => e.record_when_run)?.effort ?? null) : null;
  return coachNote({
    runId: run.runKey,
    distanceM: run.distanceM,
    activeMs: run.activeMs,
    splitPacesS: run.splits.filter((s) => !s.partial && s.distanceM > 0).map((s) => s.activeMs / 1000 / (s.distanceM / 1000)),
    session: session && session.durationS > 0 ? session : null,
    zones: state?.plan?.zones ?? null,
    newRecord: record,
    firstRun: run.firstRun,
    weekGoalMet: run.weekGoalMet,
  });
}

export function CoachNoteCard({ note }: { note: CoachNote | null }) {
  if (!note) return null;
  return (
    <Card style={styles.card}>
      <View style={styles.row} accessible accessibilityLabel={`Coach: ${note.text}`}>
        <MessageCircle size={22} color={colors.accent} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="eyebrow" tone="accent">
            Coach
          </Text>
          <Text variant="body">{note.text}</Text>
        </View>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { paddingVertical: space.lg },
  row: { flexDirection: 'row', gap: space.md },
});
