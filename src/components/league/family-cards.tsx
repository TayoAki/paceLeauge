import { Check, Home, UserPlus, X } from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import type { FamilyRequest } from '@/api/family-api';
import { PrimaryButton, SecondaryButton, TextButton } from '@/components/ui/buttons';
import { ConfirmSheet } from '@/components/ui/confirm-sheet';
import { InlineStatus, TextField } from '@/components/ui/elements';
import { Card } from '@/components/ui/layout';
import { useFamilyActions, useFamilyRequests, useFamilyTeens, useMyFamilyRequests } from '@/features/leagues/use-family';
import { Text } from '@/design/text';
import { colors, space } from '@/design/tokens';

const BAND: Record<string, string> = { '13_15': '13–15', '16_17': '16–17' };

function dayOf(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

/**
 * For a teen account (docs/ROADMAP.md 4.10): ask to join a family league with its code. The adult
 * who runs it approves, as the parent or guardian.
 */
export function FamilyJoinCard({ inLeague }: { inLeague: boolean }) {
  const mine = useMyFamilyRequests(true).data?.data ?? [];
  const actions = useFamilyActions();
  const [code, setCode] = useState('');
  const clean = code.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 8);
  const pending = mine.filter((r) => r.status === 'pending');
  const declined = mine.filter((r) => r.status === 'declined');

  return (
    <Card style={styles.card}>
      <View style={styles.row}>
        <Home size={20} color={colors.accent} />
        <Text variant="labelStrong" accessibilityRole="header" style={styles.fill}>
          {inLeague ? 'Join another family league' : 'Join your family’s league'}
        </Text>
      </View>
      <Text variant="body" tone="secondary">
        Ask the parent or guardian who runs it for the 8-character code. They’ll get a request to approve you.
      </Text>
      {pending.map((r) => (
        <View key={r.id} style={styles.request}>
          <InlineStatus title={`Waiting for approval to join ${r.league_name ?? 'the league'}`} body="The adult who runs it has been told." />
          <TextButton label="Cancel request" onPress={() => void actions.cancel(r.id)} />
        </View>
      ))}
      {declined.map((r) => (
        <InlineStatus key={r.id} tone="warning" title={`${r.league_name ?? 'The league'} didn’t approve this request.`} />
      ))}
      <TextField
        label="Family league code"
        value={code}
        onChangeText={setCode}
        autoCapitalize="characters"
        autoCorrect={false}
        placeholder="ABCD-EFGH"
        maxLength={9}
        testID="family-code"
      />
      {actions.error ? <InlineStatus tone="danger" title={actions.error} /> : null}
      <PrimaryButton
        label="Ask to join"
        icon={UserPlus}
        disabled={clean.length !== 8}
        loading={actions.busy}
        onPress={() =>
          void actions.request(clean).then((r) => {
            if (r) setCode('');
          })
        }
        testID="family-ask"
      />
    </Card>
  );
}

/**
 * For the adult who runs a family league (docs/ROADMAP.md 4.10): teens asking to join, approved
 * as their parent or guardian, and how the teens in the league are doing. Removing one is the
 * league's usual "Remove from league" on their row.
 */
export function FamilyAdminCard({ leagueId }: { leagueId: string }) {
  const requests = useFamilyRequests(leagueId, true).data?.data ?? [];
  const teens = useFamilyTeens(leagueId, true).data?.data ?? [];
  const actions = useFamilyActions();
  const [approving, setApproving] = useState<FamilyRequest | null>(null);
  if (requests.length === 0 && teens.length === 0) return null;
  const approvingName = approving?.alias ?? 'them';

  return (
    <Card style={styles.card}>
      <View style={styles.row}>
        <Home size={20} color={colors.accent} />
        <Text variant="labelStrong" accessibilityRole="header" style={styles.fill}>
          Teens in your family league
        </Text>
      </View>
      {actions.error ? <InlineStatus tone="danger" title={actions.error} /> : null}
      {requests.map((r) => (
        <View key={r.id} style={styles.request}>
          <Text variant="bodyStrong">
            {r.alias ?? 'A teen'} ({BAND[r.band ?? ''] ?? 'teen'}) wants to join
          </Text>
          <View style={styles.buttons}>
            <SecondaryButton label="Approve" icon={Check} onPress={() => setApproving(r)} style={styles.fill} testID={`family-approve-${r.id}`} />
            <SecondaryButton label="Decline" icon={X} onPress={() => void actions.decide(r.id, false)} style={styles.fill} />
          </View>
        </View>
      ))}
      {teens.map((t) => (
        <View key={t.member_id} style={styles.teen} accessible>
          <Text variant="bodyStrong">
            {t.alias} ({BAND[t.band]})
          </Text>
          <Text variant="caption" tone="secondary">
            {t.runs_this_week === 0 ? 'No runs yet this week' : `Ran ${t.runs_this_week} ${t.runs_this_week === 1 ? 'time' : 'times'} this week`}
            {t.last_run_at_ms ? ` · last run ${dayOf(t.last_run_at_ms)}` : ''}
            {t.consent_at_ms ? ` · approved ${dayOf(t.consent_at_ms)}` : ''}
          </Text>
        </View>
      ))}
      {teens.length > 0 ? (
        <Text variant="caption" tone="secondary">
          Teens see only this league: no feed, clubs, public boards or sharing outside the family, and no heart rate or health data under 16. To remove one, tap
          their name in the standings.
        </Text>
      ) : null}
      <ConfirmSheet
        visible={approving !== null}
        title={`Are you ${approvingName}’s parent or guardian?`}
        body={`Approving is your consent for ${approvingName} to use PaceLeague in this family league: their runs, standings, duels, group runs and live location, shared only with this league. You can remove them at any time.`}
        confirmLabel="Approve"
        busy={actions.busy}
        onConfirm={() => {
          const id = approving?.id;
          if (!id) return;
          void actions.decide(id, true).then(() => setApproving(null));
        }}
        onCancel={() => setApproving(null)}
      />
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: space.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  fill: { flex: 1 },
  request: { gap: space.xs },
  buttons: { flexDirection: 'row', gap: space.sm },
  teen: { gap: 2 },
});
