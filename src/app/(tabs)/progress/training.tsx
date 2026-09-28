import { useRouter } from 'expo-router';
import { Lock } from 'lucide-react-native';
import { useState } from 'react';
import { RefreshControl, StyleSheet, View } from 'react-native';

import { BarChart } from '@/components/progress/progress-extras';
import { LineChart } from '@/components/training/line-chart';
import { PrimaryButton } from '@/components/ui/buttons';
import { InlineStatus, RowGroup, SwitchRow } from '@/components/ui/elements';
import { Card, NavHeader, Screen } from '@/components/ui/layout';
import { DEFINITIONS, formLabel, RACE_KEYS, trendChange, type FormLabel, type RaceKey, type TrendKind } from '@/domain/training';
import type { Units } from '@/domain/types';
import { useAccountServices } from '@/features/account/account-provider';
import { useMe } from '@/features/data/hooks';
import { deviceHealthData } from '@/features/health/health-data';
import { formatRaceTime } from '@/features/plans/plan-client';
import { effortLabel, shortDate } from '@/features/progress/records';
import { bucketLabel, bucketLabelLong } from '@/features/progress/stats-ranges';
import { usePro } from '@/features/pro/use-pro';
import type { TrainingSummary } from '@/features/training/training-data';
import { useHealthTrends, useRunSettings, useTraining, type HealthTrends } from '@/features/training/use-training';
import { Text } from '@/design/text';
import { avatarFills, colors, space } from '@/design/tokens';

const FORM_WORDS: Record<FormLabel, { title: string; body: string }> = {
  fresh: { title: 'Fresh', body: 'You’re well rested: a good time for a race or a hard session.' },
  ready: { title: 'Ready', body: 'Training and recovery are in balance.' },
  building: { title: 'Building', body: 'You’re carrying some tiredness from recent training. That’s normal while building.' },
  tired: { title: 'Tired', body: 'A lot of recent load. An easy day or a rest day will help it turn into fitness.' },
};

const RACE_NAMES: Record<RaceKey, string> = { '5k': '5K', '10k': '10K', half: 'Half marathon', marathon: 'Marathon' };
const FITNESS_COLOR = colors.accent;
const FATIGUE_COLOR = avatarFills[1];

/** Training analytics (docs/ROADMAP.md 3.5, Pro), worked out on this phone from your activities. */
export default function TrainingScreen() {
  const router = useRouter();
  const { pro, loading } = usePro();
  const units = useMe().data?.data.profile?.units ?? 'metric';
  const training = useTraining(pro);
  const summary = training.summary;

  if (!pro) {
    return (
      <Screen edges={['top', 'bottom']}>
        <NavHeader title="Training" />
        <Card style={{ gap: space.md }}>
          <View style={styles.row}>
            <Lock size={20} color={colors.accent} />
            <Text variant="section" style={{ flex: 1 }}>
              Training analytics are part of Pro
            </Text>
          </View>
          <Text variant="body" tone="secondary">
            See your training load, fitness and fatigue, race predictions, aerobic efficiency and, from Apple Health, trends in resting heart
            rate, heart rate variability, VO2 max and sleep.
          </Text>
          <PrimaryButton label="See Pro" onPress={() => router.push('/pro')} disabled={loading} testID="training-see-pro" />
        </Card>
        <Text variant="caption" tone="secondary">
          Heart-rate zones for each run stay free, on every run’s page.
        </Text>
      </Screen>
    );
  }

  return (
    <Screen
      edges={['top', 'bottom']}
      refreshControl={<RefreshControl refreshing={false} onRefresh={() => void training.refetch()} tintColor={colors.textSecondary} />}>
      <NavHeader title="Training" />
      {training.offline ? <InlineStatus title="Offline — showing saved activities." /> : null}
      {training.isError ? <InlineStatus tone="danger" title="Couldn’t load your activities." body="Pull to try again." /> : null}
      {training.isPending ? (
        <Text variant="label" tone="secondary">
          Loading your training…
        </Text>
      ) : null}
      {summary ? <TrainingBody summary={summary} records={training.records} units={units} /> : null}
      <HealthTrendsSection />
      <Definitions />
    </Screen>
  );
}

