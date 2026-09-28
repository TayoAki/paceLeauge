import { Award, CircleAlert, Clock, CloudOff, Hourglass, Lock, LockOpen, Pause, TriangleAlert } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Pressable, StyleSheet, View } from 'react-native';

import { SecondaryButton, PrimaryButton } from '@/components/ui/buttons';
import type { GpsQuality } from '@/features/recording/types';
import { Text, type TextVariant } from '@/design/text';
import { colors, heights, radius, space } from '@/design/tokens';

// ---------------------------------------------------------------------------------------
// MetricBlock (value / unit / accessible label)
// ---------------------------------------------------------------------------------------
export function MetricBlock({
  value,
  label,
  accessibilityLabel,
  variant = 'metric',
  align = 'center',
}: {
  value: string;
  label: string;
  accessibilityLabel: string;
  variant?: TextVariant;
  align?: 'center' | 'flex-start';
}) {
  return (
    <View accessible accessibilityLabel={accessibilityLabel} style={[styles.metric, { alignItems: align }]}>
      <Text variant={variant} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
      <Text variant="eyebrow" tone="secondary">
        {label}
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------------------
// GPSStatus (shape + text; color is never the only signal)
// ---------------------------------------------------------------------------------------
const gpsCopy: Record<GpsQuality, string> = {
  searching: 'Finding GPS',
  good: 'GPS good',
  fair: 'GPS fair',
  weak: 'GPS weak',
};

export function GpsStatus({ quality }: { quality: GpsQuality }) {
  const color = quality === 'weak' ? colors.danger : quality === 'searching' ? colors.textSecondary : colors.accent;
  return (
    <View style={styles.gps} accessible accessibilityRole="text" accessibilityLabel={gpsCopy[quality]}>
      {quality === 'weak' ? (
        <TriangleAlert size={16} color={color} strokeWidth={2.4} />
      ) : (
        <View
          style={[
            styles.gpsDot,
            quality === 'good' && { backgroundColor: color },
            quality === 'fair' && { borderColor: color, borderWidth: 2, backgroundColor: 'transparent' },
            quality === 'searching' && { borderColor: color, borderWidth: 2, borderStyle: 'dashed', backgroundColor: 'transparent' },
          ]}
        />
      )}
      <Text variant="labelStrong" style={{ color }}>
        {gpsCopy[quality]}
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------------------
// RecordingControls + touch lock
// ---------------------------------------------------------------------------------------
export function RecordingControls({ onPause, onLock, pausing }: { onPause: () => void; onLock: () => void; pausing?: boolean }) {
  return (
    <View style={styles.controls}>
      <PrimaryButton label="Pause" icon={Pause} size="xl" onPress={onPause} loading={pausing} style={{ flex: 1.6 }} testID="pause-button" />
      <SecondaryButton label="Lock" icon={Lock} size="xl" onPress={onLock} style={{ flex: 1 }} accessibilityHint="Prevents accidental taps. Hold to unlock." />
    </View>
  );
}

const UNLOCK_HOLD_MS = 1200;

/**
 * Accidental-tap safeguard (not device security): blocks touches until the runner holds the
 * unlock control. VoiceOver users unlock with the standard activate action instead.
 */
export function TouchLockOverlay({ onUnlock }: { onUnlock: () => void }) {
  const [holding, setHolding] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const start = () => {
    setHolding(true);
    timer.current = setTimeout(() => {
      setHolding(false);
      onUnlock();
    }, UNLOCK_HOLD_MS);
  };
  const cancel = () => {
    setHolding(false);
    if (timer.current) clearTimeout(timer.current);
  };

  return (
    <View style={styles.lockOverlay} onStartShouldSetResponder={() => true}>
      <Pressable
        onPressIn={start}
        onPressOut={cancel}
        accessibilityRole="button"
        accessibilityLabel="Screen locked. Unlock controls"
        accessibilityHint="Double-tap to unlock"
        accessibilityActions={[{ name: 'activate', label: 'Unlock' }]}
        onAccessibilityAction={(e) => e.nativeEvent.actionName === 'activate' && onUnlock()}
        style={[styles.unlock, holding && { backgroundColor: colors.surfaceElevated }]}>
        <LockOpen size={22} color={colors.accent} />
        <Text variant="bodyStrong">{holding ? 'Keep holding…' : 'Hold to unlock'}</Text>
      </Pressable>
    </View>
  );
}

// ---------------------------------------------------------------------------------------
// XP result panel (saved ≠ synced ≠ accepted)
// ---------------------------------------------------------------------------------------
export type XpPanelState =
  | { kind: 'accepted'; totalXp: number; distanceXp: number; activeDayBonus: number }
  | { kind: 'pending'; estimate: number | null }
  | { kind: 'offline'; estimate: number | null }
  | { kind: 'personal_only'; reason: string }
  /** A walk, hike, ride or other workout: kept in the log, never scored. */
  | { kind: 'not_a_run' }
  | { kind: 'review'; reason: string }
  | { kind: 'scoring_paused' }
  | { kind: 'needs_attention'; reason: string };

function breakdown(distanceXp: number, bonus: number): string {
  const parts = [];
  if (distanceXp) parts.push(`${distanceXp} distance`);
  if (bonus) parts.push(`${bonus} active day`);
  return parts.join(' + ') || 'Already counted today';
}

export function XpPanel({ state }: { state: XpPanelState }) {
  if (state.kind === 'accepted') {
    const detail = breakdown(state.distanceXp, state.activeDayBonus);
    return (
      <View style={styles.xpAccepted} accessible accessibilityLabel={`Plus ${state.totalXp} XP. ${detail}.`} accessibilityLiveRegion="polite">
        <View style={styles.xpIcon}>
          <Award size={26} color={colors.accent} />
        </View>
        <View style={{ flex: 1 }}>
          <Text variant="title" tone="onAccent">
            +{state.totalXp} XP
          </Text>
          <Text variant="label" tone="onAccent">
            {detail}
          </Text>
        </View>
      </View>
    );
  }
  const view = {
    pending: { icon: Hourglass, title: 'Checking your run. XP is pending.', body: state.kind === 'pending' && state.estimate !== null ? `Estimate: +${state.estimate} XP` : undefined },
    offline: {
      icon: CloudOff,
      title: 'Saved on this phone. We’ll sync when you’re online.',
      body: state.kind === 'offline' && state.estimate !== null ? `XP is pending (estimate +${state.estimate}).` : 'XP is pending.',
    },
    personal_only: { icon: Clock, title: 'Saved to your history. This run doesn’t qualify for league XP.', body: 'reason' in state ? state.reason : undefined },
    not_a_run: {
      icon: Clock,
      title: 'Saved to your log.',
      body: 'Only runs earn league XP and count for your weekly goal. Walks, hikes, rides and other workouts stay in your history and stats.',
    },
    review: { icon: Hourglass, title: 'Saved. This run is held for review before it earns XP.', body: 'reason' in state ? state.reason : undefined },
    scoring_paused: { icon: Hourglass, title: 'Saved. League scoring is paused.', body: 'Your XP will be added when scoring resumes.' },
    needs_attention: { icon: CircleAlert, title: 'Saved on this phone, but it couldn’t sync.', body: 'reason' in state ? state.reason : undefined },
  }[state.kind];
  const Icon = view.icon;
  return (
    <View style={styles.xpNeutral} accessible accessibilityLabel={view.body ? `${view.title} ${view.body}` : view.title} accessibilityLiveRegion="polite">
      <Icon size={24} color={state.kind === 'needs_attention' ? colors.danger : colors.accent} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="bodyStrong">{view.title}</Text>
        {view.body ? (
          <Text variant="label" tone="secondary">
            {view.body}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/** Announces a state change once (recording/paused/saved), never every GPS tick. */
export function useAnnounce(message: string | null) {
  useEffect(() => {
    if (message) AccessibilityInfo.announceForAccessibility(message);
  }, [message]);
}

const styles = StyleSheet.create({
  metric: { gap: 2, flex: 1 },
  gps: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 32 },
  gpsDot: { width: 12, height: 12, borderRadius: 6 },
  controls: { flexDirection: 'row', gap: space.md },
  lockOverlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: 'rgba(16,19,21,0.35)',
    justifyContent: 'flex-end',
    padding: space.xl,
  },
  unlock: {
    minHeight: heights.runningPause,
    borderRadius: radius.button,
    borderWidth: 1.5,
    borderColor: colors.accent,
    backgroundColor: colors.surface,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.md,
    marginBottom: space.xxxl,
  },
  xpAccepted: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.lg,
    backgroundColor: colors.accent,
    borderRadius: radius.card,
    padding: space.xl,
  },
  xpIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.onAccent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  xpNeutral: {
    flexDirection: 'row',
    gap: space.md,
    alignItems: 'flex-start',
    backgroundColor: colors.surface,
    borderRadius: radius.card,
    padding: space.xl,
    borderWidth: 1,
    borderColor: colors.decorativeDivider,
  },
});
