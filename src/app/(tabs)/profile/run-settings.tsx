import { Activity, Download, Headphones, HeartPulse, Pause, Volume2 } from 'lucide-react-native';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { StyleSheet, View } from 'react-native';

import { SecondaryButton } from '@/components/ui/buttons';
import { ChoiceChips, InlineStatus, RowGroup, SegmentedControl, SwitchRow, TextField } from '@/components/ui/elements';
import { Card, NavHeader, Screen } from '@/components/ui/layout';
import { cueText, type CueField, type CueSettings } from '@/domain/cues';
import { useAccountServices } from '@/features/account/account-provider';
import { useMe } from '@/features/data/hooks';
import { deviceHealthData } from '@/features/health/health-data';
import { useMaxHr } from '@/features/training/use-training';
import {
  CUE_VOLUME,
  MAX_HR_RANGE,
  MAX_SCREEN_FIELDS,
  RUN_SCREEN_FIELDS,
  validMaxHr,
  type CueVolume,
  type RunScreenField,
  type RunSettings,
} from '@/features/voice/run-settings';
import { deviceVoiceOutput } from '@/features/voice/voice-output';
import { Text } from '@/design/text';
import { space } from '@/design/tokens';

type Frequency = 'half' | 'unit' | 'min1' | 'min5' | 'min10' | 'important';

function frequencyOf(cues: CueSettings): Frequency {
  if (cues.mode === 'important') return 'important';
  if (cues.trigger.kind === 'distance') return cues.trigger.every === 0.5 ? 'half' : 'unit';
  return cues.trigger.everyMinutes === 1 ? 'min1' : cues.trigger.everyMinutes === 5 ? 'min5' : 'min10';
}

function withFrequency(cues: CueSettings, frequency: Frequency): CueSettings {
  switch (frequency) {
    case 'important':
      return { ...cues, mode: 'important', trigger: { kind: 'distance', every: 1 } };
    case 'half':
      return { ...cues, mode: 'full', trigger: { kind: 'distance', every: 0.5 } };
    case 'unit':
      return { ...cues, mode: 'full', trigger: { kind: 'distance', every: 1 } };
    case 'min1':
      return { ...cues, mode: 'full', trigger: { kind: 'time', everyMinutes: 1 } };
    case 'min5':
      return { ...cues, mode: 'full', trigger: { kind: 'time', everyMinutes: 5 } };
    case 'min10':
      return { ...cues, mode: 'full', trigger: { kind: 'time', everyMinutes: 10 } };
  }
}

// Heart rate joins this list when a heart-rate source exists (watch support, docs/ROADMAP.md Phase 2).
const FIELD_ROWS: { field: CueField; label: string }[] = [
  { field: 'distance', label: 'Distance' },
  { field: 'time', label: 'Time' },
  { field: 'split', label: 'Split' },
  { field: 'averagePace', label: 'Average pace' },
  { field: 'currentPace', label: 'Current pace' },
];

const SCREEN_FIELD_LABELS: Record<RunScreenField, string> = {
  time: 'Time',
  currentPace: 'Current pace',
  averagePace: 'Average pace',
  lapPace: 'Lap pace',
  lapTime: 'Lap time',
};

