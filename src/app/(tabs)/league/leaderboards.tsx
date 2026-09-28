import { useLocales } from 'expo-localization';
import { EyeOff, Globe, LogOut, Trophy } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, RefreshControl, StyleSheet, View } from 'react-native';

import { leaderboardTiers, type LeaderboardKind, type LeaderboardRow } from '@/api/leaderboard-schemas';
import { CountrySheet } from '@/components/league/country-sheet';
import { ReportSheet, type ReportTarget } from '@/components/social/report-sheet';
import { PrimaryButton, TextButton } from '@/components/ui/buttons';
import { ConfirmSheet } from '@/components/ui/confirm-sheet';
import { ChoiceChips, InlineStatus, Row, RowGroup, SegmentedControl } from '@/components/ui/elements';
import { Card, NavHeader, Screen } from '@/components/ui/layout';
import { ordinal } from '@/domain/format';
import { countryName } from '@/features/leaderboards/countries';
import { boardStateLine, defaultCountry, eligibilityLine, myStatusLine } from '@/features/leaderboards/leaderboard-text';
import { useLeaderboard, useLeaderboardActions, useLeaderboardStatus } from '@/features/leaderboards/use-leaderboards';
import { deviceTimeZone } from '@/features/leagues/week-copy';
import { Text } from '@/design/text';
import { colors, radius, space } from '@/design/tokens';

const WEEKS = [
  { value: '0', label: 'This week' },
  { value: '-1', label: 'Last week' },
  { value: '-2', label: '2 weeks ago' },
];

function BoardRow({ row, onPress }: { row: LeaderboardRow; onPress?: () => void }) {
  const name = row.hidden ? 'Hidden runner' : row.is_me ? 'You' : (row.alias ?? 'Runner');
  const body = (
    <>
      <Text variant="section" tone="secondary" style={styles.rank} maxFontSizeMultiplier={1.3}>
        {row.rank}
      </Text>
      {row.hidden ? <EyeOff size={16} color={colors.textSecondary} /> : null}
      <View style={styles.fill}>
        <Text variant="bodyStrong" tone={row.hidden ? 'secondary' : 'primary'} numberOfLines={1}>
          {name}
        </Text>
        <Text variant="caption" tone="secondary">
          {row.tier}
        </Text>
      </View>
      <Text variant="section">{row.score}</Text>
    </>
  );
  const label = `${ordinal(row.rank)}, ${name}, ${row.tier}, ${row.score} this week`;
  return onPress ? (
    <Pressable
      style={({ pressed }) => [styles.row, row.is_me && styles.me, pressed && { opacity: 0.8 }]}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint="Report this result"
      onPress={onPress}>
      {body}
    </Pressable>
  ) : (
    <View style={[styles.row, row.is_me && styles.me]} accessible accessibilityLabel={label}>
      {body}
    </View>
  );
}

/**
 * Global and regional leaderboards (docs/ROADMAP.md 4.7, decision 7): opt-in weekly boards for
 * your tier and your country, scored like leagues (best three days, capped). Only a runner's
 * name, tier and weekly score are shown, never a route. Anyone can look; only runners who
 * joined appear.
 */
