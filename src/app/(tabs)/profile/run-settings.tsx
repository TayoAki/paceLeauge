import { Headphones, HeartPulse, Pause, Volume2 } from 'lucide-react-native';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { StyleSheet, View } from 'react-native';

import { SecondaryButton } from '@/components/ui/buttons';
import { ChoiceChips, InlineStatus, RowGroup, SegmentedControl, SwitchRow } from '@/components/ui/elements';
import { Card, NavHeader, Screen } from '@/components/ui/layout';
import { cueText, type CueField, type CueSettings } from '@/domain/cues';
import { useAccountServices } from '@/features/account/account-provider';
import { useMe } from '@/features/data/hooks';
import { CUE_VOLUME, type CueVolume, type RunSettings } from '@/features/voice/run-settings';
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

/** Voice cues and auto-pause (docs/ROADMAP.md 1.1 and 1.3). Saved on this phone. */
export default function RunSettingsScreen() {
  const { runtime } = useAccountServices();
  const store = runtime.runSettings;
  const settings = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const units = useMe().data?.data.profile?.units ?? store.units;
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [healthBlocked, setHealthBlocked] = useState(false);
  const health = runtime.health;

  useEffect(() => store.setUnits(units), [store, units]);

  const save = (next: RunSettings) => {
    setError(null);
    void store.save(next).catch(() => setError('Couldn’t save your settings. Try again.'));
  };
  const setCues = (cues: CueSettings) => save({ ...settings, cues });

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
