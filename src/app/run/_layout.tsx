import { Stack } from 'expo-router';

import { colors } from '@/design/tokens';

/** Full-screen run flow above the tabs (no tab bar while preparing, recording or saving). */
export default function RunLayout() {
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background }, gestureEnabled: false }} />;
}
