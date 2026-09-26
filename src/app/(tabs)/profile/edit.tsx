import { useQueryClient } from '@tanstack/react-query';
import { getCalendars } from 'expo-localization';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform } from 'react-native';

import { toApiError } from '@/api/errors';
import type { Profile } from '@/api/schemas';
import { PrimaryButton, SecondaryButton } from '@/components/ui/buttons';
import { InlineStatus } from '@/components/ui/elements';
import { NavHeader, Screen } from '@/components/ui/layout';
import { PROFILE_RULES } from '@/domain/config';
import { useAccount } from '@/features/account/account-provider';
import { aliasError, ProfileForm, type ProfileDraft } from '@/features/account/profile-form';
import { useMe } from '@/features/data/hooks';
import { colors } from '@/design/tokens';

function draftFrom(profile: Profile): ProfileDraft {
  return { alias: profile.alias, units: profile.units, goalDays: profile.goal_days, ackEligibility: true };
}

function saveFailure(code: string): string {
  switch (code) {
    case 'network':
      return 'You’re offline. Connect to save your changes.';
    case 'timeout':
      return 'The connection timed out. Try again.';
    case 'rate_limited':
      return 'You’ve changed your runner name a lot today. Try again tomorrow.';
    case 'account_deleting':
      return 'Your account is being deleted, so it can’t be changed.';
    case 'auth_expired':
    case 'not_authenticated':
      return 'You’re signed out. Sign in again to save your changes.';
    default:
      return 'Couldn’t save your profile. Try again.';
  }
}

/** Runner name, units and optional weekly goal (eligibility was acknowledged at sign-up). */
export default function EditProfileScreen() {
  const router = useRouter();
  const { api } = useAccount();
  const queryClient = useQueryClient();
  const me = useMe();
  const profile = me.data?.data.profile ?? null;
  const [edited, setEdited] = useState<ProfileDraft | null>(null);
  const [aliasCode, setAliasCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!profile) {
    return (
      <Screen edges={['top', 'bottom']}>
        <NavHeader title="Edit profile" />
        {me.isPending ? (
          <ActivityIndicator color={colors.textSecondary} accessibilityLabel="Loading your profile" />
        ) : (
          <>
            <InlineStatus tone="danger" title="Couldn’t load your profile." body="Check your connection and try again." />
            <SecondaryButton label="Try again" onPress={() => void me.refetch()} />
          </>
        )}
      </Screen>
    );
  }

  const draft = edited ?? draftFrom(profile);
  const changed = draft.alias.trim() !== profile.alias || draft.units !== profile.units || draft.goalDays !== profile.goal_days;
  const valid = draft.alias.trim().length >= PROFILE_RULES.aliasMinLength;

  const onChange = (next: ProfileDraft) => {
    if (next.alias !== draft.alias) setAliasCode(null);
    setEdited(next);
  };

  const save = async () => {
    if (!api) return;
    setBusy(true);
    setError(null);
    setAliasCode(null);
    try {
      await api.saveProfile({
        alias: draft.alias,
        units: draft.units,
        goalDays: draft.goalDays,
        notificationTz: profile.notification_tz ?? getCalendars()[0]?.timeZone ?? null,
        ackEligibility: false,
      });
      await queryClient.invalidateQueries();
      router.back();
    } catch (e) {
      const code = toApiError(e).code;
      if (aliasError(code)) setAliasCode(code);
      else setError(saveFailure(code));
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Screen
        edges={['top', 'bottom']}
        footer={<PrimaryButton label="Save" onPress={() => void save()} disabled={!changed || !valid} loading={busy} testID="profile-save" />}>
        <NavHeader title="Edit profile" />
        {error ? <InlineStatus tone="danger" title={error} /> : null}
        <ProfileForm draft={draft} onChange={onChange} initialAlias={profile.alias} serverError={aliasError(aliasCode)} showEligibility={false} />
      </Screen>
    </KeyboardAvoidingView>
  );
}
