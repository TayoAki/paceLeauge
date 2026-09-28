import { useRouter } from 'expo-router';
import { ChevronRight, MessageCircle, ThumbsUp } from 'lucide-react-native';
import { Pressable, StyleSheet, View } from 'react-native';

import { TextButton } from '@/components/ui/buttons';
import { Card } from '@/components/ui/layout';
import { describeDistance, formatDistance } from '@/domain/format';
import type { Units } from '@/domain/types';
import { useFeed } from '@/features/social/use-feed';
import { Text } from '@/design/text';
import { colors, layout, space } from '@/design/tokens';

/**
 * Today's summary of friends' activity (docs/ROADMAP.md, "Where things live": Phase 4 on Home):
 * the three newest runs shared with the runner, and a way into the feed. Hidden until there are any.
 */
export function FriendsActivity({ units }: { units: Units }) {
  const router = useRouter();
  const feed = useFeed();
  const items = (feed.data?.pages[0]?.items ?? []).filter((item) => !item.is_mine).slice(0, 3);
  if (items.length === 0) return null;
  return (
    <Card style={styles.card}>
      <Text variant="eyebrow" tone="secondary" style={styles.eyebrow} accessibilityRole="header">
        From friends
      </Text>
      {items.map((item) => {
        const distance = formatDistance(item.distance_m, units);
        return (
          <Pressable
            key={item.run_id}
            accessibilityRole="button"
            accessibilityLabel={`${item.owner.alias}: ${item.title}, ${describeDistance(item.distance_m, units)}. ${item.kudos} kudos, ${item.comments} comments.`}
            onPress={() => router.push({ pathname: '/shared/[id]', params: { id: item.run_id } })}
            style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}>
            <View style={styles.fill}>
              <Text variant="bodyStrong" numberOfLines={1}>
                {item.owner.alias} · {item.title}
              </Text>
              <View style={styles.meta}>
                <Text variant="label" tone="secondary">
                  {distance.value} {distance.unit}
                </Text>
                <ThumbsUp size={14} color={colors.textSecondary} />
                <Text variant="label" tone="secondary">
                  {item.kudos}
                </Text>
                <MessageCircle size={14} color={colors.textSecondary} />
                <Text variant="label" tone="secondary">
                  {item.comments}
                </Text>
              </View>
            </View>
            <ChevronRight size={20} color={colors.textSecondary} />
          </Pressable>
        );
      })}
      <TextButton label="Open the feed" onPress={() => router.push('/feed')} testID="home-open-feed" />
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { paddingVertical: space.sm, gap: space.xs },
  eyebrow: { marginTop: space.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: layout.minimumTapTarget, paddingVertical: space.xs },
  fill: { flex: 1 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
});
