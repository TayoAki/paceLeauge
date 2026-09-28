import { useQueryClient } from '@tanstack/react-query';
import { Footprints, NotebookPen, Trophy } from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { toApiError } from '@/api/errors';
import type { ServerRun } from '@/api/schemas';
import { SecondaryButton, TextButton } from '@/components/ui/buttons';
import { ChoiceChips, InlineStatus, TextField } from '@/components/ui/elements';
import { Card } from '@/components/ui/layout';
import { describeDuration } from '@/domain/format';
import { useAccountServices } from '@/features/account/account-provider';
import { useRunEfforts, useShoes } from '@/features/data/hooks';
import { effortLabel, effortSpoken, formatEffort } from '@/features/progress/records';
import { Text } from '@/design/text';
import { colors, space } from '@/design/tokens';

const NOTE_MAX = 1000;

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

/** Best efforts inside one run (docs/ROADMAP.md 1.4): the time for each record distance, and where it ranks. */
export function RunEffortsCard({ serverRunId }: { serverRunId: string }) {
  const efforts = useRunEfforts(serverRunId);
  const data = efforts.data?.data;
  if (!data || data.efforts.length === 0) return null;
  return (
    <Card>
      <Text variant="labelStrong" accessibilityRole="header">
        Best efforts
      </Text>
      {!data.counts_for_records ? (
        <Text variant="caption" tone="secondary">
          This run doesn’t count toward records, so these times aren’t ranked.
        </Text>
      ) : null}
      {data.efforts.map((e) => {
        const record = data.counts_for_records && e.rank === 1;
        const tag = !data.counts_for_records ? null : record ? 'Personal record' : e.record_when_run ? 'Record at the time' : `${ordinal(e.rank)} best`;
        return (
          <View
            key={e.effort}
            style={styles.effort}
            accessible
            accessibilityLabel={`${effortSpoken(e.effort)}: ${describeDuration(e.elapsed_ms)}${tag ? `. ${tag}` : ''}`}>
            <Text variant="body" tone="secondary" style={{ width: 120 }}>
              {effortLabel(e.effort)}
            </Text>
            <Text variant="bodyStrong" style={{ flex: 1, fontVariant: ['tabular-nums'] }}>
              {formatEffort(e.elapsed_ms)}
            </Text>
            {tag ? (
              <View style={styles.tag}>
                {record ? <Trophy size={14} color={colors.accent} /> : null}
                <Text variant="caption" tone={record ? 'accent' : 'secondary'}>
                  {tag}
                </Text>
              </View>
            ) : null}
          </View>
        );
      })}
    </Card>
  );
}

/** Notes and shoe for a synced run (docs/ROADMAP.md 1.10). Both are private to the runner. */
export function RunDetailsCard({ run, onSaved }: { run: ServerRun; onSaved: (run: ServerRun) => void }) {
  const { api } = useAccountServices();
  const queryClient = useQueryClient();
  const shoes = useShoes();
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeShoes = (shoes.data?.data ?? []).filter((s) => !s.retired || s.id === run.shoe_id);

  const save = async (input: { notes?: string; shoeId?: string | null }) => {
    if (!api) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await api.updateRunDetails(run.id, input);
      onSaved(updated);
      setDraft(null);
      void queryClient.invalidateQueries();
    } catch (e) {
      setError(toApiError(e).code === 'network' ? 'You’re offline. Saving needs a connection.' : 'Couldn’t save. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <View style={styles.header}>
        <NotebookPen size={18} color={colors.textSecondary} />
        <Text variant="labelStrong" accessibilityRole="header">
          Notes
        </Text>
      </View>
      {draft === null ? (
        <>
          <Text variant="body" tone={run.notes ? 'primary' : 'secondary'}>
            {run.notes ?? 'No notes. Only you can see notes.'}
          </Text>
          <TextButton label={run.notes ? 'Edit note' : 'Add a note'} onPress={() => setDraft(run.notes ?? '')} />
        </>
      ) : (
        <>
          <TextField
            label="Note"
            value={draft}
            onChangeText={setDraft}
            multiline
            maxLength={NOTE_MAX}
            autoFocus
            style={styles.noteInput}
            hint={`${draft.length} of ${NOTE_MAX} characters. Only you can see notes.`}
          />
          <View style={styles.row}>
            <SecondaryButton label="Cancel" onPress={() => setDraft(null)} style={{ flex: 1 }} />
            <SecondaryButton label="Save note" onPress={() => void save({ notes: draft.trim() })} loading={busy} style={{ flex: 1 }} />
          </View>
        </>
      )}

      {activeShoes.length > 0 ? (
        <>
          <View style={styles.header}>
            <Footprints size={18} color={colors.textSecondary} />
            <Text variant="labelStrong" accessibilityRole="header">
              Shoes
            </Text>
          </View>
          <ChoiceChips<string>
            label="Shoes for this run"
            value={run.shoe_id ?? 'none'}
            disabled={busy}
            onChange={(id) => void save({ shoeId: id === 'none' ? null : id })}
            options={[...activeShoes.map((s) => ({ value: s.id, label: s.name })), { value: 'none', label: 'None' }]}
          />
        </>
      ) : null}
      {error ? <InlineStatus tone="danger" title={error} /> : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  effort: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 40 },
  tag: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  row: { flexDirection: 'row', gap: space.md },
  noteInput: { minHeight: 96, paddingTop: space.md, textAlignVertical: 'top' },
});
