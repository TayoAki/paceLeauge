import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { Link2, RefreshCw, Unlink } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, RefreshControl, StyleSheet } from 'react-native';

import { toApiError } from '@/api/errors';
import type { PaceApi } from '@/api/pace-api';
import { SecondaryButton, TextButton } from '@/components/ui/buttons';
import { ConfirmSheet } from '@/components/ui/confirm-sheet';
import { InlineStatus, RowGroup, SwitchRow } from '@/components/ui/elements';
import { Card, NavHeader, Screen } from '@/components/ui/layout';
import { formatDateShort } from '@/domain/format';
import { useAccountServices } from '@/features/account/account-provider';
import {
  GARMIN_OUTCOME,
  GARMIN_RETURN_PATH,
  garminOutcome,
  STRAVA_OUTCOME,
  STRAVA_RETURN_PATH,
  stravaOutcome,
} from '@/features/connections/connections';
import { useGarminStatus, useStravaStatus } from '@/features/data/hooks';
import { HEALTH } from '@/features/health/health-names';
import { Text } from '@/design/text';
import { colors, radius, space } from '@/design/tokens';

/** Strava's brand orange, for its "Connect with Strava" button only. */
const STRAVA_ORANGE = '#FC5200';

/** One connection's busy state, error and "what just happened" line. */
function useConnectionAction(refetch: () => unknown) {
  const { api } = useAccountServices();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (task: (client: PaceApi) => Promise<unknown>) => {
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
      void refetch();
    }
  };
  return { busy, error, run };
}

/** Who owns the names of the connections shown. */
function trademarks(strava: boolean, garmin: boolean): string | null {
  if (strava && garmin) return 'Strava is a trademark of Strava, Inc., and Garmin of Garmin Ltd. PaceLeague isn’t made or endorsed by either.';
  if (strava) return 'Strava is a trademark of Strava, Inc. PaceLeague isn’t made or endorsed by Strava.';
  if (garmin) return 'Garmin is a trademark of Garmin Ltd. PaceLeague isn’t made or endorsed by Garmin.';
  return null;
}

/**
 * Connections (docs/ROADMAP.md 2.3 and 2.4): post runs to Strava, bring runs in from Garmin. Each
 * shows only once the API has it switched on (docs/OPERATIONS.md, "Integrations").
 */
export default function ConnectionsScreen() {
  const strava = useStravaStatus();
  const garmin = useGarminStatus();
  const showStrava = strava.data?.data.available ?? false;
  const showGarmin = garmin.data?.data.available ?? false;
  const notice = trademarks(showStrava, showGarmin);
  const refreshing = (strava.isFetching && !strava.isPending) || (garmin.isFetching && !garmin.isPending);
  return (
    <Screen
      edges={['top', 'bottom']}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            void strava.refetch();
            void garmin.refetch();
          }}
          tintColor={colors.textSecondary}
        />
      }>
      <NavHeader title="Connections" />
      {(strava.isError && !strava.data) || (garmin.isError && !garmin.data) ? (
        <InlineStatus tone="danger" title="Couldn’t load your connections." body="Pull to try again." />
      ) : null}
      {showStrava ? <StravaCard /> : null}
      {showGarmin ? <GarminCard /> : null}
      {strava.data && garmin.data && !showStrava && !showGarmin ? (
        <Text variant="body" tone="secondary">
          No connections are switched on yet.
        </Text>
      ) : null}
      {notice ? (
        <Text variant="caption" tone="secondary">
          {notice}
        </Text>
      ) : null}
    </Screen>
  );
}

function StravaCard() {
  const status = useStravaStatus();
  const { busy, error, run } = useConnectionAction(status.refetch);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const data = status.data?.data;

  const connect = () =>
    run(async (client) => {
      setOutcome(null);
      const returnTo = Linking.createURL(STRAVA_RETURN_PATH);
      const url = await client.startStravaConnect(returnTo);
      const result = await WebBrowser.openAuthSessionAsync(url, returnTo);
      if (result.type === 'success') setOutcome(stravaOutcome(result.url));
    });

  return (
    <>
      {outcome ? <InlineStatus tone={STRAVA_OUTCOME[outcome]!.tone} title={STRAVA_OUTCOME[outcome]!.title} /> : null}
      {error ? <InlineStatus tone="danger" title={error} /> : null}
      <Card>
        <Text variant="section" accessibilityRole="header">
          Strava
        </Text>
        {data && !data.connected ? (
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
    </>
  );
}

function GarminCard() {
  const status = useGarminStatus();
  const { busy, error, run } = useConnectionAction(status.refetch);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const data = status.data?.data;

  const connect = () =>
    run(async (client) => {
      setOutcome(null);
      const returnTo = Linking.createURL(GARMIN_RETURN_PATH);
      const url = await client.startGarminConnect(returnTo);
      const result = await WebBrowser.openAuthSessionAsync(url, returnTo);
      if (result.type === 'success') setOutcome(garminOutcome(result.url));
    });

  return (
    <>
      {outcome ? <InlineStatus tone={GARMIN_OUTCOME[outcome]!.tone} title={GARMIN_OUTCOME[outcome]!.title} /> : null}
      {error ? <InlineStatus tone="danger" title={error} /> : null}
      <Card>
        <Text variant="section" accessibilityRole="header">
          Garmin
        </Text>
        {data && !data.connected ? (
          <>
            <Text variant="body" tone="secondary">
              Bring in the runs you record on your Garmin watch, with their routes, so they can earn league XP like runs recorded here.
            </Text>
            <Text variant="body" tone="secondary">
              Garmin shares them through Terra, a service that connects fitness devices. If {HEALTH.name} has the same run, it counts once.
            </Text>
            <SecondaryButton label="Connect Garmin" icon={Link2} loading={busy} onPress={() => void connect()} testID="connect-garmin" />
          </>
        ) : data ? (
          <>
            <Text variant="body" testID="garmin-connected">
              Connected.
            </Text>
            <Text variant="label" tone="secondary">
              {data.imported} {data.imported === 1 ? 'activity' : 'activities'} brought in
              {data.last_activity_at_ms ? ` · latest ${formatDateShort(data.last_activity_at_ms)}` : ''}
            </Text>
            <TextButton label="Disconnect Garmin" icon={Unlink} tone="danger" onPress={() => setConfirmDisconnect(true)} testID="disconnect-garmin" />
          </>
        ) : (
          <Text variant="body" tone="secondary">
            Loading…
          </Text>
        )}
      </Card>

      <ConfirmSheet
        visible={confirmDisconnect}
        title="Disconnect Garmin?"
        body={`Runs already brought in stay in your history. New Garmin runs stop arriving, except through ${HEALTH.name}.`}
        confirmLabel="Disconnect"
        destructive
        busy={busy}
        onConfirm={() =>
          void run(async (client) => {
            await client.disconnectGarmin();
            setConfirmDisconnect(false);
            setOutcome(null);
          })
        }
        onCancel={() => setConfirmDisconnect(false)}
      />
    </>
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
