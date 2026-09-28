import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { UserPlus } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import { PrimaryButton, TextButton } from '@/components/ui/buttons';
import { InlineStatus } from '@/components/ui/elements';
import { Card, NavHeader, Screen } from '@/components/ui/layout';
import { useAccount } from '@/features/account/account-provider';
import { useAuth } from '@/features/account/auth-provider';
import { useMe } from '@/features/data/hooks';
import { pendingFollow } from '@/features/social/pending-follow';
import { useSocialActions } from '@/features/social/use-social';
import { Text } from '@/design/text';
import { colors, space } from '@/design/tokens';

/** A follow link (docs/ROADMAP.md 4.3): who it belongs to, then an explicit follow. */
export default function FollowLinkScreen() {
  const { code: raw } = useLocalSearchParams<{ code: string }>();
  const code = (raw ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  const router = useRouter();
  const auth = useAuth();
  const { api, state } = useAccount();
  const me = useMe();
  const actions = useSocialActions();
  const signedIn = auth.status === 'signed_in';
  const onboarded = signedIn && !!me.data?.data.profile;
  const accountId = state.status === 'ready' ? state.accountId : null;

  const link = useQuery({
    queryKey: [accountId, 'follow-link', code],
    enabled: onboarded && code.length > 0 && api !== null,
    queryFn: () => api!.getFollowLink(code),
    retry: false,
  });

  const leave = async () => {
    await pendingFollow.clear();
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };

  const follow = async () => {
    const result = await actions.followByCode(code);
    if (result) {
      await pendingFollow.clear();
      router.replace({ pathname: '/runner/[id]', params: { id: result.public_id } });
    }
  };

  const runner = link.data;
  const following = runner?.follow.following ?? 'none';

  return (
    <Screen
      edges={['top', 'bottom']}
      footer={
        <>
          {!signedIn ? (
            <PrimaryButton
              label="Sign in to follow"
              onPress={() => void pendingFollow.set(code).then(() => router.dismissTo('/welcome'))}
              testID="follow-sign-in"
            />
          ) : runner && following === 'none' ? (
            <PrimaryButton label={`Follow ${runner.alias}`} icon={UserPlus} onPress={() => void follow()} loading={actions.busy} testID="follow-confirm" />
          ) : runner ? (
            <PrimaryButton label="Open profile" onPress={() => void pendingFollow.clear().then(() => router.replace({ pathname: '/runner/[id]', params: { id: runner.public_id } }))} />
          ) : null}
          <TextButton label="Not now" onPress={() => void leave()} />
        </>
      }>
      <NavHeader title="Follow link" onBack={() => void leave()} />
      {!signedIn ? (
        <Text variant="body" tone="secondary">
          Sign in to PaceLeague to see who shared this link and follow them.
        </Text>
      ) : !onboarded ? (
        <Text variant="body" tone="secondary">
          Finish setting up your profile first.
        </Text>
      ) : link.isPending ? (
        <Text variant="label" tone="secondary">
          Checking the link…
        </Text>
      ) : runner ? (
        <Card style={styles.card}>
          <View style={styles.icon}>
            <UserPlus size={30} color={colors.accent} />
          </View>
          <Text variant="title" align="center">
            {runner.alias}
          </Text>
          <Text variant="body" tone="secondary">
            {runner.tier}
          </Text>
          {following === 'pending' ? <InlineStatus title="You’ve asked to follow them." body="They’ll see your request." /> : null}
          {following === 'accepted' ? <InlineStatus tone="success" title="You follow them." /> : null}
          <Text variant="caption" tone="secondary" align="center">
            Followers see only the runs {runner.alias} shares with followers. Some runners approve followers first.
          </Text>
        </Card>
      ) : (
        <InlineStatus title="This link doesn’t work any more." body="Ask the runner for their current link." />
      )}
      {actions.error ? <InlineStatus tone="danger" title={actions.error} /> : null}
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
});
