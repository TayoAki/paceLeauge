import { useRouter } from 'expo-router';
import { CalendarCheck, HeartPulse, Play, Settings2 } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { RefreshControl, StyleSheet, View } from 'react-native';

import { GuidedList } from '@/components/train/guided-list';
import { dayLabel, Stat, warningText, WeekCard } from '@/components/train/train-components';
import { PrimaryButton, SecondaryButton, TextButton } from '@/components/ui/buttons';
import { ConfirmSheet } from '@/components/ui/confirm-sheet';
import { InlineStatus, Row, RowGroup, SegmentedControl } from '@/components/ui/elements';
import { Card, LargeHeader, Screen } from '@/components/ui/layout';
import { checkInAdjustments, coachPrompts } from '@/domain/plans/adapt';
import { PLAN_TYPES } from '@/domain/plans/templates';
import type { PlanAdjustment } from '@/domain/plans/types';
import {
  currentPause,
  formatMinutes,
  formatRaceTime,
  LEVEL_NAMES,
  PLAN_BLURBS,
  PLAN_NAMES,
  planWeeks,
  resumeAdjustments,
  todaysSessions,
  type PlanState,
} from '@/features/plans/plan-client';
import { usePlanActions, usePlanState } from '@/features/plans/use-plan';
import { Text } from '@/design/text';
import { colors, space } from '@/design/tokens';

/** Train (docs/ROADMAP.md 3.1 and 3.4): the runner's plan, or a choice of plans, and guided runs. */
export default function TrainScreen() {
  const { state, query, offline } = usePlanState();
  const [section, setSection] = useState<'plan' | 'guided'>('plan');
  const refreshing = query.isFetching && !query.isPending;
  return (
    <Screen refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void query.refetch()} tintColor={colors.textSecondary} />}>
      <LargeHeader title="Train" subtitle={state?.server.status === 'active' ? PLAN_NAMES[state.server.type] : undefined} />
      <SegmentedControl
        options={[
          { value: 'plan', label: 'Plan' },
          { value: 'guided', label: 'Guided runs' },
        ]}
        value={section}
        onChange={setSection}
        label="Train"
      />
      {section === 'guided' ? <GuidedList /> : <PlanSection state={state} query={query} offline={offline} />}
    </Screen>
  );
}

function PlanSection({ state, query, offline }: ReturnType<typeof usePlanState>) {
  return (
    <>
      {offline ? <InlineStatus title="Showing your plan from earlier." body="You’re offline. Changes need a connection." /> : null}
      {query.isError && !query.data ? <InlineStatus tone="danger" title="Couldn’t load your plan." body="Pull to try again." /> : null}
      {query.isPending ? null : state && state.server.status === 'active' ? (
        <ActivePlan state={state} />
      ) : (
        <>
          {state ? <FinishedPlan state={state} /> : null}
          <PlanChooser />
        </>
      )}
    </>
  );
}

function PlanChooser() {
  const router = useRouter();
  return (
    <View style={styles.section}>
      <Text variant="section" accessibilityRole="header">
        Choose a plan
      </Text>
      <Text variant="body" tone="secondary">
        Plans start from what you’ve been running, build slowly, and change when you do. Every plan is free.
      </Text>
      <RowGroup>
        {PLAN_TYPES.map((type, i) => (
          <Row
            key={type}
            label={PLAN_NAMES[type]}
            hint={PLAN_BLURBS[type]}
            onPress={() => router.push({ pathname: '/train/setup', params: { type } })}
            last={i === PLAN_TYPES.length - 1}
            testID={`plan-type-${type}`}
          />
        ))}
      </RowGroup>
    </View>
  );
}

function FinishedPlan({ state }: { state: PlanState }) {
  const weeks = planWeeks(state);
  const planned = weeks.reduce((n, w) => n + w.sessions.length, 0);
  const done = weeks.reduce((n, w) => n + w.done, 0);
  return (
    <Card style={styles.card}>
      <Text variant="eyebrow" tone="accent">
        {state.server.status === 'completed' ? 'Plan complete' : 'Plan ended'}
      </Text>
      <Text variant="section">{PLAN_NAMES[state.server.type]}</Text>
      <Text variant="body" tone="secondary">
        You did {done} of {planned} sessions. {state.server.status === 'completed' ? 'Well done.' : ''}
      </Text>
    </Card>
  );
}

