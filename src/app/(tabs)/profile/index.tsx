import * as Application from 'expo-application';
import Constants from 'expo-constants';
import { useFocusEffect, useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { Ban, Bell, CloudUpload, CreditCard, Footprints, LifeBuoy, Link2, LogIn, LogOut, MapPinOff, ShieldCheck, Sparkles, Tag, UserPen, Users } from 'lucide-react-native';
import { useCallback, useState, useSyncExternalStore } from 'react';
import { StyleSheet, View } from 'react-native';

import type { Entitlements, Profile } from '@/api/schemas';
import { SecondaryButton } from '@/components/ui/buttons';
import { ConfirmSheet } from '@/components/ui/confirm-sheet';
import { Avatar, InlineStatus, Row, RowGroup } from '@/components/ui/elements';
import { Card, LargeHeader, Screen } from '@/components/ui/layout';
import { RULE_VERSION, VALIDATOR_VERSION } from '@/domain/config';
import { formatDateShort, formatXp } from '@/domain/format';
import { useAccount } from '@/features/account/account-provider';
import { useAuth } from '@/features/account/auth-provider';
import { RunInProgressError } from '@/features/account/runtime';
import { useLocalRuns, useMe, useRecorder, useStravaStatus } from '@/features/data/hooks';
import { clearExportFiles } from '@/features/privacy/export-data';
import { MANAGE_SUBSCRIPTIONS_URL } from '@/features/pro/purchases';
import { useEntitlements } from '@/features/pro/use-pro';
import { notificationsAllowed, parseReminderSettings, REMINDER_KEY } from '@/features/reminders/reminders';
import type { RunSettings } from '@/features/voice/run-settings';
import { Text } from '@/design/text';
import { space } from '@/design/tokens';

const APP_VERSION = Application.nativeApplicationVersion ?? Constants.expoConfig?.version ?? null;
const APP_BUILD = Application.nativeBuildVersion;

function profileSummary(profile: Profile | null): string | undefined {
  if (!profile) return undefined;
  const units = profile.units === 'imperial' ? 'mi' : 'km';
  return `${units} · ${profile.goal_days ? `${profile.goal_days}-day goal` : 'No goal'}`;
}

const noopSubscribe = () => () => undefined;

function proSummary(e: Entitlements | null): string {
  if (!e?.pro) return 'Free';
  if (e.period === 'trial' && e.expires_at_ms) return `Trial until ${formatDateShort(e.expires_at_ms)}`;
  return 'Pro';
}

function runSettingsSummary(settings: RunSettings | null): string | undefined {
  if (!settings) return undefined;
  return `Cues ${settings.cues.enabled ? 'on' : 'off'} · Auto-pause ${settings.autoPause ? 'on' : 'off'}`;
}

function unsyncedWarning(count: number): string {
  return count === 1
    ? '1 run hasn’t synced yet. It stays on this phone and syncs when you sign back in to this account.'
    : `${count} runs haven’t synced yet. They stay on this phone and sync when you sign back in to this account.`;
}

/** S14 — runner identity, settings, privacy, support and sign-out. */
export default function ProfileScreen() {
  const router = useRouter();
  const auth = useAuth();
  const { state, signOut, sessionLapsed } = useAccount();
  const me = useMe();
  const strava = useStravaStatus().data?.data;
  const entitlements = useEntitlements().data?.data ?? null;
  const { session } = useRecorder();
  const local = useLocalRuns();
  const journal = state.status === 'ready' ? state.runtime.journal : null;
  const runSettingsStore = state.status === 'ready' ? state.runtime.runSettings : null;
  const runSettings = useSyncExternalStore(runSettingsStore?.subscribe ?? noopSubscribe, () => runSettingsStore?.getSnapshot() ?? null);
  const [reminderOn, setReminderOn] = useState<boolean | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      if (!journal) return undefined;
      let active = true;
      void Promise.all([journal.getKv<unknown>(REMINDER_KEY), notificationsAllowed().catch(() => false)])
        .then(([saved, allowed]) => {
          if (active) setReminderOn(parseReminderSettings(saved?.value).enabled && allowed);
        })
        .catch(() => undefined);
      return () => {
        active = false;
      };
    }, [journal]),
  );

  const data = me.data?.data;
  const profile = data?.profile ?? null;
  const email = auth.status === 'signed_in' ? auth.email : null;
  const unsynced = local.filter((r) => !r.deleted && r.syncState !== 'synced').length;
  const alias = profile?.alias ?? 'Runner';
  const standing = data ? `${data.tier} · ${formatXp(data.lifetime_xp)} XP` : null;
  const identityLabel = [alias, data ? `${data.tier} tier, ${formatXp(data.lifetime_xp)} lifetime XP` : null, email ? `Signed in as ${email}` : null]
    .filter(Boolean)
    .join('. ');

  const finishSignOut = async () => {
    setBusy(true);
    try {
      clearExportFiles();
      await signOut();
      // The root navigator shows the welcome screen as soon as the session is gone.
    } catch (e) {
      setBusy(false);
      setConfirming(false);
      setSignOutError(e instanceof RunInProgressError ? 'Finish or discard your run first.' : 'Couldn’t sign out. Try again.');
    }
  };

  const requestSignOut = () => {
    setSignOutError(null);
    if (session) {
      setSignOutError('Finish or discard your run first.');
      return;
    }
    if (unsynced > 0) {
      setConfirming(true);
      return;
    }
    void finishSignOut();
  };

  return (
    <Screen>
      <LargeHeader title="Profile" />

      {sessionLapsed ? (
        <InlineStatus
          tone="warning"
          title="You’re signed out."
          body={session ? 'Finish your run — it syncs after you sign in again.' : 'Sign in again to sync. Your runs are saved on this phone.'}
        />
      ) : null}
      {profile?.status === 'deleting' ? (
        <InlineStatus tone="info" title="Your account is being deleted." body="You’re hidden from your league. Your data is removed within 7 days." />
      ) : null}
      {me.data?.source === 'cache' ? <InlineStatus tone="info" title="Offline — showing saved data." /> : null}

      <Card>
        <View style={styles.identity} accessible accessibilityLabel={identityLabel}>
          <Avatar name={profile?.alias ?? null} seed={data?.user_id ?? 'me'} highlight size={56} />
          <View style={styles.identityText}>
            <Text variant="section" numberOfLines={2}>
              {alias}
            </Text>
            {standing ? (
              <Text variant="label" tone="secondary">
                {standing}
              </Text>
            ) : null}
            {email ? (
              <Text variant="caption" tone="secondary" numberOfLines={1}>
                {email}
              </Text>
            ) : null}
          </View>
        </View>
      </Card>

      <RowGroup>
        <Row icon={UserPen} label="Edit profile" value={profileSummary(profile)} onPress={() => router.push('/profile/edit')} testID="profile-edit" />
        <Row
          icon={Footprints}
          label="Run settings"
          value={runSettingsSummary(runSettings)}
          onPress={() => router.push('/profile/run-settings')}
          testID="profile-run-settings"
        />
        <Row icon={Tag} label="Shoes" onPress={() => router.push('/profile/shoes')} testID="profile-shoes" />
        <Row
          icon={CloudUpload}
          label="Imports and sync"
          value={unsynced > 0 ? `${unsynced} waiting` : undefined}
          valueTone={unsynced > 0 ? 'accent' : 'secondary'}
          onPress={() => router.push('/profile/sync')}
          testID="profile-sync"
        />
        <Row
          icon={Link2}
          label="Connections"
          value={strava?.connected ? 'Strava' : undefined}
          onPress={() => router.push('/profile/connections')}
          testID="profile-connections"
        />
        <Row
          icon={Bell}
          label="Notifications"
          value={reminderOn === null ? undefined : reminderOn ? 'On' : 'Off'}
          onPress={() => router.push('/profile/notifications')}
        />
        <Row icon={Users} label="People" onPress={() => router.push('/profile/people')} testID="profile-people" />
        <Row icon={MapPinOff} label="Sharing and privacy zones" onPress={() => router.push('/profile/sharing')} testID="profile-sharing" />
        <Row icon={ShieldCheck} label="Privacy" onPress={() => router.push('/profile/privacy')} testID="profile-privacy" />
        <Row icon={Ban} label="Blocked runners" onPress={() => router.push('/profile/blocked')} />
        <Row icon={LifeBuoy} label="Support & legal" onPress={() => router.push('/profile/support')} last />
      </RowGroup>

      <RowGroup>
        <Row
          icon={Sparkles}
          label="PaceLeague Pro"
          value={proSummary(entitlements)}
          valueTone={entitlements?.pro ? 'accent' : 'secondary'}
          onPress={() => router.push('/pro')}
          testID="profile-pro"
          last={!(entitlements?.pro && entitlements.source === 'revenuecat')}
        />
        {entitlements?.pro && entitlements.source === 'revenuecat' ? (
          <Row icon={CreditCard} label="Manage subscription" onPress={() => void WebBrowser.openBrowserAsync(MANAGE_SUBSCRIPTIONS_URL)} last />
        ) : null}
      </RowGroup>

      {signOutError ? <InlineStatus tone="warning" title={signOutError} /> : null}
      <SecondaryButton
        label={sessionLapsed ? 'Sign in again' : 'Sign out'}
        icon={sessionLapsed ? LogIn : LogOut}
        onPress={requestSignOut}
        loading={busy && !confirming}
        testID="sign-out"
      />

      <View style={styles.about}>
        <Text variant="caption" tone="secondary" align="center">
          {APP_VERSION ? `PaceLeague ${APP_VERSION}${APP_BUILD ? ` (${APP_BUILD})` : ''}` : 'PaceLeague'}
        </Text>
        <Text variant="caption" tone="secondary" align="center">
          Rules v{data?.config.rule_version ?? RULE_VERSION} · Validator v{data?.config.validator_version ?? VALIDATOR_VERSION}
        </Text>
      </View>

      <ConfirmSheet
        visible={confirming}
        title="Sign out?"
        body={unsyncedWarning(unsynced)}
        confirmLabel="Sign out"
        cancelLabel="Stay signed in"
        busy={busy}
        onConfirm={() => void finishSignOut()}
        onCancel={() => setConfirming(false)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  identity: { flexDirection: 'row', alignItems: 'center', gap: space.lg },
  identityText: { flex: 1, gap: 2 },
  about: { gap: space.xs, marginTop: space.sm },
});
