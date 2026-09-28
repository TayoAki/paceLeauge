import { useRouter } from 'expo-router';
import { Timer } from 'lucide-react-native';
import { Pressable, StyleSheet, View } from 'react-native';

import { Card } from '@/components/ui/layout';
import { describeDuration } from '@/domain/format';
import { useTeen } from '@/features/account/teen';
import { formatElapsed } from '@/features/segments/segment-text';
import { useRunSegments } from '@/features/segments/use-segments';
import { Text } from '@/design/text';
import { colors, space } from '@/design/tokens';

/**
 * The segments a run went through (docs/ROADMAP.md 5.3): the time on each, marking the runner's
 * best. Only runs shared with everyone, map included, by runners on the segment boards have any.
 */
export function RunSegmentsCard({ serverRunId }: { serverRunId: string }) {
  const router = useRouter();
  const { isTeen } = useTeen();
  const query = useRunSegments(serverRunId, !isTeen);
  const efforts = query.data?.data ?? [];
  if (efforts.length === 0) return null;
  return (
    <Card>
      <Text variant="labelStrong" accessibilityRole="header">
        Segments
      </Text>
      {efforts.map((e) => {
        const tag = e.status === 'held' ? 'Being checked' : e.is_best ? 'Your best' : null;
        return (
          <Pressable
            key={e.effort_id}
            style={({ pressed }) => [styles.effort, pressed && { opacity: 0.8 }]}
            accessibilityRole="button"
            accessibilityLabel={`${e.name}: ${describeDuration(Math.round(e.elapsed_ms / 1000) * 1000)}${tag ? `. ${tag}` : ''}`}
            accessibilityHint="Opens the segment’s board"
            onPress={() => router.push({ pathname: '/league/segments/[id]', params: { id: e.segment_id } })}>
            <Text variant="body" tone="secondary" style={styles.name} numberOfLines={1}>
              {e.name}
            </Text>
            <Text variant="bodyStrong" style={styles.time}>
              {formatElapsed(e.elapsed_ms)}
            </Text>
            {tag ? (
              <View style={styles.tag}>
                {e.is_best && e.status === 'counted' ? <Timer size={14} color={colors.accent} /> : null}
                <Text variant="caption" tone={e.is_best && e.status === 'counted' ? 'accent' : 'secondary'}>
                  {tag}
                </Text>
              </View>
            ) : null}
          </Pressable>
        );
      })}
    </Card>
  );
}

const styles = StyleSheet.create({
  effort: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 44 },
  name: { flex: 1 },
  time: { fontVariant: ['tabular-nums'] },
  tag: { flexDirection: 'row', alignItems: 'center', gap: 4 },
});