function ActivePlan({ state }: { state: PlanState }) {
  const router = useRouter();
  const actions = usePlanActions();
  const weeks = useMemo(() => planWeeks(state), [state]);
  const today = todaysSessions(state);
  const pause = currentPause(state);
  const prompts = state.plan ? coachPrompts(state.plan, state.records, state.today) : [];
  const easierToday = state.plan ? checkInAdjustments(state.plan, state.today, 'easy', state.records).length > 0 : false;
  const [checkIn, setCheckIn] = useState(false);
  const notStarted = state.today < state.server.start_date;
  const current = weeks.find((w) => w.current) ?? (notStarted ? weeks[0] : undefined);
  const input = state.input;
  const open = today.filter((s) => s.status === 'today');
  const firstSession = state.server.sessions[0];

  return (
    <View style={styles.section}>
      <Card style={styles.card}>
        <Text variant="eyebrow" tone="secondary">
          {notStarted ? `${weeks.length} weeks` : current ? `Week ${current.index} of ${weeks.length}` : `${weeks.length} weeks`}
          {input ? ` · ${LEVEL_NAMES[input.level]}` : ''}
        </Text>
        <View style={styles.stats}>
          <Stat label={notStarted ? 'sessions in week 1' : 'done this week'} value={current ? (notStarted ? String(current.sessions.length) : `${current.done}/${current.sessions.length}`) : '–'} />
          <Stat label="minutes this week" value={current ? String(current.minutes) : '–'} />
          {state.plan?.predictedTimeS ? (
            <Stat label="predicted today" value={formatRaceTime(state.plan.predictedTimeS)} />
          ) : null}
        </View>
        {input?.raceDate ? (
          <Text variant="label" tone="secondary">
            Race day {dayLabel(input.raceDate)}
            {input.goalTimeS ? ` · goal ${formatRaceTime(input.goalTimeS)}` : ' · finish'}
          </Text>
        ) : null}
      </Card>

      {state.readOnly ? (
        <InlineStatus tone="warning" title="Update the app to change this plan." body="It was saved by a newer version of PaceLeague." />
      ) : null}
      {actions.error ? <InlineStatus tone="danger" title={actions.error} /> : null}

      {pause ? (
        <InlineStatus
          icon={CalendarCheck}
          title={`Paused until ${dayLabel(pause.to)}`}
          body="Your plan picks up gently when you’re back."
          action={
            state.readOnly ? undefined : (
              <TextButton label="Resume now" loading={actions.busy} onPress={() => void actions.rewriteAdjustments(resumeAdjustments)} />
            )
          }
        />
      ) : (
        <Card style={styles.card}>
          <Text variant="eyebrow" tone="accent">
            Today
          </Text>
          {notStarted ? (
            <Text variant="body" tone="secondary">
              Your plan starts {firstSession ? dayLabel(firstSession.date) : dayLabel(state.server.start_date)}. Run as you like until then.
            </Text>
          ) : today.length === 0 ? (
            <Text variant="body" tone="secondary">
              Rest day. Recovery is part of the plan.
            </Text>
          ) : (
            today.map((view) => (
              <View key={view.session.id} style={styles.today}>
                <Text variant="section">{view.session.title}</Text>
                <Text variant="label" tone="secondary">
                  {view.status === 'done' ? 'Done' : formatMinutes(view.session.durationS)}
                </Text>
                <View style={styles.buttons}>
                  {view.status === 'today' ? (
                    <PrimaryButton
                      label="Start workout"
                      icon={Play}
                      onPress={() => router.push({ pathname: '/run/preflight', params: { session: view.session.id } })}
                      testID="start-workout"
                    />
                  ) : null}
                  <SecondaryButton label="Details" onPress={() => router.push({ pathname: '/train/session/[id]', params: { id: view.session.id } })} />
                </View>
              </View>
            ))
          )}
          {open.length > 0 && !state.readOnly ? (
            <TextButton label="Not feeling 100%?" icon={HeartPulse} onPress={() => setCheckIn(true)} testID="check-in" />
          ) : null}
        </Card>
      )}

      {prompts.map((p) =>
        p.kind === 'pain' ? (
          <InlineStatus
            key="pain"
            tone="warning"
            title="You flagged pain."
            body="Rest until it settles. If it doesn’t, or it changes how you run, see a doctor or physiotherapist. The return-from-a-break plan eases you back when you’re ready."
            action={<TextButton label="See the plan" onPress={() => router.push({ pathname: '/train/setup', params: { type: 'return' } })} />}
          />
        ) : p.kind === 'lightened' ? (
          <InlineStatus key="lightened" tone="success" title="This week is lighter." body="Two sessions felt too hard last week, so this one eases off." />
        ) : state.readOnly ? null : (
          <InlineStatus
            key="missed"
            title="Missed a few sessions?"
            body="Count them as a pause, and the plan eases you back in rather than picking up where it was."
            action={<TextButton label="Count as a pause" loading={actions.busy} onPress={() => void actions.addAdjustments([p.pause as PlanAdjustment])} />}
          />
        ),
      )}

      {state.plan?.warnings.length ? (
        <View style={styles.warnings}>
          {state.plan.warnings.map((w, i) => (
            <InlineStatus key={`${w.code}-${w.week ?? ''}-${w.sessionId ?? ''}-${i}`} tone="warning" title={warningText(w)} />
          ))}
        </View>
      ) : null}

      {weeks.map((week) => (
        <WeekCard key={week.index} week={week} today={state.today} initiallyOpen={week.current} />
      ))}

      <SecondaryButton label="Manage plan" icon={Settings2} onPress={() => router.push('/train/manage')} testID="manage-plan" />

      <ConfirmSheet
        visible={checkIn}
        title="Not feeling 100%?"
        body={
          easierToday
            ? 'Swap today for something gentler. Nothing is added to later days.'
            : 'Today’s run is already easy: keep it gentle and short, or rest. Nothing is added to later days.'
        }
        confirmLabel={easierToday ? 'Easy run instead' : 'Rest today'}
        busy={actions.busy}
        onConfirm={() => void actions.checkIn(easierToday ? 'easy' : 'rest').then(() => setCheckIn(false))}
        onCancel={() => setCheckIn(false)}>
        {easierToday ? <SecondaryButton label="Rest today" onPress={() => void actions.checkIn('rest').then(() => setCheckIn(false))} /> : null}
      </ConfirmSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: space.lg },
  card: { gap: space.sm },
  stats: { flexDirection: 'row', gap: space.sm },
  today: { gap: space.xs, paddingVertical: space.xs },
  buttons: { flexDirection: 'row', gap: space.sm, flexWrap: 'wrap', marginTop: space.sm },
  warnings: { gap: space.sm },
});
