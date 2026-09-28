import { useLocalSearchParams, useRouter } from 'expo-router';
import { ArrowLeftRight, CalendarDays, Coffee, Feather, Play } from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { HeatCard, HeatUpsell } from '@/components/train/heat-card';
import { dayLabel } from '@/components/train/train-components';
import { PrimaryButton, SecondaryButton, TextButton } from '@/components/ui/buttons';
import { ConfirmSheet } from '@/components/ui/confirm-sheet';
import { ChoiceChips, InlineStatus, Pill, Row, RowGroup, SwitchRow } from '@/components/ui/elements';
import { Card, NavHeader, Screen } from '@/components/ui/layout';
import { addDays, startOfDay } from '@/domain/calendar';
import { formatDistance, formatDuration } from '@/domain/format';
import { heatAdvice } from '@/domain/heat';
import { hrRangeForEffort, slowRange } from '@/domain/plans/paces';
import type { Effort, PlanAdjustment } from '@/domain/plans/types';
import type { PlanFeedback } from '@/api/schemas';
import { useMe, useRunsBetween } from '@/features/data/hooks';
import {
  describeBlocks,
  EFFORT_FEEL,
  EFFORT_NAMES,
  FEEDBACK_NAMES,
  formatMinutes,
  formatPaceRange,
  sessionView,
} from '@/features/plans/plan-client';
import { usePlanActions, usePlanState } from '@/features/plans/use-plan';
import { usePro } from '@/features/pro/use-pro';
import { useHeat } from '@/features/training/use-heat';
import { useMaxHr } from '@/features/training/use-training';
import { Text } from '@/design/text';
import { space } from '@/design/tokens';

const FEEDBACK: PlanFeedback[] = ['easy', 'about_right', 'hard', 'too_hard'];
const EFFORTS: Effort[] = ['easy', 'steady', 'tempo', 'interval'];

