import { useCalendars } from 'expo-localization';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Minus, Plus, XCircle } from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { DangerButton, IconButton, PrimaryButton } from '@/components/ui/buttons';
import { ConfirmSheet } from '@/components/ui/confirm-sheet';
import { ChoiceChips, InlineStatus, TextField } from '@/components/ui/elements';
import { NavHeader, Screen } from '@/components/ui/layout';
import { clockLabel, dayLabel, groupRunStart, pickerPosition, TIME_STEP_MINUTES } from '@/features/leagues/group-run-time';
import { useGroupRuns, useLeagueActions } from '@/features/leagues/use-leagues';
import { Text } from '@/design/text';
import { space } from '@/design/tokens';

const DAYS = 10;
const DAY_MINUTES = 24 * 60;
const PRESETS = [6 * 60, 7 * 60, 8 * 60, 17 * 60 + 30, 18 * 60 + 30];

/**
 * Plan or change a group run (docs/ROADMAP.md 4.1): a title, a day in the next ten, a time, and a
 * meeting point people can find. Members get a push; whoever says they're going gets a reminder
 * an hour before.
 */
export default function GroupRunScreen() {
  const { leagueId, id } = useLocalSearchParams<{ leagueId: string; id?: string }>();
  const router = useRouter();
  const uses24h = useCalendars()[0]?.uses24hourClock ?? false;
  const existing = (useGroupRuns(leagueId ?? null).data?.data ?? []).find((r) => r.id === id) ?? null;
  const actions = useLeagueActions();
  const [now] = useState(() => Date.now());
  const initial = existing ? pickerPosition(now, existing.starts_at_ms) : null;
  const [title, setTitle] = useState(existing?.title ?? '');
  const [meeting, setMeeting] = useState(existing?.meeting_point ?? '');
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [day, setDay] = useState(initial?.dayOffset ?? 1);
  const [minutes, setMinutes] = useState(initial?.minutes ?? 7 * 60);
  const [confirmCancel, setConfirmCancel] = useState(false);
  // Read here, not inside a handler: the compiler treats values a handler reads as render inputs.
  const existingId = existing?.id ?? null;
  const startsAt = groupRunStart(now, day, minutes);
  const tooSoon = startsAt < now + 15 * 60_000;
  const ready = title.trim().length >= 3 && meeting.trim().length >= 3 && !tooSoon;

  if (id && !existing) {
    return (
      <Screen edges={['top', 'bottom']}>
        <NavHeader title="Group run" />
        <Text variant="label" tone="secondary">
          Loading…
        </Text>
      </Screen>
    );
  }

  const save = async () => {
    if (!leagueId || !ready) return;
    const input = { title: title.trim(), startsAtMs: startsAt, meetingPoint: meeting.trim(), notes: notes.trim() || null };
    const saved = existingId ? await actions.updateGroupRun(existingId, input) : await actions.createGroupRun(leagueId, input);
    if (saved) router.back();
  };

  const step = (delta: number) => setMinutes((m) => (((m + delta) % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES);
  const time = clockLabel(minutes, uses24h);

  return (
    <Screen
      edges={['top', 'bottom']}
      footer={<PrimaryButton label={existing ? 'Save changes' : 'Plan group run'} onPress={() => void save()} disabled={!ready} loading={actions.busy} testID="group-run-save" />}>
      <NavHeader title={existing ? 'Edit group run' : 'Plan a group run'} />
      <Text variant="body" tone="secondary">
        Everyone in the league can see it and say if they’re coming. Whoever’s going gets a reminder an hour before.
      </Text>
      <TextField label="What" value={title} onChangeText={setTitle} maxLength={60} placeholder="Saturday long run" testID="group-run-title" />

      <Text variant="labelStrong">Day</Text>
      <ChoiceChips
        label="Day"
        value={String(day)}
        onChange={(v) => setDay(Number(v))}
        options={Array.from({ length: DAYS }, (_, d) => ({ value: String(d), label: dayLabel(now, d) }))}
      />

      <Text variant="labelStrong">Time</Text>
      <View style={styles.stepper}>
        <IconButton icon={Minus} label={`${TIME_STEP_MINUTES} minutes earlier`} onPress={() => step(-TIME_STEP_MINUTES)} />
        <View
          style={styles.fill}
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel="Start time"
          aria-valuenow={minutes}
          aria-valuemin={0}
          aria-valuemax={DAY_MINUTES - 1}
          aria-valuetext={time}
          accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
          onAccessibilityAction={(event) => step(event.nativeEvent.actionName === 'increment' ? TIME_STEP_MINUTES : -TIME_STEP_MINUTES)}>
          <Text variant="metric" align="center">
            {time}
          </Text>
        </View>
        <IconButton icon={Plus} label={`${TIME_STEP_MINUTES} minutes later`} onPress={() => step(TIME_STEP_MINUTES)} />
      </View>
      <ChoiceChips
        label="Common times"
        value={PRESETS.includes(minutes) ? String(minutes) : ''}
        onChange={(v) => setMinutes(Number(v))}
        options={PRESETS.map((m) => ({ value: String(m), label: clockLabel(m, uses24h) }))}
      />
      {tooSoon ? <InlineStatus tone="warning" title="Pick a time at least 15 minutes from now." /> : null}

      <TextField
        label="Where to meet"
        value={meeting}
        onChangeText={setMeeting}
        maxLength={80}
        placeholder="Lakefront Trail at Fullerton"
        hint="A place everyone can find. It’s shown only to your league."
        testID="group-run-meeting"
      />
      <TextField label="Notes (optional)" value={notes} onChangeText={setNotes} maxLength={280} multiline placeholder="Easy pace, coffee after." style={styles.notes} />
      {actions.error ? <InlineStatus tone="danger" title={actions.error} /> : null}

      {existing ? <DangerButton label="Cancel group run" icon={XCircle} onPress={() => setConfirmCancel(true)} /> : null}
      <ConfirmSheet
        visible={confirmCancel}
        title="Cancel this group run?"
        body="Everyone who said they’d come gets told."
        confirmLabel="Cancel group run"
        cancelLabel="Keep it"
        destructive
        busy={actions.busy}
        onConfirm={() => {
          if (!existingId) return;
          void actions.cancelGroupRun(existingId).then((done) => {
            setConfirmCancel(false);
            if (done) router.back();
          });
        }}
        onCancel={() => setConfirmCancel(false)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  stepper: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  fill: { flex: 1 },
  notes: { minHeight: 80, textAlignVertical: 'top' },
});
