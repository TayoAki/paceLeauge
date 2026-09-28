import { useRouter } from 'expo-router';
import { Check, ChevronDown, ChevronUp, Circle, CirclePause, CircleX, Flag, Footprints, Zap } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Pill } from '@/components/ui/elements';
import { Card } from '@/components/ui/layout';
import { isoWeekday, parseIsoDate } from '@/domain/calendar';
import type { PlanWarning } from '@/domain/plans/types';
import { DAY_NAMES, FOCUS_NAMES, formatMinutes, PLAN_NAMES, type SessionView, type WeekView } from '@/features/plans/plan-client';
import { useTodaysPlan } from '@/features/plans/use-plan';
import { Text } from '@/design/text';
import { colors, radius, space } from '@/design/tokens';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function dayLabel(date: string, today?: string): string {
  if (today && date === today) return 'Today';
  const { month, day } = parseIsoDate(date);
  return `${DAY_NAMES[isoWeekday(date)]!.slice(0, 3)} ${day} ${MONTHS[month - 1]}`;
}

const STATUS_WORDS: Record<SessionView['status'], string> = {
  done: 'Done',
  missed: 'Missed',
  today: 'Today',
  upcoming: 'Planned',
  paused: 'Paused',
};

function StatusMark({ status, hard }: { status: SessionView['status']; hard: boolean }) {
  const size = 22;
  switch (status) {
    case 'done':
      return (
        <View style={[styles.mark, { backgroundColor: colors.accent }]}>
          <Check size={16} color={colors.onAccent} strokeWidth={3} />
        </View>
      );
    case 'missed':
      return <CircleX size={size} color={colors.textSecondary} />;
    case 'paused':
      return <CirclePause size={size} color={colors.textSecondary} />;
    default:
      return hard ? <Zap size={size} color={colors.accent} /> : <Circle size={size} color={status === 'today' ? colors.accent : colors.controlOutline} />;
  }
}

/** One session in a week: its day, what it is, and whether it's done. */
export function SessionRow({ view, today, last }: { view: SessionView; today: string; last?: boolean }) {
  const router = useRouter();
  const s = view.session;
  const race = s.kind === 'race';
  return (
    <Pressable
      onPress={() => router.push({ pathname: '/train/session/[id]', params: { id: s.id } })}
      accessibilityRole="button"
      accessibilityLabel={`${dayLabel(s.date, today)}. ${s.title}, ${formatMinutes(s.durationS)}. ${STATUS_WORDS[view.status]}.`}
      style={({ pressed }) => [styles.row, !last && styles.rowDivider, pressed && { backgroundColor: colors.surfaceElevated }]}>
      {race ? <Flag size={22} color={colors.accent} /> : <StatusMark status={view.status} hard={s.hard} />}
      <View style={styles.rowText}>
        <Text variant="caption" tone={view.status === 'today' ? 'accent' : 'secondary'}>
          {dayLabel(s.date, today).toUpperCase()}
        </Text>
        <Text variant="bodyStrong" numberOfLines={2} style={view.status === 'missed' || view.status === 'paused' ? { color: colors.textSecondary } : null}>
          {s.title}
        </Text>
      </View>
      <Text variant="label" tone="secondary">
        {formatMinutes(s.durationS)}
      </Text>
    </Pressable>
  );
}

