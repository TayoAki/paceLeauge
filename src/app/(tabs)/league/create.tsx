import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';

import { toApiError } from '@/api/errors';
import { PrimaryButton } from '@/components/ui/buttons';
import { TextField } from '@/components/ui/elements';
import { NavHeader, Screen } from '@/components/ui/layout';
import { LEAGUE_RULES } from '@/domain/config';
import { useAccount } from '@/features/account/account-provider';
import { Text } from '@/design/text';

const errorCopy: Record<string, string> = {
  league_name_invalid: `Use ${LEAGUE_RULES.nameMinLength}–${LEAGUE_RULES.nameMaxLength} letters, numbers or spaces.`,
  league_name_not_allowed: 'That name isn’t available. Try another.',
  already_in_league: 'You’re already in a league. Leave it first to start a new one.',
  rate_limited: 'You’ve created several leagues today. Try again tomorrow.',
  network: 'You’re offline. Connect to create a league.',
};

export default function CreateLeagueScreen() {
  const router = useRouter();
  const { api } = useAccount();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    if (!api) return;
    setBusy(true);
    setError(null);
    try {
      await api.createLeague(name);
      await queryClient.invalidateQueries();
      router.back();
    } catch (e) {
      setError(errorCopy[toApiError(e).code] ?? 'Couldn’t create the league. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen edges={['top', 'bottom']} footer={<PrimaryButton label="Create league" onPress={create} loading={busy} disabled={name.trim().length < LEAGUE_RULES.nameMinLength} testID="create-league-submit" />}>
      <NavHeader title="New league" />
      <Text variant="body" tone="secondary">
        A private league for up to {LEAGUE_RULES.capacity} people. Members see each other’s runner names, tiers and weekly XP — never routes.
      </Text>
      <TextField
        label="League name"
        value={name}
        onChangeText={(t) => setName(t.slice(0, LEAGUE_RULES.nameMaxLength))}
        placeholder="Friday Crew"
        maxLength={LEAGUE_RULES.nameMaxLength}
        autoCapitalize="words"
        error={error}
        testID="league-name-input"
      />
    </Screen>
  );
}
