import * as Location from 'expo-location';
import { useRouter } from 'expo-router';
import { LocateFixed, Repeat, RotateCcw, Shuffle, Trash2, Undo2 } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import type { Planned } from '@/api/routes-api';
import { CAN_DRAW, PlannerMap } from '@/components/routes/planner-map';
import type { LatLng } from '@/components/run/route-lines';
import { PrimaryButton, SecondaryButton, TextButton } from '@/components/ui/buttons';
import { ChoiceChips, InlineStatus, SegmentedControl, SwitchRow, TextField, RowGroup } from '@/components/ui/elements';
import { Card, NavHeader, Screen } from '@/components/ui/layout';
import { defaultRouteName, LOOP_CHOICES_KM, LOOP_CHOICES_MI, ROUTE_LIMITS, toLatLon, toRoutePoint, type RoutePoint } from '@/domain/routes';
import { useAccount } from '@/features/account/account-provider';
import { useMe } from '@/features/data/hooks';
import { addPoint, drawn, drawnKind, EMPTY_DRAW, loopRoute, nextFrom, plannedLeg, toRouteInput, undo, type DrawState } from '@/features/routes/planner';
import { routeClimb, routeDistance } from '@/features/routes/route-text';
import { describeRouteError, useRouteActions, useRoutes } from '@/features/routes/use-routes';
import { Text } from '@/design/text';
import { space } from '@/design/tokens';

type Mode = 'loop' | 'draw';

const latLng = (p: RoutePoint): LatLng => ({ latitude: p[0], longitude: p[1] });

/**
 * The route planner (docs/ROADMAP.md 5.1): a loop of a chosen distance from where the runner is,
 * planned along paths by the routing service; or a route drawn by tapping the map, each stretch
 * following paths (when planning is on) or a straight line.
 */
