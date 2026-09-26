import * as AppleAuthentication from 'expo-apple-authentication';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, TextInput, View } from 'react-native';
import type { Edge } from 'react-native-safe-area-context';

import { PrimaryButton, SecondaryButton, TextButton } from '@/components/ui/buttons';
import { InlineStatus, TextField } from '@/components/ui/elements';
import { NavHeader, Screen } from '@/components/ui/layout';
import { AuthError, isAppleSignInAvailable, sendEmailCode, signInWithApple, verifyEmailCode } from '@/features/account/auth-actions';
import { useAuth } from '@/features/account/auth-provider';
import { Text } from '@/design/text';
import { heights, radius, space } from '@/design/tokens';

const RESEND_SECONDS = 60;
const PURPOSE: Record<string, string> = { export: 'to export your data', delete: 'to delete your account' };
/** An iOS page sheet sits below the status bar, so only the bottom inset applies. */
const EDGES: Edge[] = Platform.OS === 'ios' ? ['bottom'] : ['top', 'bottom'];

/**
 * "Confirm it's you" — a fresh sign-in for the same account before export or deletion.
 * The email is fixed to the signed-in address, and Apple is offered only when this account
 * already uses Sign in with Apple, so confirming can never switch accounts.
 */
export default function ReauthScreen() {
  const router = useRouter();
  const { next } = useLocalSearchParams<{ next?: string }>();
  const auth = useAuth();
  const [appleAvailable, setAppleAvailable] = useState(false);
  const [step, setStep] = useState<'choose' | 'code'>('choose');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [sheetTop, setSheetTop] = useState(0);
  const codeRef = useRef<TextInput>(null);
  const container = useRef<View>(null);

  useEffect(() => {
    void isAppleSignInAvailable().then(setAppleAvailable);
  }, []);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const user = auth.status === 'signed_in' ? auth.session.user : null;
  const email = auth.status === 'signed_in' ? auth.email : null;
  // The Apple user identifier linked to this account (the API returns it as the identity's `sub`).
  const appleIdentity = user?.identities?.find((i) => i.provider === 'apple');
  const appleSub = typeof appleIdentity?.identity_data?.sub === 'string' ? appleIdentity.identity_data.sub : undefined;
  const offerApple = appleAvailable && appleSub !== undefined;
  const purpose = PURPOSE[next ?? ''] ?? 'to continue';

  const finish = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/profile/privacy');
  };

  const sendCode = async () => {
    if (!email) return;
    setError(null);
    setBusy(true);
    try {
      await sendEmailCode(email);
      setStep('code');
      setCode('');
      setCooldown(RESEND_SECONDS);
      setTimeout(() => codeRef.current?.focus(), 250);
    } catch (e) {
      setError(e instanceof AuthError ? e.message : 'Couldn’t send the code. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    if (!email) return;
    setError(null);
    setBusy(true);
    try {
      await verifyEmailCode(email, code);
      finish();
    } catch (e) {
      setError(e instanceof AuthError ? e.message : 'Couldn’t check the code. Try again.');
      setBusy(false);
    }
  };

  const apple = async () => {
    setError(null);
    try {
      await signInWithApple(appleSub);
      finish();
    } catch (e) {
      if (e instanceof AuthError && e.code === 'cancelled') return;
      setError(e instanceof Error ? e.message : 'Sign in with Apple didn’t work. Try again.');
    }
  };

  const footer =
    step === 'code' ? (
      <View style={styles.actions}>
        <PrimaryButton label="Confirm" onPress={() => void verify()} loading={busy} disabled={code.length !== 6} testID="reauth-verify" />
        <TextButton label={cooldown > 0 ? `Send a new code in ${cooldown}s` : 'Send a new code'} disabled={cooldown > 0 || busy} onPress={() => void sendCode()} />
      </View>
    ) : (
      <View style={styles.actions}>
        {offerApple ? (
          <AppleAuthentication.AppleAuthenticationButton
            buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
            buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.WHITE}
            cornerRadius={radius.button}
            style={styles.apple}
            onPress={() => void apple()}
          />
        ) : null}
        {email ? (
          offerApple ? (
            <SecondaryButton label="Email me a code instead" onPress={() => void sendCode()} loading={busy} testID="reauth-send-code" />
          ) : (
            <PrimaryButton label="Email me a code" onPress={() => void sendCode()} loading={busy} testID="reauth-send-code" />
          )
        ) : null}
      </View>
    );

  return (
    // The sheet starts below the top of the window; the keyboard offset accounts for that so the
    // keyboard never covers the Confirm button.
    <View ref={container} style={styles.fill} onLayout={() => container.current?.measureInWindow((_x, y) => setSheetTop(y))}>
      <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={sheetTop}>
        <Screen edges={EDGES} contentStyle={Platform.OS === 'ios' ? styles.sheetTop : undefined} footer={footer}>
          <NavHeader title="Confirm it’s you" variant="close" />
          <Text variant="body" tone="secondary">
            For your security, sign in again {purpose}. It only takes a moment.
          </Text>
          {email ? (
            <Text variant="label" tone="secondary">
              Signed in as <Text variant="labelStrong">{email}</Text>
            </Text>
          ) : null}

          {auth.status !== 'signed_in' ? (
            <InlineStatus tone="warning" title="You’re signed out." body="Sign in again from Profile, then try again." />
          ) : !email && !offerApple ? (
            <InlineStatus tone="warning" title="This account can’t confirm here." body="Sign out and sign back in, then try again." />
          ) : null}

          {step === 'code' ? (
            <>
              <Text variant="body" tone="secondary">
                Enter the code we sent to {email}. It expires in 10 minutes.
              </Text>
              <TextField
                ref={codeRef}
                label="6-digit code"
                value={code}
                onChangeText={(t) => setCode(t.replace(/\D/g, '').slice(0, 6))}
                keyboardType="number-pad"
                textContentType="oneTimeCode"
                autoComplete="one-time-code"
                maxLength={6}
                error={error}
                style={styles.code}
                testID="reauth-code"
              />
            </>
          ) : error ? (
            <InlineStatus tone="danger" title={error} />
          ) : null}
        </Screen>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  sheetTop: { paddingTop: space.sm },
  actions: { gap: space.sm },
  apple: { height: heights.primaryButton, width: '100%' },
  code: { fontSize: 28, letterSpacing: 8, fontVariant: ['tabular-nums'] },
});
