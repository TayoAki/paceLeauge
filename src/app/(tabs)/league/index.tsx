import { useRouter } from 'expo-router';
import { CircleHelp, Flag, MessagesSquare, Newspaper, Plus, Settings2, Timer, Trophy, Users, UsersRound } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Linking, RefreshControl, StyleSheet, View } from 'react-native';

import type { Standing } from '@/api/schemas';
import { GroupChallengesCard } from '@/components/league/challenge-card';
import { DuelsCard } from '@/components/league/duels-card';
import { FamilyAdminCard, FamilyJoinCard } from '@/components/league/family-cards';
import { GroupRunsCard } from '@/components/league/group-runs-card';
import { LeaderboardInvite } from '@/components/league/leaderboard-invite';
import { LeagueRow } from '@/components/league/league-row';
import { RecapCard } from '@/components/league/recap-card';
import { SeasonCard } from '@/components/league/season-card';
import { IconButton, PrimaryButton, SecondaryButton, TextButton } from '@/components/ui/buttons';
import { ChoiceChips, EmptyState, InlineStatus, Pill, Row, RowGroup, SegmentedControl } from '@/components/ui/elements';
import { Card, LargeHeader, Screen } from '@/components/ui/layout';
import { formatXp, ordinal } from '@/domain/format';
import { useLeague, useLeagueCheers, useMe } from '@/features/data/hooks';
import { useAccount } from '@/features/account/account-provider';
import { useTeen } from '@/features/account/teen';
import { InviteSheet, MemberSheet } from '@/features/leagues/league-sheets';
import { recapWeek } from '@/features/leagues/recap';
import { useSelectedLeague } from '@/features/leagues/selected-league';
import { deviceTimeZone, weekStateLine } from '@/features/leagues/week-copy';
import { Text } from '@/design/text';
import { colors, space } from '@/design/tokens';
import { useNow } from '@/lib/use-now';

/**
 * The feed (docs/ROADMAP.md 4.4), clubs (4.5), challenges (4.6), leaderboards (4.7) and segments
 * (5.3). A teen account (4.10) has only its family league's challenges.
 */
type SocialPath = '/feed' | '/league/clubs' | '/league/challenges' | '/league/leaderboards' | '/league/segments';

function SocialRows({ open, teen }: { open: (path: SocialPath) => void; teen: boolean }) {
  if (teen) {
    return (
      <RowGroup>
        <Row icon={Flag} label="Challenges" hint="Your family league’s goals, with a badge each" onPress={() => open('/league/challenges')} last testID="open-challenges" />
      </RowGroup>
    );
  }
  return (
    <RowGroup>
      <Row icon={Newspaper} label="Feed" hint="Runs your friends and league share, with kudos and comments" onPress={() => open('/feed')} testID="open-feed" />
      <Row icon={UsersRound} label="Clubs" hint="Bigger groups with a weekly board and group runs" onPress={() => open('/league/clubs')} testID="open-clubs" />
      <Row icon={Flag} label="Challenges" hint="Monthly goals with a badge each" onPress={() => open('/league/challenges')} testID="open-challenges" />
      <Row
        icon={Trophy}
        label="Leaderboards"
        hint="Weekly boards for your tier and country, if you join"
        onPress={() => open('/league/leaderboards')}
        testID="open-leaderboards"
      />
      <Row icon={Timer} label="Segments" hint="Timed stretches of path with a board each, if you join" onPress={() => open('/league/segments')} last testID="open-segments" />
    </RowGroup>
  );
}

