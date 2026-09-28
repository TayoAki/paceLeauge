import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { RefreshCw, Unlink } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, RefreshControl, StyleSheet } from 'react-native';

import { toApiError } from '@/api/errors';
import type { StravaStatus } from '@/api/schemas';
import { TextButton } from '@/components/ui/buttons';
import { ConfirmSheet } from '@/components/ui/confirm-sheet';
import { InlineStatus, RowGroup, SwitchRow } from '@/components/ui/elements';
import { Card, NavHeader, Screen } from '@/components/ui/layout';
import { useAccountServices } from '@/features/account/account-provider';
import { useStravaStatus } from '@/features/data/hooks';
import { STRAVA_OUTCOME, STRAVA_RETURN_PATH, stravaOutcome } from '@/features/strava/strava';
import { Text } from '@/design/text';
import { colors, radius, space } from '@/design/tokens';

/** Strava's brand orange, for its "Connect with Strava" button only. */
const STRAVA_ORANGE = '#FC5200';

/** Connections (docs/ROADMAP.md 2.3): post runs to Strava. Nothing is read back from Strava. */
export default function ConnectionsScreen() {
  const { api } = useAccountServices();
  const status = useStravaStatus();
  const [outcome, setOutcome] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const data = status.data?.data;

  const run = async (task: (client: NonNullable<typeof api>) => Promise<StravaStatus | void>) => {
    if (!api) return setError('You’re signed out. Sign in again to change connections.');
    setBusy(true);
    setError(null);
    try {
      await task(api);
    } catch (e) {
      const code = toApiError(e).code;
      setError(code === 'network' || code === 'timeout' ? 'You’re offline. Try again when you’re connected.' : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
      void status.refetch();
    }
  };

  const connect = () =>
    run(async (client) => {
      setOutcome(null);
      const returnTo = Linking.createURL(STRAVA_RETURN_PATH);
      const url = await client.startStravaConnect(returnTo);
      const result = await WebBrowser.openAuthSessionAsync(url, returnTo);
      if (result.type === 'success') setOutcome(stravaOutcome(result.url));
    });

  return (
    <Screen
      edges={['top', 'bottom']}
      refreshControl={<RefreshControl refreshing={status.isFetching && !status.isPending} onRefresh={() => void status.refetch()} tintColor={colors.textSecondary} />}>
      <NavHeader title="Connections" />
      {outcome ? <InlineStatus tone={STRAVA_OUTCOME[outcome]!.tone} title={STRAVA_OUTCOME[outcome]!.title} /> : null}
      {error ? <InlineStatus tone="danger" title={error} /> : null}
      {status.isError && !data ? <InlineStatus tone="danger" title="Couldn’t load your connections." body="Pull to try again." /> : null}

      <Card>
        <Text variant="section" accessibilityRole="header">
          Strava
        </Text>
        {data && !data.available ? (
          <Text variant="body" tone="secondary">
            Posting to Strava isn’t set up on this server yet.
          </Text>
        ) : data && !data.connected ? (
          <>
            <Text variant="body" tone="secondary">
              Post each run you record with PaceLeague to your Strava account, with its route. Your Strava privacy settings decide who sees it there.
            </Text>
            <Text variant="body" tone="secondary">
              Nothing comes back from Strava into PaceLeague, and your league never sees your Strava account.
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Connect with Strava"
              accessibilityState={{ disabled: busy, busy }}
              disabled={busy}
              onPress={() => void connect()}
              style={({ pressed }) => [styles.strava, (pressed || busy) && { opacity: 0.8 }]}
              testID="connect-strava">
              <Text variant="bodyStrong" style={styles.stravaLabel}>
                Connect with Strava
              </Text>
            </Pressable>
          </>
        ) : data ? (
          <>
            <Text variant="body" testID="strava-connected">
              Connected{data.athlete_name ? ` as ${data.athlete_name}` : ''}.
            </Text>
            <Text variant="label" tone="secondary">
              {data.posted} posted{data.pending ? ` · ${data.pending} waiting` : ''}
              {data.failed ? ` · ${data.failed} couldn’t be posted` : ''}
            </Text>
            {data.failed && data.last_error ? <InlineStatus tone="warning" title="Strava didn’t take a run." body={data.last_error} /> : null}
          </>
        ) : (
          <Text variant="body" tone="secondary">
            Loading…
          </Text>
        )}
      </Card>

      {data?.connected ? (
        <>
          <RowGroup>
            <SwitchRow
              label="Post new runs automatically"
              hint="Accepted runs you record with PaceLeague go to Strava after they sync. You can post other runs from their detail screen."
              value={data.auto_upload}
              disabled={busy}
              onChange={(next) => void run((client) => client.setStravaAutoUpload(next))}
              last
              testID="strava-auto"
            />
          </RowGroup>
          <TextButton label="Check again" icon={RefreshCw} onPress={() => void status.refetch()} />
          <TextButton label="Disconnect Strava" icon={Unlink} tone="danger" onPress={() => setConfirmDisconnect(true)} testID="disconnect-strava" />
        </>
      ) : null}

      <Text variant="caption" tone="secondary">
        Strava is a trademark of Strava, Inc. PaceLeague isn’t made or endorsed by Strava.
      </Text>

      <ConfirmSheet
        visible={confirmDisconnect}
        title="Disconnect Strava?"
        body="Runs already on Strava stay there. PaceLeague stops posting and gives up its access to your Strava account."
        confirmLabel="Disconnect"
        destructive
        busy={busy}
        onConfirm={() =>
          void run(async (client) => {
            await client.disconnectStrava();
            setConfirmDisconnect(false);
            setOutcome(null);
          })
        }
        onCancel={() => setConfirmDisconnect(false)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  strava: {
    minHeight: 52,
    borderRadius: radius.button,
    backgroundColor: STRAVA_ORANGE,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.lg,
    marginTop: space.sm,
  },
  stravaLabel: { color: '#FFFFFF', fontSize: 19 },
});
