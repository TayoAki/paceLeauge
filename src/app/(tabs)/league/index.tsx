import { useRouter } from 'expo-router';
import { CircleHelp, Newspaper, Plus, Settings2, Users } from 'lucide-react-native';
import { useState } from 'react';
import { RefreshControl, StyleSheet, View } from 'react-native';

import type { Standing } from '@/api/schemas';
import { LeagueRow } from '@/components/league/league-row';
import { IconButton, PrimaryButton, SecondaryButton, TextButton } from '@/components/ui/buttons';
import { EmptyState, InlineStatus, Pill, Row, RowGroup, SegmentedControl } from '@/components/ui/elements';
import { Card, LargeHeader, Screen } from '@/components/ui/layout';
import { formatXp, ordinal } from '@/domain/format';
import { useLeague, useLeagueCheers } from '@/features/data/hooks';
import { useAccount } from '@/features/account/account-provider';
import { InviteSheet, MemberSheet } from '@/features/leagues/league-sheets';
import { deviceTimeZone, weekStateLine } from '@/features/leagues/week-copy';
import { Text } from '@/design/text';
import { colors, space } from '@/design/tokens';

/** The feed of runs from people you follow and your league (docs/ROADMAP.md 4.4). */
function FeedRow({ onPress }: { onPress: () => void }) {
  return (
    <RowGroup>
      <Row icon={Newspaper} label="Feed" hint="Runs your friends and league share, with kudos and comments" onPress={onPress} last testID="open-feed" />
    </RowGroup>
  );
}

/** S08 (no crew) · S09 private weekly league. */
export default function LeagueScreen() {
  const router = useRouter();
  const [weekOffset, setWeekOffset] = useState<0 | -1>(0);
  const league = useLeague(weekOffset);
  const cheers = useLeagueCheers(weekOffset);
  const { api } = useAccount();
  const [cheerError, setCheerError] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [member, setMember] = useState<Standing | null>(null);
  const view = league.data?.data;
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
        <FeedRow onPress={() => router.push('/feed')} />
        <Card>
          <EmptyState icon={Users} title="A little friendly competition." body="Start a private league for your crew, or join one with an invite code. Your best three days each week count.">
            <PrimaryButton label="Create league" onPress={() => router.push('/league/create')} testID="create-league" />
            <SecondaryButton label="Join with code" onPress={() => router.push('/league/join')} testID="join-league" />
          </EmptyState>
        </Card>
        <TextButton label="How scoring works" icon={CircleHelp} onPress={() => router.push('/league/rules')} />
      </Screen>
    );
  }

  const me = view.me;
  const week = view.week;
  const standings = view.standings ?? [];
  const isOwner = view.league.is_owner;

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
      <View>
        <Text variant="title" numberOfLines={2}>
          {view.league.name}
        </Text>
        <Text variant="eyebrow" tone="secondary">
          Private · {view.league.member_count} {view.league.member_count === 1 ? 'runner' : 'runners'}
        </Text>
      </View>

      <FeedRow onPress={() => router.push('/feed')} />

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

      {isOwner ? <PrimaryButton label="Invite friends" onPress={() => setInviteOpen(true)} testID="invite-friends" /> : null}
      <View style={styles.links}>
        <TextButton label="How scoring works" icon={CircleHelp} onPress={() => router.push('/league/rules')} />
        {isOwner ? <TextButton label="Manage league" onPress={() => router.push('/league/manage')} /> : null}
      </View>

      <InviteSheet visible={inviteOpen} onClose={() => setInviteOpen(false)} leagueName={view.league.name} />
      <MemberSheet member={member} isOwner={isOwner} onClose={() => setMember(null)} onChanged={() => void league.refetch()} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  links: { flexDirection: 'row', justifyContent: 'center', flexWrap: 'wrap' },
});
