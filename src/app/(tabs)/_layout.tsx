import { Tabs } from 'expo-router/js-tabs';
import { ChartColumn, House, Trophy, User } from 'lucide-react-native';
import { View } from 'react-native';

import { ActiveRunBanner } from '@/components/run/active-run-banner';
import { colors } from '@/design/tokens';

/** Today · League · Progress · Profile (standard tabs; the live run takes over the screen). */
export default function TabsLayout() {
  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: colors.accent,
          tabBarInactiveTintColor: colors.textSecondary,
          tabBarStyle: { backgroundColor: colors.background, borderTopColor: colors.decorativeDivider, borderTopWidth: 1 },
          tabBarLabelStyle: { fontWeight: '600' },
          sceneStyle: { backgroundColor: colors.background },
        }}>
        <Tabs.Screen name="index" options={{ title: 'Today', tabBarIcon: ({ color, size }) => <House color={color} size={size} /> }} />
        <Tabs.Screen name="league" options={{ title: 'League', tabBarIcon: ({ color, size }) => <Trophy color={color} size={size} /> }} />
        <Tabs.Screen name="progress" options={{ title: 'Progress', tabBarIcon: ({ color, size }) => <ChartColumn color={color} size={size} /> }} />
        <Tabs.Screen name="profile" options={{ title: 'Profile', tabBarIcon: ({ color, size }) => <User color={color} size={size} /> }} />
      </Tabs>
      <ActiveRunBanner />
    </View>
  );
}