/** Voice cues, auto-pause and the run screen (docs/ROADMAP.md 1.1–1.3). Saved on this phone. */
export default function RunSettingsScreen() {
  const { runtime } = useAccountServices();
  const store = runtime.runSettings;
  const settings = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const units = useMe().data?.data.profile?.units ?? store.units;
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [healthBlocked, setHealthBlocked] = useState(false);
  const [importNote, setImportNote] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const health = runtime.health;
  const importer = runtime.healthImport;
  const heartRate = deviceHealthData();
  const maxHr = useMaxHr();
  const [maxHrText, setMaxHrText] = useState(settings.maxHr ? String(settings.maxHr) : '');
  const [maxHrError, setMaxHrError] = useState<string | null>(null);

  useEffect(() => store.setUnits(units), [store, units]);

  const save = (next: RunSettings) => {
    setError(null);
    void store.save(next).catch(() => setError('Couldn’t save your settings. Try again.'));
  };
  const setCues = (cues: CueSettings) => save({ ...settings, cues });

  const toggleImport = async (on: boolean) => {
    setImportNote(null);
    if (!on) {
      save({ ...settings, healthImport: false });
      return;
    }
    setImporting(true);
    try {
      // Asked only now. Health never says whether reading was allowed, so an empty result is
      // explained rather than treated as an error.
      await importer.connect();
      await store.save({ ...store.get(), healthImport: true });
      const added = await importer.importNew();
      setImportNote(
        added > 0
          ? `Added ${added} ${added === 1 ? 'workout' : 'workouts'} from the last 30 days. They sync now.`
          : 'Nothing new from the last 30 days. If you expected runs, check that PaceLeague can read Workouts and Workout Routes in the Health app.',
      );
    } catch {
      setImportNote('Couldn’t read from Apple Health. Try again.');
    } finally {
      setImporting(false);
    }
  };

  const toggleZones = async (on: boolean) => {
    // Permission is asked only now, when the runner switches this on.
    if (on) await heartRate?.requestHeartRate().catch(() => undefined);
    save({ ...store.get(), heartRateZones: on });
  };

  const saveMaxHr = () => {
    const text = maxHrText.trim();
    if (!text) {
      setMaxHrError(null);
      save({ ...store.get(), maxHr: null });
      return;
    }
    const value = validMaxHr(Number(text));
    if (value === null) {
      setMaxHrError(`Enter a whole number from ${MAX_HR_RANGE.min} to ${MAX_HR_RANGE.max}.`);
      return;
    }
    setMaxHrError(null);
    save({ ...store.get(), maxHr: value });
  };

  const toggleHealth = async (on: boolean) => {
    setHealthBlocked(false);
    if (!on) {
      save({ ...settings, appleHealth: false });
      return;
    }
    // Permission is asked only now, when the runner switches this on.
    const allowed = await health.requestAccess();
    if (allowed) save({ ...store.get(), appleHealth: true });
    else setHealthBlocked(true);
  };

  const unit = units === 'imperial' ? 'mile' : 'km';
  const unitLong = units === 'imperial' ? 'mile' : 'kilometer';
  const cues = settings.cues;
  const frequency = frequencyOf(cues);
  const everyField = FIELD_ROWS.every(({ field }) => !cues.fields[field]);

  const playSample = async () => {
    setPlaying(true);
    const sample = cueText(
      { kind: 'progress', index: 1, distanceM: units === 'imperial' ? 1609.344 : 1000, activeMs: 312_000, splitMs: 312_000, currentPaceSPerKm: 305, heartRateBpm: null },
      cues,
      units,
    );
    await deviceVoiceOutput().speak(sample || 'Voice cues are on.', { volume: CUE_VOLUME[settings.cueVolume], allowSpeaker: true });
    setPlaying(false);
  };

  return (
    <Screen edges={['top', 'bottom']}>
      <NavHeader title="Run settings" />

      <RowGroup>
        <SwitchRow
          icon={Volume2}
          label="Voice cues"
          hint="Spoken updates during a run. Your music gets quieter while a cue plays, then comes back."
          value={cues.enabled}
          onChange={(enabled) => setCues({ ...cues, enabled })}
          last
          testID="voice-cues-switch"
        />
      </RowGroup>

      {cues.enabled ? (
        <>
          <Card>
            <Text variant="labelStrong" accessibilityRole="header">
              How often
            </Text>
            <ChoiceChips<Frequency>
              label="How often cues play"
              value={frequency}
              onChange={(next) => setCues(withFrequency(cues, next))}
              options={[
                { value: 'half', label: `Every ½ ${unit}`, accessibilityLabel: `Every half ${unitLong}` },
                { value: 'unit', label: `Every ${unit}`, accessibilityLabel: `Every ${unitLong}` },
                { value: 'min1', label: 'Every minute' },
                { value: 'min5', label: 'Every 5 min', accessibilityLabel: 'Every 5 minutes' },
                { value: 'min10', label: 'Every 10 min', accessibilityLabel: 'Every 10 minutes' },
                { value: 'important', label: 'Splits only' },
              ]}
            />
            {frequency === 'important' ? (
              <Text variant="caption" tone="secondary">
                Just the {unitLong} and your split time — the shortest cues.
              </Text>
            ) : null}
          </Card>

          {frequency !== 'important' ? (
            <View style={styles.group}>
              <Text variant="labelStrong" accessibilityRole="header">
                What you hear
              </Text>
              <RowGroup>
                {FIELD_ROWS.map(({ field, label }, i) => (
                  <SwitchRow
                    key={field}
                    label={label}
                    value={cues.fields[field]}
                    onChange={(on) => setCues({ ...cues, fields: { ...cues.fields, [field]: on } })}
                    last={i === FIELD_ROWS.length - 1}
                  />
                ))}
              </RowGroup>
              {everyField ? <InlineStatus tone="warning" title="Pick at least one thing to hear." body="With everything off, only pauses and the finish are spoken." /> : null}
            </View>
          ) : null}

          <Card>
            <Text variant="labelStrong" accessibilityRole="header">
              Cue volume
            </Text>
            <SegmentedControl<CueVolume>
              label="Cue volume"
              value={settings.cueVolume}
              onChange={(cueVolume) => save({ ...settings, cueVolume })}
              options={[
                { value: 'quiet', label: 'Quiet' },
                { value: 'normal', label: 'Normal' },
                { value: 'loud', label: 'Loud' },
              ]}
            />
            <SecondaryButton label="Play a sample" icon={Volume2} onPress={() => void playSample()} loading={playing} />
          </Card>

          <RowGroup>
            <SwitchRow
              icon={Headphones}
              label="Use the speaker if headphones disconnect"
              hint="Off: cues stop when your headphones do, so your phone never talks out loud mid-run."
              value={settings.speakerFallback}
              onChange={(speakerFallback) => save({ ...settings, speakerFallback })}
              last
            />
          </RowGroup>
        </>
      ) : null}

      <View style={styles.group}>
        <Text variant="labelStrong" accessibilityRole="header">
          Run screen
        </Text>
        <Text variant="caption" tone="secondary">
          Up to {MAX_SCREEN_FIELDS} numbers under your distance. A lap is each full {unitLong}.
        </Text>
        <RowGroup>
          {RUN_SCREEN_FIELDS.map((field, i) => {
            const on = settings.screenFields.includes(field);
            const full = settings.screenFields.length >= MAX_SCREEN_FIELDS;
            const last = on && settings.screenFields.length === 1;
            return (
              <SwitchRow
                key={field}
                label={SCREEN_FIELD_LABELS[field]}
                value={on}
                disabled={(!on && full) || last}
                onChange={(next) =>
                  save({
                    ...settings,
                    screenFields: next
                      ? RUN_SCREEN_FIELDS.filter((f) => f === field || settings.screenFields.includes(f))
                      : settings.screenFields.filter((f) => f !== field),
                  })
                }
                last={i === RUN_SCREEN_FIELDS.length - 1}
              />
            );
          })}
        </RowGroup>
      </View>

      <RowGroup>
        <SwitchRow
          icon={Pause}
          label="Auto-pause"
          hint="Pauses when you stop and resumes when you move. Time stopped never counts."
          value={settings.autoPause}
          onChange={(autoPause) => save({ ...settings, autoPause })}
          last
          testID="auto-pause-switch"
        />
      </RowGroup>

      <View style={styles.group}>
        <Text variant="labelStrong" accessibilityRole="header">
          Heart rate
        </Text>
        {heartRate?.isAvailable() ? (
          <RowGroup>
            <SwitchRow
              icon={Activity}
              label="Heart-rate zones"
              hint="Time in each zone for runs with heart rate from an Apple Watch or another device that saves to Apple Health. Worked out on this phone."
              value={settings.heartRateZones}
              onChange={(on) => void toggleZones(on)}
              last
              testID="hr-zones-switch"
            />
          </RowGroup>
        ) : null}
        <TextField
          label="Maximum heart rate (bpm)"
          value={maxHrText}
          onChangeText={setMaxHrText}
          onBlur={saveMaxHr}
          onSubmitEditing={saveMaxHr}
          keyboardType="number-pad"
          returnKeyType="done"
          maxLength={3}
          placeholder={maxHr?.source === 'observed' ? String(maxHr.value) : 'For example, 185'}
          error={maxHrError}
          hint={
            settings.maxHr
              ? 'Zones and heart-rate ranges use this. Clear it to use the highest heart rate in your runs.'
              : maxHr
                ? `Using ${maxHr.value} bpm, the highest in your recent runs. If you know your maximum from a test, enter it.`
                : 'Zones and heart-rate ranges need it. Enter yours, or run with a heart-rate device and we’ll use the highest we see.'
          }
          testID="max-hr"
        />
      </View>

      {health.available ? (
        <RowGroup>
          <SwitchRow
            icon={HeartPulse}
            label="Save runs to Apple Health"
            hint="Runs you finish appear in Health and Fitness with their route. Deleting or fixing a run here updates it there."
            value={settings.appleHealth}
            onChange={(on) => void toggleHealth(on)}
            last
            testID="apple-health-switch"
          />
        </RowGroup>
      ) : null}
      {importer.available ? (
        <RowGroup>
          <SwitchRow
            icon={Download}
            label="Import runs from Apple Health"
            hint="Runs from your Apple Watch and other apps that save to Health come in on their own. Workouts without a route count for your goals, not league XP."
            value={settings.healthImport}
            disabled={importing}
            onChange={(on) => void toggleImport(on)}
            last
            testID="health-import-switch"
          />
        </RowGroup>
      ) : null}
      {importNote ? <InlineStatus tone="info" title={importNote} /> : null}
      {healthBlocked ? (
        <InlineStatus
          tone="warning"
          title="PaceLeague can’t save to Health yet."
          body="Allow it in the Health app: your profile › Apps › PaceLeague › turn on Workouts and Workout Routes."
        />
      ) : null}

      {error ? <InlineStatus tone="danger" title={error} /> : null}
      <Text variant="caption" tone="secondary">
        Saved on this phone. Changes apply straight away, even during a run.
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  group: { gap: space.sm },
});
