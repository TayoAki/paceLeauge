import * as Linking from 'expo-linking';
import { ExternalLink, Send } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { toApiError } from '@/api/errors';
import { SecondaryButton, TextButton } from '@/components/ui/buttons';
import { Card } from '@/components/ui/layout';
import { useAccountServices } from '@/features/account/account-provider';
import { useStravaStatus, useStravaUpload } from '@/features/data/hooks';
import { stravaActivityUrl } from '@/features/connections/connections';
import { Text } from '@/design/text';
import { space } from '@/design/tokens';

/** A run's place on Strava (docs/ROADMAP.md 2.3): posted, on its way, or a button to post it. */
export function StravaRunCard({ serverRunId, hasRoute }: { serverRunId: string; hasRoute: boolean }) {
  const { api } = useAccountServices();
  const connected = useStravaStatus().data?.data.connected ?? false;
  const upload = useStravaUpload(serverRunId, connected);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const state = upload.data?.data ?? null;
  const waiting = state?.state === 'queued' || state?.state === 'processing';

  // While Strava works on it, look again every few seconds.
  const refetch = upload.refetch;
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => void refetch(), 8_000);
    return () => clearTimeout(timer);
  }, [waiting, refetch, upload.dataUpdatedAt]);

  if (!connected || upload.isPending) return null;

  const post = async () => {
    if (!api) return;
    setBusy(true);
    setError(null);
    try {
      await api.postRunToStrava(serverRunId);
      await upload.refetch();
    } catch (e) {
      const code = toApiError(e).code;
      setError(code === 'network' || code === 'timeout' ? 'You’re offline. Try again when you’re connected.' : 'Couldn’t post this run. Try again.');
    } finally {
      setBusy(false);
    }
  };

  let body: React.ReactNode = null;
  if (state?.state === 'done' && state.activity_id) {
    const activityId = state.activity_id;
    body = (
      <View style={styles.row}>
        <Text variant="body" style={{ flex: 1 }}>
          Posted to Strava
        </Text>
        <TextButton label="View on Strava" icon={ExternalLink} tone="accent" onPress={() => void Linking.openURL(stravaActivityUrl(activityId))} testID="view-on-strava" />
      </View>
    );
  } else if (waiting) {
    body = <Text variant="body">Posting to Strava…</Text>;
  } else if (state?.state === 'failed') {
    body = (
      <>
        <Text variant="body">Strava didn’t take this run.</Text>
        {state.error ? (
          <Text variant="label" tone="secondary">
            {state.error}
          </Text>
        ) : null}
        <SecondaryButton label="Try again" icon={Send} loading={busy} onPress={() => void post()} />
      </>
    );
  } else if (hasRoute) {
    body = <SecondaryButton label="Post to Strava" icon={Send} loading={busy} onPress={() => void post()} testID="post-to-strava" />;
  }
  if (!body) return null;
  return (
    <Card>
      {body}
      {error ? (
        <Text variant="label" tone="danger">
          {error}
        </Text>
      ) : null}
    </Card>
  );
}

/** Whether the run is on Strava, for the route's privacy line. */
export function usePostedToStrava(serverRunId: string | null): boolean {
  const connected = useStravaStatus().data?.data.connected ?? false;
  return useStravaUpload(serverRunId, connected).data?.data?.state === 'done';
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md },
});
