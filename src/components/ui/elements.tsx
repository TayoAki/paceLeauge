import { Check, ChevronRight, CircleAlert, CircleCheck, Info, TriangleAlert, type LucideIcon } from 'lucide-react-native';
import type { ReactNode, Ref } from 'react';
import { Pressable, StyleSheet, TextInput, View, type StyleProp, type TextInputProps, type ViewStyle } from 'react-native';

import { Text } from '@/design/text';
import { avatarFills, colors, layout, radius, space } from '@/design/tokens';

// ---------------------------------------------------------------------------------------
// Settings-style rows
// ---------------------------------------------------------------------------------------
export function RowGroup({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.group, style]}>{children}</View>;
}

interface RowProps {
  icon?: LucideIcon;
  label: string;
  value?: string;
  onPress?: () => void;
  tone?: 'primary' | 'danger' | 'accent';
  /** Colour of the value text; positive states use the accent, as in the design. */
  valueTone?: 'secondary' | 'accent' | 'danger';
  hint?: string;
  last?: boolean;
  accessory?: ReactNode;
  testID?: string;
}

export function Row({ icon: Icon, label, value, valueTone = 'secondary', onPress, tone = 'primary', hint, last, accessory, testID }: RowProps) {
  const color = tone === 'danger' ? colors.danger : colors.textPrimary;
  const content = (
    <View style={[styles.row, !last && styles.rowDivider]}>
      {Icon ? <Icon size={22} color={tone === 'accent' ? colors.accent : color} strokeWidth={2} /> : null}
      <View style={styles.rowText}>
        <Text variant="body" style={{ color }}>
          {label}
        </Text>
        {hint ? (
          <Text variant="caption" tone="secondary">
            {hint}
          </Text>
        ) : null}
      </View>
      {value ? (
        <Text variant="label" tone={valueTone} numberOfLines={1} style={styles.rowValue}>
          {value}
        </Text>
      ) : null}
      {accessory}
      {onPress ? <ChevronRight size={20} color={colors.textSecondary} /> : null}
    </View>
  );
  if (!onPress) {
    return (
      <View accessible accessibilityLabel={value ? `${label}, ${value}` : label} accessibilityHint={hint} testID={testID}>
        {content}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={value ? `${label}, ${value}` : label}
      accessibilityHint={hint}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => pressed && { backgroundColor: colors.surfaceElevated }}>
      {content}
    </Pressable>
  );
}

/** A settings row with an on/off switch; the whole row toggles. */
export function SwitchRow({
  icon: Icon,
  label,
  hint,
  value,
  onChange,
  disabled,
  last,
  testID,
}: {
  icon?: LucideIcon;
  label: string;
  hint?: string;
  value: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  last?: boolean;
  testID?: string;
}) {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ checked: value, disabled: !!disabled }}
      disabled={disabled}
      onPress={() => onChange(!value)}
      testID={testID}
      style={({ pressed }) => [pressed && { backgroundColor: colors.surfaceElevated }, disabled && { opacity: 0.5 }]}>
      <View style={[styles.row, !last && styles.rowDivider]}>
        {Icon ? <Icon size={22} color={value ? colors.textPrimary : colors.textSecondary} strokeWidth={2} /> : null}
        <View style={styles.rowText}>
          <Text variant="body">{label}</Text>
          {hint ? (
            <Text variant="caption" tone="secondary">
              {hint}
            </Text>
          ) : null}
        </View>
        <View style={[styles.switchTrack, value && styles.switchTrackOn]}>
          <View style={[styles.switchThumb, value && styles.switchThumbOn]} />
        </View>
      </View>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------------------
// Status and empty states
// ---------------------------------------------------------------------------------------
export type StatusTone = 'info' | 'success' | 'warning' | 'danger';

const statusIcon: Record<StatusTone, LucideIcon> = {
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  danger: CircleAlert,
};
const statusColor: Record<StatusTone, string> = {
  info: colors.textSecondary,
  success: colors.accent,
  warning: colors.accent,
  danger: colors.danger,
};

