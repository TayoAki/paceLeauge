/**
 * Design tokens — the written values in docs/packet/design-tokens.json are authoritative
 * over the raster boards. tests/unit/design-tokens.test.ts fails if these drift.
 */
export const colors = {
  background: '#101315',
  surface: '#1B2024',
  surfaceElevated: '#272E33',
  textPrimary: '#F5F3EA',
  textSecondary: '#AAB2B8',
  accent: '#D5FF45',
  onAccent: '#101315',
  danger: '#FF9A85',
  controlOutline: '#70808C',
  decorativeDivider: '#354047',
} as const;

export const typeSizes = {
  hero: 64,
  workout: 72,
  title: 32,
  section: 22,
  body: 17,
  label: 15,
  caption: 13,
} as const;

export const weights = {
  regular: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
} as const;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48 } as const;

export const layout = {
  screenPadding: 20,
  cardPadding: 20,
  minimumTapTarget: 44,
} as const;

export const radius = { card: 24, button: 16, control: 12 } as const;

export const heights = { primaryButton: 56, runningPause: 72 } as const;

export const motion = { standardMin: 160, standardMax: 220, tierReveal: 400 } as const;

/** Decorative avatar fills (always paired with onAccent text for contrast). */
export const avatarFills = ['#FF9A85', '#8EC5FF', '#C9A7FF', '#FFD37A', '#7FE0C2', '#F5A3C7'] as const;
