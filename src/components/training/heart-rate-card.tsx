import { useRouter } from 'expo-router';
import { HeartPulse } from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { TextButton } from '@/components/ui/buttons';
import { Card } from '@/components/ui/layout';
import { describeDuration, formatDuration } from '@/domain/format';
import { hrZones } from '@/domain/plans/paces';
import { DEFINITIONS } from '@/domain/training';
import type { ActiveSegment } from '@/domain/types';
import { useAccountServices } from '@/features/account/account-provider';
import { deviceHealthData } from '@/features/health/health-data';
import { HEALTH } from '@/features/health/health-names';
import type { MaxHrSource } from '@/features/training/training-data';
import { useRunHeartRate, useRunSettings } from '@/features/training/use-training';
import { Text } from '@/design/text';
import { avatarFills, colors, space } from '@/design/tokens';

export const ZONE_NAMES = ['Very easy', 'Easy', 'Steady', 'Hard', 'Very hard'] as const;
export const ZONE_COLORS = [avatarFills[1], avatarFills[4], colors.accent, avatarFills[3], colors.danger] as const;

/** Time in each heart-rate zone, one row per zone with its range in beats per minute. */
export function HrZonesView({ zonesS, maxHr }: { zonesS: number[]; maxHr: number }) {
  const total = Math.max(1, zonesS.reduce((a, b) => a + b, 0));
  const ranges = hrZones(maxHr);
  return (
    <View style={styles.zones}>
      {zonesS.map((seconds, i) => {
        const share = Math.round((seconds / total) * 100);
        const range = ranges[i]!;
        return (
          <View
            key={i}
            style={styles.zone}
            accessible
            accessibilityLabel={`Zone ${i + 1}, ${ZONE_NAMES[i]}, ${range.low} to ${range.high} beats per minute: ${describeDuration(seconds * 1000)}, ${share} percent`}>
            <View style={styles.zoneHead}>
              <Text variant="label" style={{ flex: 1 }}>
                Zone {i + 1} · {ZONE_NAMES[i]}
              </Text>
              <Text variant="label" style={styles.num}>
                {formatDuration(seconds * 1000)}
              </Text>
              <Text variant="caption" tone="secondary" style={styles.share}>
                {share}%
              </Text>
            </View>
            <View style={styles.track}>
              <View style={[styles.fill, { width: `${Math.max(seconds > 0 ? 2 : 0, share)}%`, backgroundColor: ZONE_COLORS[i] }]} />
            </View>
            <Text variant="caption" tone="secondary">
              {i === 4 ? `${range.low}+ bpm` : `${range.low}–${range.high} bpm`}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

export function maxHrNote(maxHr: { value: number; source: MaxHrSource }): string {
  return maxHr.source === 'set'
    ? `Zones use the maximum heart rate you set, ${maxHr.value} bpm.`
    : `Zones use ${maxHr.value} bpm, the highest heart rate in your recent runs. If you know your maximum, set it in Run settings.`;
}

/**
 * Heart rate for a run (docs/ROADMAP.md 3.5, free): zones from Apple Health's readings while
 * heart-rate zones are on, or the average and maximum an import brought with it.
 */
export function RunHeartRateCard({ runKey, segments, avgHr, maxHr: runMax }: { runKey: string; segments: readonly ActiveSegment[]; avgHr: number | null; maxHr: number | null }) {
  const router = useRouter();
  const { runtime } = useAccountServices();
  const settings = useRunSettings();
  const heart = useRunHeartRate(segments.length > 0 ? { key: runKey, segments } : null);
  const [asking, setAsking] = useState(false);

  const turnOn = async () => {
    setAsking(true);
    try {
      // Asked only now, when the runner chooses to see zones.
      await deviceHealthData()?.requestHeartRate();
      await runtime.runSettings.save({ ...runtime.runSettings.get(), heartRateZones: true });
    } catch {
      // Health never says whether reading was allowed; with nothing to read, the card says so.
    } finally {
      setAsking(false);
    }
  };

  const zones = heart.zones;
  const average = zones?.avgHr ?? avgHr;
  const peak = zones?.peakHr ?? runMax;
  const canAsk = heart.available && !settings.heartRateZones;
  if (!zones && average === null && !(heart.enabled && heart.hasSamples)) return null;

  return (
    <Card style={{ gap: space.md }}>
      <View style={styles.header}>
        <HeartPulse size={20} color={colors.danger} />
        <Text variant="labelStrong" accessibilityRole="header" style={{ flex: 1 }}>
          Heart rate
        </Text>
      </View>
      {average !== null ? (
        <Text variant="body" accessibilityLabel={`Average ${average} beats per minute${peak ? `, maximum ${peak}` : ''}`}>
          Average {average} bpm{peak ? ` · Max ${peak} bpm` : ''}
        </Text>
      ) : null}
      {zones && heart.maxHr ? (
        <>
          <HrZonesView zonesS={zones.zonesS} maxHr={heart.maxHr.value} />
          <Text variant="caption" tone="secondary">
            {maxHrNote(heart.maxHr)} {DEFINITIONS.zones}
          </Text>
        </>
      ) : heart.enabled && heart.hasSamples && !heart.maxHr ? (
        <TextButton label="Set your maximum heart rate to see zones" onPress={() => router.push('/profile/run-settings')} />
      ) : canAsk ? (
        <TextButton label={`Show heart-rate zones from ${HEALTH.name}`} loading={asking} onPress={() => void turnOn()} testID="hr-zones-on" />
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  zones: { gap: space.md },
  zone: { gap: 4 },
  zoneHead: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm },
  num: { fontVariant: ['tabular-nums'] },
  share: { width: 40, textAlign: 'right', fontVariant: ['tabular-nums'] },
  track: { height: 8, borderRadius: 4, backgroundColor: colors.surfaceElevated, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 4 },
});
