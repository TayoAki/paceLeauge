import { Crown } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import { Card } from '@/components/ui/layout';
import { formatXp, ordinal } from '@/domain/format';
import { useLeagueSeason } from '@/features/leagues/use-leagues';
import { Text } from '@/design/text';
import { colors, space } from '@/design/tokens';

/**
 * The four-week season (docs/ROADMAP.md 4.1): weekly XP added up over the season, the top three,
 * the runner's own place, and the last champion.
 */
export function SeasonCard({ leagueId }: { leagueId: string }) {
  const season = useLeagueSeason(leagueId).data?.data;
  if (!season) return null;
  const top = season.standings.filter((s) => s.season_xp > 0).slice(0, 3);
  const me = season.standings.find((s) => s.is_me);
  const last = season.champions.find((c) => c.season_start === season.champions[0]?.season_start) ? season.champions.filter((c) => c.season_start === season.champions[0]!.season_start) : [];
  return (
    <Card style={styles.card}>
      <View style={styles.head}>
        <Crown size={20} color={colors.accent} />
        <Text variant="labelStrong" accessibilityRole="header" style={styles.fill}>
          Season {season.number} · week {season.week} of 4
        </Text>
      </View>
      {top.length === 0 ? (
        <Text variant="label" tone="secondary">
          No XP yet this season. The runner with the most over four weeks is champion.
        </Text>
      ) : (
        top.map((s) => (
          <View key={s.member_id} style={styles.row} accessible accessibilityLabel={`${ordinal(s.rank)}: ${s.hidden ? 'Hidden runner' : s.alias}, ${s.season_xp} XP`}>
            <Text variant="label" tone="secondary" style={styles.rank}>
              {s.rank}
            </Text>
            <Text variant={s.is_me ? 'labelStrong' : 'label'} style={styles.fill} numberOfLines={1}>
              {s.hidden ? 'Hidden runner' : s.is_me ? `${s.alias} (you)` : s.alias}
            </Text>
            <Text variant="label" style={styles.xp}>
              {formatXp(s.season_xp)} XP
            </Text>
          </View>
        ))
      )}
      {me && !top.some((s) => s.is_me) && me.season_xp > 0 ? (
        <Text variant="label" tone="secondary">
          You’re {ordinal(me.rank)} with {formatXp(me.season_xp)} XP.
        </Text>
      ) : null}
      {last.length > 0 ? (
        <Text variant="caption" tone="secondary">
          {last.some((c) => c.is_me)
            ? `You won season ${last[0]!.number}.`
            : `Season ${last[0]!.number} champion${last.length > 1 ? 's' : ''}: ${last.map((c) => c.alias ?? 'Hidden runner').join(' and ')}.`}
        </Text>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: space.sm },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  rank: { width: 20, fontVariant: ['tabular-nums'] },
  xp: { fontVariant: ['tabular-nums'] },
  fill: { flex: 1 },
});
