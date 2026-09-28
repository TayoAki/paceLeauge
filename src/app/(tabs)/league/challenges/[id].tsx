import { useLocalSearchParams, useRouter } from 'expo-router';
import { Award, Check, EyeOff, Flag, LogOut, Trash2 } from 'lucide-react-native';
import { useState } from 'react';
import { RefreshControl, StyleSheet, View } from 'react-native';

import type { ChallengeBoardRow } from '@/api/challenge-schemas';
import { challengeSource } from '@/components/league/challenge-card';
import { ReportSheet, type ReportTarget } from '@/components/social/report-sheet';
import { PrimaryButton, TextButton } from '@/components/ui/buttons';
import { ConfirmSheet } from '@/components/ui/confirm-sheet';
import { InlineStatus, ProgressBar } from '@/components/ui/elements';
import { Card, NavHeader, Screen } from '@/components/ui/layout';
import {
  challengeToday,
  dayLabel,
  fairnessLine,
  goalLine,
  monthLabel,
  progressFraction,
  progressLabel,
  stateLine,
  unit,
} from '@/features/challenges/challenge-text';
import { useChallenge, useChallengeActions } from '@/features/challenges/use-challenges';
import { Text } from '@/design/text';
import { colors, radius, space } from '@/design/tokens';
import { useNow } from '@/lib/use-now';

function BoardRow({ row, metric }: { row: ChallengeBoardRow; metric: 'active_days' | 'capped_score' }) {
  const name = row.hidden ? 'Hidden runner' : row.is_me ? 'You' : (row.alias ?? 'Runner');
  const amount = `${row.progress.toLocaleString('en-US')} ${unit(metric, row.progress)}`;
  return (
    <View
      style={[styles.boardRow, row.is_me && styles.me]}
      accessible
      accessibilityLabel={`${row.rank}. ${name}, ${amount}${row.completed && row.completed_on ? `, finished ${dayLabel(row.completed_on)}` : ''}`}>
      <Text variant="section" tone="secondary" style={styles.rank} maxFontSizeMultiplier={1.3}>
        {row.rank}
      </Text>
      {row.hidden ? <EyeOff size={16} color={colors.textSecondary} /> : null}
      <Text variant="bodyStrong" tone={row.hidden ? 'secondary' : 'primary'} numberOfLines={1} style={styles.fill}>
        {name}
      </Text>
      {row.completed ? <Check size={18} color={colors.accent} strokeWidth={2.6} /> : null}
      <Text variant="label">{amount}</Text>
    </View>
  );
}

/**
 * One challenge (docs/ROADMAP.md 4.6): what it asks, when it runs, your progress (joined or
 * not), and for a league's or club's challenge the board of everyone who joined.
 */
