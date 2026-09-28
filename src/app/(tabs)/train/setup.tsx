import { useLocalSearchParams, useRouter } from 'expo-router';
import { Minus, Plus } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { dayLabel, SessionRow, Stat, warningText } from '@/components/train/train-components';
import { PrimaryButton } from '@/components/ui/buttons';
import { ConfirmSheet } from '@/components/ui/confirm-sheet';
import { ChoiceChips, InlineStatus, RowGroup, SwitchRow, TextField } from '@/components/ui/elements';
import { Card, NavHeader, Screen } from '@/components/ui/layout';
import { addDays, competitionDate, weekStartOf } from '@/domain/calendar';
import { generatePlan, validatePlanInput, type PlanInputProblem } from '@/domain/plans/generate';
import { PLAN_LEVELS, PLAN_TYPES, TEMPLATES } from '@/domain/plans/templates';
import type { EffortKey, Plan, PlanInput, PlanLevel, PlanType } from '@/domain/plans/types';
import { usePersonalRecords, useRunsBetween, useStats } from '@/features/data/hooks';
import {
  DAY_NAMES,
  defaultStart,
  formatMinutes,
  formatRaceTime,
  LEVEL_NAMES,
  PLAN_BLURBS,
  PLAN_NAMES,
  parseRaceTime,
  planHistory,
  suggestedLevel,
} from '@/features/plans/plan-client';
import { deviceTimeZone, usePlanActions, usePlanState } from '@/features/plans/use-plan';
import { Text } from '@/design/text';
import { colors, radius, space } from '@/design/tokens';

const PROBLEMS: Record<PlanInputProblem, string> = {
  bad_start: 'Pick when to start.',
  bad_first_day: 'Pick when to start.',
  bad_race_date: 'The race has to be after the plan starts.',
  race_too_far: 'Pick a race within a year.',
  bad_goal: 'Enter a goal time like 25:00 or 1:55:00, or leave it empty.',
  bad_days: 'Pick 2 to 6 days a week.',
  too_few_days: 'This distance needs at least 3 days a week.',
  bad_long_run_day: 'Pick a day for the long run.',
  bad_max_session: 'Pick a longest session of 30 minutes or more.',
};

const RACE_EFFORTS: { value: EffortKey; label: string }[] = [
  { value: '5k', label: '5K' },
  { value: '10k', label: '10K' },
  { value: 'half', label: 'Half' },
  { value: 'marathon', label: 'Marathon' },
];

function Stepper({ label, value, onChange, min, max, format }: { label: string; value: number; onChange: (n: number) => void; min: number; max: number; format: (n: number) => string }) {
  return (
    <View style={styles.stepper} accessible accessibilityRole="adjustable" accessibilityLabel={label} accessibilityValue={{ text: format(value) }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(e) => onChange(Math.min(max, Math.max(min, value + (e.nativeEvent.actionName === 'increment' ? 1 : -1))))}>
      <Pressable style={styles.stepButton} onPress={() => onChange(Math.max(min, value - 1))} disabled={value <= min} accessibilityLabel={`Fewer: ${label}`}>
        <Minus size={20} color={value <= min ? colors.controlOutline : colors.textPrimary} />
      </Pressable>
      <Text variant="bodyStrong" style={styles.stepValue}>
        {format(value)}
      </Text>
      <Pressable style={styles.stepButton} onPress={() => onChange(Math.min(max, value + 1))} disabled={value >= max} accessibilityLabel={`More: ${label}`}>
        <Plus size={20} color={value >= max ? colors.controlOutline : colors.textPrimary} />
      </Pressable>
    </View>
  );
}

