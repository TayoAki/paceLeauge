import { useQueryClient } from '@tanstack/react-query';
import { Clock, ShieldAlert } from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { toApiError } from '@/api/errors';
import type { ModAction, ModReport } from '@/api/feed-schemas';
import { SecondaryButton } from '@/components/ui/buttons';
import { ConfirmSheet } from '@/components/ui/confirm-sheet';
import { EmptyState, InlineStatus, SegmentedControl, TextField } from '@/components/ui/elements';
import { Card, NavHeader, Screen } from '@/components/ui/layout';
import { formatDistance } from '@/domain/format';
import { useAccount } from '@/features/account/account-provider';
import { useCachedQuery, useMe } from '@/features/data/hooks';
import { Text } from '@/design/text';
import { colors, space } from '@/design/tokens';

type Status = 'open' | 'actioned' | 'dismissed';

const KIND: Record<ModReport['target_kind'], string> = {
  member: 'League member',
  league: 'League',
  runner: 'Runner',
  run: 'Run',
  comment: 'Comment',
};

const REASON: Record<string, string> = {
  offensive_name: 'Offensive name',
  harassment: 'Harassment',
  impersonation: 'Impersonation',
  cheating: 'Not a real run',
  spam: 'Spam',
  offensive_content: 'Offensive content',
  private_info: 'Private information',
  other: 'Other',
};

const ACTION: Record<ModAction, { label: string; body: string; destructive: boolean }> = {
  dismiss: { label: 'Dismiss', body: 'Nothing changes for the runner.', destructive: false },
  reset_alias: { label: 'Reset name', body: 'Their runner name becomes “Runner” and a code. They can choose a new one.', destructive: true },
  remove_from_league: { label: 'Remove from league', body: 'They leave the league and can’t rejoin with an old invite.', destructive: true },
  rename_league: { label: 'Rename league', body: 'The league gets a neutral name the owner can change.', destructive: true },
  hide_run: { label: 'Hide run', body: 'Only the runner sees it until they share it again. Their data stays.', destructive: true },
  remove_comment: { label: 'Remove comment', body: 'The comment is removed for everyone. Other reports about it close too.', destructive: true },
};

const FIELDS: [string, string][] = [
  ['alias', 'Runner'],
  ['league_name', 'League'],
  ['title', 'Run'],
  ['run_title', 'On the run'],
  ['body', 'Comment'],
  ['visibility', 'Shared with'],
];

function hoursFrom(ms: number, now: number): string {
  const hours = Math.round(Math.abs(ms - now) / 3_600_000);
  if (hours < 1) return 'under an hour';
  return hours === 1 ? '1 hour' : `${hours} hours`;
}

function Snapshot({ report }: { report: ModReport }) {
  const s = report.content_snapshot;
  const lines = FIELDS.filter(([key]) => typeof s[key] === 'string' && s[key] !== '').map(([key, label]) => [label, s[key] as string]);
  if (typeof s.distance_m === 'number') lines.push(['Distance', (({ value, unit }) => `${value} ${unit}`)(formatDistance(s.distance_m, 'metric'))]);
  if (typeof s.started_at_ms === 'number') lines.push(['Started', new Date(s.started_at_ms).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })]);
  return (
    <View style={styles.snapshot}>
      {lines.map(([label, value]) => (
        <Text key={label} variant="label" selectable>
          <Text variant="labelStrong">{label}: </Text>
          {value}
        </Text>
      ))}
    </View>
  );
}

/**
 * Staff moderation (docs/ROADMAP.md 4.9): the report queue against its 24-hour response target,
 * each report's snapshot (never routes or contact details), and the audited actions.
 */
