import { useLocales } from 'expo-localization';
import { useRouter } from 'expo-router';
import { Trophy } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import { PrimaryButton, TextButton } from '@/components/ui/buttons';
import { InlineStatus } from '@/components/ui/elements';
import { Card } from '@/components/ui/layout';
import { countryName } from '@/features/leaderboards/countries';
import { defaultCountry, inviteCopy } from '@/features/leaderboards/leaderboard-text';
import { useLeaderboardActions, useLeaderboardStatus } from '@/features/leaderboards/use-leaderboards';
import { Text } from '@/design/text';
import { colors, space } from '@/design/tokens';

/**
 * The invitation to the leaderboards (docs/ROADMAP.md 4.7, decision 7): shown at a natural
 * moment (after winning a league's week, or after a full league week) to runners who never
 * joined; one tap joins, "Not now" hides it for four weeks.
 */
export function LeaderboardInvite() {
  const router = useRouter();
  const status = useLeaderboardStatus().data?.data;
  const actions = useLeaderboardActions();
  const country = defaultCountry(useLocales()[0]?.regionCode);
  if (!status?.invite) return null;
  const copy = inviteCopy(status.invite, status.tier);
  return (
    <Card style={styles.card}>
      <View style={styles.head}>
        <Trophy size={20} color={colors.accent} />
        <Text variant="labelStrong" accessibilityRole="header" style={styles.fill}>
          {copy.title}
        </Text>
      </View>
      <Text variant="body" tone="secondary">
        {copy.body}
      </Text>
      {actions.error ? <InlineStatus tone="danger" title={actions.error} /> : null}
      <PrimaryButton
        label="Join the leaderboards"
        accessibilityHint={`Joins the ${status.tier} board and the ${countryName(country)} board`}
        onPress={() =>
          void actions.join(country).then((joined) => {
            if (joined) router.push('/league/leaderboards');
          })
        }
        loading={actions.busy}
        testID="join-leaderboards-invite"
      />
      <Text variant="caption" tone="secondary">
        You’ll be on the {countryName(country)} board. You can change it on the leaderboards.
      </Text>
      <TextButton label="Not now" onPress={() => void actions.dismiss()} />
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: space.sm },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  fill: { flex: 1 },
});
