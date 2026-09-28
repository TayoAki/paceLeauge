import { useLocalSearchParams, useRouter } from 'expo-router';
import { Crown, Flag, Globe, Lock, LogOut, MessagesSquare, Pencil, Share2, ShieldCheck, ShieldMinus, UserMinus } from 'lucide-react-native';
import { useState } from 'react';
import { Linking, Share, StyleSheet, View } from 'react-native';

import type { ClubMember } from '@/api/club-schemas';
import type { Standing } from '@/api/schemas';
import { GroupChallengesCard } from '@/components/league/challenge-card';
import { GroupRunsCard } from '@/components/league/group-runs-card';
import { LeagueRow } from '@/components/league/league-row';
import { ReportSheet, type ReportTarget } from '@/components/social/report-sheet';
import { PrimaryButton, SecondaryButton, TextButton } from '@/components/ui/buttons';
import { ConfirmSheet } from '@/components/ui/confirm-sheet';
import { InlineStatus, Row, RowGroup, SegmentedControl } from '@/components/ui/elements';
import { NavHeader, Screen } from '@/components/ui/layout';
import { Sheet } from '@/components/ui/sheet';
import { useClub, useClubActions, useClubBoard, useClubMembers } from '@/features/clubs/use-clubs';
import { formatCode } from '@/features/leagues/league-sheets';
import { Text } from '@/design/text';
import { colors, space } from '@/design/tokens';
import { useNow } from '@/lib/use-now';

const ROLE: Record<string, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' };

/**
 * A club's page (docs/ROADMAP.md 4.5): who runs it, the weekly board (best three days, as in
 * leagues), group runs, the group-chat link, and for the owner and admins the tools to run it.
 */
