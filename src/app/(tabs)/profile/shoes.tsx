import { useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, Footprints, Plus, Star, Trash2 } from 'lucide-react-native';
import { useState } from 'react';
import { RefreshControl, StyleSheet, View } from 'react-native';

import { toApiError } from '@/api/errors';
import type { Shoe } from '@/api/schemas';
import { DangerButton, PrimaryButton, SecondaryButton, TextButton } from '@/components/ui/buttons';
import { ConfirmSheet } from '@/components/ui/confirm-sheet';
import { EmptyState, InlineStatus, ProgressBar, SwitchRow, TextField } from '@/components/ui/elements';
import { Card, NavHeader, Screen } from '@/components/ui/layout';
import { describeDistance, formatDistance } from '@/domain/format';
import type { Units } from '@/domain/types';
import { useAccountServices } from '@/features/account/account-provider';
import { useMe, useShoes } from '@/features/data/hooks';
import { Text } from '@/design/text';
import { colors, space } from '@/design/tokens';

const DEFAULT_LIMIT_KM = 700;
const KM_PER_MILE = 1.609344;

interface Draft {
  shoeId?: string;
  name: string;
  /** In the runner's units, as typed. */
  limit: string;
  isDefault: boolean;
}

function errorCopy(code: string): string {
  if (code === 'too_many_shoes') return 'You can track up to 20 shoes. Retire one to add another.';
  if (code === 'invalid_input') return 'Give the shoe a name (up to 40 characters) and a reminder between 50 and 5,000 km.';
  if (code === 'network' || code === 'timeout') return 'You’re offline. Shoes need a connection.';
  return 'Couldn’t save. Try again.';
}

