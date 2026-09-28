import { Award, Lock } from 'lucide-react-native';
import { useMemo } from 'react';
import { RefreshControl, StyleSheet, View } from 'react-native';

import { InlineStatus, ProgressBar } from '@/components/ui/elements';
import { Card, NavHeader, Screen } from '@/components/ui/layout';
import { useBadges } from '@/features/data/hooks';
import { BADGE_GROUPS, badgeViews, type BadgeView } from '@/features/progress/badges';
import { shortDate } from '@/features/progress/records';
import { Text } from '@/design/text';
import { colors, space } from '@/design/tokens';

/** Badges and milestones (docs/ROADMAP.md 1.8). Earned from runs that count; deleting the run takes the badge back. */
export default function BadgesScreen() {
  const badges = useBadges();
  const data = badges.data?.data;
  const views = useMemo(() => (data ? badgeViews(data) : []), [data]);
  const earned = views.filter((b) => b.earnedAtMs !== null).length;

  return (
    <Screen
      edges={['top', 'bottom']}
      refreshControl={<RefreshControl refreshing={badges.isFetching && !badges.isPending} onRefresh={() => void badges.refetch()} tintColor={colors.textSecondary} />}>
      <NavHeader title="Badges" />
      {badges.data?.source === 'cache' ? <InlineStatus title="Offline — showing saved badges." /> : null}
      {badges.isError && !data ? <InlineStatus tone="danger" title="Couldn’t load your badges." body="Pull to try again." /> : null}
      {data ? (
        <Text variant="body" tone="secondary">
          {earned} of {views.length} earned. Badges come from runs that count. They never change your XP.
        </Text>
      ) : null}

      {BADGE_GROUPS.map((group) => {
        const items = views.filter((b) => b.group === group);
        if (items.length === 0) return null;
        return (
          <Card key={group}>
            <Text variant="labelStrong" accessibilityRole="header">
              {group}
            </Text>
            {items.map((b) => (
              <BadgeRow key={b.code} badge={b} />
            ))}
          </Card>
        );
      })}
    </Screen>
  );
}

function BadgeRow({ badge }: { badge: BadgeView }) {
  const earned = badge.earnedAtMs !== null;
  const status = earned ? `Earned ${shortDate(badge.earnedAtMs!)}` : (badge.progressLabel ?? 'Not earned yet');
  return (
    <View style={styles.row} accessible accessibilityLabel={`${badge.title}. ${badge.description} ${status}.`}>
      <View style={[styles.icon, earned && styles.iconEarned]}>
        {earned ? <Award size={22} color={colors.onAccent} strokeWidth={2.2} /> : <Lock size={18} color={colors.textSecondary} />}
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="bodyStrong" tone={earned ? 'primary' : 'secondary'}>
          {badge.title}
        </Text>
        <Text variant="caption" tone="secondary">
          {badge.description}
        </Text>
        {earned ? (
          <Text variant="caption" tone="accent">
            {status}
          </Text>
        ) : badge.fraction !== null ? (
          <View style={styles.progress}>
            <View style={{ flex: 1 }}>
              <ProgressBar fraction={badge.fraction} label={`${badge.title}: ${status}`} height={4} />
            </View>
            <Text variant="caption" tone="secondary">
              {status}
            </Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 56 },
  icon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceElevated,
  },
  iconEarned: { backgroundColor: colors.accent },
  progress: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: 2 },
});
