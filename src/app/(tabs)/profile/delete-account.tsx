import { useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { Trash2 } from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { toApiError } from '@/api/errors';
import { DangerButton, TextButton } from '@/components/ui/buttons';
import { ConfirmSheet } from '@/components/ui/confirm-sheet';
import { InlineStatus } from '@/components/ui/elements';
import { Card, NavHeader, Screen } from '@/components/ui/layout';
import { deleteAccountDatabase } from '@/db/open';
import { useAccount } from '@/features/account/account-provider';
import { useAuth } from '@/features/account/auth-provider';
import { RunInProgressError } from '@/features/account/runtime';
import { useLocalRuns, useMe, useRecorder } from '@/features/data/hooks';
import { clearExportFiles } from '@/features/privacy/export-data';
import { MANAGE_SUBSCRIPTIONS_URL } from '@/features/pro/purchases';
import { useEntitlements } from '@/features/pro/use-pro';
import { Text } from '@/design/text';
import { colors, space } from '@/design/tokens';

type Status = { tone: 'info' | 'warning' | 'danger'; title: string; body?: string };

/** The server accepts deletion only within 10 minutes of a sign-in; it stays the authority. */
const RECENT_SIGN_IN_MS = 10 * 60_000;
/** Lets the confirmation sheet finish closing before another modal is presented (iOS). */
const SHEET_CLOSE_MS = 400;

const RUN_IN_PROGRESS: Status = {
  tone: 'warning',
  title: 'Finish or discard your run first.',
  body: 'You can delete your account once your run is saved or discarded.',
};
const CONFIRM_IDENTITY: Status = {
  tone: 'info',
  title: 'Confirm it’s you to delete your account.',
  body: 'After you confirm, tap Delete account again.',
};
const SIGNED_OUT: Status = { tone: 'warning', title: 'You’re signed out.', body: 'Sign in again from Profile, then delete your account.' };

function requestFailure(code: string): Status {
  switch (code) {
    case 'network':
      return { tone: 'danger', title: 'You’re offline. Deleting your account needs a connection.' };
    case 'timeout':
      return { tone: 'danger', title: 'The connection timed out. Try again.' };
    case 'auth_expired':
    case 'not_authenticated':
      return SIGNED_OUT;
    default:
      return { tone: 'danger', title: 'Couldn’t request deletion. Try again.' };
  }
}

function Bullets({ title, items }: { title: string; items: string[] }) {
  return (
    <Card>
      <Text variant="section" accessibilityRole="header">
        {title}
      </Text>
      {items.map((item) => (
        <View key={item} style={styles.bullet}>
          <View style={styles.dot} aria-hidden />
          <Text variant="body" tone="secondary" style={styles.fill}>
            {item}
          </Text>
        </View>
      ))}
    </Card>
  );
}

/** S16 — consequences, recent sign-in, confirmation, then local cleanup and sign-out. */
export default function DeleteAccountScreen() {
  const router = useRouter();
  const auth = useAuth();
  const { state, api, signOut } = useAccount();
  const me = useMe();
  const entitlements = useEntitlements().data?.data ?? null;
  const { session } = useRecorder();
  const local = useLocalRuns();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [identityRequested, setIdentityRequested] = useState(false);

  const email = auth.status === 'signed_in' ? auth.email : null;
  const unsynced = local.filter((r) => !r.deleted && r.syncState !== 'synced').length;
  const alreadyDeleting = me.data?.data.profile?.status === 'deleting';

  const start = () => {
    if (session) {
      setStatus(RUN_IN_PROGRESS);
      return;
    }
    if (auth.status !== 'signed_in') {
      setStatus(SIGNED_OUT);
      return;
    }
    // Ask for a fresh sign-in before, not after, the destructive confirmation (once; after that
    // the server's answer decides).
    const lastSignIn = Date.parse(auth.session.user.last_sign_in_at ?? '');
    if (!identityRequested && !(Date.now() - lastSignIn < RECENT_SIGN_IN_MS)) {
      setIdentityRequested(true);
      setStatus(CONFIRM_IDENTITY);
      router.push('/reauth?next=delete');
      return;
    }
    setStatus(null);
    setConfirming(true);
  };

  const fail = (next: Status) => {
    setBusy(false);
    setConfirming(false);
    setStatus(next);
  };

  const confirmDelete = async () => {
    if (!api || state.status !== 'ready') return;
    setBusy(true);
    try {
      // Requires a recent sign-in. The server hides the profile and leaves the league at once,
      // then a retrying job removes the rest.
      await api.requestAccountDeletion();
    } catch (e) {
      const code = toApiError(e).code;
      if (code === 'recent_auth_required') {
        fail(CONFIRM_IDENTITY);
        setTimeout(() => router.push('/reauth?next=delete'), SHEET_CLOSE_MS);
      } else {
        fail(requestFailure(code));
      }
      return;
    }

    state.runtime.telemetry.track('deletion_requested');
    const accountId = state.accountId;
    try {
      // Stops sync, closes this account's journal, cancels the reminder, clears cached server
      // data and signs out. The welcome screen replaces this one.
      await signOut();
    } catch (e) {
      // The server keeps the same deletion job, so tapping Delete again finishes the cleanup here.
      fail({
        tone: 'warning',
        title: 'Deletion requested.',
        body:
          e instanceof RunInProgressError
            ? 'Finish or discard your run, then tap Delete account again to clear this phone.'
            : 'Tap Delete account again to clear this phone and sign out.',
      });
      return;
    }
    // The journal is closed now: remove it (with any unsynced runs) and its key from the device.
    await deleteAccountDatabase(accountId).catch(() => undefined);
    clearExportFiles();
  };

  const unsyncedLine =
    unsynced === 0
      ? 'Runs on this phone that haven’t synced yet'
      : `Runs on this phone that haven’t synced yet — you have ${unsynced}`;

  return (
    <Screen edges={['top', 'bottom']}>
      <NavHeader title="Delete account" />

      <Text variant="body" tone="secondary">
        Deleting your account is permanent. Here’s what happens.
      </Text>
      {email ? (
        <Text variant="label" tone="secondary">
          Signed in as <Text variant="labelStrong">{email}</Text>
        </Text>
      ) : null}
      {alreadyDeleting ? (
        <InlineStatus title="Deletion already requested." body="Your data is being removed. Confirm again to clear this phone and sign out." />
      ) : null}

      <Bullets
        title="What’s deleted"
        items={[
          'Your runs, routes and XP',
          'Your league membership. If you own a league, it passes to the longest-standing member — or closes if you’re the only one in it.',
          'Your runner name and profile',
          unsyncedLine,
        ]}
      />
      <Bullets
        title="What happens next"
        items={[
          'You’re hidden from your league immediately.',
          'Your primary data is removed within 7 days.',
          'You’re signed out on this phone.',
        ]}
      />

      {/* Deletion never waits on a subscription (REQ-010), but the store keeps billing until it's cancelled there (S16). */}
      {entitlements?.pro && entitlements.source === 'revenuecat' ? (
        <InlineStatus
          tone="warning"
          title="Deleting your account doesn’t cancel Pro."
          body="The App Store keeps billing until you cancel the subscription there. You can delete your account either way."
          action={<TextButton label="Manage subscription" onPress={() => void WebBrowser.openBrowserAsync(MANAGE_SUBSCRIPTIONS_URL)} />}
        />
      ) : null}
      <TextButton label="Export my data first" tone="primary" onPress={() => router.dismissTo('/profile/privacy')} style={styles.inlineAction} />

      {session && !status ? <InlineStatus tone={RUN_IN_PROGRESS.tone} title={RUN_IN_PROGRESS.title} body={RUN_IN_PROGRESS.body} /> : null}
      {status ? <InlineStatus tone={status.tone} title={status.title} body={status.body} /> : null}
      <DangerButton
        label="Delete account"
        icon={Trash2}
        onPress={start}
        disabled={!!session}
        style={session ? styles.disabled : undefined}
        testID="delete-account-start"
      />

      <ConfirmSheet
        visible={confirming}
        title="Delete your account? This can’t be undone."
        body={
          unsynced > 0
            ? `Your runs, routes, XP and league membership are deleted, including ${unsynced === 1 ? '1 run' : `${unsynced} runs`} on this phone that haven’t synced.`
            : 'Your runs, routes, XP and league membership are deleted.'
        }
        confirmLabel="Delete account"
        destructive
        busy={busy}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setConfirming(false)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  bullet: { flexDirection: 'row', gap: space.md, alignItems: 'flex-start' },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.textSecondary, marginTop: 9 },
  inlineAction: { alignSelf: 'flex-start', paddingHorizontal: 0 },
  disabled: { opacity: 0.45 },
});
