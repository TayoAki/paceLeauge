import type { ReactNode } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/design/text';
import { colors, layout, radius, space } from '@/design/tokens';

/** A bottom sheet with a title; tapping outside closes it unless it's busy. */
export function Sheet({ visible, onClose, title, busy, children }: { visible: boolean; onClose: () => void; title: string; busy?: boolean; children: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent aria-label={title}>
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} accessibilityRole="button" accessibilityLabel="Close" onPress={busy ? undefined : onClose} />
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, space.lg) + space.sm }]} accessibilityViewIsModal>
          <Text variant="section" accessibilityRole="header">
            {title}
          </Text>
          {children}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.6)' },
  sheet: {
    backgroundColor: colors.surfaceElevated,
    borderTopLeftRadius: radius.card,
    borderTopRightRadius: radius.card,
    padding: layout.cardPadding + 4,
    gap: space.md,
  },
});