/** A planned session: what to do, how it went, and changing it (Part B points 4–7). */
export default function SessionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { state } = usePlanState();
  const actions = usePlanActions();
  const units = useMe().data?.data.profile?.units ?? 'metric';
  const [sheet, setSheet] = useState<'move' | 'swap' | 'rest' | 'match' | null>(null);
  const [pain, setPain] = useState<boolean | null>(null);
  const { pro } = usePro();
  const maxHr = useMaxHr();

  const server = state?.server.sessions.find((s) => s.id === id) ?? null;
  const view = state && server ? sessionView(state, server) : null;
  const dayStart = server ? startOfDay(addDays(server.date, -1), state!.server.time_zone) : 0;
  const nearbyRuns = useRunsBetween(dayStart, dayStart + 3 * 86_400_000, 'run', sheet === 'match');
  const { entry: heat } = useHeat(server?.date ?? null);

  const upcoming =
    state && server
      ? state.server.sessions.filter((s) => s.id !== server.id && s.date >= state.today && s.run_id === null && s.date <= addDays(server.date, 10))
      : [];

  if (!state || !server || !view) {
    return (
      <Screen edges={['top', 'bottom']}>
        <NavHeader title="Session" />
        <InlineStatus title="This session isn’t in your plan any more." />
      </Screen>
    );
  }

  const s = view.session;
  const plan = state.plan;
  const planZone = plan?.zones && s.effort !== 'walk' ? plan.zones[s.effort] : null;
  // Pro: today's heat slows the range (and the workout's spoken paces, set up in preflight).
  const advice = pro && heat && view.status === 'today' ? heatAdvice(heat) : null;
  const slowdown = advice?.slowdown ?? null;
  const byFeel = advice !== null && advice.slowdown === null;
  const zone = planZone && slowdown ? slowRange(planZone, slowdown) : planZone;
  const hrRange = pro && maxHr ? hrRangeForEffort(maxHr.value, s.effort) : null;
  const editable = !state.readOnly && (view.status === 'today' || view.status === 'upcoming');
  const planId = state.server.id;
  const add = (adjustments: PlanAdjustment[]) => void actions.addAdjustments(adjustments).then(() => setSheet(null));
  const moveDates = Array.from({ length: 8 }, (_, i) => addDays(state.today, i)).filter((d) => d !== s.date && d <= state.server.end_date);
  const painValue = pain ?? view.pain;

  return (
    <Screen edges={['top', 'bottom']}>
      <NavHeader title={dayLabel(s.date, state.today)} />
      <View style={styles.head}>
        <Text variant="title">{s.title}</Text>
        <View style={styles.pills}>
          <Pill label={formatMinutes(s.durationS)} tone="neutral" />
          <Pill label={EFFORT_NAMES[s.effort]} tone={s.hard ? 'accent' : 'neutral'} />
          {s.edited ? <Pill label="Changed" tone="neutral" /> : null}
        </View>
      </View>

      {actions.error ? <InlineStatus tone="danger" title={actions.error} /> : null}

      <Card style={styles.card}>
        <Text variant="eyebrow" tone="secondary">
          The workout
        </Text>
        {describeBlocks(s.blocks).map((line, i) => (
          <Text key={i} variant="body">
            {line.charAt(0).toUpperCase() + line.slice(1)}
          </Text>
        ))}
        {zone ? (
          <Text variant="label" tone="secondary">
            {EFFORT_NAMES[s.effort]} pace: {formatPaceRange(zone, units)}
            {slowdown ? ' (slowed for heat)' : byFeel ? ' (too hot today: go by feel)' : ''}
          </Text>
        ) : null}
        {hrRange ? (
          <Text variant="label" tone="secondary" accessibilityLabel={`Heart rate ${hrRange.low} to ${hrRange.high} beats per minute`}>
            Heart rate: {hrRange.low}–{hrRange.high} bpm
          </Text>
        ) : null}
        <Text variant="label" tone="secondary">
          {EFFORT_FEEL[s.effort]}
        </Text>
        {pro && !maxHr && view.status !== 'done' ? (
          <TextButton label="Set your maximum heart rate for heart-rate ranges" onPress={() => router.push('/profile/run-settings')} />
        ) : null}
      </Card>

      {view.status === 'today' ? pro ? <HeatCard date={s.date} units={units} zone={planZone} effortName={EFFORT_NAMES[s.effort]} /> : <HeatUpsell /> : null}

      {view.status === 'done' && view.run ? (
        <Card style={styles.card}>
          <Text variant="eyebrow" tone="accent">
            Done
          </Text>
          <Row
            label={view.run.title}
            value={`${formatDistance(view.run.distance_m, units).value} ${formatDistance(view.run.distance_m, units).unit} · ${formatDuration(view.run.active_ms)}`}
            onPress={() => router.push({ pathname: '/progress/runs/[id]', params: { id: server.run_id!, server: server.run_id! } })}
            last
          />
          {!state.readOnly ? (
            <>
              <Text variant="labelStrong">How did it feel?</Text>
              <ChoiceChips
                options={FEEDBACK.map((f) => ({ value: f, label: FEEDBACK_NAMES[f] }))}
                value={view.feedback ?? ('' as PlanFeedback)}
                onChange={(f) => void actions.feedback(planId, s.id, f, painValue)}
                label="How did it feel?"
                disabled={actions.busy}
              />
              <RowGroup>
                <SwitchRow
                  label="Something hurt"
                  hint="We’ll suggest rest. See a doctor or physiotherapist if it doesn’t settle."
                  value={painValue}
                  onChange={(next) => {
                    setPain(next);
                    void actions.feedback(planId, s.id, view.feedback, next);
                  }}
                  disabled={actions.busy}
                  last
                />
              </RowGroup>
              <TextButton label="This wasn’t that run" onPress={() => void actions.match(planId, s.id, null)} />
            </>
          ) : null}
        </Card>
      ) : null}

      {view.status === 'missed' || view.status === 'paused' ? (
        <Card style={styles.card}>
          <Text variant="body" tone="secondary">
            {view.status === 'paused' ? 'The plan was paused.' : 'Missed. That’s fine: the plan carries on without cramming it in.'}
          </Text>
          {!state.readOnly ? <SecondaryButton label="I did this one" onPress={() => setSheet('match')} /> : null}
        </Card>
      ) : null}

      {view.status === 'today' ? (
        <PrimaryButton label="Start workout" icon={Play} size="large" onPress={() => router.push({ pathname: '/run/preflight', params: { session: s.id } })} />
      ) : null}

      {editable ? (
        <View style={styles.section}>
          <Text variant="section">Change it</Text>
          <RowGroup>
            <Row icon={CalendarDays} label="Move to another day" onPress={() => setSheet('move')} />
            {upcoming.length > 0 ? <Row icon={ArrowLeftRight} label="Swap with another session" onPress={() => setSheet('swap')} /> : null}
            {s.kind !== 'race' ? <Row icon={Feather} label="Easy run instead" onPress={() => add([{ type: 'easy_instead', sessionId: s.id }])} /> : null}
            {s.kind !== 'race' ? <Row icon={Coffee} label="Rest instead" onPress={() => setSheet('rest')} last /> : null}
          </RowGroup>
          {s.kind !== 'race' ? (
            <>
              <Text variant="labelStrong">Length</Text>
              <ChoiceChips
                options={[-10, -5, 5, 10]
                  .filter((d) => s.durationS / 60 + d >= 10)
                  .map((d) => ({ value: String(d), label: `${d > 0 ? '+' : '−'}${Math.abs(d)} min` }))}
                value=""
                onChange={(d) => add([{ type: 'set_duration', sessionId: s.id, durationS: s.durationS + Number(d) * 60 }])}
                label="Change the length"
                disabled={actions.busy}
              />
              <Text variant="labelStrong">Effort</Text>
              <ChoiceChips
                options={EFFORTS.map((e) => ({ value: e, label: EFFORT_NAMES[e] }))}
                value={s.effort}
                onChange={(e) => e !== s.effort && add([{ type: 'set_effort', sessionId: s.id, effort: e }])}
                label="Change the effort"
                disabled={actions.busy}
              />
            </>
          ) : null}
        </View>
      ) : null}

      <ConfirmSheet visible={sheet === 'move'} title="Move to" confirmLabel="Cancel" onConfirm={() => setSheet(null)} onCancel={() => setSheet(null)}>
        <ChoiceChips
          options={moveDates.map((d) => ({ value: d, label: dayLabel(d, state.today) }))}
          value=""
          onChange={(d) => add([{ type: 'move', sessionId: s.id, toDate: d }])}
          label="Move to"
          disabled={actions.busy}
        />
      </ConfirmSheet>

      <ConfirmSheet visible={sheet === 'swap'} title="Swap with" confirmLabel="Cancel" onConfirm={() => setSheet(null)} onCancel={() => setSheet(null)}>
        <RowGroup>
          {upcoming.map((o, i) => (
            <Row key={o.id} label={o.title} value={dayLabel(o.date, state.today)} onPress={() => add([{ type: 'swap', a: s.id, b: o.id }])} last={i === upcoming.length - 1} />
          ))}
        </RowGroup>
      </ConfirmSheet>

      <ConfirmSheet
        visible={sheet === 'rest'}
        title="Rest instead?"
        body="The session comes out of the plan. Nothing moves to other days."
        confirmLabel="Rest"
        busy={actions.busy}
        onConfirm={() => add([{ type: 'rest_instead', sessionId: s.id }])}
        onCancel={() => setSheet(null)}
      />

      <ConfirmSheet visible={sheet === 'match'} title="Which run was it?" confirmLabel="Cancel" onConfirm={() => setSheet(null)} onCancel={() => setSheet(null)}>
        {(nearbyRuns.data?.data ?? []).length === 0 ? (
          <Text variant="body" tone="secondary">
            {nearbyRuns.isPending ? 'Looking for runs around that day…' : 'No runs around that day.'}
          </Text>
        ) : (
          <RowGroup>
            {(nearbyRuns.data?.data ?? []).map((r, i, all) => (
              <Row
                key={r.id}
                label={r.title}
                value={`${formatDistance(r.distance_m, units).value} ${formatDistance(r.distance_m, units).unit}`}
                onPress={() => void actions.match(planId, s.id, r.id).then(() => setSheet(null))}
                last={i === all.length - 1}
              />
            ))}
          </RowGroup>
        )}
      </ConfirmSheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { gap: space.sm },
  pills: { flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' },
  card: { gap: space.sm },
  section: { gap: space.sm },
});
