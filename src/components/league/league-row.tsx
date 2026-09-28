import { EyeOff, HandHeart } from 'lucide-react-native';
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
export function LeagueRow({
  standing,
  onPress,
  cheers = 0,
  cheered = false,
  onCheer,
}: {
  standing: Standing;
  onPress?: () => void;
  /** Cheers this runner received this week (docs/ROADMAP.md 1.9). */
  cheers?: number;
  /** I already cheered this runner this week. */
  cheered?: boolean;
  onCheer?: () => void;
}) {
  const name = standing.hidden ? 'Hidden runner' : standing.is_me ? 'You' : (standing.alias ?? 'Runner');
  const a11y = `${ordinal(standing.rank)} place, ${name}${standing.tier && !standing.is_me ? `, ${standing.tier} tier` : ''}, ${formatXp(standing.weekly_xp)} XP this week${
    standing.is_owner ? ', league owner' : ''
  }${cheers > 0 ? `, ${cheers} ${cheers === 1 ? 'cheer' : 'cheers'}` : ''}`;
  const main = (
    <View style={styles.main}>
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
  const showCheer = !standing.hidden && (onCheer !== undefined || cheers > 0);
  return (
    <View style={[styles.row, standing.is_me && styles.me]}>
      {onPress ? (
        <Pressable style={styles.fill} accessibilityRole="button" accessibilityLabel={a11y} accessibilityHint="Member options" onPress={onPress}>
          {main}
        </Pressable>
      ) : (
        <View style={styles.fill} accessible accessibilityLabel={a11y}>
          {main}
        </View>
      )}
      {showCheer ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={cheered ? `You cheered ${name} this week` : `Cheer ${name}`}
          accessibilityState={{ disabled: !onCheer || cheered, selected: cheered }}
          disabled={!onCheer || cheered}
          onPress={onCheer}
          hitSlop={6}
          style={({ pressed }) => [styles.cheer, cheered && styles.cheered, pressed && { opacity: 0.7 }]}
          testID={`cheer-${standing.member_id}`}>
          <HandHeart size={18} color={cheered ? colors.onAccent : colors.textSecondary} strokeWidth={2.2} />
          {cheers > 0 ? (
            <Text variant="caption" style={{ color: cheered ? colors.onAccent : colors.textSecondary }} maxFontSizeMultiplier={1.2}>
              {cheers}
            </Text>
          ) : null}
        </Pressable>
      ) : null}
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
  fill: { flex: 1 },
  main: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 64 },
  cheer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    minWidth: 44,
    minHeight: 44,
    paddingHorizontal: space.sm,
    justifyContent: 'center',
    borderRadius: 22,
    borderWidth: 1.5,
    borderColor: colors.controlOutline,
  },
  cheered: { backgroundColor: colors.accent, borderColor: colors.accent },
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
