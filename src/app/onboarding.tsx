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
import { checkAge, devicePort, needsAgeCopy, type AgeCheck } from '@/features/account/age-check';
import { aliasError, ProfileForm, type ProfileDraft } from '@/features/account/profile-form';
import { Text } from '@/design/text';

/** S02 — alias, units, adult-pilot acknowledgement and optional weekly goal. */
export default function OnboardingScreen() {
  const { api, state, signOut } = useAccount();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<ProfileDraft>(() => ({
    alias: '',
    units: defaultUnitsForRegion(getLocales()[0]?.regionCode),
    goalDays: 3,
    ackEligibility: false,
  }));
  const [error, setError] = useState<string | null>(null);
  const [aliasCode, setAliasCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ageBlock, setAgeBlock] = useState<Exclude<AgeCheck, { outcome: 'allowed' }> | null>(null);

  useEffect(() => {
    if (state.status === 'ready') state.runtime.telemetry.track('account_created');
  }, [state]);

  const canContinue = draft.alias.trim().length >= 2 && draft.ackEligibility && !busy;

  const save = async () => {
    if (!api) return;
    setBusy(true);
    setError(null);
    setAliasCode(null);
    setAgeBlock(null);
    try {
      // Age assurance first: the App Store or Google Play may ask the runner to share their age range.
      const age = await checkAge(devicePort, 'sign_up');
      if (age.outcome !== 'allowed') {
        setAgeBlock(age);
        return;
      }
      await api.saveProfile({
        alias: draft.alias,
        units: draft.units,
        goalDays: draft.goalDays,
        notificationTz: getCalendars()[0]?.timeZone ?? null,
        ackEligibility: draft.ackEligibility,
        ageSignal: age.signal,
        ageSource: age.source,
      });
      await queryClient.invalidateQueries();
    } catch (e) {
      const code = toApiError(e).code;
      if (aliasError(code)) setAliasCode(code);
      else if (code === 'age_restricted') setAgeBlock({ outcome: 'minor', source: 'server' });
      else setError(code === 'network' ? 'You’re offline. Connect to finish setting up.' : 'Couldn’t save your profile. Try again.');
    } finally {
      setBusy(false);
    }
  };

  if (ageBlock?.outcome === 'minor') {
    return (
      <AppMessage
        title="PaceLeague is for adults"
        body="The App Store or Google Play says you’re under 18, so we can’t create a runner profile for you. Nothing was saved beyond your sign-in.">
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
