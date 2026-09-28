import { useRouter } from 'expo-router';
import { CirclePause, CirclePlay, FastForward, Repeat, RefreshCw, Square } from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { dayLabel } from '@/components/train/train-components';
import { SecondaryButton } from '@/components/ui/buttons';
import { ConfirmSheet } from '@/components/ui/confirm-sheet';
import { ChoiceChips, InlineStatus, Row, RowGroup, TextField } from '@/components/ui/elements';
import { NavHeader, Screen } from '@/components/ui/layout';
import { addDays } from '@/domain/calendar';
import { daysBetween } from '@/domain/plans/generate';
import { TEMPLATES } from '@/domain/plans/templates';
import { currentPause, formatRaceTime, PLAN_NAMES, parseRaceTime, resumeAdjustments } from '@/features/plans/plan-client';
import { usePlanActions, usePlanState } from '@/features/plans/use-plan';
import { Text } from '@/design/text';
import { space } from '@/design/tokens';

const PAUSES = [
  { value: '3', label: '3 days' },
  { value: '7', label: '1 week' },
  { value: '14', label: '2 weeks' },
  { value: '21', label: '3 weeks' },
];

/** Changing the whole plan: pause, repeat or skip a week, the goal, limits, or a new plan (Part B point 6). */
export default function ManagePlanScreen() {
  const router = useRouter();
  const { state } = usePlanState();
  const actions = usePlanActions();
  const [sheet, setSheet] = useState<'pause' | 'end' | 'repeat' | 'skip' | null>(null);
  const [goalText, setGoalText] = useState<string | null>(null);

  if (!state || state.server.status !== 'active') {
    return (
      <Screen edges={['top', 'bottom']}>
        <NavHeader title="Manage plan" />
        <InlineStatus title="There’s no plan running." />
      </Screen>
    );
  }

  const input = state.input;
  const race = !!(input && TEMPLATES[input.type].race);
  const week = Math.floor(daysBetween(state.server.start_date, state.today) / 7) + 1;
  const focus = state.plan?.weeks[week - 1]?.focus;
  const weekEditable = focus === 'base' || focus === 'build' || focus === 'lighter';
  const pause = currentPause(state);
  const goal = goalText ?? (input?.goalTimeS ? formatRaceTime(input.goalTimeS) : '');
  const goalS = goal.trim() ? parseRaceTime(goal) : null;
  const locked = state.readOnly;
  const done = () => setSheet(null);

  return (
    <Screen edges={['top', 'bottom']}>
      <NavHeader title="Manage plan" />
      <Text variant="section">{PLAN_NAMES[state.server.type]}</Text>
      {locked ? <InlineStatus tone="warning" title="Update the app to change this plan." /> : null}
      {actions.error ? <InlineStatus tone="danger" title={actions.error} /> : null}

      <RowGroup>
        {pause ? (
          <Row icon={CirclePlay} label="Resume now" hint={`Paused until ${dayLabel(pause.to)}`} onPress={locked ? undefined : () => void actions.rewriteAdjustments(resumeAdjustments)} />
        ) : (
          <Row icon={CirclePause} label="Pause the plan" hint="For illness, injury or travel. You come back to a gentler week." onPress={locked ? undefined : () => setSheet('pause')} />
        )}
        {weekEditable ? (
          <>
            <Row icon={Repeat} label="Repeat this week" hint="Do this week again next week." onPress={locked ? undefined : () => setSheet('repeat')} />
            <Row
              icon={FastForward}
              label={race ? 'Rest this week' : 'Skip this week'}
              hint={race ? 'Your race day stays put, so the week becomes rest.' : 'Move on to next week’s sessions now.'}
              onPress={locked ? undefined : () => setSheet('skip')}
              last
            />
          </>
        ) : null}
      </RowGroup>

      {race && input ? (
        <View style={styles.section}>
          <TextField
            label="Goal time"
            placeholder="Just finish"
            value={goal}
            onChangeText={setGoalText}
            error={goal.trim() && goalS === null ? 'Enter a time like 25:00 or 1:55:00.' : null}
            keyboardType="numbers-and-punctuation"
            autoCorrect={false}
          />
          <View style={styles.buttons}>
            <SecondaryButton label="Save goal" disabled={locked || (goal.trim() !== '' && goalS === null)} loading={actions.busy} onPress={() => void actions.updateInput({ goalTimeS: goalS })} />
            <SecondaryButton label="Just finish" disabled={locked} onPress={() => { setGoalText(''); void actions.updateInput({ goalTimeS: null }); }} />
          </View>
          <Text variant="caption" tone="secondary">
            A new race date is a new plan: start one below.
          </Text>
        </View>
      ) : null}

      {input ? (
        <View style={styles.section}>
          <Text variant="labelStrong">Longest session you’ll do</Text>
          <ChoiceChips
            options={[
              { value: 'none', label: 'No limit' },
              { value: '45', label: '45 min' },
              { value: '60', label: '1 h' },
              { value: '90', label: '1 h 30' },
              { value: '120', label: '2 h' },
            ]}
            value={input.maxSessionMin ? String(input.maxSessionMin) : 'none'}
            onChange={(v) => void actions.updateInput({ maxSessionMin: v === 'none' ? null : Number(v) })}
            label="Longest session"
            disabled={locked || actions.busy}
          />
        </View>
      ) : null}

      <RowGroup>
        <Row icon={RefreshCw} label="Start a different plan" onPress={() => router.push({ pathname: '/train/setup', params: { type: state.server.type } })} />
        <Row icon={Square} label="End this plan" tone="danger" onPress={() => setSheet('end')} last />
      </RowGroup>

      <ConfirmSheet visible={sheet === 'pause'} title="Pause for" confirmLabel="Cancel" onConfirm={done} onCancel={done}>
        <ChoiceChips
          options={PAUSES}
          value=""
          onChange={(days) => void actions.addAdjustments([{ type: 'pause', from: state.today, to: addDays(state.today, Number(days) - 1) }]).then(done)}
          label="Pause for"
          disabled={actions.busy}
        />
      </ConfirmSheet>
      <ConfirmSheet
        visible={sheet === 'repeat'}
        title="Repeat this week?"
        body={race ? 'Next week is this week again. A later week makes room, so race day stays put.' : 'Next week is this week again, and the plan runs a week longer.'}
        confirmLabel="Repeat"
        busy={actions.busy}
        onConfirm={() => void actions.addAdjustments([{ type: 'repeat_week', week }]).then(done)}
        onCancel={done}
      />
      <ConfirmSheet
        visible={sheet === 'skip'}
        title={race ? 'Rest this week?' : 'Skip this week?'}
        body={race ? 'This week’s sessions come out, and next week starts a little gentler.' : 'Next week’s sessions start now, and the plan ends a week sooner.'}
        confirmLabel={race ? 'Rest' : 'Skip'}
        busy={actions.busy}
        onConfirm={() => void actions.addAdjustments([{ type: 'skip_week', week }]).then(done)}
        onCancel={done}
      />
      <ConfirmSheet
        visible={sheet === 'end'}
        title="End this plan?"
        body="Its sessions and your runs stay in your history."
        confirmLabel="End plan"
        destructive
        busy={actions.busy}
        onConfirm={() => void actions.end(state.server.id).then((r) => { done(); if (r !== null) router.back(); })}
        onCancel={done}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  section: { gap: space.sm },
  buttons: { flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' },
});
