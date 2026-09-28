import { useRouter } from 'expo-router';
import { Award, CalendarCheck, Flag, Plus } from 'lucide-react-native';
import { Pressable, StyleSheet, View } from 'react-native';

import type { Challenge } from '@/api/challenge-schemas';
import type { GroupTarget } from '@/api/leagues-api';
import { SecondaryButton } from '@/components/ui/buttons';
import { Pill, ProgressBar } from '@/components/ui/elements';
import { challengeToday, progressFraction, progressLabel, stateLine } from '@/features/challenges/challenge-text';
import { useChallenges } from '@/features/challenges/use-challenges';
import { Text } from '@/design/text';
import { colors, radius, space } from '@/design/tokens';

/** Where a challenge comes from, for its card. */
export function challengeSource(challenge: Challenge): string {
  if (challenge.scope === 'global') return 'Everyone';
  return challenge.group_name ?? (challenge.scope === 'club' ? 'Your club' : 'Your league');
}

/**
 * One challenge (docs/ROADMAP.md 4.6): its name, where it's from, when it runs and the runner's
 * own progress, joined or not. Opens the challenge.
 */
export function ChallengeCard({ challenge, now }: { challenge: Challenge; now: number }) {
  const router = useRouter();
  const when = stateLine(challenge.state, challenge.starts_on, challenge.ends_on, challengeToday(now));
  const progress = progressLabel(challenge.metric, challenge.progress, challenge.target);
  const status = challenge.completed ? 'Done' : challenge.joined ? 'Joined' : null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${challenge.title}. ${challengeSource(challenge)}. ${when}. ${challenge.joined ? '' : 'Not joined. '}${progress}.${challenge.completed ? ' Done.' : ''}`}
      onPress={() => router.push({ pathname: '/league/challenges/[id]', params: { id: challenge.id } })}
      style={({ pressed }) => [styles.card, pressed && { opacity: 0.8 }]}
      testID={`challenge-${challenge.id}`}>
      <View style={styles.head}>
        <View style={[styles.icon, challenge.completed && styles.iconDone]}>
          {challenge.completed ? (
            <Award size={20} color={colors.onAccent} strokeWidth={2.2} />
          ) : challenge.metric === 'active_days' ? (
            <CalendarCheck size={20} color={colors.textSecondary} />
          ) : (
            <Flag size={20} color={colors.textSecondary} />
          )}
        </View>
        <View style={styles.fill}>
          <Text variant="bodyStrong" numberOfLines={2}>
            {challenge.title}
          </Text>
          <Text variant="caption" tone="secondary" numberOfLines={2}>
            {challengeSource(challenge)} · {when}
          </Text>
        </View>
        {status ? <Pill label={status} tone={challenge.completed ? 'accent' : 'neutral'} /> : null}
      </View>
      <View style={styles.progress}>
        <View style={styles.fill}>
          <ProgressBar fraction={progressFraction(challenge.progress, challenge.target)} label={`${challenge.title}: ${progress}`} height={6} />
        </View>
        <Text variant="caption" tone="secondary">
          {progress}
        </Text>
      </View>
    </Pressable>
  );
}

/**
 * A league's or a club's challenges on its page, and for its owner (or a club's admins) the way
 * to set one.
 */
export function GroupChallengesCard({ target, canManage, now }: { target: GroupTarget; canManage: boolean; now: number }) {
  const router = useRouter();
  const list = useChallenges().data?.data.current ?? [];
  const mine = list.filter((c) => ('leagueId' in target ? c.league_id === target.leagueId : c.club_id === target.clubId));
  if (mine.length === 0 && !canManage) return null;
  const params = 'leagueId' in target ? { leagueId: target.leagueId } : { clubId: target.clubId };
  return (
    <View style={styles.group}>
      <View style={styles.row}>
        <Flag size={20} color={colors.textSecondary} />
        <Text variant="labelStrong" accessibilityRole="header" style={styles.fill}>
          Challenges
        </Text>
      </View>
      {mine.map((c) => (
        <ChallengeCard key={c.id} challenge={c} now={now} />
      ))}
      {canManage ? (
        <SecondaryButton label="Start a challenge" icon={Plus} onPress={() => router.push({ pathname: '/league/challenges/create', params })} testID="start-challenge" />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: space.sm,
    backgroundColor: colors.surface,
    borderRadius: radius.control + 4,
    padding: space.lg,
    minHeight: 64,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  icon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceElevated,
  },
  iconDone: { backgroundColor: colors.accent },
  progress: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  group: { gap: space.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  fill: { flex: 1 },
});