function TrainingBody({ summary, records, units }: { summary: TrainingSummary; records: ReturnType<typeof useTraining>['records']; units: Units }) {
  const { current, points } = summary;
  const label = formLabel(current.form);
  const words = FORM_WORDS[label];
  const first = points[0];
  const empty = summary.activities === 0;
  const change =
    summary.yearAgoLoad === null
      ? null
      : summary.yearAgoLoad === 0
        ? summary.recentLoad > 0
          ? 'Nothing in the same weeks a year ago.'
          : null
        : `${summary.recentLoad >= summary.yearAgoLoad ? '+' : ''}${Math.round(((summary.recentLoad - summary.yearAgoLoad) / summary.yearAgoLoad) * 100)}% against the same 12 weeks a year ago (${summary.yearAgoLoad}).`;

  return (
    <>
      {empty ? <InlineStatus title="No activities in the last 12 weeks." body="Load, fitness and fatigue build from your runs and other workouts." /> : null}
      <Card style={{ gap: space.md }}>
        <Text variant="eyebrow" tone="secondary">
          Form today
        </Text>
        <View accessible accessibilityLabel={`Form today: ${words.title}. ${words.body} Fitness ${Math.round(current.fitness)}, fatigue ${Math.round(current.fatigue)}, form ${Math.round(current.form)}.`} style={{ gap: space.sm }}>
          <Text variant="title">{words.title}</Text>
          <Text variant="body" tone="secondary">
            {words.body}
          </Text>
          <View style={styles.numbers}>
            <Figure label="Fitness" value={Math.round(current.fitness)} color={FITNESS_COLOR} />
            <Figure label="Fatigue" value={Math.round(current.fatigue)} color={FATIGUE_COLOR} />
            <Figure label="Form" value={Math.round(current.form)} />
          </View>
        </View>
        {points.length > 1 && first ? (
          <LineChart
            series={[
              { key: 'fitness', label: 'Fitness', color: FITNESS_COLOR, values: points.map((p) => p.fitness) },
              { key: 'fatigue', label: 'Fatigue', color: FATIGUE_COLOR, values: points.map((p) => p.fatigue) },
            ]}
            summary={`Fitness and fatigue over 12 weeks. Fitness went from ${Math.round(first.fitness)} to ${Math.round(current.fitness)}; fatigue from ${Math.round(first.fatigue)} to ${Math.round(current.fatigue)}.`}
            startLabel={bucketLabel(first.date, 'week')}
            endLabel="Today"
          />
        ) : null}
      </Card>

      <Card style={{ gap: space.md }}>
        <BarChart
          title="Training load by week"
          bars={summary.weeks.map((w) => ({
            key: w.monday,
            label: bucketLabel(w.monday, 'week'),
            value: w.load,
            valueLabel: String(w.load),
            description: `Week of ${bucketLabelLong(w.monday, 'week')}: load ${w.load}`,
          }))}
        />
        <Text variant="caption" tone="secondary">
          Last 12 weeks: {summary.recentLoad}. {change ?? ''}
        </Text>
        {summary.thresholdS === null ? (
          <Text variant="caption" tone="secondary">
            Without a recent best effort of a mile or more, runs are scored by time. Record a hard mile or 5K for a sharper score.
          </Text>
        ) : null}
      </Card>

      <Predictions summary={summary} records={records} />
      <Efficiency summary={summary} units={units} />
    </>
  );
}

function Figure({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <View style={styles.number}>
      <View style={styles.row}>
        {color ? <View style={[styles.swatch, { backgroundColor: color }]} /> : null}
        <Text variant="eyebrow" tone="secondary">
          {label}
        </Text>
      </View>
      <Text variant="metric" style={{ fontVariant: ['tabular-nums'] }}>
        {value}
      </Text>
    </View>
  );
}

