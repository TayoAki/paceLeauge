import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DarkTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AppMessage, LaunchSplash } from '@/components/ui/app-states';
import { isBackendConfigured } from '@/config/env';
import { AccountProvider, useAccount } from '@/features/account/account-provider';
import { AgeNeededScreen, AgeRestrictedScreen, useExistingAgeCheck } from '@/features/account/age-gate';
import { AuthProvider, useAuth } from '@/features/account/auth-provider';
import { useMe } from '@/features/data/hooks';
import { colors } from '@/design/tokens';

SplashScreen.preventAutoHideAsync().catch(() => undefined);

const queryClient = new QueryClient({
  defaultOptions: { queries: { gcTime: 10 * 60_000, refetchOnWindowFocus: false } },
});

const navigationTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: colors.background,
    card: colors.background,
    text: colors.textPrimary,
    border: colors.decorativeDivider,
    primary: colors.accent,
  },
};

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.background }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <AccountProvider>
              <ThemeProvider value={navigationTheme}>
                <StatusBar style="light" />
                <RootNavigator />
              </ThemeProvider>
            </AccountProvider>
          </AuthProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function RootNavigator() {
  const auth = useAuth();
  const { state, sessionLapsed, retryOpen } = useAccount();
  const me = useMe();
  const signedIn = auth.status === 'signed_in';
  const ready = state.status === 'ready';
  const profile = me.data?.data.profile ?? null;
  const loading = auth.status === 'loading' || (signedIn && (state.status === 'opening' || (ready && me.isPending)));
  const ageGate = useExistingAgeCheck(signedIn && ready ? profile : null);

  useEffect(() => {
    if (!loading) SplashScreen.hideAsync().catch(() => undefined);
  }, [loading]);

  if (!isBackendConfigured) {
    return (
      <AppMessage
        title="Backend not configured"
        body="Set EXPO_PUBLIC_API_URL and EXPO_PUBLIC_API_KEY (see .env.example), then restart the app."
      />
    );
  }
  if (loading) return <LaunchSplash />;
  if (state.status === 'error') {
    return <AppMessage title="Your saved runs are locked" body={state.error.message} actionLabel="Try again" onAction={retryOpen} />;
  }
  if (signedIn && ready && me.isError && !me.data) {
    return (
      <AppMessage
        title="Can’t reach PaceLeague"
        body="Check your connection and try again. Runs you save on this phone are kept safely."
        actionLabel="Try again"
        onAction={() => void me.refetch()}
      />
    );
  }

  const onboarded = signedIn && ready && profile !== null;
  if (onboarded && profile.age_signal === 'minor') return <AgeRestrictedScreen />;
  if (onboarded && ageGate.needsAge) return <AgeNeededScreen check={ageGate.needsAge} onRetry={ageGate.retry} />;
  const inApp = onboarded || (sessionLapsed && ready);

  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}>
      <Stack.Protected guard={!signedIn && !sessionLapsed}>
        <Stack.Screen name="welcome" />
        <Stack.Screen name="sign-in" />
      </Stack.Protected>
      <Stack.Protected guard={signedIn && ready && profile === null}>
        <Stack.Screen name="onboarding" options={{ gestureEnabled: false }} />
      </Stack.Protected>
      <Stack.Protected guard={inApp}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="run" options={{ presentation: 'fullScreenModal', gestureEnabled: false }} />
        <Stack.Screen name="share/[id]" options={{ presentation: 'fullScreenModal' }} />
        <Stack.Screen name="reauth" options={{ presentation: 'modal' }} />
      </Stack.Protected>
      <Stack.Screen name="invite/[code]" />
      <Stack.Screen name="legal" />
      <Stack.Screen name="strava" />
      <Stack.Protected guard={__DEV__}>
        <Stack.Screen name="dev/catalog" />
      </Stack.Protected>
    </Stack>
  );
}