/** Inline status: icon shape + text, never color alone. */
export function InlineStatus({
  tone = 'info',
  title,
  body,
  action,
  icon,
}: {
  tone?: StatusTone;
  title: string;
  body?: string;
  action?: ReactNode;
  icon?: LucideIcon;
}) {
  const Icon = icon ?? statusIcon[tone];
  // The message is one accessible element; an action stays a separate, reachable control.
  return (
    <View style={styles.status}>
      <View style={styles.statusMain} accessible accessibilityRole="summary" accessibilityLabel={body ? `${title}. ${body}` : title}>
        <Icon size={20} color={statusColor[tone]} strokeWidth={2.2} />
        <View style={styles.rowText}>
          <Text variant="labelStrong">{title}</Text>
          {body ? (
            <Text variant="label" tone="secondary">
              {body}
            </Text>
          ) : null}
        </View>
      </View>
      {action ? <View style={styles.statusAction}>{action}</View> : null}
    </View>
  );
}

export function EmptyState({ title, body, icon: Icon, children }: { title: string; body?: string; icon?: LucideIcon; children?: ReactNode }) {
  return (
    <View style={styles.empty}>
      {Icon ? (
        <View style={styles.emptyIcon}>
          <Icon size={32} color={colors.accent} strokeWidth={2} />
        </View>
      ) : null}
      <Text variant="section" align="center" accessibilityRole="header">
        {title}
      </Text>
      {body ? (
        <Text variant="body" tone="secondary" align="center">
          {body}
        </Text>
      ) : null}
      {children ? <View style={styles.emptyActions}>{children}</View> : null}
    </View>
  );
}

// ---------------------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------------------
export function Pill({ label, tone = 'accent' }: { label: string; tone?: 'accent' | 'neutral' | 'danger' }) {
  const bg = tone === 'accent' ? colors.accent : tone === 'danger' ? 'transparent' : colors.surfaceElevated;
  const fg = tone === 'accent' ? colors.onAccent : tone === 'danger' ? colors.danger : colors.textPrimary;
  return (
    <View style={[styles.pill, { backgroundColor: bg }, tone === 'danger' && { borderWidth: 1, borderColor: colors.danger }]}>
      <Text variant="labelStrong" style={{ color: fg }}>
        {label}
      </Text>
    </View>
  );
}

export function ProgressBar({ fraction, label, height = 6 }: { fraction: number; label: string; height?: number }) {
  const clamped = Math.max(0, Math.min(1, fraction));
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(clamped * 100) }}
      style={[styles.track, { height, borderRadius: height / 2 }]}>
      <View style={[styles.fill, { width: `${clamped * 100}%`, borderRadius: height / 2 }]} />
    </View>
  );
}

function hash(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function Avatar({ name, seed, highlight, size = 40 }: { name: string | null; seed: string; highlight?: boolean; size?: number }) {
  const fill = highlight ? colors.accent : name ? avatarFills[hash(seed) % avatarFills.length] : colors.surfaceElevated;
  return (
    <View
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: fill,
        alignItems: 'center',
        justifyContent: 'center',
      }}>
      <Text variant="bodyStrong" style={{ color: name ? colors.onAccent : colors.textSecondary }} maxFontSizeMultiplier={1.2}>
        {name ? name.trim().charAt(0).toUpperCase() : '·'}
      </Text>
    </View>
  );
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <View style={styles.segments} accessibilityRole="tablist" accessibilityLabel={label}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={option.label}
            onPress={() => onChange(option.value)}
            style={[styles.segment, selected && styles.segmentSelected]}>
            <Text variant={selected ? 'labelStrong' : 'label'} tone={selected ? 'primary' : 'secondary'}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A wrapping row of single-choice chips, for choices with more options than a segmented control fits. */