function Predictions({ summary, records }: { summary: TrainingSummary; records: ReturnType<typeof useTraining>['records'] }) {
  const predictions = summary.predictions;
  const source = predictions ? records?.records.find((r) => r.effort === predictions.basedOn)?.best : null;
  return (
    <Card style={{ gap: space.md }}>
      <Text variant="labelStrong" accessibilityRole="header">
        Race predictions
      </Text>
      {predictions ? (
        <>
          {RACE_KEYS.map((key) => (
            <View key={key} style={styles.predictionRow} accessible accessibilityLabel={`${RACE_NAMES[key]}: ${formatRaceTime(predictions.times[key])}`}>
              <Text variant="body" tone="secondary" style={{ flex: 1 }}>
                {RACE_NAMES[key]}
              </Text>
              <Text variant="bodyStrong" style={{ fontVariant: ['tabular-nums'] }}>
                {formatRaceTime(predictions.times[key])}
              </Text>
            </View>
          ))}
          <Text variant="caption" tone="secondary">
            From your {effortLabel(predictions.basedOn)}
            {source ? ` on ${shortDate(source.started_at_ms)}` : ''}. {DEFINITIONS.prediction}
          </Text>
        </>
      ) : (
        <Text variant="body" tone="secondary">
          Run a mile or more hard in the last six months and your predictions appear here.
        </Text>
      )}
    </Card>
  );
}

function Efficiency({ summary, units }: { summary: TrainingSummary; units: Units }) {
  const points = summary.efficiency;
  const factor = units === 'imperial' ? 3.28084 : 1;
  const unit = units === 'imperial' ? 'ft' : 'm';
  const format = (v: number) => (v * factor).toFixed(2);
  const first = points[0];
  const last = points[points.length - 1];
  return (
    <Card style={{ gap: space.md }}>
      <Text variant="labelStrong" accessibilityRole="header">
        Aerobic efficiency
      </Text>
      {first && last && points.length > 1 ? (
        <>
          <Text variant="body">
            {format(first.value)} → {format(last.value)} {unit} per heartbeat on easy runs
          </Text>
          <LineChart
            series={[{ key: 'efficiency', label: 'Efficiency', color: FITNESS_COLOR, values: points.map((p) => p.value) }]}
            summary={`Aerobic efficiency over ${points.length} easy runs, from ${format(first.value)} to ${format(last.value)} ${unit === 'm' ? 'metres' : 'feet'} per heartbeat.`}
            height={90}
            startLabel={bucketLabel(first.date, 'week')}
            endLabel={bucketLabel(last.date, 'week')}
          />
        </>
      ) : (
        <Text variant="body" tone="secondary">
          Needs at least two easy runs with heart rate, from a watch or Apple Health.
        </Text>
      )}
      <Text variant="caption" tone="secondary">
        {DEFINITIONS.efficiency}
      </Text>
    </Card>
  );
}

const TREND_ROWS: { kind: TrendKind; title: string; format: (v: number) => string; spoken: (v: number) => string }[] = [
  { kind: 'restingHr', title: 'Resting heart rate', format: (v) => `${Math.round(v)} bpm`, spoken: (v) => `${Math.round(v)} beats per minute` },
  { kind: 'hrv', title: 'Heart rate variability', format: (v) => `${Math.round(v)} ms`, spoken: (v) => `${Math.round(v)} milliseconds` },
  { kind: 'vo2max', title: 'VO2 max', format: (v) => v.toFixed(1), spoken: (v) => `${v.toFixed(1)} millilitres per kilogram per minute` },
  {
    kind: 'sleep',
    title: 'Sleep',
    format: (v) => `${Math.floor(v / 60)} h ${String(Math.round(v % 60)).padStart(2, '0')} min`,
    spoken: (v) => `${Math.floor(v / 60)} hours ${Math.round(v % 60)} minutes`,
  },
];

