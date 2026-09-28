import { useLocalSearchParams, useRouter } from 'expo-router';
import { Flag, ShieldCheck } from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { CommentsSection } from '@/components/social/comments-section';
import { ReportSheet } from '@/components/social/report-sheet';
import { RunSocialBar } from '@/components/social/run-social-bar';
import { SharedRunCard } from '@/components/social/shared-run-card';
import { TextButton } from '@/components/ui/buttons';
import { InlineStatus, Row, RowGroup } from '@/components/ui/elements';
import { NavHeader, Screen } from '@/components/ui/layout';
import { useMe } from '@/features/data/hooks';
import { useFeedActions, useKudosList } from '@/features/social/use-feed';
import { VISIBILITY_NAMES, useSharedRun } from '@/features/social/use-social';
import { Text } from '@/design/text';
import { colors, space } from '@/design/tokens';

/** Someone's run as the caller may see it (docs/ROADMAP.md 4.2), with kudos and comments (4.4). */
export default function SharedRunScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const units = useMe().data?.data.profile?.units ?? 'metric';
  const shared = useSharedRun(id ?? null);
  const run = shared.data?.data;
  const actions = useFeedActions();
  const [showKudos, setShowKudos] = useState(false);
  const [reporting, setReporting] = useState(false);
  const kudos = useKudosList(id ?? null, showKudos);

  return (
    <Screen edges={['top', 'bottom']}>
      <NavHeader title={run ? run.owner.alias : 'Run'} />
      {run ? (
        <>
          <SharedRunCard run={run} units={units} />
          <RunSocialBar item={run} onKudos={() => void actions.toggleKudos(run)} onKudosCount={() => setShowKudos((v) => !v)} />
          {!run.is_mine && run.kudos > 0 ? <TextButton label={showKudos ? 'Hide kudos' : 'Who gave kudos'} onPress={() => setShowKudos((v) => !v)} /> : null}
          {actions.error ? <InlineStatus tone="danger" title={actions.error} /> : null}
          {showKudos && kudos.data ? (
            <RowGroup>
              {kudos.data.data.map((k, i, all) => (
                <Row
                  key={k.public_id}
                  label={k.is_me ? `${k.alias} (you)` : k.alias}
                  hint={k.tier}
                  onPress={k.is_me ? undefined : () => router.push({ pathname: '/runner/[id]', params: { id: k.public_id } })}
                  last={i === all.length - 1}
                />
              ))}
            </RowGroup>
          ) : null}
          <View style={styles.note}>
            <ShieldCheck size={16} color={colors.textSecondary} />
            <Text variant="caption" tone="secondary" style={{ flex: 1 }}>
              Shared with {VISIBILITY_NAMES[run.visibility].toLowerCase()}. Maps never show the first and last 200 m or the runner’s privacy zones.
            </Text>
          </View>
          <CommentsSection run={run} />
          {!run.is_mine ? (
            <View style={styles.menu}>
              <TextButton label={`${run.owner.alias}’s profile`} onPress={() => router.push({ pathname: '/runner/[id]', params: { id: run.owner.public_id } })} />
              <TextButton label="Report run" icon={Flag} onPress={() => setReporting(true)} />
            </View>
          ) : null}
          <ReportSheet
            target={reporting ? { kind: 'run', id: run.run_id, owner: { public_id: run.owner.public_id, alias: run.owner.alias }, runId: run.run_id } : null}
            onClose={() => {
              setReporting(false);
              // A reported run is gone for the reporter.
              if (!shared.isFetching) void shared.refetch().catch(() => undefined);
            }}
          />
        </>
      ) : shared.isError ? (
        <InlineStatus title="This run isn’t available." body="It may have been deleted, or it’s no longer shared with you." />
      ) : (
        <Text variant="label" tone="secondary">
          Loading…
        </Text>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  note: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  menu: { flexDirection: 'row', flexWrap: 'wrap', gap: space.lg, justifyContent: 'center' },
});
