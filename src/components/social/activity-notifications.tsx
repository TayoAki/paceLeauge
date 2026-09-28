import { useQueryClient } from '@tanstack/react-query';
import { BellRing, Heart, MessageCircle, PartyPopper, Trophy, UserPlus } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import type { NotificationKind, NotificationPrefs, NotificationSettings } from '@/api/feed-schemas';
import { SecondaryButton } from '@/components/ui/buttons';
import { InlineStatus, RowGroup, SwitchRow } from '@/components/ui/elements';
import { Card } from '@/components/ui/layout';
import { useAccount } from '@/features/account/account-provider';
import { useCachedQuery, type Cached } from '@/features/data/hooks';
import { pushSupported, syncPushRegistration } from '@/features/notifications/push';
import { notificationsAllowed, requestNotificationPermission } from '@/features/reminders/reminders';
import { Text } from '@/design/text';
import { space } from '@/design/tokens';

const KINDS: { kind: NotificationKind; label: string; hint: string; icon: typeof Heart }[] = [
  { kind: 'kudos', label: 'Kudos', hint: 'When someone gives your run kudos. A few at once arrive together.', icon: Heart },
  { kind: 'comments', label: 'Comments and replies', hint: 'On your runs, and replies to your comments.', icon: MessageCircle },
  { kind: 'follows', label: 'Follows', hint: 'Follow requests, new followers and accepted requests.', icon: UserPlus },
  { kind: 'cheers', label: 'League cheers', hint: 'When a league-mate cheers you on.', icon: PartyPopper },
  { kind: 'results', label: 'Weekly results', hint: 'How your league week went, the day after it ends. Only after weeks you ran.', icon: Trophy },
];

/**
 * Push notifications about other runners (docs/ROADMAP.md 4.9). Each type can be switched off;
 * none are about losing rank (REQ-012). Shown only when the server sends pushes.
 */
export function ActivityNotifications() {
  const { api, state } = useAccount();
  const accountId = state.status === 'ready' ? state.accountId : null;
  const journal = state.status === 'ready' ? state.runtime.journal : null;
  const queryClient = useQueryClient();
  const settings = useCachedQuery('notification-settings', [], (a) => a.getNotificationSettings(), { enabled: pushSupported, staleTime: 0 });
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const data = settings.data?.data;
  const put = useCallback(
    (next: NotificationSettings) =>
      queryClient.setQueryData<Cached<NotificationSettings>>([accountId, 'notification-settings'], { data: next, source: 'network', updatedAt: Date.now() }),
    [accountId, queryClient],
  );

  useEffect(() => {
    let alive = true;
    void notificationsAllowed()
      .catch(() => false)
      .then((on) => alive && setAllowed(on));
    return () => {
      alive = false;
    };
  }, []);

  if (!pushSupported) {
    return (
      <Card style={styles.card}>
        <Text variant="labelStrong">Friends and league</Text>
        <Text variant="caption" tone="secondary">
          Notifications about kudos, comments, follows, cheers and weekly results go to the PaceLeague app on your phone.
        </Text>
      </Card>
    );
  }
  if (!data?.available) return null;

  const turnOn = async () => {
    if (!api || !journal) return;
    setBusy(true);
    setError(null);
    try {
      const granted = await requestNotificationPermission();
      setAllowed(granted);
      if (granted) {
        await syncPushRegistration(api, journal, { force: true });
        await settings.refetch();
      }
    } catch {
      setError('Couldn’t turn on notifications. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const setPref = async (kind: NotificationKind, on: boolean) => {
    if (!api) return;
    const before = data;
    put({ ...data, prefs: { ...data.prefs, [kind]: on } as NotificationPrefs });
    setError(null);
    try {
      put(await api.setNotificationPrefs({ [kind]: on }));
    } catch {
      put(before);
      setError('Couldn’t save that. Check your connection and try again.');
    }
  };

  return (
    <View style={styles.group}>
      <Text variant="labelStrong" accessibilityRole="header">
        Friends and league
      </Text>
      <Text variant="caption" tone="secondary">
        Nothing arrives between 10 pm and 7 am your time, and nothing is ever about losing rank.
      </Text>
      {allowed === false ? (
        <InlineStatus
          icon={BellRing}
          title="Notifications are off on this phone."
          body="Turn them on to hear about kudos, comments and your league."
          action={<SecondaryButton label="Turn on notifications" onPress={() => void turnOn()} loading={busy} testID="push-enable" />}
        />
      ) : null}
      {error ? <InlineStatus tone="danger" title={error} /> : null}
      <RowGroup>
        {KINDS.map(({ kind, label, hint, icon }, i) => (
          <SwitchRow
            key={kind}
            icon={icon}
            label={label}
            hint={hint}
            value={data.prefs[kind]}
            onChange={(on) => void setPref(kind, on)}
            last={i === KINDS.length - 1}
            testID={`push-${kind}`}
          />
        ))}
      </RowGroup>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { gap: space.xs },
  group: { gap: space.sm },
});
