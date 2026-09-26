import { EyeOff } from 'lucide-react-native';
import { Pressable, StyleSheet, View } from 'react-native';

import { Avatar } from '@/components/ui/elements';
import type { Standing } from '@/api/schemas';
import { formatXp, ordinal } from '@/domain/format';
import { Text } from '@/design/text';
import { colors, radius, space } from '@/design/tokens';

/**
 * One standings row: competition rank, alias, weekly XP. Members blocked in either
 * direction stay in place as "Hidden runner" so ranks are never falsified.
 */
export function LeagueRow({ standing, onPress }: { standing: Standing; onPress?: () => void }) {
  const name = standing.hidden ? 'Hidden runner' : standing.is_me ? 'You' : (standing.alias ?? 'Runner');
  const a11y = `${ordinal(standing.rank)} place, ${name}${standing.tier && !standing.is_me ? `, ${standing.tier} tier` : ''}, ${formatXp(standing.weekly_xp)} XP this week${
    standing.is_owner ? ', league owner' : ''
  }`;
  const content = (
    <View style={[styles.row, standing.is_me && styles.me]}>
      <Text variant="section" tone="secondary" style={styles.rank} maxFontSizeMultiplier={1.3}>
        {standing.rank}
      </Text>
      {standing.hidden ? (
        <View style={styles.hiddenAvatar}>
          <EyeOff size={18} color={colors.textSecondary} />
        </View>
      ) : (
        <Avatar name={standing.is_me ? (standing.alias ?? 'You') : standing.alias} seed={standing.member_id} highlight={standing.is_me} />
      )}
      <View style={{ flex: 1 }}>
        <Text variant="bodyStrong" numberOfLines={1} tone={standing.hidden ? 'secondary' : 'primary'}>
          {name}
        </Text>
        {standing.tier && !standing.hidden ? (
          <Text variant="caption" tone="secondary">
            {standing.tier}
            {standing.is_owner ? ' · Owner' : ''}
          </Text>
        ) : null}
      </View>
      <Text variant="section" style={styles.xp}>
        {formatXp(standing.weekly_xp)}
      </Text>
    </View>
  );
  return onPress ? (
    <Pressable accessibilityRole="button" accessibilityLabel={a11y} accessibilityHint="Member options" onPress={onPress}>
      {content}
    </Pressable>
  ) : (
    <View accessible accessibilityLabel={a11y}>
      {content}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: colors.surface,
    borderRadius: radius.control + 4,
    paddingHorizontal: space.lg,
    minHeight: 64,
    borderWidth: 1.5,
    borderColor: 'transparent',
  },
  me: { borderColor: colors.accent },
  rank: { width: 28, textAlign: 'center', fontVariant: ['tabular-nums'] },
  xp: { fontVariant: ['tabular-nums'] },
  hiddenAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.surfaceElevated,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
