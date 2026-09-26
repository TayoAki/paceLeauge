import { Text as RNText, StyleSheet, type TextProps, type TextStyle } from 'react-native';

import { colors, typeSizes } from './tokens';

export type TextVariant =
  | 'workout'
  | 'hero'
  | 'display'
  | 'title'
  | 'section'
  | 'body'
  | 'bodyStrong'
  | 'label'
  | 'labelStrong'
  | 'caption'
  | 'eyebrow'
  | 'metric'
  | 'metricLarge';

type Tone = 'primary' | 'secondary' | 'accent' | 'onAccent' | 'danger';

const toneColor: Record<Tone, string> = {
  primary: colors.textPrimary,
  secondary: colors.textSecondary,
  accent: colors.accent,
  onAccent: colors.onAccent,
  danger: colors.danger,
};

/**
 * Giant workout numerals keep a modest Dynamic Type ceiling so they never push the Pause
 * control off screen; all reading text scales fully (REQ-014).
 */
const variantStyles = StyleSheet.create({
  workout: { fontSize: typeSizes.workout, fontWeight: '800', letterSpacing: -2, fontVariant: ['tabular-nums'] },
  hero: { fontSize: typeSizes.hero, fontWeight: '800', letterSpacing: -1.5, fontVariant: ['tabular-nums'] },
  display: { fontSize: 56, fontWeight: '900', letterSpacing: -2, lineHeight: 54, textTransform: 'uppercase' },
  title: { fontSize: typeSizes.title, fontWeight: '800', letterSpacing: -0.5 },
  section: { fontSize: typeSizes.section, fontWeight: '700' },
  body: { fontSize: typeSizes.body, fontWeight: '400', lineHeight: 23 },
  bodyStrong: { fontSize: typeSizes.body, fontWeight: '600', lineHeight: 23 },
  label: { fontSize: typeSizes.label, fontWeight: '400', lineHeight: 20 },
  labelStrong: { fontSize: typeSizes.label, fontWeight: '600', lineHeight: 20 },
  caption: { fontSize: typeSizes.caption, fontWeight: '400', lineHeight: 18 },
  eyebrow: { fontSize: typeSizes.caption, fontWeight: '600', letterSpacing: 2.5, textTransform: 'uppercase' },
  metric: { fontSize: typeSizes.title, fontWeight: '800', fontVariant: ['tabular-nums'], letterSpacing: -0.5 },
  metricLarge: { fontSize: 44, fontWeight: '800', fontVariant: ['tabular-nums'], letterSpacing: -1 },
});

const multiplierCeiling: Partial<Record<TextVariant, number>> = {
  workout: 1.25,
  hero: 1.3,
  display: 1.3,
  metric: 1.5,
  metricLarge: 1.4,
  title: 1.6,
};

export interface AppTextProps extends TextProps {
  variant?: TextVariant;
  tone?: Tone;
  align?: TextStyle['textAlign'];
}

export function Text({ variant = 'body', tone = 'primary', align, style, maxFontSizeMultiplier, ...rest }: AppTextProps) {
  return (
    <RNText
      maxFontSizeMultiplier={maxFontSizeMultiplier ?? multiplierCeiling[variant] ?? 2}
      style={[variantStyles[variant], { color: toneColor[tone] }, align ? { textAlign: align } : null, style]}
      {...rest}
    />
  );
}
