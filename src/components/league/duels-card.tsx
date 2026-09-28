import { Swords } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import type { Duel } from '@/api/league-schemas';
import { TextButton } from '@/components/ui/buttons';
import { InlineStatus } from '@/components/ui/elements';
import { Card } from '@/components/ui/layout';
import { formatXp } from '@/domain/format';
import { useDuels, useLeagueActions } from '@/features/leagues/use-leagues';
import { Text } from '@/design/text';
import { colors, space } from '@/design/tokens';

function outcome(duel: Duel, name: string): string {
  if (duel.status === 'pending') return duel.i_challenged ? `Waiting for ${name} to accept.` : `${name} challenged you.`;
  if (duel.result === 'won') return 'You won.';
  if (duel.result === 'lost') return `${name} won.`;
  if (duel.result === 'tied') return 'A tie.';
  return duel.state === 'in_progress' ? 'Best three days wins. It ends Sunday night.' : 'Final once the week’s runs are in.';
}

/** This week's one-on-one duels (docs/ROADMAP.md 4.1), scored like the league. */
export function DuelsCard({ leagueId, weekOffset }: { leagueId: string; weekOffset: 0 | -1 }) {
  const duels = useDuels(leagueId, weekOffset).data?.data ?? [];
  const actions = useLeagueActions();
  if (duels.length === 0) {
    return weekOffset === 0 ? (
      <Text variant="caption" tone="secondary">
        Tap a league-mate’s name to challenge them to a duel this week.
      </Text>
    ) : null;
  }
  return (
    <Card style={styles.card}>
      <View style={styles.head}>
        <Swords size={20} color={colors.accent} />
        <Text variant="labelStrong" accessibilityRole="header">
          Duels
        </Text>
      </View>
      {actions.error ? <InlineStatus tone="danger" title={actions.error} /> : null}
      {duels.map((duel) => {
        const name = duel.opponent.alias ?? 'Hidden runner';
        return (
          <View key={duel.id} style={styles.duel}>
            <View style={styles.row} accessible accessibilityLabel={`You ${formatXp(duel.my_xp)} XP, ${name} ${formatXp(duel.opponent.weekly_xp)} XP. ${outcome(duel, name)}`}>
              <Text variant="labelStrong" style={styles.fill} numberOfLines={1}>
                You vs {name}
              </Text>
              <Text variant="labelStrong" style={styles.score}>
                {formatXp(duel.my_xp)} – {formatXp(duel.opponent.weekly_xp)}
              </Text>
            </View>
            <Text variant="caption" tone="secondary">
              {outcome(duel, name)}
            </Text>
            {duel.status === 'pending' && weekOffset === 0 ? (
              <View style={styles.actions}>
                {duel.i_challenged ? (
                  <TextButton label="Cancel" onPress={() => void actions.cancelDuel(duel.id)} disabled={actions.busy} />
                ) : (
                  <>
                    <TextButton label="Accept" tone="accent" onPress={() => void actions.respond(duel.id, true)} disabled={actions.busy} testID="duel-accept" />
                    <TextButton label="Decline" onPress={() => void actions.respond(duel.id, false)} disabled={actions.busy} />
                  </>
                )}
              </View>
            ) : null}
          </View>
        );
      })}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: space.md },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  duel: { gap: 2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  score: { fontVariant: ['tabular-nums'] },
  actions: { flexDirection: 'row', gap: space.lg },
  fill: { flex: 1 },
});