/** Plan setup (docs/ROADMAP.md Part B point 2): start from where the runner is. */
export default function PlanSetupScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ type?: string }>();
  const actions = usePlanActions();
  const { state: existing } = usePlanState();
  const [now] = useState(() => Date.now());
  const today = competitionDate(now, deviceTimeZone());
  const monday = weekStartOf(today);

  const stats = useStats({ from: addDays(monday, -28), to: addDays(monday, -1), bucket: 'week', activity: 'run' });
  const records = usePersonalRecords();
  const runs = useRunsBetween(now - 28 * 86_400_000, now, 'run');
  const history = useMemo(
    () =>
      planHistory({
        stats: stats.data?.data ?? null,
        records: records.data?.data ?? null,
        runs: (runs.data?.data ?? []).map((r) => ({ startedAtMs: r.started_at_ms, activeMs: r.active_ms })),
        now,
      }),
    [stats.data, records.data, runs.data, now],
  );

  const initialType = PLAN_TYPES.includes(params.type as PlanType) ? (params.type as PlanType) : '5k';
  const [type, setType] = useState<PlanType>(initialType);
  const [level, setLevel] = useState<PlanLevel | null>(null);
  const [days, setDays] = useState(initialType === 'start_running' ? 3 : 4);
  const [longRunDay, setLongRunDay] = useState(6);
  const [startNextWeek, setStartNextWeek] = useState(defaultStart(today).firstDay === null && defaultStart(today).startDate !== monday);
  const [raceWeeks, setRaceWeeks] = useState<number | null>(null);
  const [raceDay, setRaceDay] = useState(6);
  const [goalText, setGoalText] = useState('');
  const [raceEffort, setRaceEffort] = useState<EffortKey | 'none'>('none');
  const [raceTimeText, setRaceTimeText] = useState('');
  const [maxSession, setMaxSession] = useState<string>('none');
  const [injury, setInjury] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState(false);

  const tpl = TEMPLATES[type];
  const chosenLevel = level ?? suggestedLevel(history);
  const startDate = startNextWeek ? addDays(monday, 7) : monday;
  const firstDay = startNextWeek || today === monday ? null : today;
  const usualWeeks = tpl.weeks[chosenLevel];
  const weeksToRace = raceWeeks ?? usualWeeks;
  const raceDate = tpl.race ? addDays(startDate, (weeksToRace - 1) * 7 + raceDay) : null;
  const goalS = goalText.trim() ? parseRaceTime(goalText) : null;
  const raceTimeS = raceEffort !== 'none' && raceTimeText.trim() ? parseRaceTime(raceTimeText) : null;

  const input: PlanInput = {
    type,
    level: chosenLevel,
    startDate,
    firstDay,
    raceDate: tpl.race && raceWeeks !== null ? raceDate : null,
    goalTimeS: tpl.race ? goalS : null,
    daysPerWeek: Math.max(days, tpl.minDays),
    longRunDay,
    maxSessionMin: maxSession === 'none' ? null : Number(maxSession),
    recentInjury: injury,
    history: {
      ...history,
      bestEfforts: raceEffort !== 'none' && raceTimeS ? { ...history.bestEfforts, [raceEffort]: raceTimeS } : history.bestEfforts,
    },
  };
  const goalError = tpl.race && goalText.trim() && goalS === null ? PROBLEMS.bad_goal : null;
  const raceTimeError = raceEffort !== 'none' && raceTimeText.trim() && raceTimeS === null ? 'Enter a time like 24:30.' : null;
  const problem = validatePlanInput(input);
  let preview: Plan | null = null;
  if (!problem) {
    try {
      preview = generatePlan(input);
    } catch {
      preview = null;
    }
  }

  // The plan starts from recent runs, so it waits for them (or for them to fail to load).
  const historyReady = !stats.isPending && !records.isPending && !runs.isPending;
  const replacing = existing?.server.status === 'active';
  const start = async () => {
    setConfirmReplace(false);
    const saved = await actions.create(input);
    if (saved) router.replace('/train');
  };

  const firstWeek = preview?.weeks.find((w) => w.sessions.length > 0);
  const peak = preview ? Math.max(...preview.weeks.map((w) => w.minutes)) : 0;

  return (
    <Screen edges={['top', 'bottom']}>
      <NavHeader title="New plan" />
      <View style={styles.section}>
        <Text variant="labelStrong">Plan</Text>
        <ChoiceChips options={PLAN_TYPES.map((t) => ({ value: t, label: PLAN_NAMES[t] }))} value={type} onChange={(t) => { setType(t); setRaceWeeks(null); }} label="Plan" />
        <Text variant="label" tone="secondary">
          {PLAN_BLURBS[type]}
        </Text>
      </View>

      <View style={styles.section}>
        <Text variant="labelStrong">Your running</Text>
        <ChoiceChips options={PLAN_LEVELS.map((l) => ({ value: l, label: LEVEL_NAMES[l] }))} value={chosenLevel} onChange={setLevel} label="Your running" />
        <Text variant="label" tone="secondary">
          {!historyReady
            ? 'Reading your recent runs…'
            : history.weeklyMinutes.some((m) => m > 0)
            ? `You’ve run about ${formatMinutes((history.weeklyMinutes.reduce((a, b) => a + b, 0) / Math.max(1, history.weeklyMinutes.length)) * 60)} a week lately. The plan starts from there.`
            : 'No recent runs yet, so the plan starts gently.'}
        </Text>
      </View>

      <View style={styles.section}>
        <Text variant="labelStrong">Days a week</Text>
        <ChoiceChips
          options={[2, 3, 4, 5, 6].filter((d) => d >= tpl.minDays && d <= Math.max(tpl.minDays, tpl.maxDays[chosenLevel])).map((d) => ({ value: String(d), label: String(d) }))}
          value={String(Math.min(Math.max(days, tpl.minDays), tpl.maxDays[chosenLevel]))}
          onChange={(d) => setDays(Number(d))}
          label="Days a week"
        />
        <Text variant="labelStrong">{tpl.runWalk ? 'Favourite day to run' : 'Long run day'}</Text>
        <ChoiceChips options={DAY_NAMES.map((d, i) => ({ value: String(i), label: d.slice(0, 3), accessibilityLabel: d }))} value={String(longRunDay)} onChange={(d) => setLongRunDay(Number(d))} label="Long run day" />
      </View>

      {tpl.race ? (
        <View style={styles.section}>
          <Text variant="labelStrong">Race day</Text>
          <Stepper label="Weeks to race day" value={weeksToRace} onChange={setRaceWeeks} min={1} max={40} format={(n) => (n === 1 ? 'This week' : `${n} weeks`)} />
          <ChoiceChips options={DAY_NAMES.map((d, i) => ({ value: String(i), label: d.slice(0, 3), accessibilityLabel: d }))} value={String(raceDay)} onChange={(d) => { setRaceDay(Number(d)); setRaceWeeks(weeksToRace); }} label="Race day of the week" />
          {raceDate ? (
            <Text variant="label" tone="secondary">
              {dayLabel(raceDate)}
              {raceWeeks === null ? ` · the usual ${usualWeeks} weeks` : ''}
            </Text>
          ) : null}
          <TextField label="Goal time (optional)" placeholder={type === '5k' ? 'e.g. 25:00' : type === '10k' ? 'e.g. 52:00' : 'e.g. 1:55:00'} value={goalText} onChangeText={setGoalText} error={goalError} hint="Leave it empty to train to finish." keyboardType="numbers-and-punctuation" autoCorrect={false} />
        </View>
      ) : null}

      <View style={styles.section}>
        <Text variant="labelStrong">A recent race (optional)</Text>
        <Text variant="label" tone="secondary">
          Sets your paces. Otherwise they come from your best efforts of the last six months, or you train by feel.
        </Text>
        <ChoiceChips options={[{ value: 'none' as const, label: 'None' }, ...RACE_EFFORTS]} value={raceEffort} onChange={setRaceEffort} label="Recent race distance" />
        {raceEffort !== 'none' ? (
          <TextField label="Your time" placeholder="e.g. 24:30" value={raceTimeText} onChangeText={setRaceTimeText} error={raceTimeError} keyboardType="numbers-and-punctuation" autoCorrect={false} />
        ) : null}
      </View>

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
          value={maxSession}
          onChange={setMaxSession}
          label="Longest session"
        />
        <RowGroup>
          <SwitchRow label="Injured or ill in the last 3 months" hint="The plan starts lower and adds a lighter week more often." value={injury} onChange={setInjury} last />
        </RowGroup>
      </View>

      <View style={styles.section}>
        <Text variant="labelStrong">Start</Text>
        <ChoiceChips
          options={[
            { value: 'now', label: 'Today' },
            { value: 'next', label: dayLabel(addDays(monday, 7)) },
          ]}
          value={startNextWeek ? 'next' : 'now'}
          onChange={(v) => setStartNextWeek(v === 'next')}
          label="Start"
        />
      </View>

      {preview ? (
        <Card style={styles.preview}>
          <Text variant="eyebrow" tone="accent">
            Your plan
          </Text>
          <View style={styles.stats}>
            <Stat label="weeks" value={String(preview.weeks.length)} />
            <Stat label="most minutes in a week" value={String(peak)} />
            {preview.predictedTimeS ? <Stat label="predicted today" value={formatRaceTime(preview.predictedTimeS)} /> : null}
          </View>
          {preview.warnings.map((w, i) => (
            <InlineStatus key={`${w.code}-${i}`} tone="warning" title={warningText(w)} />
          ))}
          {firstWeek ? (
            <View>
              <Text variant="labelStrong">Week {firstWeek.index}</Text>
              {firstWeek.sessions.map((s, i) => (
                <SessionRow key={s.id} view={{ session: s, status: 'upcoming', feedback: null, pain: false, matchedBy: null, run: null }} today={today} last={i === firstWeek.sessions.length - 1} />
              ))}
            </View>
          ) : null}
        </Card>
      ) : problem ? (
        <InlineStatus tone="danger" title={PROBLEMS[problem]} />
      ) : null}

      {actions.error ? <InlineStatus tone="danger" title={actions.error} /> : null}
      <PrimaryButton
        label="Start plan"
        size="large"
        loading={actions.busy}
        disabled={!preview || !!goalError || !!raceTimeError || !historyReady}
        onPress={() => (replacing ? setConfirmReplace(true) : void start())}
        testID="start-plan"
      />
      <Text variant="caption" tone="secondary">
        Plans are starting points written for our coach’s review. Listen to your body: skip or ease any session, and see a professional about pain.
      </Text>

      <ConfirmSheet
        visible={confirmReplace}
        title="Replace your current plan?"
        body={existing ? `Your ${PLAN_NAMES[existing.server.type]} plan ends. Its sessions stay in your history.` : undefined}
        confirmLabel="Start new plan"
        busy={actions.busy}
        onConfirm={() => void start()}
        onCancel={() => setConfirmReplace(false)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  section: { gap: space.sm },
  preview: { gap: space.md },
  stats: { flexDirection: 'row', gap: space.sm },
  stepper: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderRadius: radius.control, alignSelf: 'flex-start' },
  stepButton: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  stepValue: { minWidth: 110, textAlign: 'center' },
});