export function ChoiceChips<T extends string>({
  options,
  value,
  onChange,
  label,
  disabled,
}: {
  options: { value: T; label: string; accessibilityLabel?: string }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <View style={styles.chips} accessibilityRole="radiogroup" accessibilityLabel={label}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityLabel={option.accessibilityLabel ?? option.label}
            accessibilityState={{ checked: selected, disabled: !!disabled }}
            disabled={disabled}
            onPress={() => onChange(option.value)}
            style={({ pressed }) => [styles.chip, selected && styles.chipOn, pressed && { opacity: 0.8 }, disabled && { opacity: 0.5 }]}>
            {selected ? <Check size={16} color={colors.onAccent} strokeWidth={3} /> : null}
            <Text variant="labelStrong" style={{ color: selected ? colors.onAccent : colors.textPrimary }}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function TextField({
  label,
  error,
  hint,
  style,
  ref,
  ...rest
}: TextInputProps & {
  label: string;
  error?: string | null;
  hint?: string;
  ref?: Ref<TextInput>;
}) {
  return (
    <View style={styles.field}>
      <Text variant="labelStrong" nativeID={`${label}-label`}>
        {label}
      </Text>
      <TextInput
        ref={ref}
        accessibilityLabel={label}
        accessibilityLabelledBy={`${label}-label`}
        placeholderTextColor={colors.textSecondary}
        style={[styles.input, error ? { borderColor: colors.danger } : null, style]}
        {...rest}
      />
      {error ? (
        <View style={styles.fieldError} accessibilityLiveRegion="polite">
          <CircleAlert size={16} color={colors.danger} />
          <Text variant="label" tone="danger">
            {error}
          </Text>
        </View>
      ) : hint ? (
        <Text variant="caption" tone="secondary">
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  group: {
    backgroundColor: colors.surface,
    borderRadius: radius.card,
    overflow: 'hidden',
  },
  row: {
    minHeight: 60,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: layout.cardPadding,
    paddingVertical: space.md,
  },
  rowDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth * 2,
    borderBottomColor: colors.decorativeDivider,
  },
  rowText: { flex: 1, gap: 2 },
  switchTrack: {
    width: 52,
    height: 32,
    borderRadius: 16,
    padding: 3,
    justifyContent: 'center',
    backgroundColor: colors.surfaceElevated,
    borderWidth: 1.5,
    borderColor: colors.controlOutline,
  },
  switchTrackOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  switchThumb: { width: 23, height: 23, borderRadius: 12, backgroundColor: colors.textPrimary },
  switchThumbOn: { alignSelf: 'flex-end', backgroundColor: colors.onAccent },
  rowValue: { maxWidth: '45%' },
  statusMain: { flexDirection: 'row', gap: space.md, alignItems: 'flex-start' },
  statusAction: { paddingLeft: 20 + space.md, alignItems: 'flex-start' },
  status: {
    gap: space.sm,
    padding: space.lg,
    borderRadius: radius.control,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.decorativeDivider,
  },
  empty: { alignItems: 'center', gap: space.md, paddingVertical: space.xl },
  emptyIcon: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: colors.surfaceElevated,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.sm,
  },
  emptyActions: { alignSelf: 'stretch', gap: space.sm, marginTop: space.md },
  pill: {
    paddingHorizontal: space.md,
    paddingVertical: 6,
    borderRadius: 999,
    alignSelf: 'flex-start',
  },
  track: {
    backgroundColor: colors.decorativeDivider,
    overflow: 'hidden',
    width: '100%',
  },
  fill: { height: '100%', backgroundColor: colors.accent },
  segments: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderRadius: radius.control,
    padding: 4,
  },
  segment: {
    flex: 1,
    minHeight: layout.minimumTapTarget,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.control - 4,
  },
  segmentSelected: { backgroundColor: colors.surfaceElevated },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    minHeight: layout.minimumTapTarget,
    paddingHorizontal: space.lg,
    borderRadius: 999,
    borderWidth: 1.5,
    borderColor: colors.controlOutline,
  },
  chipOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  field: { gap: space.sm },
  input: {
    minHeight: 56,
    borderRadius: radius.control,
    borderWidth: 1.5,
    borderColor: colors.controlOutline,
    paddingHorizontal: space.lg,
    color: colors.textPrimary,
    fontSize: 17,
    backgroundColor: colors.surface,
  },
  fieldError: { flexDirection: 'row', gap: space.sm, alignItems: 'center' },
});