export default function PlanRouteScreen() {
  const router = useRouter();
  const { api } = useAccount();
  const units = useMe().data?.data.profile?.units ?? 'metric';
  const list = useRoutes().data?.data;
  const available = list?.planning_available ?? false;
  const full = (list?.routes.length ?? 0) >= ROUTE_LIMITS.routes;
  const actions = useRouteActions();

  const [mode, setMode] = useState<Mode>('loop');
  const [error, setError] = useState<string | null>(null);
  const [here, setHere] = useState<LatLng | null>(null);
  const [locating, setLocating] = useState(false);
  const [locationNote, setLocationNote] = useState<string | null>(null);

  // Loop
  const [start, setStart] = useState<LatLng | null>(null);
  const choices = units === 'imperial' ? LOOP_CHOICES_MI : LOOP_CHOICES_KM;
  const perUnit = units === 'imperial' ? 1609.344 : 1000;
  const [distance, setDistance] = useState<string>(String(choices[1]));
  const [loop, setLoop] = useState<Planned | null>(null);
  const [variant, setVariant] = useState(0);
  const [planning, setPlanning] = useState(false);

  // Draw
  const [draw, setDraw] = useState<DrawState>(EMPTY_DRAW);
  const [snap, setSnap] = useState(true);
  const [legBusy, setLegBusy] = useState(false);

  const [name, setName] = useState('');

  /** Finds the runner; `useAsStart` moves the loop's start there even if one was tapped. */
  const locate = async (useAsStart = false) => {
    setLocating(true);
    setLocationNote(null);
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (!permission.granted) {
        setLocationNote(CAN_DRAW ? 'Location is off. Tap the map to choose where to start.' : 'Location is off. Allow it for this site to plan from where you are.');
        return;
      }
      const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const p = { latitude: position.coords.latitude, longitude: position.coords.longitude };
      setHere(p);
      setStart((s) => (useAsStart ? p : (s ?? p)));
      if (useAsStart) setLoop(null);
    } catch {
      setLocationNote('Couldn’t find where you are. Try again, or tap the map to choose a start.');
    } finally {
      setLocating(false);
    }
  };

  // Where the runner is, if they've already let the app know; otherwise they're asked when they
  // tap "Start where I am".
  useEffect(() => {
    let alive = true;
    void (async () => {
      const permission = await Location.getForegroundPermissionsAsync();
      if (!permission.granted) return;
      const position = (await Location.getLastKnownPositionAsync()) ?? (await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }));
      if (!alive || !position) return;
      const p = { latitude: position.coords.latitude, longitude: position.coords.longitude };
      setHere(p);
      setStart((s) => s ?? p);
    })().catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const planLoop = async (nextVariant: number) => {
    if (!api || !start) return;
    setPlanning(true);
    setError(null);
    try {
      const planned = await api.planLoop(toLatLon(toRoutePoint({ lat: start.latitude, lon: start.longitude })), Number(distance) * perUnit, nextVariant);
      setLoop(planned);
      setVariant(nextVariant);
    } catch (e) {
      setError(describeRouteError(e));
    } finally {
      setPlanning(false);
    }
  };

  const tapMap = async (p: LatLng) => {
    setError(null);
    if (mode === 'loop') {
      setStart(p);
      setLoop(null);
      return;
    }
    if (legBusy) return;
    const point = toRoutePoint({ lat: p.latitude, lon: p.longitude });
    const from = nextFrom(draw);
    if (!from || !snap || !available || !api) {
      setDraw((d) => addPoint(d, point, null));
      return;
    }
    setLegBusy(true);
    try {
      const planned = await api.planLeg(toLatLon(from), toLatLon(point));
      setDraw((d) => addPoint(d, point, plannedLeg(planned)));
    } catch (e) {
      setError(`${describeRouteError(e)} Turn off “Follow paths” to draw a straight line.`);
    } finally {
      setLegBusy(false);
    }
  };

  const closeLoop = () => {
    const first = draw.points[0];
    if (first) void tapMap(latLng(first));
  };

  const current = mode === 'loop' ? (loop ? loopRoute(loop) : null) : drawn(draw);
  const kind = mode === 'loop' ? 'loop' : drawnKind(draw);
  const line = useMemo(() => (current ? current.points.map(latLng) : null), [current]);
  const markers = mode === 'loop' ? (start && !loop ? [start] : []) : draw.points.map(latLng);
  const suggested = current ? defaultRouteName(kind, current.distanceM, units) : '';

  const save = async () => {
    if (!current) return;
    const saved = await actions.save(null, toRouteInput(name.trim() || suggested, kind, current));
    if (saved) router.replace({ pathname: '/train/routes/[id]', params: { id: saved.id } });
  };

  const mapLabel =
    mode === 'loop'
      ? loop
        ? `Map of the planned loop, ${routeDistance(loop.distance_m, units)}.`
        : 'Map of where the loop starts.'
      : current
        ? `Map of the route drawn so far, ${routeDistance(current.distanceM, units)}. Tap the map to add a point.`
        : 'Map. Tap it to place the start, then each point of the route.';

  return (
    <Screen edges={['top', 'bottom']}>
      <NavHeader title="Plan a route" />
      <SegmentedControl
        label="How to plan"
        options={[
          { value: 'loop', label: 'Loop' },
          { value: 'draw', label: 'Draw' },
        ]}
        value={mode}
        onChange={(m) => {
          setMode(m);
          setError(null);
        }}
      />

      <PlannerMap
        route={line}
        markers={markers}
        center={start ?? here}
        height={320}
        accessibilityLabel={mapLabel}
        onPress={CAN_DRAW ? (p) => void tapMap(p) : undefined}
      />
      {available ? (
        <Text variant="caption" tone="secondary">
          Paths from OpenStreetMap. © OpenStreetMap contributors.
        </Text>
      ) : null}
      {locationNote ? <InlineStatus tone="warning" title={locationNote} /> : null}
      {error ? <InlineStatus tone="danger" title={error} /> : null}

      {mode === 'loop' ? (
        <Card style={styles.card}>
          {!available && list ? (
            <InlineStatus
              title="Loops of a set distance need route planning, which isn’t switched on yet."
              body={CAN_DRAW ? 'You can draw a route point to point instead.' : 'Draw routes in the PaceLeague app on your phone.'}
            />
          ) : null}
          <Text variant="labelStrong">Distance</Text>
          <ChoiceChips
            label="Loop distance"
            value={distance}
            onChange={(v) => {
              setDistance(v);
              setLoop(null);
            }}
            options={choices.map((c) => ({ value: String(c), label: `${c} ${units === 'imperial' ? 'mi' : 'km'}` }))}
          />
          <Text variant="caption" tone="secondary">
            {start
              ? start === here
                ? 'Starting where you are.'
                : 'Starting where you tapped.'
              : CAN_DRAW
                ? 'Tap the map to choose where to start, or use where you are.'
                : 'Use where you are to start.'}
          </Text>
          <SecondaryButton label="Start where I am" icon={LocateFixed} onPress={() => void locate(true)} loading={locating} />
          {loop ? (
            <View style={styles.result} accessibilityLiveRegion="polite">
              <Text variant="title">{routeDistance(loop.distance_m, units)}</Text>
              <Text variant="caption" tone="secondary">
                {[
                  loop.within_tolerance ? 'Within 2% of the distance you chose.' : 'The closest loop we could find from here.',
                  routeClimb(loop.ascent_m, units),
                  `${loop.cues.length} turns`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
              <SecondaryButton label="Try another loop" icon={Shuffle} onPress={() => void planLoop(variant + 1)} loading={planning} testID="another-loop" />
            </View>
          ) : (
            <PrimaryButton label="Plan loop" icon={Repeat} onPress={() => void planLoop(0)} loading={planning} disabled={!available || !start} testID="plan-loop" />
          )}
        </Card>
      ) : (
        <Card style={styles.card}>
          {CAN_DRAW ? (
            <>
              <Text variant="body" tone="secondary">
                Tap the map to place the start, then each point of the route in order.
              </Text>
              {available ? (
                <RowGroup>
                  <SwitchRow label="Follow paths" hint="Off: straight lines between your points." value={snap} onChange={setSnap} last />
                </RowGroup>
              ) : null}
              {current ? (
                <Text variant="title" accessibilityLiveRegion="polite">
                  {routeDistance(current.distanceM, units)}
                </Text>
              ) : null}
              {legBusy ? (
                <Text variant="label" tone="secondary">
                  Planning along paths…
                </Text>
              ) : null}
              <View style={styles.buttons}>
                <SecondaryButton label="Undo" icon={Undo2} onPress={() => setDraw((d) => undo(d))} disabled={draw.points.length === 0 || legBusy} style={styles.fill} />
                <SecondaryButton label="Back to start" icon={RotateCcw} onPress={closeLoop} disabled={draw.points.length < 2 || legBusy} style={styles.fill} />
              </View>
              <TextButton label="Clear" icon={Trash2} tone="danger" onPress={() => setDraw(EMPTY_DRAW)} disabled={draw.points.length === 0} />
            </>
          ) : (
            <InlineStatus title="Drawing a route needs the map in the PaceLeague app on your phone." body="Here you can plan a loop of a set distance." />
          )}
        </Card>
      )}

      {current ? (
        <Card style={styles.card}>
          <TextField label="Name" value={name} onChangeText={setName} placeholder={suggested} maxLength={ROUTE_LIMITS.nameLength} testID="route-name" />
          {actions.error ? <InlineStatus tone="danger" title={actions.error} /> : null}
          {full ? <InlineStatus tone="warning" title="You have 100 saved routes, the most there can be. Delete one to save this." /> : null}
          <PrimaryButton label="Save route" onPress={() => void save()} loading={actions.busy} disabled={full || legBusy || planning} testID="save-route" />
        </Card>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: { gap: space.sm },
  result: { gap: space.xs },
  buttons: { flexDirection: 'row', gap: space.sm },
  fill: { flex: 1 },
});