/** A week of the plan, open for this week and folded for the others. */
export function WeekCard({ week, today, initiallyOpen }: { week: WeekView; today: string; initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(!!initiallyOpen);
  const focus = FOCUS_NAMES[week.focus];
  const summary = week.focus === 'paused' ? 'Paused' : `${week.done} of ${week.sessions.length} done · ${formatMinutes(week.minutes * 60)}`;
  return (
    <Card style={styles.week}>
      <Pressable
        onPress={() => setOpen(!open)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`Week ${week.index}, ${focus}. ${summary}`}
        style={styles.weekHeader}>
        <View style={styles.rowText}>
          <View style={styles.weekTitle}>
            <Text variant="bodyStrong">Week {week.index}</Text>
            {week.current ? <Pill label="This week" /> : null}
            {week.focus !== 'build' ? <Pill label={focus} tone="neutral" /> : null}
          </View>
          <Text variant="label" tone="secondary">
            {summary}
          </Text>
        </View>
        {open ? <ChevronUp size={22} color={colors.textSecondary} /> : <ChevronDown size={22} color={colors.textSecondary} />}
      </Pressable>
      {open ? (
        week.sessions.length === 0 ? (
          <Text variant="label" tone="secondary" style={{ paddingVertical: space.sm }}>
            {week.focus === 'paused' ? 'Nothing planned while the plan is paused.' : 'No sessions this week.'}
          </Text>
        ) : (
          <View>
            {week.sessions.map((view, i) => (
              <SessionRow key={view.session.id} view={view} today={today} last={i === week.sessions.length - 1} />
            ))}
          </View>
        )
      ) : null}
    </Card>
  );
}

export function warningText(w: PlanWarning): string {
  const week = w.week ? `week ${w.week}` : 'the plan';
  switch (w.code) {
    case 'goal_ambitious':
      return 'Your goal is faster than this plan can build to from your recent runs. Paces use the fastest the plan can build to instead.';
    case 'short_runway':
      return 'The race is sooner than this plan usually needs. It still gets you there, with less time to build.';
    case 'two_hard_days':
      return `Two hard days in a row in ${week}. Hard days go best with an easy day or rest between.`;
    case 'too_many_hard':
      return `More than two hard sessions in ${week}.`;
    case 'big_jump':
      return `${week.charAt(0).toUpperCase()}${week.slice(1)} is a big step up from the weeks before.`;
    case 'long_run_share':
      return `The long run is more than half of ${week}.`;
    case 'over_max_session':
      return `A session in ${week} is longer than your limit.`;
  }
}

/** A small tile of one number, for plan summaries. */
export function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat} accessible accessibilityLabel={`${label}: ${value}`}>
      <Text variant="section" numberOfLines={1}>
        {value}
      </Text>
      <Text variant="caption" tone="secondary">
        {label}
      </Text>
    </View>
  );
}

/** Home: today's planned workout, or the rest day (docs/ROADMAP.md, Screens). */
export function TodaysWorkoutCard() {
  const router = useRouter();
  const today = useTodaysPlan();
  if (!today) return null;
  const view = today.open ?? today.views[0] ?? null;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => router.navigate(view ? { pathname: '/train/session/[id]', params: { id: view.session.id } } : '/train')}
      style={({ pressed }) => [styles.todayCard, pressed && { opacity: 0.85 }]}>
      <View style={styles.rowText}>
        <Text variant="eyebrow" tone="accent">
          {PLAN_NAMES[today.planType]} · today
        </Text>
        {view ? (
          <>
            <Text variant="bodyStrong">{view.session.title}</Text>
            <Text variant="label" tone="secondary">
              {view.status === 'done' ? 'Done. Nice work.' : `${formatMinutes(view.session.durationS)} · ${view.session.hard ? 'a harder day' : 'easy does it'}`}
            </Text>
          </>
        ) : today.pausedUntil ? (
          <Text variant="bodyStrong">Paused until {dayLabel(today.pausedUntil)}</Text>
        ) : today.startsOn ? (
          <Text variant="bodyStrong">Starts {dayLabel(today.startsOn)}</Text>
        ) : (
          <Text variant="bodyStrong">Rest day</Text>
        )}
      </View>
      {view?.status === 'done' ? <StatusMark status="done" hard={false} /> : null}
    </Pressable>
  );
}

export function RunWalkIcon() {
  return <Footprints size={22} color={colors.accent} />;
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md, minHeight: 56 },
  rowDivider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.decorativeDivider },
  rowText: { flex: 1, gap: 2 },
  mark: { width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  week: { gap: space.sm, paddingVertical: space.md },
  weekHeader: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 44 },
  weekTitle: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' },
  todayCard: { flexDirection: 'row', alignItems: 'center', gap: space.md, backgroundColor: colors.surface, borderRadius: radius.card, padding: space.lg },
  stat: { flex: 1, backgroundColor: colors.surface, borderRadius: radius.control, padding: space.md, gap: 2 },
});
