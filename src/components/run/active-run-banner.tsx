import { useRouter } from 'expo-router';
import { ChevronRight, Radio } from 'lucide-react-native';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useRecorder } from '@/features/data/hooks';
import { formatDuration } from '@/domain/format';
import { Text } from '@/design/text';
import { colors, radius, space } from '@/design/tokens';

/** Visible return-to-run path whenever a session exists outside the run flow. */
export function ActiveRunBanner() {
  const { session, metrics } = useRecorder();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  if (!session) return null;
  const label =
    session.status === 'recording' ? `Recording · ${formatDuration(metrics.activeMs)}` : session.status === 'paused' ? 'Run paused' : 'Recording stopped';
  return (
    <View pointerEvents="box-none" style={[styles.wrap, { top: insets.top + space.xs }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}. Return to run`}
        onPress={() => router.push('/run/active')}
        style={styles.banner}
        testID="return-to-run">
        <Radio size={18} color={colors.onAccent} />
        <Text variant="labelStrong" tone="onAccent" style={{ flex: 1 }}>
          {label}
        </Text>
        <Text variant="labelStrong" tone="onAccent">
          Return
        </Text>
        <ChevronRight size={18} color={colors.onAccent} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: space.lg, right: space.lg },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: colors.accent,
    borderRadius: radius.control,
    paddingHorizontal: space.lg,
    minHeight: 48,
  },
});
