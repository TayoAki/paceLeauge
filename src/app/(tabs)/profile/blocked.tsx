import { EyeOff, UserX } from 'lucide-react-native';
import { useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { toApiError } from '@/api/errors';
import type { BlockEntry } from '@/api/schemas';
import { SecondaryButton, TextButton } from '@/components/ui/buttons';
import { ConfirmSheet } from '@/components/ui/confirm-sheet';
import { EmptyState, InlineStatus, RowGroup } from '@/components/ui/elements';
import { NavHeader, Screen } from '@/components/ui/layout';
import { useAccount } from '@/features/account/account-provider';
import { useBlocks, useRefreshAccountData } from '@/features/data/hooks';
import { Text } from '@/design/text';
import { colors, layout, space } from '@/design/tokens';

function blockedOn(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function unblockFailure(code: string): string {
  if (code === 'network') return 'You’re offline. Connect to unblock.';
  if (code === 'auth_expired' || code === 'not_authenticated') return 'You’re signed out. Sign in again to unblock.';
  return 'Couldn’t unblock. Try again.';
}

/** REQ-011 — runners you've blocked; unblocking is always a confirmed choice. */
export default function BlockedScreen() {
  const { api } = useAccount();
  const blocks = useBlocks();
  const refreshAccountData = useRefreshAccountData();
  const [target, setTarget] = useState<BlockEntry | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const list = blocks.data?.data ?? [];

  const unblock = async () => {
    if (!api || !target) return;
    setBusy(true);
    setMessage(null);
    try {
      await api.unblock(target.block_id);
      // Refetches this list and the league standings.
      await refreshAccountData();
      setMessage({ tone: 'success', text: `${target.alias} is unblocked.` });
    } catch (e) {
      setMessage({ tone: 'danger', text: unblockFailure(toApiError(e).code) });
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <Screen edges={['top', 'bottom']}>
      <NavHeader title="Blocked runners" />
      <Text variant="body" tone="secondary">
        Blocked runners can’t see you, and you can’t see them. They stay in league standings as hidden rows, so everyone’s rank stays accurate.
      </Text>

      {blocks.data?.source === 'cache' ? <InlineStatus title="Offline — showing your saved list." /> : null}
      {message ? <InlineStatus tone={message.tone} title={message.text} /> : null}

      {blocks.isPending ? (
        <ActivityIndicator color={colors.textSecondary} accessibilityLabel="Loading blocked runners" />
      ) : blocks.isError && !blocks.data ? (
        <>
          <InlineStatus
            tone="danger"
            title={blocks.error.code === 'network' ? 'You’re offline. Connect to see who you’ve blocked.' : 'Couldn’t load blocked runners.'}
          />
          <SecondaryButton label="Try again" onPress={() => void blocks.refetch()} />
        </>
      ) : list.length === 0 ? (
        <EmptyState icon={UserX} title="You haven’t blocked anyone." body="You can block a runner from your league’s standings." />
      ) : (
        <RowGroup>
          {list.map((entry, i) => (
            <View key={entry.block_id} style={[styles.row, i < list.length - 1 && styles.divider]}>
              <EyeOff size={22} color={colors.textSecondary} />
              <View style={styles.text} accessible accessibilityLabel={`${entry.alias}, blocked ${blockedOn(entry.created_at_ms)}`}>
                <Text variant="body" numberOfLines={2}>
                  {entry.alias}
                </Text>
                <Text variant="caption" tone="secondary">
                  Blocked {blockedOn(entry.created_at_ms)}
                </Text>
              </View>
              <TextButton
                label="Unblock"
                tone="primary"
                accessibilityLabel={`Unblock ${entry.alias}`}
                onPress={() => {
                  setMessage(null);
                  setTarget(entry);
                  setConfirming(true);
                }}
              />
            </View>
          ))}
        </RowGroup>
      )}

      <ConfirmSheet
        visible={confirming}
        title={`Unblock ${target?.alias ?? 'this runner'}?`}
        body="If you share a league, you’ll see each other in the standings again."
        confirmLabel="Unblock"
        busy={busy}
        onConfirm={() => void unblock()}
        onCancel={() => setConfirming(false)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingLeft: layout.cardPadding,
    paddingRight: space.sm,
    paddingVertical: space.sm,
  },
  divider: { borderBottomWidth: StyleSheet.hairlineWidth * 2, borderBottomColor: colors.decorativeDivider },
  text: { flex: 1, gap: 2 },
});
