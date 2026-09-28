import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ShieldCheck, Users } from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { api } from '@/api/client';
import { toApiError } from '@/api/errors';
import { PrimaryButton, TextButton } from '@/components/ui/buttons';
import { EmptyState, InlineStatus } from '@/components/ui/elements';
import { Card, NavHeader, Screen } from '@/components/ui/layout';
import { useAccount } from '@/features/account/account-provider';
import { useAuth } from '@/features/account/auth-provider';
import { useMe } from '@/features/data/hooks';
import { useSelectedLeague } from '@/features/leagues/selected-league';
import { formatCode } from '@/features/leagues/league-sheets';
import { pendingInvite } from '@/features/leagues/pending-invite';
import { Text } from '@/design/text';
import { colors, space } from '@/design/tokens';

const statusCopy: Record<string, { title: string; body: string }> = {
  not_found: { title: 'We couldn’t find that invite.', body: 'Check the code, or ask the league owner for a new link.' },
  expired: { title: 'This invite has expired.', body: 'Invites last 7 days. Ask the league owner for a new one.' },
  revoked: { title: 'This invite was turned off.', body: 'Ask the league owner for a new one.' },
  closed: { title: 'This league has closed.', body: 'You can start your own league from the League tab.' },
  full: { title: 'This league is full.', body: 'Leagues have up to 20 runners.' },
  unavailable: { title: 'This invite isn’t available.', body: 'You can start your own league from the League tab.' },
};

const joinErrorCopy: Record<string, string> = {
  invite_not_found: statusCopy.not_found!.title,
  invite_expired: statusCopy.expired!.title,
  invite_revoked: statusCopy.revoked!.title,
  league_closed: statusCopy.closed!.title,
  league_full: statusCopy.full!.title,
  invite_unavailable: statusCopy.unavailable!.title,
  league_limit: 'You’re in 5 leagues, the most at once. Leave one first (League › League options).',
  invites_paused: 'Joining is paused right now. Try again later.',
  rate_limited: 'Too many attempts. Wait a minute and try again.',
  network: 'You’re offline. Connect to join.',
};

/** S10 — minimal league preview, then an explicit join (never automatic). */
export default function InviteScreen() {
  const { code: raw, source } = useLocalSearchParams<{ code: string; source?: string }>();
  const code = (raw ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  const router = useRouter();
  const auth = useAuth();
  const { state } = useAccount();
  const me = useMe();
  const [, selectLeague] = useSelectedLeague();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const signedIn = auth.status === 'signed_in';
  const onboarded = signedIn && !!me.data?.data.profile;

  const preview = useQuery({
    queryKey: ['invite-preview', code, signedIn],
    enabled: code.length > 0 && api !== null,
    queryFn: () => api!.getInvitePreview(code),
    retry: false,
  });

  const leave = async () => {
    await pendingInvite.clear();
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };

  const join = async () => {
    if (!api) return;
    setBusy(true);
    setError(null);
    try {
      const joined = await api.joinLeague(code);
      if (joined.league) selectLeague(joined.league.id);
      if (state.status === 'ready') state.runtime.telemetry.track('league_joined', { source: source === 'code' ? 'code' : 'link' });
      await pendingInvite.clear();
      await queryClient.invalidateQueries();
      router.dismissTo('/league');
    } catch (e) {
      setError(joinErrorCopy[toApiError(e).code] ?? 'Couldn’t join. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const signInToJoin = async () => {
    await pendingInvite.set(code);
    router.dismissTo('/welcome');
  };

  const data = preview.data;
  const usable = data && (data.status === 'valid' || data.status === 'league_limit' || data.status === 'already_member');

  let footer: React.ReactNode = <TextButton label="Not now" onPress={leave} />;
  if (data?.status === 'valid') {
    footer = (
      <>
        {signedIn ? (
          <PrimaryButton label={onboarded ? `Join ${data.league_name}` : 'Finish your profile to join'} onPress={onboarded ? join : () => router.dismissTo('/')} loading={busy} testID="join-confirm" />
        ) : (
          <PrimaryButton label="Sign in to join" onPress={signInToJoin} testID="invite-sign-in" />
        )}
        <TextButton label="Not now" onPress={leave} />
      </>
    );
  } else if (data?.status === 'already_member') {
    footer = <PrimaryButton label="Open league" onPress={() => void pendingInvite.clear().then(() => router.dismissTo('/league'))} />;
  }

  return (
    <Screen edges={['top', 'bottom']} footer={footer}>
      <NavHeader title="League invite" onBack={leave} />
      {preview.isPending ? (
        <Text variant="body" tone="secondary">
          Checking invite {formatCode(code)}…
        </Text>
      ) : preview.isError ? (
        <InlineStatus tone="danger" title="Couldn’t check this invite." body="Check your connection and try again." action={<TextButton label="Try again" onPress={() => void preview.refetch()} />} />
      ) : data && usable ? (
        <Card style={styles.card}>
          <View style={styles.icon}>
            <Users size={30} color={colors.accent} />
          </View>
          <Text variant="eyebrow" tone="secondary">
            {data.kind === 'family' ? 'Family league' : data.kind === 'work' ? 'Work league' : 'Private league'}
          </Text>
          <Text variant="title" align="center">
            {data.league_name}
          </Text>
          <Text variant="body" tone="secondary">
            {data.member_count} of {data.capacity} runners
          </Text>
          {data.status === 'already_member' ? <InlineStatus tone="success" title="You’re already in this league." /> : null}
          {data.status === 'league_limit' ? (
            <InlineStatus tone="warning" title="You’re in 5 leagues, the most at once." body="Leave one first (League › League options) to join this one." />
          ) : null}
          <View style={styles.privacy}>
            <ShieldCheck size={18} color={colors.textSecondary} />
            <Text variant="label" tone="secondary" style={{ flex: 1 }}>
              Members see your runner name, tier and weekly XP — never your routes.
            </Text>
          </View>
        </Card>
      ) : data ? (
        <Card>
          <EmptyState title={statusCopy[data.status]?.title ?? 'This invite isn’t available.'} body={statusCopy[data.status]?.body} />
        </Card>
      ) : null}
      {error ? <InlineStatus tone="danger" title={error} /> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: { alignItems: 'center', gap: space.md },
  icon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.surfaceElevated,
    alignItems: 'center',
    justifyContent: 'center',
  },
  privacy: { flexDirection: 'row', gap: space.sm, alignItems: 'center', marginTop: space.sm },
});
