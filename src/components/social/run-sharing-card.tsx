import { useRouter } from 'expo-router';
import { Route, Users } from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import type { ServerRun } from '@/api/schemas';
import type { Visibility } from '@/api/social-schemas';
import { TextButton } from '@/components/ui/buttons';
import { ChoiceChips, InlineStatus, RowGroup, SwitchRow } from '@/components/ui/elements';
import { Card } from '@/components/ui/layout';
import { useSocialActions, VISIBILITY_HINTS, VISIBILITY_NAMES } from '@/features/social/use-social';
import { Text } from '@/design/text';
import { colors, space } from '@/design/tokens';

const VISIBILITIES: Visibility[] = ['only_me', 'leagues', 'followers', 'everyone'];

/** Who sees this run, and whether its map is shared (docs/ROADMAP.md 4.2). Owner only. */
export function RunSharingCard({ run, hasRoute }: { run: ServerRun; hasRoute: boolean }) {
  const router = useRouter();
  const actions = useSocialActions();
  // Shown straight away; the server's answer follows.
  const [visibility, setVisibility] = useState<Visibility>(run.visibility ?? 'only_me');
  const [mapShared, setMapShared] = useState(run.map_shared ?? false);

  const save = async (nextVisibility: Visibility, nextMap: boolean) => {
    const before = { visibility, mapShared };
    setVisibility(nextVisibility);
    setMapShared(nextMap);
    const result = await actions.setRunSharing(run.id, nextVisibility, nextMap);
    if (!result) {
      setVisibility(before.visibility);
      setMapShared(before.mapShared);
    }
  };

  return (
    <Card style={styles.card}>
      <View style={styles.head}>
        <Users size={20} color={colors.textSecondary} />
        <Text variant="labelStrong" accessibilityRole="header" style={{ flex: 1 }}>
          Who sees this run
        </Text>
      </View>
      <ChoiceChips<Visibility>
        label="Who sees this run"
        value={visibility}
        onChange={(v) => void save(v, mapShared)}
        options={VISIBILITIES.map((v) => ({ value: v, label: VISIBILITY_NAMES[v] }))}
        disabled={actions.busy}
      />
      <Text variant="caption" tone="secondary">
        {VISIBILITY_HINTS[visibility]}
      </Text>
      {visibility !== 'only_me' && hasRoute ? (
        <RowGroup>
          <SwitchRow
            icon={Route}
            label="Share the map"
            hint="Leaves out your privacy zones and the first and last 200 m."
            value={mapShared}
            onChange={(on) => void save(visibility, on)}
            disabled={actions.busy}
            last
            testID="run-share-map"
          />
        </RowGroup>
      ) : null}
      {actions.error ? <InlineStatus tone="danger" title={actions.error} /> : null}
      {visibility !== 'only_me' ? (
        <TextButton label="See it as others do" onPress={() => router.push({ pathname: '/shared/[id]', params: { id: run.id } })} />
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: space.sm },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
});
