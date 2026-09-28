import { useRouter } from 'expo-router';
import { Sun } from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { SecondaryButton, TextButton } from '@/components/ui/buttons';
import { InlineStatus, TextField } from '@/components/ui/elements';
import { Card } from '@/components/ui/layout';
import { cToF, fToC, heatAdvice } from '@/domain/heat';
import type { PaceRange } from '@/domain/plans/types';
import { slowRange } from '@/domain/plans/paces';
import type { IsoDate, Units } from '@/domain/types';
import { formatPaceRange } from '@/features/plans/plan-client';
import { useHeat } from '@/features/training/use-heat';
import { Text } from '@/design/text';
import { colors, space } from '@/design/tokens';

/**
 * Hot today? (Pro, docs/ROADMAP.md Part B point 4.) The runner enters the temperature and
 * humidity; the session's pace range slows to match, and the workout's spoken paces follow.
 */
export function HeatCard({ date, units, zone, effortName }: { date: IsoDate; units: Units; zone: PaceRange | null; effortName: string }) {
  const { entry, save } = useHeat(date);
  const imperial = units === 'imperial';
  const [editing, setEditing] = useState(false);
  const [temp, setTemp] = useState('');
  const [humidity, setHumidity] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const t = Number(temp.replace(',', '.'));
    const h = Number(humidity.replace(',', '.'));
    const tempC = imperial ? fToC(t) : t;
    if (!temp.trim() || !Number.isFinite(t) || tempC < -30 || tempC > 50) {
      setError(`Enter the temperature in ${imperial ? '°F' : '°C'}.`);
      return;
    }
    if (!humidity.trim() || !Number.isFinite(h) || h < 1 || h > 100) {
      setError('Enter the humidity, from 1 to 100%.');
      return;
    }
    setError(null);
    await save({ date, tempC: Math.round(tempC * 10) / 10, humidity: Math.round(h) });
    setEditing(false);
  };

  const shownTemp = (c: number) => (imperial ? `${Math.round(cToF(c))}°F` : `${Math.round(c)}°C`);

  if (entry && !editing) {
    const advice = heatAdvice(entry);
    return (
      <Card style={styles.card}>
        <View style={styles.row}>
          <Sun size={20} color={colors.accent} />
          <Text variant="labelStrong" style={{ flex: 1 }}>
            {shownTemp(entry.tempC)}, {entry.humidity}% humidity
          </Text>
        </View>
        {advice.slowdown === null ? (
          <InlineStatus
            tone="warning"
            title="Too hot and humid for hard running."
            body="Run easy by feel, go early or late when it’s cooler, or move this session. Drink regularly."
          />
        ) : advice.slowdown === 0 ? (
          <Text variant="body" tone="secondary">
            No need to slow down in this weather.
          </Text>
        ) : (
          <Text variant="body">
            Run about {Math.round(advice.slowdown * 1000) / 10}% slower today
            {zone ? `: ${effortName.toLowerCase()} pace ${formatPaceRange(slowRange(zone, advice.slowdown), units)}` : ''}. Your spoken paces
            follow.
          </Text>
        )}
        <Text variant="caption" tone="secondary">
          Dew point {shownTemp(advice.dewPointC)}. Heart-rate ranges stay the same: heart rate already rises in the heat.
        </Text>
        <View style={styles.row}>
          <TextButton label="Change" onPress={() => setEditing(true)} />
          <TextButton label="Clear" onPress={() => void save(null)} />
        </View>
      </Card>
    );
  }

  return (
    <Card style={styles.card}>
      <View style={styles.row}>
        <Sun size={20} color={colors.accent} />
        <Text variant="labelStrong" style={{ flex: 1 }}>
          Hot today?
        </Text>
      </View>
      <Text variant="caption" tone="secondary">
        Enter the temperature and humidity from your weather app, and today’s paces slow down to match.
      </Text>
      <View style={styles.fields}>
        <View style={{ flex: 1 }}>
          <TextField label={`Temperature (${imperial ? '°F' : '°C'})`} value={temp} onChangeText={setTemp} keyboardType="numbers-and-punctuation" maxLength={5} testID="heat-temp" />
        </View>
        <View style={{ flex: 1 }}>
          <TextField label="Humidity (%)" value={humidity} onChangeText={setHumidity} keyboardType="number-pad" maxLength={3} testID="heat-humidity" />
        </View>
      </View>
      {error ? <InlineStatus tone="danger" title={error} /> : null}
      <SecondaryButton label="Adjust paces for heat" onPress={() => void submit()} testID="heat-save" />
    </Card>
  );
}

/** For runners without Pro: one quiet line pointing at heat and heart-rate guidance. */
export function HeatUpsell() {
  const router = useRouter();
  return <TextButton label="Heat-adjusted paces and heart-rate ranges come with Pro" onPress={() => router.push('/pro')} />;
}

const styles = StyleSheet.create({
  card: { gap: space.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  fields: { flexDirection: 'row', gap: space.md },
});
