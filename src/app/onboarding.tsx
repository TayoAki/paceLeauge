import { useQueryClient } from '@tanstack/react-query';
import { getCalendars, getLocales } from 'expo-localization';
import { useEffect, useState } from 'react';

import { toApiError } from '@/api/errors';
import { PrimaryButton, TextButton } from '@/components/ui/buttons';
import { AppMessage } from '@/components/ui/app-states';
import { InlineStatus } from '@/components/ui/elements';
import { Screen } from '@/components/ui/layout';
import { defaultUnitsForRegion } from '@/domain/format';
import { useAccount } from '@/features/account/account-provider';
import { useMe } from '@/features/data/hooks';
import { checkAge, devicePort, needsAgeCopy, type AgeCheck } from '@/features/account/age-check';
import { aliasError, ProfileForm, type ProfileDraft } from '@/features/account/profile-form';
import { Text } from '@/design/text';

/** S02 — alias, units, adult-pilot acknowledgement and optional weekly goal. */
export default function OnboardingScreen() {
  const { api, state, signOut } = useAccount();
  const queryClient = useQueryClient();
  const teenAccounts = useMe().data?.data.config.teen_accounts_enabled ?? false;
  const [draft, setDraft] = useState<ProfileDraft>(() => ({
    alias: '',
    units: defaultUnitsForRegion(getLocales()[0]?.regionCode),
    goalDays: 3,
    ackEligibility: false,
  }));
  const [error, setError] = useState<string | null>(null);
  const [aliasCode, setAliasCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ageBlock, setAgeBlock] = useState<Extract<AgeCheck, { outcome: 'minor' | 'needs_age' }> | null>(null);
  // 13–17: a teen account (docs/ROADMAP.md 4.10), once they've read what it means.
  const [teen, setTeen] = useState<Extract<AgeCheck, { outcome: 'teen' }> | null>(null);

  useEffect(() => {
    if (state.status === 'ready') state.runtime.telemetry.track('account_created');
  }, [state]);

  const canContinue = draft.alias.trim().length >= 2 && draft.ackEligibility && !busy;

  const create = async (ageSignal: 'adult' | 'not_required' | 'teen_13_15' | 'teen_16_17', ageSource: string) => {
    if (!api) return;
    await api.saveProfile({
      alias: draft.alias,
      units: draft.units,
      goalDays: draft.goalDays,
      notificationTz: getCalendars()[0]?.timeZone ?? null,
      ackEligibility: true,
      ageSignal,
      ageSource,
    });
    await queryClient.invalidateQueries();
  };

  const attempt = async (task: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setAliasCode(null);
    setAgeBlock(null);
    try {
      await task();
    } catch (e) {
      const code = toApiError(e).code;
      if (aliasError(code)) {
        setTeen(null);
        setAliasCode(code);
      } else if (code === 'age_restricted') setAgeBlock({ outcome: 'minor', source: 'server' });
      else setError(code === 'network' ? 'You’re offline. Connect to finish setting up.' : 'Couldn’t save your profile. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    attempt(async () => {
      // Age assurance first: the App Store or Google Play may ask the runner to share their age range.
      const age = await checkAge(devicePort, 'sign_up');
      if (age.outcome === 'teen') {
        // Teen accounts are off until counsel's review: under 18 is turned away, as in the beta.
        if (teenAccounts) setTeen(age);
        else setAgeBlock({ outcome: 'minor', source: age.source });
        return;
      }
      if (age.outcome !== 'allowed') {
        setAgeBlock(age);
        return;
      }
      await create(age.signal, age.source);
    });

  if (ageBlock?.outcome === 'minor') {
    return (
      <AppMessage
        title={teenAccounts ? 'PaceLeague is for 13 and up' : 'PaceLeague is for adults'}
        body={`The App Store or Google Play says you’re under ${teenAccounts ? 13 : 18}, so we can’t create a runner profile for you. Nothing was saved beyond your sign-in.`}>
        <TextButton label="Sign out" onPress={() => void signOut()} />
      </AppMessage>
    );
  }
  if (teen) {
    return (
      <AppMessage
        title="A teen account"
        body={`The App Store or Google Play says you’re 13 to 17. You can record and track your own runs, and join your family’s league once the parent or guardian who runs it approves you. Feeds, clubs, public boards and sharing outside your family stay off.${
          teen.signal === 'teen_13_15' ? ' Heart rate and health data stay off until you’re 16.' : ''
        }`}
        actionLabel="Continue"
        onAction={() => void attempt(() => create(teen.signal, teen.source))}>
        {error ? <InlineStatus tone="danger" title={error} /> : null}
        <TextButton label="Sign out" onPress={() => void signOut()} />
      </AppMessage>
    );
  }
  const ageCopy = ageBlock?.outcome === 'needs_age' ? needsAgeCopy(ageBlock.reason) : null;

  return (
    <Screen
      edges={['top', 'bottom']}
      footer={
        <>
          <PrimaryButton label="Continue" onPress={save} disabled={!canContinue} loading={busy} testID="onboarding-continue" />
          <TextButton label="Cancel and sign out" onPress={() => void signOut()} />
        </>
      }>
      <Text variant="title" accessibilityRole="header">
        Set up your runner profile
      </Text>
      <Text variant="body" tone="secondary">
        Your league sees your runner name, tier and weekly XP. Your routes stay private.
      </Text>
      {error ? <InlineStatus tone="danger" title={error} /> : null}
      {ageCopy ? <InlineStatus tone="warning" title={ageCopy.title} body={`${ageCopy.body.replace('Check again', 'Continue')}`} /> : null}
      <ProfileForm draft={draft} onChange={setDraft} serverError={aliasError(aliasCode)} showEligibility />
    </Screen>
  );
}
