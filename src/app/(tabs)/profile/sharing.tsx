import * as Location from 'expo-location';
import { Flame, LocateFixed, MapPin, Route, Trash2 } from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import type { Visibility } from '@/api/social-schemas';
import { IconButton, SecondaryButton, TextButton } from '@/components/ui/buttons';
import { ChoiceChips, EmptyState, InlineStatus, Row, RowGroup, SwitchRow, TextField } from '@/components/ui/elements';
import { Card, NavHeader, Screen } from '@/components/ui/layout';
import { fromCompact } from '@/domain/route-codec';
import { useAccount } from '@/features/account/account-provider';
import { useMe } from '@/features/data/hooks';
import { useTeen, visibilityChoices } from '@/features/account/teen';
import { useHeatmap, useHeatmapActions } from '@/features/heatmap/use-heatmap';
import { useRoutePlanning } from '@/features/routes/use-routes';
import { useSocialActions, useSocialSettings, VISIBILITY_HINTS, VISIBILITY_NAMES } from '@/features/social/use-social';
import { Text } from '@/design/text';
import { space } from '@/design/tokens';

const RADII = [100, 200, 400, 800];

/** The heatmap (docs/ROADMAP.md 5.4): off until the runner adds their runs. */
function HeatmapSwitch() {
  const heat = useHeatmap();
  const actions = useHeatmapActions();
  const data = heat.data?.data;
  if (!data) return null;
  return (
    <>
      <RowGroup>
        <SwitchRow
          icon={Flame}
          label="Add my runs to the heatmap"
          hint={`Runs you share with everyone, map included, help show popular paths. A path shows only once ${data.min_runners} different runners have run it; your privacy zones and where runs start and end are never used.`}
          value={data.contributing}
          onChange={(on) => void actions.setContribution(on)}
          disabled={actions.busy}
          last
          testID="heatmap-switch"
        />
      </RowGroup>
      {actions.error ? <InlineStatus tone="danger" title={actions.error} /> : null}
    </>
  );
}

function radiusLabel(m: number, imperial: boolean): string {
  return imperial ? `${Math.round((m * 3.28084) / 50) * 50} ft` : `${m} m`;
}

/**
 * Sharing and privacy zones (docs/ROADMAP.md 4.2 and 4.3): who sees new runs, whether their maps
 * are shared, follower approval and name search, and the places no shared map ever shows.
 */