export default function ClubScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const now = useNow(60_000);
  const club = useClub(id ?? null);
  const data = club.data?.data;
  const [weekOffset, setWeekOffset] = useState<0 | -1>(0);
  const board = useClubBoard(id ?? null, weekOffset, data?.is_member === true);
  const isAdmin = data?.my_role === 'owner' || data?.my_role === 'admin';
  const [showMembers, setShowMembers] = useState(false);
  const members = useClubMembers(id ?? null, showMembers && data?.is_member === true);
  const actions = useClubActions();
  const [member, setMember] = useState<ClubMember | null>(null);
  const [confirm, setConfirm] = useState<'leave' | 'remove' | 'transfer' | null>(null);
  const [report, setReport] = useState<ReportTarget | null>(null);
  const [invite, setInvite] = useState<string | null>(null);

  if (!data || !id) {
    return (
      <Screen edges={['top', 'bottom']}>
        <NavHeader title="Club" />
        {club.isError ? (
          <InlineStatus title="This club isn’t available." body="It may be invite-only, or it has closed." />
        ) : (
          <Text variant="label" tone="secondary">
            Loading…
          </Text>
        )}
      </Screen>
    );
  }

  const shareInvite = async () => {
    const created = await actions.invite(id);
    if (!created) return;
    setInvite(created.code);
    await Share.share({ message: `Join ${data.name} on PaceLeague: in League › Clubs, enter the code ${formatCode(created.code)}.` }).catch(() => undefined);
  };

  const rows: Standing[] = (board.data?.data.rows ?? []).map((r) => ({ ...r, is_owner: r.role === 'owner' }));
  const me = board.data?.data.me;
  const memberName = member ? (member.hidden ? 'this runner' : (member.alias ?? 'this runner')) : '';
  // Read here, not inside a handler: the compiler treats values a handler reads as render inputs.
  const memberId = member?.member_id ?? null;
  const chatUrl = data.chat_url;

  return (
    <Screen edges={['top', 'bottom']}>
      <NavHeader title={data.name} />
      <View style={styles.head}>
        <View style={styles.row}>
          {data.visibility === 'public' ? <Globe size={16} color={colors.textSecondary} /> : <Lock size={16} color={colors.textSecondary} />}
          <Text variant="label" tone="secondary">
            {data.visibility === 'public' ? 'Public club' : 'Invite-only club'} · {data.member_count} {data.member_count === 1 ? 'runner' : 'runners'}
          </Text>
        </View>
        {data.description ? <Text variant="body">{data.description}</Text> : null}
        {data.admins.length > 0 ? (
          <Text variant="caption" tone="secondary">
            Run by {data.admins.map((a) => a.alias).join(', ')}
          </Text>
        ) : null}
      </View>
      {actions.error ? <InlineStatus tone="danger" title={actions.error} /> : null}

      {!data.is_member ? (
        data.can_join ? (
          <PrimaryButton label="Join club" onPress={() => void actions.join(id)} loading={actions.busy} testID="join-club" />
        ) : (
          <InlineStatus title={data.member_count >= data.capacity ? 'This club is full.' : 'You can’t join this club.'} />
        )
      ) : (
        <>
          {data.chat_url ? (
            <SecondaryButton
              label="Open the group chat"
              icon={MessagesSquare}
              onPress={() => {
                if (chatUrl) void Linking.openURL(chatUrl).catch(() => undefined);
              }}
              accessibilityHint="Opens your club’s chat app. There’s no chat inside PaceLeague."
            />
          ) : null}

          <Text variant="section" accessibilityRole="header">
            This week’s board
          </Text>
          <SegmentedControl
            label="Week"
            value={weekOffset === 0 ? 'this' : 'last'}
            onChange={(v) => setWeekOffset(v === 'this' ? 0 : -1)}
            options={[
              { value: 'this', label: 'This week' },
              { value: 'last', label: 'Last week' },
            ]}
          />
          <Text variant="caption" tone="secondary">
            Best three days count, from when each runner joined. Only members see the board.
          </Text>
          <View style={styles.board}>
            {rows.slice(0, 20).map((s) => (
              <LeagueRow key={s.member_id} standing={s} />
            ))}
            {me && !rows.slice(0, 20).some((s) => s.is_me) ? <LeagueRow standing={{ ...me, is_owner: me.role === 'owner' }} /> : null}
            {(board.data?.data.members ?? 0) > 20 ? (
              <Text variant="caption" tone="secondary">
                Top 20 of {board.data?.data.members} runners.
              </Text>
            ) : null}
          </View>

          <GroupChallengesCard target={{ clubId: id }} canManage={isAdmin} now={now} />
          <GroupRunsCard target={{ clubId: id }} now={now} onReport={(groupRunId) => setReport({ kind: 'group_run', id: groupRunId, owner: null })} />

          <RowGroup>
            {isAdmin ? <Row icon={Share2} label="Share an invite code" hint="Codes work for 14 days" onPress={() => void shareInvite()} testID="club-invite" /> : null}
            {isAdmin ? <Row icon={Pencil} label="Edit club" onPress={() => router.push({ pathname: '/league/clubs/edit', params: { id } })} /> : null}
            <Row
              icon={ShieldCheck}
              label={isAdmin ? 'Members and roles' : 'Members'}
              value={showMembers ? 'Hide' : undefined}
              onPress={() => setShowMembers((v) => !v)}
              last
              testID="club-members"
            />
          </RowGroup>
          {invite ? <InlineStatus tone="success" title={`Invite code: ${formatCode(invite)}`} body="Anyone with it can join for the next 14 days." /> : null}
          {showMembers ? (
            <RowGroup>
              {(members.data?.data ?? []).map((m, i, all) => (
                <Row
                  key={m.member_id}
                  label={m.hidden ? 'Hidden runner' : m.is_me ? `${m.alias} (you)` : (m.alias ?? 'Runner')}
                  value={ROLE[m.role]}
                  onPress={isAdmin && !m.is_me && m.role !== 'owner' ? () => setMember(m) : undefined}
                  last={i === all.length - 1}
                />
              ))}
            </RowGroup>
          ) : null}
        </>
      )}

      <View style={styles.links}>
        {data.my_role !== 'owner' ? <TextButton label="Report club" icon={Flag} onPress={() => setReport({ kind: 'club', id, owner: null })} /> : null}
        {data.is_member ? <TextButton label="Leave club" icon={LogOut} tone="danger" onPress={() => setConfirm('leave')} testID="leave-club" /> : null}
      </View>

      <Sheet visible={member !== null} onClose={() => setMember(null)} title={memberName} busy={actions.busy}>
        {member ? (
          <RowGroup style={{ backgroundColor: colors.surface }}>
            {data.my_role === 'owner' ? (
              member.role === 'admin' ? (
                <Row icon={ShieldMinus} label="Remove as admin" onPress={() => void actions.demote(id, member.member_id).then(() => setMember(null))} />
              ) : (
                <Row icon={ShieldCheck} label="Make admin" hint="Admins can edit the page, invite, remove members and group runs" onPress={() => void actions.promote(id, member.member_id).then(() => setMember(null))} />
              )
            ) : null}
            {data.my_role === 'owner' ? <Row icon={Crown} label="Make owner" onPress={() => setConfirm('transfer')} /> : null}
            {data.my_role === 'owner' || member.role === 'member' ? (
              <Row icon={UserMinus} label="Remove from club" tone="danger" onPress={() => setConfirm('remove')} last />
            ) : null}
          </RowGroup>
        ) : null}
      </Sheet>

      <ConfirmSheet
        visible={confirm === 'remove'}
        title={`Remove ${memberName}?`}
        body="They leave the club now and can’t rejoin. They aren’t told why."
        confirmLabel="Remove from club"
        destructive
        busy={actions.busy}
        onConfirm={() => {
          if (!memberId) return;
          void actions.remove(id, memberId).then(() => {
            setConfirm(null);
            setMember(null);
          });
        }}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmSheet
        visible={confirm === 'transfer'}
        title={`Make ${memberName} the owner?`}
        body="You’ll stay on as an admin."
        confirmLabel="Make owner"
        busy={actions.busy}
        onConfirm={() => {
          if (!memberId) return;
          void actions.transfer(id, memberId).then(() => {
            setConfirm(null);
            setMember(null);
          });
        }}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmSheet
        visible={confirm === 'leave'}
        title={data.my_role === 'owner' ? `Close ${data.name}?` : `Leave ${data.name}?`}
        body={
          data.my_role === 'owner'
            ? 'If anyone else is in the club, make them the owner first. Alone, leaving closes the club.'
            : 'You leave the board and group runs. You can rejoin later.'
        }
        confirmLabel={data.my_role === 'owner' ? 'Close club' : 'Leave club'}
        destructive
        busy={actions.busy}
        onConfirm={() =>
          void actions.leave(id).then((left) => {
            setConfirm(null);
            if (left !== null) router.back();
          })
        }
        onCancel={() => setConfirm(null)}
      />
      <ReportSheet target={report} onClose={() => setReport(null)} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { gap: space.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  board: { gap: space.sm },
  links: { flexDirection: 'row', flexWrap: 'wrap', gap: space.lg, justifyContent: 'center' },
});
