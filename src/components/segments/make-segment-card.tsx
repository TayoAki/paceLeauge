import { useRouter } from 'expo-router';
import { Timer } from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import type { SavedRoute } from '@/api/routes-api';
import { SEGMENT_SURFACES, type SegmentSurface } from '@/api/segments-api';
import { SecondaryButton } from '@/components/ui/buttons';
import { ConfirmSheet } from '@/components/ui/confirm-sheet';
import { ChoiceChips, InlineStatus, TextField } from '@/components/ui/elements';
import { Card } from '@/components/ui/layout';
import { SURFACE_NAMES } from '@/features/segments/segment-text';
import { useSegmentActions } from '@/features/segments/use-segments';
import { Text } from '@/design/text';
import { colors, space } from '@/design/tokens';

/** What the server accepts (db/migrations/20261004000200_segments.sql, mod_create_segment). */
const MIN_M = 200;
const MAX_M = 20_000;
const MAX_POINTS = 1000;

/**
 * Staff only (docs/ROADMAP.md 5.3): segments are curated, made from a route a moderator planned
 * along a path, trail, track or park, never a road. Runners are timed on it from the route's
 * first point to its last, that way round.
 */
export function MakeSegmentCard({ route }: { route: SavedRoute }) {
  const router = useRouter();
  const actions = useSegmentActions();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(route.name);
  const [surface, setSurface] = useState<SegmentSurface>('path');
  const fits = route.distance_m >= MIN_M && route.distance_m <= MAX_M && route.points.length <= MAX_POINTS;

  const create = async () => {
    const segment = await actions.create(route.id, name, surface);
    if (!segment) return;
    setOpen(false);
    router.push({ pathname: '/league/segments/[id]', params: { id: segment.id } });
  };

  return (
    <Card style={styles.card}>
      <View style={styles.head}>
        <Timer size={20} color={colors.accent} />
        <Text variant="labelStrong" accessibilityRole="header" style={styles.fill}>
          Make a segment (staff)
        </Text>
      </View>
      <Text variant="caption" tone="secondary">
        Segments go on paths, trails, tracks and in parks, never along roads. Runners who join are timed from this route’s start to its end, this way round.
        It takes effect for everyone at once and goes in the moderation log.
      </Text>
      {fits ? (
        <SecondaryButton label="Make a segment" icon={Timer} onPress={() => setOpen(true)} testID="make-segment" />
      ) : (
        <InlineStatus title="A segment is 200 m to 20 km long." />
      )}
      <ConfirmSheet
        visible={open}
        title="Make a segment?"
        body="Everyone on the segment boards sees it, and their shared runs from the last 90 days are timed on it."
        confirmLabel="Make segment"
        busy={actions.busy}
        onConfirm={() => void create()}
        onCancel={() => {
          actions.clearError();
          setOpen(false);
        }}>
        <TextField label="Name" value={name} onChangeText={setName} maxLength={60} testID="segment-name" />
        <ChoiceChips label="Surface" value={surface} onChange={setSurface} options={SEGMENT_SURFACES.map((s) => ({ value: s, label: SURFACE_NAMES[s] }))} />
        {actions.error ? <InlineStatus tone="danger" title={actions.error} /> : null}
      </ConfirmSheet>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: space.sm },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  fill: { flex: 1 },
});
