import * as AppleAuthentication from 'expo-apple-authentication';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { WelcomeLanes } from '@/components/art/art';
import { SecondaryButton } from '@/components/ui/buttons';
import { InlineStatus } from '@/components/ui/elements';
import { Divider, Screen } from '@/components/ui/layout';
import { LegalLinks } from '@/components/ui/legal-links';
import { AuthError, isAppleSignInAvailable, signInWithApple } from '@/features/account/auth-actions';
import { Text } from '@/design/text';
import { heights, radius, space } from '@/design/tokens';

/** S01 — promise, Sign in with Apple or email, terms and privacy. */
export default function WelcomeScreen() {
  const router = useRouter();
  const [appleAvailable, setAppleAvailable] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void isAppleSignInAvailable().then(setAppleAvailable);
  }, []);

  const apple = async () => {
    setError(null);
    try {
      await signInWithApple();
    } catch (e) {
      if (e instanceof AuthError && e.code === 'cancelled') return;
      setError(e instanceof Error ? e.message : 'Sign in failed.');
    }
  };

  return (
    <Screen
      edges={['top', 'bottom']}
      footer={
        <View style={styles.actions}>
          {error ? <InlineStatus tone="danger" title={error} /> : null}
          {appleAvailable ? (
            <AppleAuthentication.AppleAuthenticationButton
              buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
              buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.WHITE}
              cornerRadius={radius.button}
              style={styles.apple}
              onPress={apple}
            />
          ) : null}
          <SecondaryButton label="Continue with email" onPress={() => router.push('/sign-in')} testID="continue-email" />
          <LegalLinks />
        </View>
      }>
      <Text variant="section" style={styles.wordmark} accessibilityRole="header" accessibilityLabel="PaceLeague">
        PACELEAGUE
      </Text>
      <View style={styles.art}>
        <WelcomeLanes width={340} height={200} />
      </View>
      <Text variant="display" accessibilityLabel="Show up. Move up.">
        {'SHOW UP.\nMOVE UP.'}
      </Text>
      <Text variant="section">Track your runs. Build your rank. Find your crew.</Text>
      <Divider />
      <Text variant="body" tone="secondary">
        Rest days keep your rank.
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  wordmark: { letterSpacing: 2, fontWeight: '800' },
  art: { alignItems: 'center', marginVertical: space.sm },
  actions: { gap: space.md },
  apple: { height: heights.primaryButton, width: '100%' },
});