/** Pro, iOS: Apple Health trends, read only while the switch is on and never sent to the server. */
function HealthTrendsSection() {
  const { runtime } = useAccountServices();
  const settings = useRunSettings();
  const port = deviceHealthData();
  const trends = useHealthTrends(settings.healthTrends);
  const [busy, setBusy] = useState(false);
  if (!port?.isAvailable()) return null;

  const toggle = async (on: boolean) => {
    setBusy(true);
    try {
      // Permission is asked only now, when the runner switches this on.
      if (on) await port.requestTrends().catch(() => undefined);
      await runtime.runSettings.save({ ...runtime.runSettings.get(), healthTrends: on });
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ gap: space.sm }}>
      <RowGroup>
        <SwitchRow
          label="Health trends from Apple Health"
          hint="Resting heart rate, heart rate variability, VO2 max and sleep. Read on this phone only; PaceLeague never sends them to its servers."
          value={settings.healthTrends}
          disabled={busy}
          onChange={(on) => void toggle(on)}
          last
          testID="health-trends-switch"
        />
      </RowGroup>
      {settings.healthTrends && trends.data ? <TrendCards trends={trends.data} /> : null}
      {settings.healthTrends && trends.isError ? <InlineStatus tone="danger" title="Couldn’t read from Apple Health." body="Try again later." /> : null}
    </View>
  );
}

function TrendCards({ trends }: { trends: HealthTrends }) {
  const anything = TREND_ROWS.some(({ kind }) => trends.weeks[kind].some((v) => v !== null));
  if (!anything) {
    return (
      <InlineStatus
        title="Nothing to show from Apple Health yet."
        body="If you expected readings, check that PaceLeague can read them in the Health app: your profile › Apps › PaceLeague."
      />
    );
  }
  return (
    <>
      {TREND_ROWS.map(({ kind, title, format, spoken }) => {
        const weeks = trends.weeks[kind];
        const latest = [...weeks].reverse().find((v): v is number => v !== null);
        if (latest === undefined) return null;
        const change = trendChange(weeks);
        return (
          <Card key={kind} style={{ gap: space.sm }}>
            <View style={styles.row}>
              <Text variant="labelStrong" accessibilityRole="header" style={{ flex: 1 }}>
                {title}
              </Text>
              <Text variant="bodyStrong" style={{ fontVariant: ['tabular-nums'] }}>
                {format(latest)}
              </Text>
            </View>
            <LineChart
              series={[{ key: kind, label: title, color: FITNESS_COLOR, values: weeks }]}
              summary={`${title}, weekly average over 12 weeks${change ? `: from ${spoken(change.from)} to ${spoken(change.to)}` : ''}. This week ${spoken(latest)}.`}
              height={56}
              legend={false}
              startLabel={bucketLabel(trends.mondays[0]!, 'week')}
              endLabel="This week"
            />
            <Text variant="caption" tone="secondary">
              {DEFINITIONS[kind]}
            </Text>
          </Card>
        );
      })}
    </>
  );
}

function Definitions() {
  const entries: { title: string; text: string }[] = [
    { title: 'Training load', text: DEFINITIONS.load },
    { title: 'Fitness', text: DEFINITIONS.fitness },
    { title: 'Fatigue', text: DEFINITIONS.fatigue },
    { title: 'Form', text: DEFINITIONS.form },
  ];
  return (
    <Card style={{ gap: space.md }}>
      <Text variant="labelStrong" accessibilityRole="header">
        How these work
      </Text>
      {entries.map((e) => (
        <View key={e.title} style={{ gap: 2 }}>
          <Text variant="label">{e.title}</Text>
          <Text variant="caption" tone="secondary">
            {e.text}
          </Text>
        </View>
      ))}
      <Text variant="caption" tone="secondary">
        Worked out on this phone from your runs, walks, rides and other workouts, and from Apple Health if you turn trends on. They’re for
        training, not medical advice.
      </Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  numbers: { flexDirection: 'row', gap: space.md },
  number: { flex: 1, gap: 2 },
  swatch: { width: 10, height: 10, borderRadius: 5 },
  predictionRow: { flexDirection: 'row', alignItems: 'center', minHeight: 36 },
});
