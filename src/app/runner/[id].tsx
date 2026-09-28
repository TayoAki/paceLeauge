import { useLocalSearchParams, useRouter } from 'expo-router';
import { BellOff, Ban, Flag, UserCheck, UserPlus } from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ReportSheet } from '@/components/social/report-sheet';
import { SharedRunCard } from '@/components/social/shared-run-card';
import { PrimaryButton, SecondaryButton, TextButton } from '@/components/ui/buttons';
import { ConfirmSheet } from '@/components/ui/confirm-sheet';
import { EmptyState, InlineStatus } from '@/components/ui/elements';
import { Card, NavHeader, Screen } from '@/components/ui/layout';
import { useMe } from '@/features/data/hooks';
import { useRunnerProfile, useSocialActions } from '@/features/social/use-social';
import { Text } from '@/design/text';
import { space } from '@/design/tokens';

/** A runner's profile (docs/ROADMAP.md 4.3): who they are, following them, and the runs they share with you. */
export default function RunnerScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const units = useMe().data?.data.profile?.units ?? 'metric';
  const profile = useRunnerProfile(id ?? null);
  const actions = useSocialActions();
  const [sheet, setSheet] = useState<'unfollow' | 'block' | 'report' | null>(null);
  const data = profile.data?.data;

  if (!data) {
    return (
      <Screen edges={['top', 'bottom']}>
        <NavHeader title="Runner" />
        {profile.isError ? (
          <InlineStatus title="This runner isn’t available." body="They may have left PaceLeague." />
        ) : (
          <Text variant="label" tone="secondary">
            Loading…
          </Text>
        )}
      </Screen>
    );
  }

  const follow = data.follow;
  const publicId = data.public_id;

  return (
    <Screen edges={['top', 'bottom']}>
      <NavHeader title={data.is_me ? 'Your profile' : 'Runner'} />
      <View style={styles.head}>
        <Text variant="title">{data.alias}</Text>
        <Text variant="label" tone="secondary">
          {data.tier} · {data.followers} {data.followers === 1 ? 'follower' : 'followers'} · following {data.following}
        </Text>
      </View>

      {actions.error ? <InlineStatus tone="danger" title={actions.error} /> : null}

      {data.is_me ? (
        <Text variant="body" tone="secondary">
          This is how other runners see your profile. They see only the runs you share with them.
        </Text>
      ) : (
        <>
          {follow.follows_me === 'pending' ? (
            <InlineStatus
              title={`${data.alias} asked to follow you.`}
              action={
                <View style={styles.row}>
                  <TextButton label="Accept" onPress={() => void actions.respond(publicId, true)} />
                  <TextButton label="Decline" onPress={() => void actions.respond(publicId, false)} />
                </View>
              }
            />
          ) : null}
          {follow.following === 'accepted' ? (
            <SecondaryButton label="Following" icon={UserCheck} onPress={() => setSheet('unfollow')} testID="runner-following" />
          ) : follow.following === 'pending' ? (
            <SecondaryButton label="Requested · tap to cancel" onPress={() => void actions.unfollow(publicId)} loading={actions.busy} testID="runner-requested" />
          ) : (
            <PrimaryButton label="Follow" icon={UserPlus} onPress={() => void actions.follow(publicId)} loading={actions.busy} testID="runner-follow" />
          )}
          {follow.following === 'pending' ? (
            <Text variant="caption" tone="secondary">
              {data.alias} approves followers. You’ll see their shared runs once they accept.
            </Text>
          ) : null}
        </>
      )}

      <Text variant="section">Runs</Text>
      {data.runs.length === 0 ? (
        <Card>
          <EmptyState
            title="No runs to show."
            body={data.is_me ? 'Runs you share with followers or everyone appear here.' : `${data.alias} hasn’t shared any runs with you.`}
          />
        </Card>
      ) : (
        data.runs.map((run) => (
          <SharedRunCard key={run.run_id} run={run} units={units} showOwner={false} showMap={false} onPress={() => router.push({ pathname: '/shared/[id]', params: { id: run.run_id } })} />
        ))
      )}

      {!data.is_me ? (
        <View style={styles.menu}>
          <TextButton
            label={follow.muted ? 'Unmute' : 'Mute'}
            icon={BellOff}
            onPress={() => void actions.mute(publicId, !follow.muted)}
            accessibilityHint="Muted runners’ runs stay out of your feed. They aren’t told."
          />
          <TextButton label="Report" icon={Flag} onPress={() => setSheet('report')} testID="runner-report" />
          <TextButton label="Block" icon={Ban} onPress={() => setSheet('block')} testID="runner-block" />
        </View>
      ) : null}
      <ReportSheet
        target={sheet === 'report' ? { kind: 'runner', id: publicId, owner: { public_id: publicId, alias: data.alias } } : null}
        onClose={() => setSheet(null)}
        onBlocked={() => router.back()}
      />

      <ConfirmSheet
        visible={sheet === 'unfollow'}
        title={`Unfollow ${data.alias}?`}
        body="Their shared runs leave your feed. They aren’t told."
        confirmLabel="Unfollow"
        busy={actions.busy}
        onConfirm={() => void actions.unfollow(publicId).then(() => setSheet(null))}
        onCancel={() => setSheet(null)}
      />
      <ConfirmSheet
        visible={sheet === 'block'}
        title={`Block ${data.alias}?`}
        body="You won’t see each other anywhere in PaceLeague, and follows between you end. They aren’t told. You can unblock them in Profile › Privacy."
        confirmLabel="Block"
        destructive
        busy={actions.busy}
        onConfirm={() =>
          void actions.block(publicId).then(() => {
            setSheet(null);
            router.back();
          })
        }
        onCancel={() => setSheet(null)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { gap: space.xs },
  row: { flexDirection: 'row', gap: space.lg },
  menu: { flexDirection: 'row', flexWrap: 'wrap', gap: space.lg, justifyContent: 'center' },
});
