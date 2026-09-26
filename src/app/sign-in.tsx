import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, TextInput, View } from 'react-native';

import { PrimaryButton, TextButton } from '@/components/ui/buttons';
import { InlineStatus, SegmentedControl, TextField } from '@/components/ui/elements';
import { NavHeader, Screen } from '@/components/ui/layout';
import { env } from '@/config/env';
import {
  AuthError,
  EMAIL_PATTERN,
  PASSWORD_MIN_LENGTH,
  sendEmailCode,
  signInWithPassword,
  signUpWithPassword,
  verifyEmailCode,
} from '@/features/account/auth-actions';
import { Text } from '@/design/text';
import { space } from '@/design/tokens';

const RESEND_SECONDS = 60;

/** Email sign-in (part of S01): email and password during the beta, or an emailed one-time code. */
export default function SignInScreen() {
  return env.emailSignIn === 'code' ? <CodeSignIn /> : <PasswordSignIn />;
}

type Mode = 'create' | 'sign_in';

const MODES: { value: Mode; label: string }[] = [
  { value: 'create', label: 'Create account' },
  { value: 'sign_in', label: 'Sign in' },
];

const FORGOT = env.supportEmail
  ? `Email ${env.supportEmail} from the address you signed up with, and we’ll send you a temporary password. You can change it in Profile.`
  : 'Contact the person who invited you to the beta, and they’ll arrange a temporary password. You can change it in Profile.';

function PasswordSignIn() {
  const [mode, setMode] = useState<Mode>('create');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [reveal, setReveal] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [forgot, setForgot] = useState(false);
  const [busy, setBusy] = useState(false);
  const passwordRef = useRef<TextInput>(null);
  const creating = mode === 'create';

  const switchMode = (next: Mode) => {
    setMode(next);
    setEmailError(null);
    setPasswordError(null);
    setFormError(null);
    setForgot(false);
  };

  const submit = async () => {
    setEmailError(null);
    setPasswordError(null);
    setFormError(null);
    if (!EMAIL_PATTERN.test(email.trim())) {
      setEmailError('Enter a valid email address.');
      return;
    }
    setBusy(true);
    try {
      await (creating ? signUpWithPassword(email, password) : signInWithPassword(email, password));
      // The root navigator moves on as soon as the session exists.
    } catch (e) {
      const error = e instanceof AuthError ? e : new AuthError('unknown', 'Something went wrong. Please try again.');
      if (error.code === 'invalid_email' || error.code === 'account_exists') setEmailError(error.message);
      else if (error.code === 'weak_password' || error.code === 'invalid_credentials') setPasswordError(error.message);
      else setFormError(error.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Screen
        edges={['top', 'bottom']}
        footer={
          <View style={{ gap: space.sm }}>
            <PrimaryButton label={creating ? 'Create account' : 'Sign in'} onPress={() => void submit()} loading={busy} testID="password-submit" />
            {creating ? null : <TextButton label="Forgot password?" onPress={() => setForgot(true)} testID="forgot-password" />}
          </View>
        }>
        <NavHeader title="Continue with email" />
        <SegmentedControl label="Account" options={MODES} value={mode} onChange={switchMode} />
        <Text variant="body" tone="secondary">
          {creating ? 'Create your account with your email and a password.' : 'Welcome back. Sign in with your email and password.'}
        </Text>
        <TextField
          label="Email"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="email"
          keyboardType="email-address"
          textContentType="username"
          returnKeyType="next"
          onSubmitEditing={() => passwordRef.current?.focus()}
          error={emailError}
          testID="email-input"
        />
        <TextField
          ref={passwordRef}
          label="Password"
          value={password}
          onChangeText={setPassword}
          secureTextEntry={!reveal}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete={creating ? 'new-password' : 'current-password'}
          textContentType={creating ? 'newPassword' : 'password'}
          passwordRules={`minlength: ${PASSWORD_MIN_LENGTH};`}
          returnKeyType="go"
          onSubmitEditing={() => void submit()}
          error={passwordError}
          hint={creating ? `At least ${PASSWORD_MIN_LENGTH} characters. A short phrase is easy to remember.` : undefined}
          testID="password-input"
        />
        <TextButton label={reveal ? 'Hide password' : 'Show password'} onPress={() => setReveal((r) => !r)} style={{ alignSelf: 'flex-start', paddingHorizontal: 0 }} />
        {formError ? <InlineStatus tone="danger" title={formError} /> : null}
        {forgot && !creating ? <InlineStatus title="Forgot your password?" body={FORGOT} /> : null}
      </Screen>
    </KeyboardAvoidingView>
  );
}

function CodeSignIn() {
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
