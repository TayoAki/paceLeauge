import { Stack } from 'expo-router';

import { colors } from '@/design/tokens';

export default function ProgressLayout() {
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }} />;
}
