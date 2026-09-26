import type { ComponentType, ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';

import { Text } from '@/design/text';
import { colors, heights, layout, radius, space } from '@/design/tokens';

type IconComponent = ComponentType<{
  size?: number;
  color?: string;
  strokeWidth?: number;
}>;

interface BaseButtonProps extends Omit<PressableProps, 'children' | 'style'> {
  label: string;
  icon?: IconComponent;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
  size?: 'regular' | 'large' | 'xl';
  children?: ReactNode;
}

const sizeHeight = {
  regular: heights.primaryButton,
  large: 64,
  xl: heights.runningPause,
} as const;

function ButtonContent({
  label,
  icon: Icon,
  loading,
  color,
  strong,
}: {
  label: string;
  icon?: IconComponent;
  loading?: boolean;
  color: string;
  strong?: boolean;
}) {
  return (
    <View style={styles.content}>
      {loading ? (
        <ActivityIndicator color={color} />
      ) : (
        <>
          {Icon ? <Icon size={22} color={color} strokeWidth={2.4} /> : null}
          <Text variant={strong ? 'section' : 'bodyStrong'} style={{ color }} numberOfLines={1} adjustsFontSizeToFit>
            {label}
          </Text>
        </>
      )}
    </View>
  );
}

/** Lime primary action. Always dark text on lime (onAccent). */
export function PrimaryButton({ label, icon, loading, disabled, style, size = 'regular', ...rest }: BaseButtonProps) {
  const inactive = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!inactive, busy: !!loading }}
      disabled={inactive}
      style={({ pressed }) => [
        styles.base,
        {
          minHeight: sizeHeight[size],
          backgroundColor: disabled ? colors.surfaceElevated : colors.accent,
        },
        pressed && !inactive && styles.pressed,
        style,
      ]}
      {...rest}>
      <ButtonContent
        label={label}
        icon={icon}
        loading={loading}
        color={disabled ? colors.textSecondary : colors.onAccent}
        strong={size !== 'regular'}
      />
    </Pressable>
  );
}

/** Outlined secondary action (meaningful outline token). */
export function SecondaryButton({ label, icon, loading, disabled, style, size = 'regular', ...rest }: BaseButtonProps) {
  const inactive = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!inactive, busy: !!loading }}
      disabled={inactive}
      style={({ pressed }) => [
        styles.base,
        styles.outlined,
        { minHeight: sizeHeight[size] },
        pressed && !inactive && styles.pressedOutline,
        disabled && styles.disabledOutline,
        style,
      ]}
      {...rest}>
      <ButtonContent
        label={label}
        icon={icon}
        loading={loading}
        color={disabled ? colors.textSecondary : colors.textPrimary}
        strong={size !== 'regular'}
      />
    </Pressable>
  );
}

/** Destructive control: coral outline, icon plus explicit label (never color alone). */
export function DangerButton({ label, icon, loading, disabled, style, ...rest }: BaseButtonProps) {
  const inactive = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!inactive, busy: !!loading }}
      disabled={inactive}
      style={({ pressed }) => [
        styles.base,
        styles.danger,
        { minHeight: heights.primaryButton },
        disabled && !loading && styles.disabledDanger,
        pressed && !inactive && styles.pressedOutline,
        style,
      ]}
      {...rest}>
      <ButtonContent label={label} icon={icon} loading={loading} color={colors.danger} />
    </Pressable>
  );
}

/** Quiet text action with a full-size tap target. */
export function TextButton({
  label,
  icon,
  disabled,
  style,
  tone = 'secondary',
  ...rest
}: BaseButtonProps & { tone?: 'secondary' | 'primary' | 'danger' | 'accent' }) {
  const color = {
    secondary: colors.textSecondary,
    primary: colors.textPrimary,
    danger: colors.danger,
    accent: colors.accent,
  }[tone];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      hitSlop={8}
      style={({ pressed }) => [styles.text, pressed && { opacity: 0.6 }, disabled && { opacity: 0.4 }, style]}
      {...rest}>
      <ButtonContent label={label} icon={icon} color={color} />
    </Pressable>
  );
}

/** Circular icon button (header actions). Requires an accessible label. */
export function IconButton({
  icon: Icon,
  label,
  style,
  tone = 'surface',
  ...rest
}: Omit<BaseButtonProps, 'icon'> & {
  icon: IconComponent;
  tone?: 'surface' | 'plain';
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      style={({ pressed }) => [styles.icon, tone === 'surface' && styles.iconSurface, pressed && { opacity: 0.7 }, style]}
      {...rest}>
      <Icon size={22} color={colors.textPrimary} strokeWidth={2.2} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: radius.button,
    paddingHorizontal: space.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.md,
  },
  pressed: { opacity: 0.85, transform: [{ scale: 0.99 }] },
  outlined: {
    borderWidth: 1.5,
    borderColor: colors.controlOutline,
    backgroundColor: 'transparent',
  },
  pressedOutline: { backgroundColor: colors.surface },
  disabledDanger: { opacity: 0.45 },
  disabledOutline: { borderColor: colors.decorativeDivider },
  danger: {
    borderWidth: 1.5,
    borderColor: colors.danger,
    backgroundColor: 'transparent',
  },
  text: {
    minHeight: layout.minimumTapTarget,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.md,
  },
  icon: {
    width: layout.minimumTapTarget + 4,
    height: layout.minimumTapTarget + 4,
    borderRadius: (layout.minimumTapTarget + 4) / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconSurface: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.decorativeDivider,
  },
});