export default function ModerationScreen() {
  const { api, state } = useAccount();
  const accountId = state.status === 'ready' ? state.accountId : null;
  const queryClient = useQueryClient();
  const isStaff = useMe().data?.data.is_staff === true;
  const [status, setStatus] = useState<Status>('open');
  const reports = useCachedQuery('mod-reports', [status], (a) => a.modListReports(status), { enabled: isStaff, staleTime: 0 });
  const health = useCachedQuery('mod-health', [], (a) => a.modQueueHealth(), { enabled: isStaff, staleTime: 0 });
  const [acting, setActing] = useState<{ report: ModReport; action: ModAction } | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  if (!isStaff) {
    return (
      <Screen edges={['top', 'bottom']}>
        <NavHeader title="Moderation" />
        <InlineStatus title="Moderation is for PaceLeague staff." />
      </Screen>
    );
  }

  const resolve = async () => {
    if (!api || !acting || note.trim().length < 3) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await api.modResolveReport(acting.report.report_id, acting.action, note.trim());
      const extra = result.also_resolved > 0 ? ` ${result.also_resolved} other ${result.also_resolved === 1 ? 'report' : 'reports'} about it closed too.` : '';
      setMessage({ tone: 'success', text: `${ACTION[acting.action].label}: done${result.within_target ? ' within the target' : ', after the target'}.${extra}` });
      setActing(null);
      setNote('');
      await Promise.all(['mod-reports', 'mod-health'].map((name) => queryClient.invalidateQueries({ queryKey: [accountId, name] })));
    } catch (e) {
      const code = toApiError(e).code;
      setMessage({
        tone: 'danger',
        text: code === 'already_resolved' ? 'Someone already resolved that report.' : code === 'owner_must_transfer' ? 'League owners can’t be removed. Rename the league or reset their name instead.' : 'That didn’t work. Try again.',
      });
    } finally {
      setBusy(false);
    }
  };

  const h = health.data?.data;
  const list = reports.data?.data ?? [];
  return (
    <Screen edges={['top', 'bottom']}>
      <NavHeader title="Moderation" />
      {h ? (
        <Card style={styles.card}>
          <View style={styles.row}>
            <ShieldAlert size={20} color={h.overdue > 0 ? colors.danger : colors.textSecondary} />
            <Text variant="labelStrong" style={{ flex: 1 }}>
              {h.open} open · {h.overdue} overdue
            </Text>
          </View>
          <Text variant="caption" tone="secondary">
            Target: act within {h.response_target_hours} hours.
            {h.next_due_at_ms
              ? ` Next due ${h.overdue > 0 ? `${hoursFrom(h.next_due_at_ms, health.dataUpdatedAt)} ago` : `in ${hoursFrom(h.next_due_at_ms, health.dataUpdatedAt)}`}.`
              : ''}{' '}
            Last 7 days:{' '}
            {h.resolved_within_target_7d} of {h.resolved_7d} within the target.{h.held_comments > 0 ? ` ${h.held_comments} comments held after reports.` : ''}
          </Text>
        </Card>
      ) : null}

      <SegmentedControl<Status>
        label="Reports"
        value={status}
        onChange={setStatus}
        options={[
          { value: 'open', label: 'Open' },
          { value: 'actioned', label: 'Actioned' },
          { value: 'dismissed', label: 'Dismissed' },
        ]}
      />
      {message ? <InlineStatus tone={message.tone} title={message.text} /> : null}
      {reports.isError && !reports.data ? <InlineStatus tone="danger" title="Couldn’t load reports." body="Check your connection and try again." /> : null}
      {reports.data && list.length === 0 ? (
        <Card>
          <EmptyState title={status === 'open' ? 'No open reports.' : 'Nothing here.'} />
        </Card>
      ) : null}
      {list.map((report) => (
        <Card key={report.report_id} style={styles.card}>
          <View style={styles.row}>
            <Text variant="labelStrong" style={{ flex: 1 }}>
              {KIND[report.target_kind]} · {REASON[report.reason_code] ?? report.reason_code}
            </Text>
            {report.status === 'open' ? (
              <View style={styles.row}>
                <Clock size={14} color={report.overdue ? colors.danger : colors.textSecondary} />
                <Text variant="caption" tone={report.overdue ? 'danger' : 'secondary'}>
                  {report.overdue ? `Overdue ${hoursFrom(report.due_at_ms, reports.dataUpdatedAt)}` : `Due in ${hoursFrom(report.due_at_ms, reports.dataUpdatedAt)}`}
                </Text>
              </View>
            ) : (
              <Text variant="caption" tone="secondary">
                {report.resolution ? ACTION[report.resolution as ModAction]?.label ?? report.resolution : report.status}
              </Text>
            )}
          </View>
          <Snapshot report={report} />
          {report.open_on_target > 1 ? (
            <Text variant="caption" tone="secondary">
              {report.open_on_target} open reports about this.
            </Text>
          ) : null}
          {report.target_state.removed === true ? (
            <Text variant="caption" tone="secondary">
              Already removed.
            </Text>
          ) : report.target_state.held === true ? (
            <Text variant="caption" tone="secondary">
              Held after reports: only its author sees it.
            </Text>
          ) : null}
          {report.status === 'open' ? (
            <View style={styles.actions}>
              {report.actions.map((action) => (
                <SecondaryButton key={action} label={ACTION[action].label} onPress={() => setActing({ report, action })} testID={`mod-${action}`} />
              ))}
            </View>
          ) : null}
        </Card>
      ))}

      <ConfirmSheet
        visible={acting !== null}
        title={acting ? `${ACTION[acting.action].label}?` : ''}
        body={acting ? ACTION[acting.action].body : undefined}
        confirmLabel={acting ? ACTION[acting.action].label : 'Confirm'}
        destructive={acting ? ACTION[acting.action].destructive : false}
        busy={busy}
        onConfirm={() => void resolve()}
        onCancel={() => {
          setActing(null);
          setNote('');
        }}>
        <TextField label="Note for the audit log" value={note} onChangeText={setNote} maxLength={200} placeholder="At least 3 characters" testID="mod-note" />
      </ConfirmSheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: { gap: space.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  snapshot: { gap: 2 },
  actions: { gap: space.sm },
});
