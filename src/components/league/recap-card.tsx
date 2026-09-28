import { Sparkles } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import { Card } from '@/components/ui/layout';
import { formatDistance, formatXp, ordinal } from '@/domain/format';
import type { Units } from '@/domain/types';
import { useWeekRecap } from '@/features/leagues/use-leagues';
import { Text } from '@/design/text';
import { colors, space } from '@/design/tokens';

/** The week's recap (docs/ROADMAP.md 4.1); `recapWeek` decides which week, if any. */
export function RecapCard({ leagueId, leagueName, weekOffset, units }: { leagueId: string; leagueName: string; weekOffset: 0 | -1; units: Units }) {
  const recap = useWeekRecap(leagueId, weekOffset, true).data?.data;
  if (!recap) return null;
  const crew = formatDistance(recap.league.distance_m, units);
  const mine = formatDistance(recap.me.distance_m, units);
  const duels = recap.me.duels;
  const lines = [
    recap.me.runs === 0
      ? 'You took the week off. Rest weeks keep your rank.'
      : recap.me.weekly_xp > 0
        ? `You ran ${recap.me.runs} ${recap.me.runs === 1 ? 'time' : 'times'}, ${mine.value} ${mine.unit}, for ${formatXp(recap.me.weekly_xp)} XP${recap.me.rank && recap.league.members > 1 ? ` (${ordinal(recap.me.rank)})` : ''}.`
        : // Runs from before joining this league count elsewhere, not here.
          `You ran ${recap.me.runs} ${recap.me.runs === 1 ? 'time' : 'times'}, ${mine.value} ${mine.unit}.`,
    recap.league.runs > 0
      ? `${leagueName} ran ${recap.league.runs} ${recap.league.runs === 1 ? 'time' : 'times'}, ${crew.value} ${crew.unit} between ${recap.league.active_runners} of ${recap.league.members}.`
      : null,
    recap.league.top?.alias ? `Top of the week: ${recap.league.top.alias} with ${formatXp(recap.league.top.weekly_xp)} XP.` : null,
    recap.me.cheers > 0 ? `${recap.me.cheers} ${recap.me.cheers === 1 ? 'cheer' : 'cheers'} for you.` : null,
    duels.won + duels.lost + duels.tied > 0 ? `Duels: ${duels.won} won, ${duels.lost} lost${duels.tied ? `, ${duels.tied} tied` : ''}.` : null,
  ].filter((line): line is string => line !== null);
  return (
    <Card style={styles.card}>
      <View style={styles.head}>
        <Sparkles size={20} color={colors.accent} />
        <Text variant="labelStrong" accessibilityRole="header">
          {weekOffset === 0 ? 'Your week so far' : 'Last week'}
        </Text>
      </View>
      {lines.map((line) => (
        <Text key={line} variant="label" tone="secondary">
          {line}
        </Text>
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: space.xs },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
});