/** Shoes with mileage and a replacement reminder (docs/ROADMAP.md 1.10). Private to the runner. */
export default function ShoesScreen() {
  const { api } = useAccountServices();
  const queryClient = useQueryClient();
  const shoes = useShoes();
  const units = useMe().data?.data.profile?.units ?? 'metric';
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<Shoe | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = shoes.data?.data ?? [];
  const active = list.filter((s) => !s.retired);
  const retired = list.filter((s) => s.retired);
  const unitLabel = units === 'imperial' ? 'mi' : 'km';

  const act = async (task: () => Promise<unknown>) => {
    if (!api) return;
    setBusy(true);
    setError(null);
    try {
      await task();
      await queryClient.invalidateQueries();
      setDraft(null);
      setDeleting(null);
    } catch (e) {
      setError(errorCopy(toApiError(e).code));
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    if (!draft || !api) return;
    const typed = draft.limit.trim() === '' ? null : Number(draft.limit);
    const limitKm = typed === null || Number.isNaN(typed) ? null : Math.round(units === 'imperial' ? typed * KM_PER_MILE : typed);
    void act(() => api.saveShoe({ name: draft.name.trim(), limitKm, isDefault: draft.isDefault, shoeId: draft.shoeId }));
  };

  const edit = (s: Shoe) =>
    setDraft({
      shoeId: s.id,
      name: s.name,
      limit: s.limit_km === null ? '' : String(Math.round(units === 'imperial' ? s.limit_km / KM_PER_MILE : s.limit_km)),
      isDefault: s.is_default,
    });

  return (
    <Screen
      edges={['top', 'bottom']}
      refreshControl={<RefreshControl refreshing={shoes.isFetching && !shoes.isPending} onRefresh={() => void shoes.refetch()} tintColor={colors.textSecondary} />}>
      <NavHeader title="Shoes" />
      <Text variant="body" tone="secondary">
        Track distance on each pair and get a nudge when it’s time for new ones. Your default pair is added to new runs.
      </Text>
      {shoes.isError && !shoes.data ? <InlineStatus tone="danger" title="Couldn’t load your shoes." body="Pull to try again." /> : null}

      {draft ? (
        <Card>
          <Text variant="labelStrong" accessibilityRole="header">
            {draft.shoeId ? 'Edit shoe' : 'Add a shoe'}
          </Text>
          <TextField label="Name" value={draft.name} onChangeText={(name) => setDraft({ ...draft, name })} maxLength={40} placeholder="e.g. Daily trainers" autoFocus />
          <TextField
            label={`Remind me at (${unitLabel})`}
            value={draft.limit}
            onChangeText={(limit) => setDraft({ ...draft, limit: limit.replace(/[^0-9]/g, '') })}
            keyboardType="number-pad"
            placeholder={String(units === 'imperial' ? Math.round(DEFAULT_LIMIT_KM / KM_PER_MILE) : DEFAULT_LIMIT_KM)}
            hint="Most running shoes last 500–800 km (300–500 mi). Leave empty for no reminder."
          />
          <SwitchRow label="Use for new runs" value={draft.isDefault} onChange={(isDefault) => setDraft({ ...draft, isDefault })} last />
          <View style={styles.row}>
            <SecondaryButton label="Cancel" onPress={() => setDraft(null)} style={{ flex: 1 }} />
            <PrimaryButton label="Save" onPress={save} loading={busy} disabled={draft.name.trim() === ''} style={{ flex: 1 }} />
          </View>
        </Card>
      ) : (
        <SecondaryButton label="Add a shoe" icon={Plus} onPress={() => setDraft({ name: '', limit: '', isDefault: active.length === 0 })} testID="add-shoe" />
      )}
      {error ? <InlineStatus tone="danger" title={error} /> : null}

      {shoes.data && list.length === 0 && !draft ? <EmptyState icon={Footprints} title="No shoes yet." body="Add a pair to see how far you’ve run in it." /> : null}

      {active.map((s) => (
        <ShoeCard
          key={s.id}
          shoe={s}
          units={units}
          busy={busy}
          onEdit={() => edit(s)}
          onDefault={s.is_default ? undefined : () => void act(() => api!.saveShoe({ name: s.name, limitKm: s.limit_km, isDefault: true, shoeId: s.id }))}
          onRetire={() => void act(() => api!.retireShoe(s.id, true))}
        />
      ))}

      {retired.length > 0 ? (
        <View style={{ gap: space.sm }}>
          <Text variant="labelStrong" tone="secondary" accessibilityRole="header">
            Retired
          </Text>
          {retired.map((s) => (
            <ShoeCard
              key={s.id}
              shoe={s}
              units={units}
              busy={busy}
              onRestore={() => void act(() => api!.retireShoe(s.id, false))}
              onDelete={() => setDeleting(s)}
            />
          ))}
        </View>
      ) : null}

      <ConfirmSheet
        visible={deleting !== null}
        title={`Delete “${deleting?.name ?? ''}”?`}
        body="Your runs stay; they just won’t show this shoe."
        confirmLabel="Delete shoe"
        destructive
        busy={busy}
        onConfirm={() => deleting && void act(() => api!.deleteShoe(deleting.id))}
        onCancel={() => setDeleting(null)}
      />
    </Screen>
  );
}

function ShoeCard({
  shoe,
  units,
  busy,
  onEdit,
  onDefault,
  onRetire,
  onRestore,
  onDelete,
}: {
  shoe: Shoe;
  units: Units;
  busy: boolean;
  onEdit?: () => void;
  onDefault?: () => void;
  onRetire?: () => void;
  onRestore?: () => void;
  onDelete?: () => void;
}) {
  const d = formatDistance(shoe.distance_m, units);
  const limitM = shoe.limit_km === null ? null : shoe.limit_km * 1000;
  const fraction = limitM ? shoe.distance_m / limitM : null;
  const due = fraction !== null && fraction >= 1;
  const soon = fraction !== null && fraction >= 0.9 && !due;
  const limit = limitM ? formatDistance(limitM, units) : null;
  return (
    <Card>
      <View style={styles.header} accessible accessibilityLabel={`${shoe.name}${shoe.is_default ? ', default for new runs' : ''}. ${describeDistance(shoe.distance_m, units)} over ${shoe.runs} runs.${limit ? ` Reminder at ${limit.value} ${limit.unitLong}.` : ''}`}>
        <Footprints size={22} color={shoe.retired ? colors.textSecondary : colors.accent} />
        <View style={{ flex: 1 }}>
          <Text variant="bodyStrong">{shoe.name}</Text>
          <Text variant="label" tone="secondary">
            {d.value} {d.unit} · {shoe.runs} {shoe.runs === 1 ? 'run' : 'runs'}
            {shoe.is_default ? ' · Default' : ''}
          </Text>
        </View>
        {shoe.is_default ? <Star size={18} color={colors.accent} /> : null}
      </View>
      {fraction !== null && limit ? (
        <ProgressBar fraction={Math.min(1, fraction)} label={`${Math.round(fraction * 100)} percent of ${limit.value} ${limit.unitLong}`} />
      ) : null}
      {due ? <InlineStatus tone="warning" title="Time for a new pair?" body={`This shoe has passed ${limit?.value} ${limit?.unit}.`} /> : null}
      {soon ? (
        <Text variant="caption" tone="secondary">
          Nearly at {limit?.value} {limit?.unit}.
        </Text>
      ) : null}
      <View style={styles.actions}>
        {onEdit ? <TextButton label="Edit" onPress={onEdit} disabled={busy} /> : null}
        {onDefault ? <TextButton label="Make default" icon={Star} onPress={onDefault} disabled={busy} /> : null}
        {onRetire ? <TextButton label="Retire" icon={Archive} onPress={onRetire} disabled={busy} /> : null}
        {onRestore ? <TextButton label="Bring back" icon={ArchiveRestore} onPress={onRestore} disabled={busy} /> : null}
        {onDelete ? <DangerButton label="Delete" icon={Trash2} onPress={onDelete} disabled={busy} style={{ flex: 1 }} /> : null}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: space.md },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.md, alignItems: 'center' },
});
