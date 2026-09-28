import { useCalendars } from 'expo-localization';
import { useRouter } from 'expo-router';
import { CalendarPlus, MapPin, UsersRound } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import type { Rsvp } from '@/api/league-schemas';
import type { GroupTarget } from '@/api/leagues-api';
import { SecondaryButton, TextButton } from '@/components/ui/buttons';
import { ChoiceChips, InlineStatus } from '@/components/ui/elements';
import { Card } from '@/components/ui/layout';
import { whenLabel } from '@/features/leagues/group-run-time';
import { useGroupRuns, useLeagueActions } from '@/features/leagues/use-leagues';
import { Text } from '@/design/text';
import { colors, space } from '@/design/tokens';

const RSVP_OPTIONS: { value: Rsvp; label: string }[] = [
  { value: 'going', label: 'Going' },
  { value: 'maybe', label: 'Maybe' },
  { value: 'not_going', label: 'Can’t make it' },
];

function who(names: string[], count: number): string {
  if (count === 0) return 'Nobody going yet.';
  const shown = names.slice(0, 3).join(', ');
  const more = count - Math.min(names.length, 3);
  return `${shown}${more > 0 ? ` and ${more} more` : ''} ${count === 1 ? 'is' : 'are'} going.`;
}

/** The group-run screen's params for a league or a club. */
function targetParams(target: GroupTarget): { leagueId?: string; clubId?: string } {
  return 'clubId' in target ? { clubId: target.clubId } : { leagueId: target.leagueId };
}

/** Group runs (docs/ROADMAP.md 4.1 and 4.5): a time, a meeting point and who's coming. */
export function GroupRunsCard({ target, now, onReport }: { target: GroupTarget; now: number; onReport?: (groupRunId: string) => void }) {
  const router = useRouter();
  const uses24h = useCalendars()[0]?.uses24hourClock ?? false;
  const runs = useGroupRuns(target).data?.data ?? [];
  const actions = useLeagueActions();
  const params = targetParams(target);
  return (
    <View style={styles.group}>
      <View style={styles.head}>
        <UsersRound size={20} color={colors.textSecondary} />
        <Text variant="labelStrong" accessibilityRole="header" style={styles.fill}>
          Group runs
        </Text>
      </View>
      {actions.error ? <InlineStatus tone="danger" title={actions.error} /> : null}
      {runs.map((run) => (
        <Card key={run.id} style={styles.card}>
          <Text variant="bodyStrong">{run.title}</Text>
          <Text variant="label" tone={run.cancelled ? 'danger' : 'secondary'}>
            {run.cancelled ? 'Cancelled · ' : ''}
            {whenLabel(run.starts_at_ms, now, uses24h)}
            {run.host ? ` · planned by ${run.is_host ? 'you' : run.host}` : ''}
          </Text>
          <View style={styles.row}>
            <MapPin size={16} color={colors.textSecondary} />
            <Text variant="label" tone="secondary" style={styles.fill}>
              {run.meeting_point}
            </Text>
          </View>
          {run.notes ? (
            <Text variant="label" tone="secondary">
              {run.notes}
            </Text>
          ) : null}
          <Text variant="caption" tone="secondary">
            {who(run.going, run.going_count)}
            {run.maybe_count > 0 ? ` ${run.maybe_count} maybe.` : ''}
          </Text>
          {!run.cancelled ? (
            <ChoiceChips<Rsvp>
              label={`Are you going to ${run.title}?`}
              value={run.my_rsvp ?? ('' as Rsvp)}
              onChange={(status) => void actions.rsvp(run.id, status)}
              options={RSVP_OPTIONS}
              disabled={actions.busy}
            />
          ) : null}
          <View style={styles.links}>
            {run.can_edit && !run.cancelled ? (
              <TextButton label={run.is_host ? 'Edit or cancel' : 'Edit or remove'} onPress={() => router.push({ pathname: '/league/group-run', params: { ...params, id: run.id } })} />
            ) : null}
            {!run.is_host && onReport ? <TextButton label="Report" onPress={() => onReport(run.id)} /> : null}
          </View>
        </Card>
      ))}
      <SecondaryButton label="Plan a group run" icon={CalendarPlus} onPress={() => router.push({ pathname: '/league/group-run', params })} testID="plan-group-run" />
    </View>
  );
}

const styles = StyleSheet.create({
  group: { gap: space.sm },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  card: { gap: space.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  links: { flexDirection: 'row', flexWrap: 'wrap', gap: space.lg },
  fill: { flex: 1 },
});
