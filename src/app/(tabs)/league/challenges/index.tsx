import { RefreshControl } from 'react-native';

import { ChallengeCard } from '@/components/league/challenge-card';
import { EmptyState, InlineStatus } from '@/components/ui/elements';
import { Card, NavHeader, Screen } from '@/components/ui/layout';
import { useChallenges } from '@/features/challenges/use-challenges';
import { Text } from '@/design/text';
import { colors } from '@/design/tokens';
import { useNow } from '@/lib/use-now';

/**
 * Challenges (docs/ROADMAP.md 4.6): this month's challenges for everyone, the ones your leagues
 * and clubs set, and the ones you finished. They count days and a capped score, never raw
 * distance, and each comes with a badge.
 */
export default function ChallengesScreen() {
  const now = useNow(60_000);
  const challenges = useChallenges();
  const data = challenges.data?.data;
  const everyone = (data?.current ?? []).filter((c) => c.scope === 'global');
  const groups = (data?.current ?? []).filter((c) => c.scope !== 'global');
  const past = data?.past ?? [];

  return (
    <Screen
      edges={['top', 'bottom']}
      refreshControl={
        <RefreshControl refreshing={challenges.isFetching && !challenges.isPending} onRefresh={() => void challenges.refetch()} tintColor={colors.textSecondary} />
      }>
      <NavHeader title="Challenges" />
      <Text variant="body" tone="secondary">
        Monthly goals that count the days you run and your best three days each week, never raw distance, so one huge run can’t win. Each one you
        finish is a badge.
      </Text>
      {challenges.data?.source === 'cache' ? <InlineStatus title="Offline — showing saved challenges." /> : null}
      {challenges.isError && !data ? <InlineStatus tone="danger" title="Couldn’t load challenges." body="Pull to try again." /> : null}

      {everyone.length > 0 ? (
        <Text variant="section" accessibilityRole="header">
          For everyone
        </Text>
      ) : null}
      {everyone.map((c) => (
        <ChallengeCard key={c.id} challenge={c} now={now} />
      ))}

      {data ? (
        <Text variant="section" accessibilityRole="header">
          Your leagues and clubs
        </Text>
      ) : null}
      {groups.map((c) => (
        <ChallengeCard key={c.id} challenge={c} now={now} />
      ))}
      {data && groups.length === 0 ? (
        <Card>
          <EmptyState title="No group challenges right now." body="A league’s owner or a club’s admins can set one from the league or club page." />
        </Card>
      ) : null}

      {past.length > 0 ? (
        <Text variant="section" accessibilityRole="header">
          Finished
        </Text>
      ) : null}
      {past.map((c) => (
        <ChallengeCard key={c.id} challenge={c} now={now} />
      ))}
    </Screen>
  );
}