export default function LeaderboardsScreen() {
  const statusQuery = useLeaderboardStatus();
  const status = statusQuery.data?.data;
  const actions = useLeaderboardActions();
  const suggested = defaultCountry(useLocales()[0]?.regionCode);
  const [kind, setKind] = useState<LeaderboardKind>('tier');
  const [tier, setTier] = useState<string | null>(null);
  const [weekOffset, setWeekOffset] = useState(0);
  const [picking, setPicking] = useState(false);
  const [pendingCountry, setPendingCountry] = useState<string | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [report, setReport] = useState<ReportTarget | null>(null);
  const key = kind === 'tier' ? tier : status?.joined ? null : (pendingCountry ?? suggested);
  const boardQuery = useLeaderboard(kind, key, weekOffset, status !== undefined);
  const board = boardQuery.data?.data;
  const country = status?.joined ? status.country : (pendingCountry ?? suggested);
  const rows = board?.rows ?? [];
  const eligibility = status ? eligibilityLine(status) : null;
  const mine = board ? myStatusLine(board.my_status) : null;

  return (
    <Screen
      edges={['top', 'bottom']}
      refreshControl={
        <RefreshControl
          refreshing={boardQuery.isFetching && !boardQuery.isPending}
          onRefresh={() => {
            void statusQuery.refetch();
            void boardQuery.refetch();
          }}
          tintColor={colors.textSecondary}
        />
      }>
      <NavHeader title="Leaderboards" />
      {status && !status.joined ? (
        <Card style={styles.card}>
          <View style={styles.head}>
            <Trophy size={20} color={colors.accent} />
            <Text variant="labelStrong" accessibilityRole="header" style={styles.fill}>
              See how your week compares
            </Text>
          </View>
          <Text variant="body" tone="secondary">
            Weekly boards for your tier and your country, scored like leagues: your best three days, capped, from runs that count. Only your runner name, tier
            and weekly score are shown, never a route. You can leave any time.
          </Text>
          {status.removed ? (
            <InlineStatus tone="warning" title="A moderator took you off the leaderboards." />
          ) : (
            <>
              <RowGroup style={{ backgroundColor: colors.surfaceElevated }}>
                <Row icon={Globe} label="Country" value={countryName(country)} onPress={() => setPicking(true)} last testID="leaderboard-country" />
              </RowGroup>
              <PrimaryButton label="Join the leaderboards" onPress={() => void actions.join(country ?? 'US')} loading={actions.busy} testID="join-leaderboards" />
            </>
          )}
        </Card>
      ) : null}
      {actions.error ? <InlineStatus tone="danger" title={actions.error} /> : null}
      {eligibility ? <InlineStatus title={eligibility} /> : null}

      <SegmentedControl<LeaderboardKind>
        label="Board"
        value={kind}
        onChange={setKind}
        options={[
          { value: 'tier', label: 'Tier' },
          { value: 'country', label: country ? countryName(country) : 'Country' },
        ]}
      />
      {kind === 'tier' ? (
        <ChoiceChips
          label="Tier"
          value={tier ?? board?.key ?? status?.tier ?? 'Seed'}
          onChange={setTier}
          options={leaderboardTiers.map((t) => ({ value: t, label: t }))}
        />
      ) : null}
      <ChoiceChips label="Week" value={String(weekOffset)} onChange={(v) => setWeekOffset(Number(v))} options={WEEKS} />

      {board ? (
        <Text variant="caption" tone="secondary">
          {boardStateLine(board, deviceTimeZone())} {board.runners} {board.runners === 1 ? 'runner' : 'runners'} on this board.
        </Text>
      ) : null}
      {boardQuery.isError && !board ? <InlineStatus tone="danger" title="Couldn’t load the board." body="Pull to try again." /> : null}
      {mine ? <InlineStatus tone="warning" title={mine} /> : null}
      <View style={styles.board}>
        {rows.map((r) => (
          <BoardRow key={r.result_id} row={r} onPress={r.is_me ? undefined : () => setReport({ kind: 'leaderboard', id: r.result_id, owner: null })} />
        ))}
        {board?.me && !rows.some((r) => r.is_me) ? <BoardRow row={board.me} /> : null}
        {board && rows.length === 0 ? (
          <Text variant="label" tone="secondary">
            Nobody on this board yet.
          </Text>
        ) : null}
      </View>

      {status?.joined ? (
        <View style={styles.links}>
          <TextButton label="Change country" icon={Globe} onPress={() => setPicking(true)} />
          <TextButton label="Leave leaderboards" icon={LogOut} onPress={() => setConfirmLeave(true)} testID="leave-leaderboards" />
        </View>
      ) : null}

      <CountrySheet
        visible={picking}
        current={country ?? null}
        suggested={suggested}
        onClose={() => setPicking(false)}
        onPick={(code) => {
          setPicking(false);
          if (status?.joined) void actions.join(code);
          else setPendingCountry(code);
        }}
      />
      <ConfirmSheet
        visible={confirmLeave}
        title="Leave the leaderboards?"
        body="You come off every board straight away, past weeks included. Your runs, XP and leagues don’t change, and you can join again."
        confirmLabel="Leave leaderboards"
        busy={actions.busy}
        onConfirm={() => void actions.leave().then(() => setConfirmLeave(false))}
        onCancel={() => setConfirmLeave(false)}
      />
      <ReportSheet target={report} onClose={() => setReport(null)} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: { gap: space.sm },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  fill: { flex: 1 },
  board: { gap: space.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: colors.surface,
    borderRadius: radius.control + 4,
    paddingHorizontal: space.lg,
    minHeight: 56,
    borderWidth: 1.5,
    borderColor: 'transparent',
  },
  me: { borderColor: colors.accent },
  rank: { minWidth: 28, textAlign: 'center' },
  links: { flexDirection: 'row', flexWrap: 'wrap', gap: space.lg, justifyContent: 'center' },
});
