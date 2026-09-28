import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { Flag, LogOut, MessagesSquare } from 'lucide-react-native';
import { useState } from 'react';
import { View } from 'react-native';

import { toApiError } from '@/api/errors';
import type { ReportReason } from '@/api/pace-api';
import type { Standing } from '@/api/schemas';
import { LeagueRow } from '@/components/league/league-row';
import { DangerButton, PrimaryButton, SecondaryButton } from '@/components/ui/buttons';
import { ConfirmSheet } from '@/components/ui/confirm-sheet';
import { InlineStatus, Row, RowGroup, TextField } from '@/components/ui/elements';
import { NavHeader, Screen } from '@/components/ui/layout';
import { LEAGUE_RULES } from '@/domain/config';
import { useAccount } from '@/features/account/account-provider';
import { useLeague } from '@/features/data/hooks';
import { MemberSheet } from '@/features/leagues/league-sheets';
import { useLeagueActions } from '@/features/leagues/use-leagues';
import { Text } from '@/design/text';
import { space } from '@/design/tokens';

const REPORT_REASONS: { value: ReportReason; label: string }[] = [
  { value: 'offensive_name', label: 'Offensive league name' },
  { value: 'spam', label: 'Spam' },
  { value: 'other', label: 'Something else' },
];

export default function ManageLeagueScreen() {
  const router = useRouter();
  const { api } = useAccount();
  const queryClient = useQueryClient();
  const league = useLeague(0);
  const view = league.data?.data;
  const [name, setName] = useState<string | null>(null);
  const [member, setMember] = useState<Standing | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [chat, setChat] = useState<string | null>(null);
  const chatActions = useLeagueActions();
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  if (!view?.league) {
    return (
      <Screen edges={['top', 'bottom']}>
        <NavHeader title="League" />
        <Text variant="body" tone="secondary">
          You’re not in a league.
        </Text>
      </Screen>
    );
  }
  const current = view.league;
  const others = (view.standings ?? []).filter((s) => !s.is_me);
  const alone = current.member_count <= 1;

  const run = async (task: () => Promise<unknown>, success: string, after?: () => void) => {
    if (!api) return;
    setBusy(true);
    setMessage(null);
    try {
      await task();
      await queryClient.invalidateQueries();
      setMessage({ tone: 'success', text: success });
      after?.();
    } catch (e) {
      const code = toApiError(e).code;
      const text =
        code === 'owner_must_transfer'
          ? 'Make someone else the owner before you leave.'
          : code === 'league_name_invalid' || code === 'league_name_not_allowed'
            ? 'That name isn’t available. Try another.'
            : code === 'network'
              ? 'You’re offline. Try again when connected.'
              : 'That didn’t work. Try again.';
      setMessage({ tone: 'danger', text });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen edges={['top', 'bottom']}>
      <NavHeader title={current.is_owner ? 'Manage league' : 'League options'} />
      {message ? <InlineStatus tone={message.tone} title={message.text} /> : null}

      {current.is_owner ? (
        <>
          <TextField label="League name" value={name ?? current.name} onChangeText={setName} maxLength={LEAGUE_RULES.nameMaxLength} autoCapitalize="words" />
          <SecondaryButton
            label="Save name"
            disabled={!name || name.trim() === current.name}
            loading={busy}
            onPress={() => void run(() => api!.renameLeague(name ?? current.name, current.id), 'League renamed.', () => setName(null))}
          />
          <TextField
            label="Group chat link"
            value={chat ?? current.chat_url ?? ''}
            onChangeText={setChat}
            placeholder="https://chat.whatsapp.com/…"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            hint="Your crew’s WhatsApp, Discord, Signal, Telegram, GroupMe or Messenger invite link. Only members see it; there’s no chat inside PaceLeague."
            error={chatActions.error}
            testID="chat-link-input"
          />
          <SecondaryButton
            label={chat === '' && current.chat_url ? 'Remove chat link' : 'Save chat link'}
            icon={MessagesSquare}
            disabled={chat === null || chat.trim() === (current.chat_url ?? '')}
            loading={chatActions.busy}
            onPress={() =>
              void chatActions.setChatLink(current.id, chat?.trim() || null).then((saved) => {
                if (saved) {
                  setChat(null);
                  setMessage({ tone: 'success', text: 'Chat link saved.' });
                }
              })
            }
          />
          <Text variant="section" accessibilityRole="header">
            Members
          </Text>
          <Text variant="label" tone="secondary">
            Tap a member to report, block, remove, or make them owner.
          </Text>
          <View style={{ gap: space.sm }}>
            {others.map((s) => (
              <LeagueRow key={s.member_id} standing={s} onPress={() => setMember(s)} />
            ))}
            {others.length === 0 ? (
              <Text variant="body" tone="secondary">
                No one else yet. Invite friends from the League tab.
              </Text>
            ) : null}
          </View>
        </>
      ) : (
        <RowGroup>
          <Row icon={Flag} label="Report league name" onPress={() => setReporting((r) => !r)} last={!reporting} />
          {reporting
            ? REPORT_REASONS.map((r, i) => (
                <Row
                  key={r.value}
                  label={r.label}
                  last={i === REPORT_REASONS.length - 1}
                  onPress={() => void run(() => api!.submitReport('league', null, r.value, current.id), 'Thanks. Moderators will review it.', () => setReporting(false))}
                />
              ))
            : null}
        </RowGroup>
      )}

      {current.is_owner && !alone ? (
        <InlineStatus title="To leave, make another member the owner first." />
      ) : (
        <DangerButton label={current.is_owner ? 'Close league' : 'Leave league'} icon={LogOut} onPress={() => setConfirmLeave(true)} />
      )}

      <ConfirmSheet
        visible={confirmLeave}
        title={current.is_owner ? `Close ${current.name}?` : `Leave ${current.name}?`}
        body={
          current.is_owner
            ? 'You’re the only member, so the league closes and its invites stop working. Your runs and rank stay yours.'
            : 'You’ll stop appearing in the standings now. Your runs and rank stay yours. If you rejoin later, only runs after rejoining count that week.'
        }
        confirmLabel={current.is_owner ? 'Close league' : 'Leave league'}
        destructive
        busy={busy}
        onConfirm={() =>
          void run(() => api!.leaveLeague(current.id), 'Done.', () => {
            setConfirmLeave(false);
            router.back();
          })
        }
        onCancel={() => setConfirmLeave(false)}
      />
      <MemberSheet member={member} isOwner={current.is_owner} onClose={() => setMember(null)} onChanged={() => void league.refetch()} />
      {current.is_owner ? <PrimaryButton label="Done" onPress={() => router.back()} /> : null}
    </Screen>
  );
}