/** S08 (no crew) · S09 private weekly league. */
export default function LeagueScreen() {
  const router = useRouter();
  const [weekOffset, setWeekOffset] = useState<0 | -1>(0);
  const league = useLeague(weekOffset);
  const cheers = useLeagueCheers(weekOffset);
  const [, selectLeague] = useSelectedLeague();
  const units = useMe().data?.data.profile?.units ?? 'metric';
  const now = useNow(60_000);
  const { api } = useAccount();
  const { isTeen } = useTeen();
  const [cheerError, setCheerError] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [member, setMember] = useState<Standing | null>(null);
  const view = league.data?.data;
  // The league picked earlier is gone (left, removed or closed): show the first one instead.
  const fallback = view && !view.league ? (view.leagues?.[0]?.id ?? null) : null;
  useEffect(() => {
    if (fallback) selectLeague(fallback);
  }, [fallback, selectLeague]);
  const refreshing = league.isFetching && !league.isPending;
  const refresh = (
    <RefreshControl
      refreshing={refreshing}
      onRefresh={() => {
        void league.refetch();
        void cheers.refetch();
      }}
      tintColor={colors.textSecondary}
    />
  );
  const cheerData = cheers.data?.data;
  const received = new Map((cheerData?.received ?? []).map((c) => [c.member_id, c.count]));
  const mine = new Set(cheerData?.mine ?? []);
  const cheer = async (memberId: string) => {
    if (!api) return;
    setCheerError(null);
    try {
      await api.cheerMember(memberId);
      await cheers.refetch();
    } catch {
      setCheerError('Couldn’t send your cheer. Try again.');
    }
  };

  if (league.isPending) {
    return (
      <Screen>
        <LargeHeader title="League" />
      </Screen>
    );
  }

  if (!view?.league) {
    return (
      <Screen refreshControl={refresh}>
        <LargeHeader title="League" />
        {league.isError ? <InlineStatus tone="danger" title="Couldn’t load your league." body="Pull to try again." /> : null}
        {isTeen ? (
          <FamilyJoinCard inLeague={false} />
        ) : (
          <>
            <SocialRows open={(path) => router.push(path)} teen={false} />
            <Card>
          <EmptyState icon={Users} title="A little friendly competition." body="Start a private league for your crew, or join one with an invite code. Your best three days each week count.">
            <PrimaryButton label="Create league" onPress={() => router.push('/league/create')} testID="create-league" />
            <SecondaryButton label="Join with code" onPress={() => router.push('/league/join')} testID="join-league" />
          </EmptyState>
            </Card>
          </>
        )}
        <TextButton label="How scoring works" icon={CircleHelp} onPress={() => router.push('/league/rules')} />
      </Screen>
    );
  }

  const me = view.me;
  const week = view.week;
  const standings = view.standings ?? [];
  const isOwner = view.league.is_owner;
  const leagueId = view.league.id;
  const leagues = view.leagues ?? [];
  const chatUrl = view.league.chat_url ?? null;
  const recap = recapWeek(new Date(now));
  const kindLabel = view.league.kind === 'family' ? 'Family league' : view.league.kind === 'work' ? 'Work league' : 'Private';

  return (
    <Screen refreshControl={refresh}>
      <LargeHeader
        title="League"
        action={
          isOwner ? (
            <IconButton icon={Plus} label="Invite friends" onPress={() => setInviteOpen(true)} />
          ) : (
            <IconButton icon={Settings2} label="League options" onPress={() => router.push('/league/manage')} />
          )
        }
      />
      {leagues.length > 1 ? (
        <ChoiceChips
          label="Your leagues"
          value={leagueId}
          onChange={(id) => {
            setWeekOffset(0);
            selectLeague(id);
          }}
          options={leagues.map((l) => ({ value: l.id, label: l.name }))}
        />
      ) : null}
      <View>
        <Text variant="title" numberOfLines={2}>
          {view.league.name}
        </Text>
        <Text variant="eyebrow" tone="secondary">
          {kindLabel} · {view.league.member_count} {view.league.member_count === 1 ? 'runner' : 'runners'}
        </Text>
      </View>
      {chatUrl ? (
        <SecondaryButton
          label="Open the group chat"
          icon={MessagesSquare}
          onPress={() => void Linking.openURL(chatUrl).catch(() => undefined)}
          accessibilityHint="Opens your crew’s chat app. There’s no chat inside PaceLeague."
        />
      ) : null}

      <SocialRows open={(path) => router.push(path)} teen={isTeen} />

      <SegmentedControl
        label="Week"
        value={weekOffset === 0 ? 'this' : 'last'}
        onChange={(v) => setWeekOffset(v === 'this' ? 0 : -1)}
        options={[
          { value: 'this', label: 'This week' },
          { value: 'last', label: 'Last week' },
        ]}
      />

      {league.data?.source === 'cache' ? <InlineStatus title="Offline — showing saved standings." /> : null}
      {!view.competition_enabled ? (
        <InlineStatus tone="warning" title="League scoring is paused." body="Your runs are saved and will count when scoring resumes." />
      ) : null}

      <Card>
        <View style={styles.hero} accessible accessibilityLabel={`Your week: ${formatXp(me?.weekly_xp ?? 0)} XP${me ? `, ${ordinal(me.rank)} place` : ''}. Your best 3 days count.`}>
          <View style={{ flex: 1 }}>
            <Text variant="eyebrow" tone="secondary">
              {weekOffset === 0 ? 'Your week' : 'Last week'}
            </Text>
            <Text variant="hero" numberOfLines={1} adjustsFontSizeToFit>
              {formatXp(me?.weekly_xp ?? 0)}
              <Text variant="title"> XP</Text>
            </Text>
            <Text variant="label" tone="secondary">
              Your best 3 days count.
            </Text>
          </View>
          {me && standings.length > 1 ? <Pill label={`${ordinal(me.rank)} place`} /> : null}
        </View>
      </Card>

      <View style={{ gap: space.sm }}>
        {weekOffset === 0 && cheerData && cheerData.cheered_me.length > 0 ? (
          <Text variant="label" tone="secondary" accessibilityLiveRegion="polite">
            Cheered this week by {cheerData.cheered_me.join(', ')}.
          </Text>
        ) : null}
        {cheerError ? <InlineStatus tone="danger" title={cheerError} /> : null}
        {standings.map((s) => (
          <LeagueRow
            key={s.member_id}
            standing={s}
            onPress={s.is_me ? undefined : () => setMember(s)}
            cheers={received.get(s.member_id) ?? 0}
            cheered={mine.has(s.member_id)}
            onCheer={weekOffset === 0 && !s.is_me && !s.hidden ? () => void cheer(s.member_id) : undefined}
          />
        ))}
      </View>

      {week ? (
        <Text variant="label" tone="secondary">
          {weekStateLine(week, deviceTimeZone())}
        </Text>
      ) : null}

      {view.league.kind === 'family' && isOwner ? <FamilyAdminCard leagueId={leagueId} /> : null}
      {!isTeen ? <LeaderboardInvite /> : null}
      {recap !== null && view.competition_enabled ? <RecapCard leagueId={leagueId} leagueName={view.league.name} weekOffset={recap} units={units} /> : null}
      <SeasonCard leagueId={leagueId} />
      <DuelsCard leagueId={leagueId} weekOffset={weekOffset} />
      <GroupChallengesCard target={{ leagueId }} canManage={isOwner} now={now} />
      <GroupRunsCard target={{ leagueId }} now={now} />

      {isOwner ? <PrimaryButton label="Invite friends" onPress={() => setInviteOpen(true)} testID="invite-friends" /> : null}
      <View style={styles.links}>
        <TextButton label="How scoring works" icon={CircleHelp} onPress={() => router.push('/league/rules')} />
        {isOwner ? <TextButton label="Manage league" onPress={() => router.push('/league/manage')} /> : null}
      </View>
      {isTeen ? (
        <FamilyJoinCard inLeague />
      ) : leagues.length < (view.max_leagues ?? 5) ? (
        <View style={styles.links}>
          <TextButton label="Start another league" icon={Plus} onPress={() => router.push('/league/create')} testID="another-league" />
          <TextButton label="Join with code" onPress={() => router.push('/league/join')} />
        </View>
      ) : (
        <Text variant="caption" tone="secondary" align="center">
          You’re in {leagues.length} leagues, the most at once.
        </Text>
      )}

      <InviteSheet visible={inviteOpen} onClose={() => setInviteOpen(false)} leagueName={view.league.name} leagueId={leagueId} />
      <MemberSheet member={member} isOwner={isOwner} onClose={() => setMember(null)} onChanged={() => void league.refetch()} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  links: { flexDirection: 'row', justifyContent: 'center', flexWrap: 'wrap' },
});
