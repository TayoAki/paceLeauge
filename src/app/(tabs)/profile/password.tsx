import { useRouter } from 'expo-router';
import { useState } from 'react';
import { AccessibilityInfo, KeyboardAvoidingView, Platform } from 'react-native';

import { PrimaryButton, TextButton } from '@/components/ui/buttons';
import { InlineStatus, TextField } from '@/components/ui/elements';
import { NavHeader, Screen } from '@/components/ui/layout';
import { AuthError, changePassword, PASSWORD_MIN_LENGTH } from '@/features/account/auth-actions';
import { useAuth } from '@/features/account/auth-provider';
import { Text } from '@/design/text';

/** Change password (Profile → Privacy). Needs a recent sign-in; other devices are signed out. */
export default function PasswordScreen() {
  const router = useRouter();
  const auth = useAuth();
  const email = auth.status === 'signed_in' ? auth.email : null;
  const [password, setPassword] = useState('');
  const [reveal, setReveal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsConfirm, setNeedsConfirm] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setError(null);
    setNeedsConfirm(false);
    setSaved(false);
    setBusy(true);
    try {
      await changePassword(password);
      setPassword('');
      setSaved(true);
      AccessibilityInfo.announceForAccessibility('Password changed.');
    } catch (e) {
      if (e instanceof AuthError && e.code === 'reauth_needed') {
        setNeedsConfirm(true);
        router.push('/reauth?next=password');
      } else {
        setError(e instanceof AuthError ? e.message : 'Couldn’t change your password. Try again.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Screen
        edges={['top', 'bottom']}
        footer={<PrimaryButton label="Save password" onPress={() => void save()} loading={busy} disabled={password.length === 0} testID="password-save" />}>
        <NavHeader title="Change password" />
        <Text variant="body" tone="secondary">
          {email ? `Choose a new password for ${email}.` : 'Choose a new password.'} Other devices signed in to your account will be signed out.
        </Text>
        <TextField
          label="New password"
          value={password}
          onChangeText={(value) => {
            setPassword(value);
            setSaved(false);
          }}
          secureTextEntry={!reveal}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="new-password"
          textContentType="newPassword"
          passwordRules={`minlength: ${PASSWORD_MIN_LENGTH};`}
          returnKeyType="done"
          onSubmitEditing={() => void save()}
          error={error}
          hint={`At least ${PASSWORD_MIN_LENGTH} characters. A short phrase is easy to remember.`}
          testID="new-password"
        />
        <TextButton label={reveal ? 'Hide password' : 'Show password'} onPress={() => setReveal((r) => !r)} style={{ alignSelf: 'flex-start', paddingHorizontal: 0 }} />
        {needsConfirm ? <InlineStatus title="Confirm it’s you to change your password." body="After you confirm, tap Save password again." /> : null}
        {saved ? <InlineStatus tone="success" title="Password changed." body="Use your new password the next time you sign in." /> : null}
      </Screen>
    </KeyboardAvoidingView>
  );
}
