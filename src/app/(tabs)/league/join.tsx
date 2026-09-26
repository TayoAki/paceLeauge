import { useRouter } from 'expo-router';
import { useState } from 'react';

import { PrimaryButton } from '@/components/ui/buttons';
import { TextField } from '@/components/ui/elements';
import { NavHeader, Screen } from '@/components/ui/layout';
import { Text } from '@/design/text';

function normalize(code: string): string {
  return code.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 8);
}

/** Join with code → the invite preview, where joining is an explicit choice. */
export default function JoinWithCodeScreen() {
  const router = useRouter();
  const [code, setCode] = useState('');
  const clean = normalize(code);
  return (
    <Screen
      edges={['top', 'bottom']}
      footer={
        <PrimaryButton
          label="Continue"
          disabled={clean.length !== 8}
          onPress={() => router.push({ pathname: '/invite/[code]', params: { code: clean, source: 'code' } })}
          testID="join-code-continue"
        />
      }>
      <NavHeader title="Join with code" />
      <Text variant="body" tone="secondary">
        Enter the 8-character code from the league owner. You’ll see the league before you join.
      </Text>
      <TextField
        label="Invite code"
        value={code}
        onChangeText={setCode}
        autoCapitalize="characters"
        autoCorrect={false}
        placeholder="ABCD-EFGH"
        maxLength={9}
        style={{ fontSize: 24, letterSpacing: 4 }}
        testID="join-code-input"
      />
    </Screen>
  );
}
