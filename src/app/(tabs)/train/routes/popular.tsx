import * as Location from 'expo-location';
import { useRouter } from 'expo-router';
import { Flame, LocateFixed, Route as RouteIcon, Save } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { HeatMapView } from '@/components/heatmap/heat-map-view';
import { RouteSketch } from '@/components/run/route-sketch';
import { PrimaryButton, SecondaryButton, TextButton } from '@/components/ui/buttons';
import { ChoiceChips, InlineStatus } from '@/components/ui/elements';
import { Card, NavHeader, Screen } from '@/components/ui/layout';
import { LOOP_CHOICES_KM, LOOP_CHOICES_MI, type JoinedRoute } from '@/domain/routes';
import { useAccount } from '@/features/account/account-provider';
import { useTeen } from '@/features/account/teen';
import { useMe } from '@/features/data/hooks';
import { pickLoops, planSuggestion, type LoopPlan } from '@/features/heatmap/suggest';
import { useHeatmap, useHeatmapActions, useHeatmapTiles, useHotspots } from '@/features/heatmap/use-heatmap';
import { toRouteInput } from '@/features/routes/planner';
import { routeDistance } from '@/features/routes/route-text';
import { describeRouteError, useRouteActions, useRoutes } from '@/features/routes/use-routes';
import { Text } from '@/design/text';
import { colors, radius, space } from '@/design/tokens';

/** The tiles' colours, faintest first (server/src/heatmap.ts). */
const LEVEL_COLORS = ['rgba(226,72,32,0.47)', 'rgba(242,104,32,0.67)', 'rgba(252,156,44,0.84)', 'rgb(255,222,92)'];
const SUGGESTIONS = 3;

interface Suggestion {
  plan: LoopPlan;
  route: JoinedRoute | null;
  error: string | null;
}

function Legend() {
  return (
    <View style={styles.legend} accessible accessibilityLabel="Brighter paths are busier.">
      <Text variant="caption" tone="secondary">
        Quieter
      </Text>
      {LEVEL_COLORS.map((c) => (
        <View key={c} style={[styles.swatch, { backgroundColor: c }]} />
      ))}
      <Text variant="caption" tone="secondary">
        Busier
      </Text>
    </View>
  );
}

/**
 * Popular paths (docs/ROADMAP.md 5.4): the heatmap around the runner, and loops the planner makes
 * through the busiest places nearby. A path shows only once 5 different runners have run it, from
 * runners who add their runs; the first and last 200 m of every run and everyone's privacy zones
 * are never used. Rebuilt weekly.
 */
