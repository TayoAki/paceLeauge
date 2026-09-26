import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Monogram } from '@/components/art/art';
import { Text } from '@/design/text';
import { colors, layout, space } from '@/design/tokens';

import { PrimaryButton } from './buttons';

export function LaunchSplash() {
  return (
    <View style={styles.center} accessibilityLabel="Loading PaceLeague">
      <Monogram size={72} />
    </View>
  );
}

/** Whole-screen message for configuration, locked-journal and first-launch offline states. */
export function AppMessage({ title, body, actionLabel, onAction }: { title: string; body: string; actionLabel?: string; onAction?: () => void }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.message, { paddingTop: insets.top + space.xxxl, paddingBottom: insets.bottom + space.xl }]}>
      <Monogram size={56} />
      <View style={{ gap: space.md }}>
        <Text variant="title" accessibilityRole="header">
          {title}
        </Text>
        <Text variant="body" tone="secondary">
          {body}
        </Text>
      </View>
      {actionLabel && onAction ? <PrimaryButton label={actionLabel} onPress={onAction} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
  message: { flex: 1, backgroundColor: colors.background, paddingHorizontal: layout.screenPadding, gap: space.xl },
});
