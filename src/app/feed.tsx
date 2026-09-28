import { useRouter } from 'expo-router';
import { Newspaper, Users } from 'lucide-react-native';
import { RefreshControl, StyleSheet, View } from 'react-native';

import { RunSocialBar } from '@/components/social/run-social-bar';
import { SharedRunCard } from '@/components/social/shared-run-card';
import { SecondaryButton } from '@/components/ui/buttons';
import { EmptyState, InlineStatus } from '@/components/ui/elements';
import { Card, NavHeader, Screen } from '@/components/ui/layout';
import { useMe } from '@/features/data/hooks';
import { describeFeedError, useFeed, useFeedActions } from '@/features/social/use-feed';
import { Text } from '@/design/text';
import { colors, space } from '@/design/tokens';

/**
 * The feed (docs/ROADMAP.md 4.4): your runs, runs shared with you by people you follow, and runs
 * your league-mates share with the league, newest first. Cards show numbers only unless the runner
 * shared the map.
 */
export default function FeedScreen() {
  const router = useRouter();
  const units = useMe().data?.data.profile?.units ?? 'metric';
  const feed = useFeed();
  const actions = useFeedActions();
  const items = feed.data?.pages.flatMap((p) => p.items) ?? [];
  const open = (runId: string) => router.push({ pathname: '/shared/[id]', params: { id: runId } });

  return (
    <Screen
      edges={['top', 'bottom']}
      refreshControl={<RefreshControl refreshing={feed.isRefetching && !feed.isFetchingNextPage} onRefresh={() => void feed.refetch()} tintColor={colors.textSecondary} />}>
      <NavHeader title="Feed" />
      {feed.isError && items.length === 0 ? <InlineStatus tone="danger" title={describeFeedError(feed.error)} body="Pull to try again." /> : null}
      {actions.error ? <InlineStatus tone="danger" title={actions.error} /> : null}
      {feed.isPending ? (
        <Text variant="label" tone="secondary">
          Loading…
        </Text>
      ) : items.length === 0 && !feed.isError ? (
        <Card>
          <EmptyState
            icon={Newspaper}
            title="Nothing here yet."
            body="Runs you share, and runs your friends and league share with you, show up here. Follow friends from Profile › People.">
            <SecondaryButton label="Find people" icon={Users} onPress={() => router.push('/profile/people')} />
          </EmptyState>
        </Card>
      ) : (
        items.map((item) => (
          <View key={item.run_id} style={styles.item}>
            <SharedRunCard run={item} units={units} onPress={() => open(item.run_id)} />
            <RunSocialBar item={item} onKudos={() => void actions.toggleKudos(item)} onComments={() => open(item.run_id)} onKudosCount={() => open(item.run_id)} />
          </View>
        ))
      )}
      {feed.hasNextPage ? (
        <SecondaryButton label="Show more" onPress={() => void feed.fetchNextPage()} loading={feed.isFetchingNextPage} testID="feed-more" />
      ) : items.length > 0 ? (
        <Text variant="caption" tone="secondary" align="center">
          That’s everything for now.
        </Text>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  item: { gap: space.xs },
});
