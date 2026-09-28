import { useRouter } from 'expo-router';
import { ChevronLeft, X } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { Platform, ScrollView, StyleSheet, View, type ScrollViewProps, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets, type Edge } from 'react-native-safe-area-context';

import { Text } from '@/design/text';
import { colors, layout, radius, space } from '@/design/tokens';

import { IconButton } from './buttons';

interface ScreenProps {
  children: ReactNode;
  scroll?: boolean;
  edges?: Edge[];
  footer?: ReactNode;
  contentStyle?: StyleProp<ViewStyle>;
  refreshControl?: ScrollViewProps['refreshControl'];
  testID?: string;
}

/**
 * Full-height screen on the app background with safe-area padding. Content scrolls so a
 * 200% Dynamic Type layout never clips a primary action; `footer` pins actions at the bottom.
 */
export function Screen({ children, scroll = true, edges = ['top'], footer, contentStyle, refreshControl, testID }: ScreenProps) {
  const insets = useSafeAreaInsets();
  const padTop = edges.includes('top') ? insets.top + space.sm : 0;
  const padBottom = edges.includes('bottom') ? insets.bottom : 0;
  const body = scroll ? (
    <ScrollView
      contentContainerStyle={[styles.content, { paddingTop: padTop, paddingBottom: footer ? space.lg : padBottom + space.xl }, contentStyle]}
      keyboardShouldPersistTaps="handled"
      refreshControl={refreshControl}>
      {children}
    </ScrollView>
  ) : (
    <View style={[styles.content, styles.fill, { paddingTop: padTop, paddingBottom: footer ? 0 : padBottom }, contentStyle]}>{children}</View>
  );
  return (
    <View style={styles.screen} testID={testID}>
      {body}
      {footer ? <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, space.lg) }]}>{footer}</View> : null}
    </View>
  );
}

export function Card({ children, style, elevated = false }: { children: ReactNode; style?: StyleProp<ViewStyle>; elevated?: boolean }) {
  return <View style={[styles.card, elevated && { backgroundColor: colors.surfaceElevated }, style]}>{children}</View>;
}

/** Large-title header used at the top of tab screens (title + optional subtitle + action). */
export function LargeHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <View style={styles.largeHeader}>
      <View style={styles.fill}>
        <Text variant="title" accessibilityRole="header" style={styles.largeTitle}>
          {title}
        </Text>
        {subtitle ? (
          <Text variant="eyebrow" tone="secondary">
            {subtitle}
          </Text>
        ) : null}
      </View>
      {action}
    </View>
  );
}

/** Centered title with a back (or close) control for pushed and modal screens. */
export function NavHeader({ title, onBack, variant = 'back', right }: { title: string; onBack?: () => void; variant?: 'back' | 'close'; right?: ReactNode }) {
  const router = useRouter();
  const back = onBack ?? (() => (router.canGoBack() ? router.back() : router.replace('/')));
  return (
    <View style={styles.navHeader}>
      <View style={styles.navSide}>
        {variant === 'back' ? <IconButton icon={ChevronLeft} label="Back" tone="plain" onPress={back} /> : null}
      </View>
      <Text variant="section" align="center" accessibilityRole="header" style={styles.fill} numberOfLines={1}>
        {title}
      </Text>
      <View style={[styles.navSide, { alignItems: 'flex-end' }]}>
        {variant === 'close' ? <IconButton icon={X} label="Close" onPress={back} /> : right}
      </View>
    </View>
  );
}

export function Divider({ style }: { style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.divider, style]} />;
}

export function Gap({ size = space.lg }: { size?: number }) {
  return <View style={{ height: size }} />;
}

/** On the web, screens keep a phone-like column in the middle of wide windows (P.2). */
const WIDE = Platform.OS === 'web' ? ({ width: '100%', maxWidth: 680, alignSelf: 'center' } as const) : {};

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  fill: { flex: 1 },
  content: { paddingHorizontal: layout.screenPadding, gap: space.lg, ...WIDE },
  footer: {
    paddingHorizontal: layout.screenPadding,
    paddingTop: space.md,
    gap: space.sm,
    backgroundColor: colors.background,
    ...WIDE,
  },
  card: { backgroundColor: colors.surface, borderRadius: radius.card, padding: layout.cardPadding, gap: space.md },
  largeHeader: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginBottom: space.xs },
  largeTitle: { fontSize: 36 },
  navHeader: { flexDirection: 'row', alignItems: 'center', minHeight: 52, marginHorizontal: -space.sm },
  navSide: { width: 56 },
  divider: { height: StyleSheet.hairlineWidth * 2, backgroundColor: colors.decorativeDivider },
});
