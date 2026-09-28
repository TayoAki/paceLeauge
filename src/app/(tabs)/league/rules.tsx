import { StyleSheet, View } from 'react-native';

import { Card, NavHeader, Screen } from '@/components/ui/layout';
import { INDOOR_DAILY_CAP_KM, TIERS } from '@/domain/config';
import { formatXp } from '@/domain/format';
import { Text } from '@/design/text';
import { space } from '@/design/tokens';

function Section({ title, lines }: { title: string; lines: string[] }) {
  return (
    <Card>
      <Text variant="section" accessibilityRole="header">
        {title}
      </Text>
      {lines.map((line) => (
        <Text key={line} variant="body" tone="secondary">
          {line}
        </Text>
      ))}
    </Card>
  );
}

/** Plain-language rules sheet (score contract v1). */
export default function RulesScreen() {
  return (
    <Screen edges={['top', 'bottom']}>
      <NavHeader title="How scoring works" />
      <Section
        title="Runs that count"
        lines={[
          'A run counts for XP when it has at least 100 m, at least 1 minute of active time, and GPS for at least 80% of that time.',
          'Shorter or patchy runs are still saved to your history — they just don’t earn league XP.',
          'Paused time never counts, and gaps in GPS are never filled in.',
        ]}
      />
      <Section
        title="Daily XP"
        lines={[
          '1 XP for every 100 m in a day, up to 100.',
          '+25 active-day bonus when a day has at least 1 km and 5 minutes.',
          'Runs on the same day add up, so the most a day can earn is 125 XP — splitting a run doesn’t earn more.',
        ]}
      />
      <Section
        title="Runs from your watch and other apps"
        lines={[
          'Runs from Apple Health, Health Connect, a watch or Garmin earn XP the same way when they come with a GPS route.',
          'Workouts without a route, runs typed in by hand and imported files are kept as history. They count for your weekly goal and streak, not league XP.',
          'If two devices record the same run, it counts once — we keep the copy with the better GPS record.',
        ]}
      />
      <Section
        title="Treadmill and indoor runs"
        lines={[
          `Indoor runs recorded on a watch earn XP when their pace, steps and heart rate all look like running. There’s no GPS to check them, so indoor distance earns XP for up to ${INDOOR_DAILY_CAP_KM} km a day (${INDOOR_DAILY_CAP_KM * 10} XP). The active-day bonus still applies.`,
          'Indoor runs recorded on your phone, or with a typed-in distance, count for your weekly goal and streak but don’t earn league XP.',
        ]}
      />
      <Card>
        <Text variant="section" accessibilityRole="header">
          Your rank
        </Text>
        <Text variant="body" tone="secondary">
          Every XP you earn adds up forever. Rest days never lower your rank.
        </Text>
        <View style={styles.tiers}>
          {TIERS.map((t) => (
            <View key={t.name} style={styles.tier} accessible accessibilityLabel={`${t.name} from ${formatXp(t.minXp)} XP`}>
              <Text variant="bodyStrong">{t.name}</Text>
              <Text variant="body" tone="secondary">
                {formatXp(t.minXp)} XP
              </Text>
            </View>
          ))}
        </View>
        <Text variant="label" tone="secondary">
          Deleting a run, or a correction, removes the XP it earned.
        </Text>
      </Card>
      <Section
        title="Weekly league"
        lines={[
          'Your league score is your best 3 days of the week (up to 375 XP).',
          'Weeks run Monday to Sunday on Central Time (America/Chicago) for everyone, wherever you are.',
          'Scores are provisional until Monday plus 24 hours. Runs that reach us after that still count for your rank, not that week’s league.',
          'New members count from when they join. If you leave and rejoin, only runs after rejoining count that week.',
          'Tied scores share a place.',
        ]}
      />
      <Section
        title="Fair and private"
        lines={[
          'Routes are visible only to you. Your league sees your runner name, tier and weekly XP.',
          'Unusual GPS (like a car-speed stretch) is held for review — it’s never treated as proof of cheating.',
          'No cash prizes, no pace races.',
        ]}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  tiers: { gap: space.sm },
  tier: { flexDirection: 'row', justifyContent: 'space-between' },
});
