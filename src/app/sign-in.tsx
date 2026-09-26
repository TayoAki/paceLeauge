import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, TextInput, View } from 'react-native';

import { PrimaryButton, TextButton } from '@/components/ui/buttons';
import { TextField } from '@/components/ui/elements';
import { NavHeader, Screen } from '@/components/ui/layout';
import { AuthError, EMAIL_PATTERN, sendEmailCode, verifyEmailCode } from '@/features/account/auth-actions';
import { Text } from '@/design/text';
import { space } from '@/design/tokens';

const RESEND_SECONDS = 60;

/** Email one-time code sign-in (part of S01). */
export default function SignInScreen() {
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const codeRef = useRef<TextInput>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const send = async () => {
    setError(null);
    if (!EMAIL_PATTERN.test(email.trim())) {
      setError('Enter a valid email address.');
      return;
    }
    setBusy(true);
    try {
      await sendEmailCode(email);
      setStep('code');
      setCooldown(RESEND_SECONDS);
      setTimeout(() => codeRef.current?.focus(), 250);
    } catch (e) {
      setError(e instanceof AuthError ? e.message : 'Could not send the code.');
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    setError(null);
    setBusy(true);
    try {
      await verifyEmailCode(email, code);
      // The root navigator moves on as soon as the session exists.
    } catch (e) {
      setError(e instanceof AuthError ? e.message : 'Could not verify the code.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Screen
        edges={['top', 'bottom']}
        footer={
          step === 'email' ? (
            <PrimaryButton label="Send code" onPress={send} loading={busy} testID="send-code" />
          ) : (
            <View style={{ gap: space.sm }}>
              <PrimaryButton label="Verify and continue" onPress={verify} loading={busy} disabled={code.replace(/\D/g, '').length !== 6} testID="verify-code" />
              <TextButton
                label={cooldown > 0 ? `Send a new code in ${cooldown}s` : 'Send a new code'}
                disabled={cooldown > 0 || busy}
                onPress={send}
              />
            </View>
          )
        }>
        <NavHeader title="Continue with email" onBack={step === 'code' ? () => setStep('email') : undefined} />
        {step === 'email' ? (
          <>
            <Text variant="body" tone="secondary">
              We’ll email you a 6-digit code. No password needed.
            </Text>
            <TextField
              label="Email"
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              autoComplete="email"
              keyboardType="email-address"
              textContentType="emailAddress"
              returnKeyType="send"
              onSubmitEditing={send}
              error={error}
              testID="email-input"
            />
          </>
        ) : (
          <>
            <Text variant="body" tone="secondary">
              Enter the code we sent to {email.trim().toLowerCase()}. It expires in 10 minutes.
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
              style={{ fontSize: 28, letterSpacing: 8, fontVariant: ['tabular-nums'] }}
              testID="code-input"
            />
          </>
        )}
      </Screen>
    </KeyboardAvoidingView>
  );
}
