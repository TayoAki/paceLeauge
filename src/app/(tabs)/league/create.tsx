import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';

import { toApiError } from '@/api/errors';
import type { LeagueKind } from '@/api/schemas';
import { PrimaryButton } from '@/components/ui/buttons';
import { ChoiceChips, TextField } from '@/components/ui/elements';
import { NavHeader, Screen } from '@/components/ui/layout';
import { LEAGUE_RULES } from '@/domain/config';
import { useAccount } from '@/features/account/account-provider';
import { useMe } from '@/features/data/hooks';
import { useSelectedLeague } from '@/features/leagues/selected-league';
import { Text } from '@/design/text';

const errorCopy: Record<string, string> = {
  league_name_invalid: `Use ${LEAGUE_RULES.nameMinLength}–${LEAGUE_RULES.nameMaxLength} letters, numbers or spaces.`,
  league_name_not_allowed: 'That name isn’t available. Try another.',
  league_limit: 'You’re in 5 leagues, the most at once. Leave one first (League › League options).',
  rate_limited: 'You’ve created several leagues today. Try again tomorrow.',
  network: 'You’re offline. Connect to create a league.',
};

const KINDS: { value: LeagueKind; label: string; about: string; placeholder: string }[] = [
  { value: 'friends', label: 'Friends', about: 'A crew of friends. Best three days each week, and a champion every four weeks.', placeholder: 'Friday Crew' },
  { value: 'family', label: 'Family', about: 'For your family. Best three days each week, and a champion every four weeks.', placeholder: 'The Rivera family' },
  { value: 'work', label: 'Work', about: 'For colleagues. Only runner names, tiers and weekly XP are shared, never routes.', placeholder: 'Office Striders' },
];

/** A new league from a template (docs/ROADMAP.md 4.1). */
export default function CreateLeagueScreen() {
  const router = useRouter();
  const { api } = useAccount();
  const queryClient = useQueryClient();
  const [, selectLeague] = useSelectedLeague();
  const [kind, setKind] = useState<LeagueKind>('friends');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const template = KINDS.find((k) => k.value === kind) ?? KINDS[0]!;
  // Teen accounts (docs/ROADMAP.md 4.10) aren't mentioned until they're switched on.
  const teenAccounts = useMe().data?.data.config.teen_accounts_enabled ?? false;
  const about = kind === 'family' && teenAccounts ? 'For your family. Teens can join with a parent’s or guardian’s consent.' : template.about;

  const create = async () => {
    if (!api) return;
    setBusy(true);
    setError(null);
    try {
      const view = await api.createLeague(name, kind);
      if (view.league) selectLeague(view.league.id);
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
        A private league for up to {LEAGUE_RULES.capacity} people. Members see each other’s runner names, tiers and weekly XP — never routes. You can be in up to 5 leagues.
      </Text>
      <ChoiceChips<LeagueKind> label="Kind of league" value={kind} onChange={setKind} options={KINDS.map((k) => ({ value: k.value, label: k.label }))} />
      <Text variant="caption" tone="secondary">
        {about}
      </Text>
      <TextField
        label="League name"
        value={name}
        onChangeText={(t) => setName(t.slice(0, LEAGUE_RULES.nameMaxLength))}
        placeholder={template.placeholder}
        maxLength={LEAGUE_RULES.nameMaxLength}
        autoCapitalize="words"
        error={error}
        testID="league-name-input"
      />
    </Screen>
  );
}