export default function SharingScreen() {
  const { api } = useAccount();
  const imperial = (useMe().data?.data.profile?.units ?? 'metric') === 'imperial';
  const settings = useSocialSettings();
  const actions = useSocialActions();
  const data = settings.data?.data;
  // Teen accounts (docs/ROADMAP.md 4.10): their family league at most, and no followers.
  const { isTeen } = useTeen();
  // The heatmap is shown with the routes it sits in (useRoutePlanning).
  const planning = useRoutePlanning();
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('Home');
  const [radius, setRadius] = useState(200);
  const [center, setCenter] = useState<{ lat: number; lon: number; from: string } | null>(null);
  const [locating, setLocating] = useState<'here' | 'run' | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const pickHere = async () => {
    setLocating('here');
    setNote(null);
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (!permission.granted) {
        setNote('Location is off. Use where your last run started instead, or turn location on in Settings.');
        return;
      }
      const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      setCenter({ lat: position.coords.latitude, lon: position.coords.longitude, from: 'Where you are now' });
    } catch {
      setNote('Couldn’t find where you are. Try again outside.');
    } finally {
      setLocating(null);
    }
  };

  const pickLastRun = async () => {
    if (!api) return;
    setLocating('run');
    setNote(null);
    try {
      const page = await api.listMyRuns(null, 10);
      for (const run of page.runs) {
        const route = await api.getMyRunRoute(run.id);
        const first = route.points[0];
        if (first) {
          const p = fromCompact(first);
          setCenter({ lat: p.lat, lon: p.lon, from: `Where “${run.title}” started` });
          return;
        }
      }
      setNote('None of your recent runs has a route to use.');
    } catch {
      setNote('Couldn’t load your runs. Check your connection.');
    } finally {
      setLocating(null);
    }
  };

  const saveZone = async () => {
    if (!center) return;
    const saved = await actions.saveZone({ label: label.trim() || 'Zone', lat: center.lat, lon: center.lon, radiusM: radius });
    if (saved) {
      setAdding(false);
      setCenter(null);
      setLabel('Home');
    }
  };

  return (
    <Screen edges={['top', 'bottom']}>
      <NavHeader title="Sharing" />
      {settings.isError && !data ? <InlineStatus tone="danger" title="Couldn’t load your sharing settings." body="Check your connection and try again." /> : null}
      {actions.error ? <InlineStatus tone="danger" title={actions.error} /> : null}

      {data ? (
        <>
          <Card style={styles.card}>
            <Text variant="labelStrong" accessibilityRole="header">
              Who sees new runs
            </Text>
            <ChoiceChips<Visibility>
              label="Who sees new runs"
              value={data.default_visibility}
              onChange={(v) => void actions.setSettings({ defaultVisibility: v })}
              options={visibilityChoices(isTeen).map((v) => ({ value: v, label: VISIBILITY_NAMES[v] }))}
              disabled={actions.busy}
            />
            <Text variant="caption" tone="secondary">
              {VISIBILITY_HINTS[data.default_visibility]} Your league always sees your runner name, tier and weekly XP. You can change any run on its page.
            </Text>
          </Card>

          <RowGroup>
            <SwitchRow
              icon={Route}
              label="Share maps of new runs"
              hint="Maps leave out your privacy zones and the first and last 200 m of every run. Off: people see only the numbers."
              value={data.default_map_shared}
              onChange={(on) => void actions.setSettings({ defaultMapShared: on })}
              disabled={actions.busy}
              last={isTeen}
              testID="share-maps-switch"
            />
            {!isTeen ? (
              <>
            <SwitchRow
              label="Approve followers"
              hint="Off: anyone with your link can follow you straight away."
              value={data.follow_approval}
              onChange={(on) => void actions.setSettings({ followApproval: on })}
              disabled={actions.busy}
            />
            <SwitchRow
              label="Let people find me by name"
              hint="Off: people can follow you only through your follow link."
              value={data.discoverable}
              onChange={(on) => void actions.setSettings({ discoverable: on })}
              disabled={actions.busy}
              last
              testID="discoverable-switch"
            />
              </>
            ) : null}
          </RowGroup>

          {!isTeen && planning ? <HeatmapSwitch /> : null}

          <View style={styles.group}>
            <Text variant="labelStrong" accessibilityRole="header">
              Privacy zones
            </Text>
            <Text variant="caption" tone="secondary">
              Places no shared map ever shows, such as home or work. Up to 5.
            </Text>
            {data.zones.length === 0 && !adding ? (
              <Card>
                <EmptyState title="No privacy zones yet." body="Add your home first: maps that start there are cut before they leave it." />
              </Card>
            ) : (
              <RowGroup>
                {data.zones.map((z, i) => (
                  <Row
                    key={z.id}
                    icon={MapPin}
                    label={z.label}
                    value={radiusLabel(z.radius_m, imperial)}
                    last={i === data.zones.length - 1}
                    accessory={<IconButton icon={Trash2} label={`Remove ${z.label}`} tone="plain" onPress={() => void actions.deleteZone(z.id)} />}
                  />
                ))}
              </RowGroup>
            )}

            {adding ? (
              <Card style={styles.card}>
                <TextField label="Name" value={label} onChangeText={setLabel} maxLength={32} />
                <Text variant="labelStrong">Size</Text>
                <ChoiceChips
                  label="Zone size"
                  value={String(radius)}
                  onChange={(v) => setRadius(Number(v))}
                  options={RADII.map((m) => ({ value: String(m), label: radiusLabel(m, imperial) }))}
                />
                <Text variant="labelStrong">Where</Text>
                <View style={styles.buttons}>
                  <SecondaryButton label="Where I am now" icon={LocateFixed} onPress={() => void pickHere()} loading={locating === 'here'} />
                  <SecondaryButton label="Where my last run started" icon={Route} onPress={() => void pickLastRun()} loading={locating === 'run'} />
                </View>
                {center ? <InlineStatus tone="success" title={center.from} body="Save to hide this area from shared maps." /> : null}
                {note ? <InlineStatus tone="warning" title={note} /> : null}
                <View style={styles.row}>
                  <SecondaryButton label="Save zone" onPress={() => void saveZone()} disabled={!center} loading={actions.busy} style={{ flex: 1 }} testID="save-zone" />
                  <TextButton label="Cancel" onPress={() => setAdding(false)} />
                </View>
              </Card>
            ) : data.zones.length < 5 ? (
              <SecondaryButton label="Add a privacy zone" icon={MapPin} onPress={() => setAdding(true)} testID="add-zone" />
            ) : null}
          </View>
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: { gap: space.sm },
  group: { gap: space.sm },
  buttons: { gap: space.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md },
});