export default function PopularPathsScreen() {
  const router = useRouter();
  const { api } = useAccount();
  const { isTeen } = useTeen();
  const units = useMe().data?.data.profile?.units ?? 'metric';
  const heat = useHeatmap(!isTeen);
  const data = heat.data?.data;
  const tiles = useHeatmapTiles(data?.build ? data.build.id : null);
  const contribution = useHeatmapActions();
  const planning = useRoutes().data?.data.planning_available ?? false;
  const routeActions = useRouteActions();

  const [here, setHere] = useState<{ lat: number; lon: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [locationNote, setLocationNote] = useState<string | null>(null);
  const hotspots = useHotspots(data?.build ? here : null);
  const choices = units === 'imperial' ? LOOP_CHOICES_MI : LOOP_CHOICES_KM;
  const perUnit = units === 'imperial' ? 1609.344 : 1000;
  const [distance, setDistance] = useState(String(choices[1]));
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [finding, setFinding] = useState(false);
  const [shown, setShown] = useState(0);
  const plans = useMemo(
    () => (here && hotspots.data ? pickLoops(here, hotspots.data.data, Number(distance) * perUnit, SUGGESTIONS) : []),
    [here, hotspots.data, distance, perUnit],
  );

  const locate = async () => {
    setLocating(true);
    setLocationNote(null);
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (!permission.granted) {
        setLocationNote('Location is off. Allow it to see popular paths near you.');
        return;
      }
      const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      setHere({ lat: position.coords.latitude, lon: position.coords.longitude });
    } catch {
      setLocationNote('Couldn’t find where you are. Try again.');
    } finally {
      setLocating(false);
    }
  };

  // Where the runner is, if they've already let the app know.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const permission = await Location.getForegroundPermissionsAsync();
      if (!permission.granted) return;
      const position = (await Location.getLastKnownPositionAsync()) ?? (await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }));
      if (alive && position) setHere({ lat: position.coords.latitude, lon: position.coords.longitude });
    })().catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const find = async () => {
    if (!api || !here) return;
    setFinding(true);
    setShown(0);
    const found: Suggestion[] = [];
    for (const plan of plans) {
      try {
        found.push({ plan, route: await planSuggestion(api, here, plan), error: null });
      } catch (e) {
        found.push({ plan, route: null, error: describeRouteError(e) });
      }
      setSuggestions([...found]);
    }
    setFinding(false);
  };

  const save = async (s: Suggestion) => {
    if (!s.route) return;
    const name = `Popular loop · ${routeDistance(s.route.distanceM, units)}`;
    const saved = await routeActions.save(null, toRouteInput(name, 'path', s.route));
    if (saved) router.push({ pathname: '/train/routes/[id]', params: { id: saved.id } });
  };

  if (isTeen) {
    return (
      <Screen edges={['top', 'bottom']}>
        <NavHeader title="Popular paths" />
        <InlineStatus title="Your account can’t use this." />
      </Screen>
    );
  }

  const current = suggestions?.[shown] ?? null;
  const guide = current?.route ? current.route.points.map((p) => ({ latitude: p[0], longitude: p[1] })) : null;
  const builtOn = data?.build ? new Date(data.build.built_at_ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : null;

  return (
    <Screen edges={['top', 'bottom']}>
      <NavHeader title="Popular paths" />
      {heat.isError && !data ? <InlineStatus tone="danger" title="Couldn’t load the heatmap." body="Check your connection and try again." /> : null}
      {data && !data.build ? (
        <InlineStatus title="The heatmap isn’t ready yet." body="It’s updated once a week, from the runs of runners who add theirs. Check back soon." />
      ) : null}

      {data?.build ? (
        here && tiles.data ? (
          <HeatMapView
            center={here}
            tiles={tiles.data.data}
            height={320}
            route={guide}
            accessibilityLabel="Heatmap of popular running paths around you. Brighter paths are busier."
          />
        ) : !here ? (
          <Card style={styles.card}>
            <Text variant="body" tone="secondary">
              See the paths runners use most around you.
            </Text>
            <SecondaryButton label="Show paths near me" icon={LocateFixed} onPress={() => void locate()} loading={locating} testID="heat-locate" />
            {locationNote ? <InlineStatus tone="warning" title={locationNote} /> : null}
          </Card>
        ) : tiles.isError ? (
          <InlineStatus tone="danger" title="Couldn’t load the map." body="Check your connection and try again." />
        ) : null
      ) : null}
      {data?.build ? (
        <>
          <Legend />
          <Text variant="caption" tone="secondary">
            A path shows once {data.min_runners} different runners have run it. It never shows where a run starts or ends, or anyone’s privacy zones. Updated
            weekly{builtOn ? `, last on ${builtOn}` : ''}.
          </Text>
        </>
      ) : null}

      {data?.build && here ? (
        <Card style={styles.card}>
          <View style={styles.head}>
            <RouteIcon size={20} color={colors.accent} />
            <Text variant="labelStrong" accessibilityRole="header" style={styles.fill}>
              Loops through busy paths
            </Text>
          </View>
          {!planning ? (
            <Text variant="body" tone="secondary">
              Suggested loops need route planning, which isn’t switched on yet.
            </Text>
          ) : (
            <>
              <ChoiceChips
                label="Distance"
                value={distance}
                onChange={(v) => {
                  setDistance(v);
                  setSuggestions(null);
                }}
                options={choices.slice(0, 4).map((d) => ({ value: String(d), label: `${d} ${units === 'imperial' ? 'mi' : 'km'}` }))}
              />
              {hotspots.data && plans.length === 0 ? (
                <Text variant="body" tone="secondary">
                  No busy paths near you for a loop that long yet. Try another distance.
                </Text>
              ) : null}
              {plans.length > 0 && !suggestions ? (
                <PrimaryButton label="Find loops" icon={Flame} onPress={() => void find()} loading={finding} testID="find-loops" />
              ) : null}
            </>
          )}
          {suggestions && suggestions.length > 0 ? (
            <View style={styles.list}>
              {suggestions.map((s, i) => (
                <Pressable
                  key={i}
                  onPress={() => setShown(i)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: i === shown }}
                  accessibilityLabel={s.route ? `Loop ${i + 1}, ${routeDistance(s.route.distanceM, units)}` : `Loop ${i + 1} couldn’t be planned`}
                  style={[styles.suggestion, i === shown && styles.selected]}
                  testID={`suggestion-${i}`}>
                  <View style={styles.thumb}>
                    {s.route ? (
                      <RouteSketch lines={[]} guide={s.route.points.map((p) => ({ latitude: p[0], longitude: p[1] }))} height={56} width={72} bare />
                    ) : null}
                  </View>
                  <View style={styles.fill}>
                    <Text variant="bodyStrong">{s.route ? routeDistance(s.route.distanceM, units) : `Loop ${i + 1}`}</Text>
                    <Text variant="caption" tone="secondary">
                      {s.error ?? `Through ${s.plan.via.length === 1 ? 'a busy place and back' : `${s.plan.via.length} busy places`}`}
                    </Text>
                  </View>
                </Pressable>
              ))}
              {finding ? (
                <Text variant="caption" tone="secondary">
                  Planning…
                </Text>
              ) : null}
              {current?.route ? (
                <SecondaryButton label="Save this route" icon={Save} onPress={() => void save(current)} loading={routeActions.busy} testID="save-suggestion" />
              ) : null}
              {routeActions.error ? <InlineStatus tone="danger" title={routeActions.error} /> : null}
              <Text variant="caption" tone="secondary">
                Paths from OpenStreetMap. © OpenStreetMap contributors. Check a route before you run it.
              </Text>
            </View>
          ) : null}
        </Card>
      ) : null}

      {data ? (
        <Card style={styles.card}>
          <Text variant="labelStrong" accessibilityRole="header">
            {data.contributing ? 'You’re adding your runs' : 'Add your runs'}
          </Text>
          <Text variant="body" tone="secondary">
            {data.contributing
              ? 'Runs you share with everyone, map included, go into the next weekly update. Stop any time; they’re gone from the update after.'
              : `Runs you share with everyone, map included, can help show popular paths. Only paths ${data.min_runners} or more runners share ever show, never where you start or finish, or your privacy zones.`}
          </Text>
          {contribution.error ? <InlineStatus tone="danger" title={contribution.error} /> : null}
          {data.contributing ? (
            <TextButton label="Stop adding my runs" onPress={() => void contribution.setContribution(false)} testID="heat-stop" />
          ) : (
            <SecondaryButton label="Add my runs" onPress={() => void contribution.setContribution(true)} loading={contribution.busy} testID="heat-contribute" />
          )}
        </Card>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: { gap: space.sm },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  fill: { flex: 1, gap: 2 },
  legend: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  swatch: { width: 24, height: 10, borderRadius: 3 },
  list: { gap: space.sm },
  suggestion: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.sm,
    borderRadius: radius.card,
    backgroundColor: colors.surfaceElevated,
    borderWidth: 1.5,
    borderColor: 'transparent',
  },
  selected: { borderColor: colors.accent },
  thumb: { width: 72, height: 56, borderRadius: radius.control, backgroundColor: colors.background, overflow: 'hidden' },
});
