import { Ban } from 'lucide-react-native';
import { useState } from 'react';

import type { ReportKind } from '@/api/feed-schemas';
import { SecondaryButton, TextButton } from '@/components/ui/buttons';
import { InlineStatus, Row, RowGroup } from '@/components/ui/elements';
import { Sheet } from '@/components/ui/sheet';
import { env } from '@/config/env';
import { REPORT_REASONS, useFeedActions } from '@/features/social/use-feed';
import { Text } from '@/design/text';
import { colors } from '@/design/tokens';

export interface ReportTarget {
  kind: ReportKind;
  /** A runner's public id, or the run's or comment's id. */
  id: string;
  /** The runner behind it, to offer a block afterwards. */
  owner: { public_id: string; alias: string } | null;
  /** The run it's on, so the screen refreshes. */
  runId?: string;
}

const WHAT: Record<ReportKind, string> = { comment: 'comment', run: 'run', runner: 'runner' };

/**
 * Report a runner, a run or a comment (docs/ROADMAP.md 4.4 and 4.9): a reason, never free text.
 * A reported run or comment disappears for the reporter straight away, and blocking is one tap.
 */
export function ReportSheet({ target, onClose, onBlocked }: { target: ReportTarget | null; onClose: () => void; onBlocked?: () => void }) {
  const actions = useFeedActions();
  const [done, setDone] = useState(false);
  const [blocked, setBlocked] = useState(false);

  const close = () => {
    setDone(false);
    setBlocked(false);
    actions.clearError();
    onClose();
  };

  if (!target) return null;
  const reasons = REPORT_REASONS[target.kind];
  const owner = target.owner;
  return (
    <Sheet visible onClose={close} title={done ? 'Thanks for telling us' : `Report this ${WHAT[target.kind]}`} busy={actions.busy}>
      {actions.error ? <InlineStatus tone="danger" title={actions.error} /> : null}
      {!done ? (
        <>
          <Text variant="body" tone="secondary">
            Moderators see what you report and why, never who you are. We act on reports within 24 hours.
          </Text>
          <RowGroup style={{ backgroundColor: colors.surface }}>
            {reasons.map((r, i) => (
              <Row
                key={r.value}
                label={r.label}
                last={i === reasons.length - 1}
                onPress={
                  actions.busy
                    ? undefined
                    : () =>
                        void actions.report(target.kind, target.id, r.value, target.runId).then((result) => {
                          if (result) setDone(true);
                        })
                }
              />
            ))}
          </RowGroup>
          <TextButton label="Cancel" onPress={close} />
        </>
      ) : (
        <>
          <Text variant="body" tone="secondary">
            {target.kind === 'runner'
              ? 'A moderator will look at it within 24 hours.'
              : `You won’t see this ${WHAT[target.kind]} anymore. A moderator will look at it within 24 hours.`}
            {env.supportEmail ? ` If someone is in danger, contact local emergency services, then email ${env.supportEmail}.` : ''}
          </Text>
          {owner && !blocked ? (
            <SecondaryButton
              label={`Block ${owner.alias}`}
              icon={Ban}
              loading={actions.busy}
              onPress={() =>
                void actions.block(owner.public_id).then(() => {
                  setBlocked(true);
                  onBlocked?.();
                })
              }
            />
          ) : null}
          {blocked ? <InlineStatus tone="success" title="Blocked. You won’t see each other anywhere in PaceLeague." /> : null}
          <TextButton label="Done" onPress={close} />
        </>
      )}
    </Sheet>
  );
}