export default function ChallengeScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const now = useNow(60_000);
  const query = useChallenge(id ?? null);
  const challenge = query.data?.data;
  const actions = useChallengeActions();
  const [confirm, setConfirm] = useState<'leave' | 'remove' | null>(null);
  const [report, setReport] = useState<ReportTarget | null>(null);

  if (!challenge || !id) {
    return (
      <Screen edges={['top', 'bottom']}>
        <NavHeader title="Challenge" />
        {query.isError ? (
          <InlineStatus title="This challenge isn’t available." body="It may have been removed, or it belongs to a league or club you’re not in." />
        ) : (
          <Text variant="label" tone="secondary">
            Loading…
          </Text>
        )}
      </Screen>
    );
  }

  const open = challenge.state === 'upcoming' || challenge.state === 'open';
  const progress = progressLabel(challenge.metric, challenge.progress, challenge.target);
  const board = challenge.board;
  const rows = board?.rows ?? [];
  const month = monthLabel(challenge.starts_on);
  const status = challenge.completed
    ? `Done on ${dayLabel(challenge.completed_on ?? challenge.ends_on)}. The badge is yours.`
    : challenge.joined
      ? challenge.state === 'final'
        ? 'Not finished this time.'
        : 'Runs count as they arrive.'
      : challenge.progress > 0 && open
        ? `You already have ${challenge.progress.toLocaleString('en-US')} ${unit(challenge.metric, challenge.progress)} in ${month}. Join to go for the badge.`
        : 'Join to go for the badge.';

  return (
    <Screen
      edges={['top', 'bottom']}
      refreshControl={<RefreshControl refreshing={query.isFetching && !query.isPending} onRefresh={() => void query.refetch()} tintColor={colors.textSecondary} />}>
      <NavHeader title="Challenge" />
      <View style={styles.head}>
        <Text variant="title">{challenge.title}</Text>
        <Text variant="label" tone="secondary">
          {challengeSource(challenge)} · {stateLine(challenge.state, challenge.starts_on, challenge.ends_on, challengeToday(now))}
        </Text>
        {challenge.created_by && challenge.scope !== 'global' ? (
          <Text variant="caption" tone="secondary">
            Set by {challenge.is_creator ? 'you' : challenge.created_by}
          </Text>
        ) : null}
      </View>
      <Text variant="body">{goalLine(challenge.metric, challenge.target)}</Text>
      <Text variant="caption" tone="secondary">
        {fairnessLine(challenge.metric)} Runs from all of {month} count, including ones from before you joined.
      </Text>

      <Card style={styles.card}>
        <View style={styles.row}>
          {challenge.completed ? <Award size={22} color={colors.accent} /> : null}
          <Text variant="section" style={styles.fill}>
            {progress}
          </Text>
        </View>
        <ProgressBar fraction={progressFraction(challenge.progress, challenge.target)} label={`Your progress: ${progress}`} />
        <Text variant="label" tone="secondary" accessibilityLiveRegion="polite">
          {status}
        </Text>
      </Card>
      {actions.error ? <InlineStatus tone="danger" title={actions.error} /> : null}
      {!challenge.joined && open ? <PrimaryButton label="Join challenge" onPress={() => void actions.join(id)} loading={actions.busy} testID="join-challenge" /> : null}

      {board ? (
        <>
          <Text variant="section" accessibilityRole="header">
            Board
          </Text>
          <Text variant="caption" tone="secondary">
            {challenge.participants} {challenge.participants === 1 ? 'runner' : 'runners'} joined
            {board.finished > 0 ? ` · ${board.finished} finished` : ''}. Ties go to whoever got there first.
          </Text>
          <View style={styles.board}>
            {rows.slice(0, 50).map((r) => (
              <BoardRow key={r.position} row={r} metric={challenge.metric} />
            ))}
            {board.me && !rows.slice(0, 50).some((r) => r.is_me) ? <BoardRow row={board.me} metric={challenge.metric} /> : null}
          </View>
        </>
      ) : (
        <Text variant="caption" tone="secondary">
          {challenge.participants.toLocaleString('en-US')} {challenge.participants === 1 ? 'runner has' : 'runners have'} joined. There’s no public board: only you see
          your progress.
        </Text>
      )}

      <View style={styles.links}>
        {challenge.joined && open ? <TextButton label="Leave challenge" icon={LogOut} onPress={() => setConfirm('leave')} testID="leave-challenge" /> : null}
        {challenge.scope !== 'global' && !challenge.is_creator ? (
          <TextButton label="Report challenge" icon={Flag} onPress={() => setReport({ kind: 'challenge', id, owner: null })} />
        ) : null}
        {challenge.can_manage && open ? <TextButton label="Remove challenge" icon={Trash2} tone="danger" onPress={() => setConfirm('remove')} /> : null}
      </View>

      <ConfirmSheet
        visible={confirm === 'leave'}
        title="Leave this challenge?"
        body="You come off its board. Your runs stay, and you can join again before it ends."
        confirmLabel="Leave challenge"
        busy={actions.busy}
        onConfirm={() => void actions.leave(id).then(() => setConfirm(null))}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmSheet
        visible={confirm === 'remove'}
        title="Remove this challenge?"
        body="It’s taken down for everyone who joined, with its board."
        confirmLabel="Remove challenge"
        destructive
        busy={actions.busy}
        onConfirm={() =>
          void actions.remove(id).then((removed) => {
            setConfirm(null);
            if (removed) router.back();
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
  card: { gap: space.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  fill: { flex: 1 },
  board: { gap: space.sm },
  boardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: colors.surface,
    borderRadius: radius.control + 4,
    paddingHorizontal: space.lg,
    minHeight: 52,
    borderWidth: 1.5,
    borderColor: 'transparent',
  },
  me: { borderColor: colors.accent },
  rank: { minWidth: 24, textAlign: 'center' },
  links: { flexDirection: 'row', flexWrap: 'wrap', gap: space.lg, justifyContent: 'center' },
});
