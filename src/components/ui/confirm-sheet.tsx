import type { ReactNode } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/design/text';
import { colors, layout, radius, space } from '@/design/tokens';

import { DangerButton, PrimaryButton, SecondaryButton } from './buttons';

interface ConfirmSheetProps {
  visible: boolean;
  title: string;
  body?: string;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** iOS: called once the sheet has fully closed (safe moment to present another modal). */
  onDismiss?: () => void;
  children?: ReactNode;
}

/**
 * Bottom confirmation sheet. Destructive confirmations use an explicit labelled button and
 * never rely on a precise swipe gesture (REQ-014).
 */
export function ConfirmSheet({
  visible,
  title,
  body,
  confirmLabel,
  cancelLabel = 'Cancel',
  destructive,
  busy,
  onConfirm,
  onCancel,
  onDismiss,
  children,
}: ConfirmSheetProps) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel} onDismiss={onDismiss} statusBarTranslucent aria-label={title}>
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} accessibilityRole="button" accessibilityLabel="Dismiss" onPress={busy ? undefined : onCancel} />
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, space.lg) + space.sm }]} accessibilityViewIsModal>
          <Text variant="section" accessibilityRole="header">
            {title}
          </Text>
          {body ? (
            <Text variant="body" tone="secondary">
              {body}
            </Text>
          ) : null}
          {children}
          <View style={styles.actions}>
            {destructive ? (
              <DangerButton label={confirmLabel} onPress={onConfirm} loading={busy} />
            ) : (
              <PrimaryButton label={confirmLabel} onPress={onConfirm} loading={busy} />
            )}
            <SecondaryButton label={cancelLabel} onPress={onCancel} disabled={busy} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  sheet: {
    backgroundColor: colors.surfaceElevated,
    borderTopLeftRadius: radius.card,
    borderTopRightRadius: radius.card,
    padding: layout.cardPadding + 4,
    gap: space.md,
  },
  actions: { gap: space.sm, marginTop: space.sm },
});
