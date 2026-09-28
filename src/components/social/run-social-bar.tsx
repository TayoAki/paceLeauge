import { MessageCircle, ThumbsUp } from 'lucide-react-native';
import { Pressable, StyleSheet, View } from 'react-native';

import type { FeedItem } from '@/api/feed-schemas';
import { Text } from '@/design/text';
import { colors, layout, space } from '@/design/tokens';

/**
 * Kudos and comments under a run (docs/ROADMAP.md 4.4). Runners can't give their own runs kudos;
 * they see the count instead.
 */
export function RunSocialBar({
  item,
  onKudos,
  onComments,
  onKudosCount,
}: {
  item: Pick<FeedItem, 'kudos' | 'kudoed' | 'comments' | 'is_mine'>;
  onKudos: () => void;
  onComments?: () => void;
  onKudosCount?: () => void;
}) {
  const kudosLabel = `${item.kudos} ${item.kudos === 1 ? 'kudo' : 'kudos'}`;
  const commentsLabel = `${item.comments} ${item.comments === 1 ? 'comment' : 'comments'}`;
  return (
    <View style={styles.bar}>
      {item.is_mine ? (
        <Pressable
          accessibilityRole={onKudosCount ? 'button' : 'text'}
          accessibilityLabel={kudosLabel}
          accessibilityHint={onKudosCount ? 'Shows who gave kudos' : undefined}
          onPress={onKudosCount}
          disabled={!onKudosCount || item.kudos === 0}
          style={({ pressed }) => [styles.action, pressed && { opacity: 0.6 }]}>
          <ThumbsUp size={20} color={colors.textSecondary} />
          <Text variant="label" tone="secondary">
            {item.kudos}
          </Text>
        </Pressable>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={item.kudoed ? `You gave kudos, ${kudosLabel}` : `Give kudos, ${kudosLabel}`}
          accessibilityState={{ selected: item.kudoed }}
          onPress={onKudos}
          hitSlop={4}
          style={({ pressed }) => [styles.action, pressed && { opacity: 0.6 }]}
          testID="kudos-button">
          <ThumbsUp size={20} color={item.kudoed ? colors.accent : colors.textSecondary} fill={item.kudoed ? colors.accent : 'none'} />
          <Text variant="labelStrong" style={{ color: item.kudoed ? colors.accent : colors.textSecondary }}>
            {item.kudos}
          </Text>
        </Pressable>
      )}
      {onComments ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={commentsLabel}
          accessibilityHint="Opens the comments"
          onPress={onComments}
          hitSlop={4}
          style={({ pressed }) => [styles.action, pressed && { opacity: 0.6 }]}>
          <MessageCircle size={20} color={colors.textSecondary} />
          <Text variant="label" tone="secondary">
            {item.comments}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', gap: space.xl, paddingHorizontal: space.xs },
  action: { flexDirection: 'row', alignItems: 'center', gap: space.xs, minHeight: layout.minimumTapTarget, minWidth: layout.minimumTapTarget },
});
