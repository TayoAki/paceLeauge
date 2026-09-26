import { Ban, Crown, Flag, RefreshCw, Share2, UserMinus } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Modal, Pressable, Share, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { toApiError } from '@/api/errors';
import type { ReportReason } from '@/api/pace-api';
import type { Invite, Standing } from '@/api/schemas';
import { PrimaryButton, SecondaryButton, TextButton } from '@/components/ui/buttons';
import { InlineStatus, Row, RowGroup } from '@/components/ui/elements';
import { useAccountServices } from '@/features/account/account-provider';
import { Text } from '@/design/text';
import { colors, layout, radius, space } from '@/design/tokens';

import { formatInZone, deviceTimeZone } from './week-copy';

function Sheet({ visible, onClose, children, title }: { visible: boolean; onClose: () => void; children: React.ReactNode; title: string }) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} accessibilityLabel="Close" onPress={onClose} />
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, space.lg) + space.sm }]} accessibilityViewIsModal>
          <Text variant="section" accessibilityRole="header">
            {title}
          </Text>
          {children}
        </View>
      </View>
    </Modal>
  );
}

export function inviteLink(code: string): string {
  return `paceleague://invite/${code}`;
}

export function formatCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

const INVITE_CACHE = 'league:invite';

/** Owner's invite: a random 7-day code shared through the system share sheet (no contacts). */
export function InviteSheet({ visible, onClose, leagueName }: { visible: boolean; onClose: () => void; leagueName: string }) {
  const { api, runtime } = useAccountServices();
  const [invite, setInvite] = useState<Invite | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!visible || !api) return;
    let alive = true;
    void (async () => {
      const cached = await runtime.journal.getKv<Invite>(INVITE_CACHE);
      if (cached && cached.value.expires_at_ms - Date.now() > 24 * 3600_000) {
        if (alive) setInvite(cached.value);
        return;
      }
      try {
        const fresh = await api.createLeagueInvite();
        await runtime.journal.setKv(INVITE_CACHE, fresh);
        if (alive) setInvite(fresh);
      } catch (e) {
        if (alive) setError(toApiError(e).code === 'invites_paused' ? 'Invites are paused right now.' : 'Couldn’t create an invite. Check your connection.');
      }
    })();
    return () => {
      alive = false;
    };
  }, [visible, api, runtime]);

  const rotate = async () => {
    if (!api) return;
    setBusy(true);
    setError(null);
    try {
      const fresh = await api.rotateLeagueInvites();
      await runtime.journal.setKv(INVITE_CACHE, fresh);
      setInvite(fresh);
    } catch {
      setError('Couldn’t make a new code. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const share = () => {
    if (!invite) return;
    void Share.share({
      message: `Join my PaceLeague crew “${leagueName}”: ${inviteLink(invite.code)} — or enter code ${formatCode(invite.code)} in the app. Expires ${formatInZone(invite.expires_at_ms, deviceTimeZone())}.`,
    });
  };

  return (
    <Sheet visible={visible} onClose={onClose} title="Invite friends">
      <Text variant="body" tone="secondary">
        Share this code with people you run with. It works for 7 days; they choose to join.
      </Text>
      {invite ? (
        <View style={styles.code} accessible accessibilityLabel={`Invite code ${invite.code.split('').join(' ')}`}>
          <Text variant="hero" style={{ letterSpacing: 4 }} numberOfLines={1} adjustsFontSizeToFit selectable>
            {formatCode(invite.code)}
          </Text>
          <Text variant="caption" tone="secondary">
            Expires {formatInZone(invite.expires_at_ms, deviceTimeZone())}
          </Text>
        </View>
      ) : null}
      {error ? <InlineStatus tone="danger" title={error} /> : null}
      <PrimaryButton label="Share invite" icon={Share2} onPress={share} disabled={!invite} />
      <SecondaryButton label="New code (turns off old ones)" icon={RefreshCw} onPress={rotate} loading={busy} />
      <TextButton label="Done" onPress={onClose} />
    </Sheet>
  );
}

const REASONS: { value: ReportReason; label: string }[] = [
  { value: 'offensive_name', label: 'Offensive name' },
  { value: 'harassment', label: 'Harassment' },
  { value: 'impersonation', label: 'Impersonation' },
  { value: 'cheating', label: 'Suspicious results' },
  { value: 'spam', label: 'Spam' },
  { value: 'other', label: 'Something else' },
];

/** Report / block / (owner) remove or transfer — for one member row. */
export function MemberSheet({
  member,
  isOwner,
  onClose,
  onChanged,
}: {
  member: Standing | null;
  isOwner: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { api } = useAccountServices();
  const [mode, setMode] = useState<'menu' | 'report' | 'confirm-remove' | 'confirm-transfer' | 'confirm-block'>('menu');
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const name = member?.hidden ? 'this runner' : (member?.alias ?? 'this runner');

  const close = () => {
    setMode('menu');
    setMessage(null);
    onClose();
  };

  const run = async (task: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await task();
      setMessage({ tone: 'success', text: success });
      setMode('menu');
      onChanged();
    } catch (e) {
      const code = toApiError(e).code;
      setMessage({ tone: 'danger', text: code === 'network' ? 'You’re offline. Try again when connected.' : 'That didn’t work. Try again.' });
    } finally {
      setBusy(false);
    }
  };

  if (!member || !api) return null;
  return (
    <Sheet visible onClose={close} title={member.hidden ? 'Hidden runner' : (member.alias ?? 'Runner')}>
      {message ? <InlineStatus tone={message.tone} title={message.text} /> : null}
      {mode === 'menu' ? (
        <RowGroup style={{ backgroundColor: colors.surface }}>
          <Row icon={Flag} label="Report" hint="Sends the name and league to moderators" onPress={() => setMode('report')} />
          <Row icon={Ban} label="Block" hint="You won’t see each other’s names" onPress={() => setMode('confirm-block')} last={!isOwner} />
          {isOwner ? (
            <>
              <Row icon={Crown} label="Make owner" onPress={() => setMode('confirm-transfer')} />
              <Row icon={UserMinus} label="Remove from league" tone="danger" onPress={() => setMode('confirm-remove')} last />
            </>
          ) : null}
        </RowGroup>
      ) : null}
      {mode === 'report' ? (
        <RowGroup style={{ backgroundColor: colors.surface }}>
          {REASONS.map((r, i) => (
            <Row
              key={r.value}
              label={r.label}
              last={i === REASONS.length - 1}
              onPress={() => void run(() => api.submitReport('member', member.member_id, r.value), 'Thanks. Moderators will review it.')}
            />
          ))}
        </RowGroup>
      ) : null}
      {mode === 'confirm-block' ? (
        <>
          <Text variant="body" tone="secondary">
            You and {name} won’t see each other’s names. They stay in the standings as a hidden runner so places stay accurate.
          </Text>
          <PrimaryButton label="Block" loading={busy} onPress={() => void run(() => api.blockMember(member.member_id), 'Blocked.')} />
        </>
      ) : null}
      {mode === 'confirm-remove' ? (
        <>
          <Text variant="body" tone="secondary">
            {name} will leave the league now and can’t rejoin with an old invite.
          </Text>
          <PrimaryButton label="Remove from league" loading={busy} onPress={() => void run(() => api.removeLeagueMember(member.member_id), 'Removed.')} />
        </>
      ) : null}
      {mode === 'confirm-transfer' ? (
        <>
          <Text variant="body" tone="secondary">
            {name} will own the league and manage invites. You stay as a member.
          </Text>
          <PrimaryButton label="Make owner" loading={busy} onPress={() => void run(() => api.transferLeagueOwnership(member.member_id), 'Ownership transferred.')} />
        </>
      ) : null}
      <TextButton label={mode === 'menu' ? 'Close' : 'Back'} onPress={mode === 'menu' ? close : () => setMode('menu')} />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.6)' },
  sheet: {
    backgroundColor: colors.surfaceElevated,
    borderTopLeftRadius: radius.card,
    borderTopRightRadius: radius.card,
    padding: layout.cardPadding + 4,
    gap: space.md,
  },
  code: { alignItems: 'center', gap: space.xs, paddingVertical: space.md, backgroundColor: colors.surface, borderRadius: radius.control },
});
