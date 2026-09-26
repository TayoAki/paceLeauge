import { Play, Share2 } from 'lucide-react-native';
import { useState } from 'react';
import { View } from 'react-native';

import { Monogram, PosterLanes, SlantLanes, TierChevron } from '@/components/art/art';
import { LeagueRow } from '@/components/league/league-row';
import { RunRow, TierCard, WeeklyGoal } from '@/components/progress/progress-components';
import { GpsStatus, MetricBlock, RecordingControls, XpPanel, type XpPanelState } from '@/components/run/run-components';
import { SharePoster } from '@/components/share/share-poster';
import { DangerButton, IconButton, PrimaryButton, SecondaryButton, TextButton } from '@/components/ui/buttons';
import { InlineStatus, Pill, ProgressBar, Row, RowGroup, SegmentedControl, TextField } from '@/components/ui/elements';
import { Card, NavHeader, Screen } from '@/components/ui/layout';
import { competitionWeekAt, weekDates } from '@/domain/calendar';
import { Text } from '@/design/text';
import { colors, space } from '@/design/tokens';
import { useNow } from '@/lib/use-now';

const XP_STATES: XpPanelState[] = [
  { kind: 'accepted', totalXp: 77, distanceXp: 52, activeDayBonus: 25 },
  { kind: 'pending', estimate: 77 },
  { kind: 'offline', estimate: 77 },
  {
    kind: 'personal_only',
    reason: 'Too short to count — league runs need at least 100 m.',
  },
  { kind: 'review', reason: 'Some GPS points moved faster than a runner can.' },
  { kind: 'scoring_paused' },
  {
    kind: 'needs_attention',
    reason: 'This run couldn’t be accepted. Your copy is safe on this phone.',
  },
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: space.md }}>
      <Text variant="eyebrow" tone="secondary" accessibilityRole="header">
        {title}
      </Text>
      {children}
    </View>
  );
}

/** Development-only gallery of the design system, for visual QA against the design boards. */
export default function CatalogScreen() {
  const [segment, setSegment] = useState<'this' | 'last'>('this');
  const [text, setText] = useState('Friday morning');
  const week = competitionWeekAt(useNow(60_000));
  const days = weekDates(week.weekStart).map((date, i) => ({
    date,
    active: i === 0 || i === 2,
  }));

  return (
    <Screen edges={['top', 'bottom']}>
      <NavHeader title="Component catalog" />

      <Section title="Typography">
        <Text variant="workout">5.24</Text>
        <Text variant="hero">897 XP</Text>
        <Text variant="display">Show up.</Text>
        <Text variant="title">Friday Crew</Text>
        <Text variant="section">Recent runs</Text>
        <Text variant="body">Your best three days count.</Text>
        <Text variant="label" tone="secondary">
          Rest days keep your rank.
        </Text>
        <Text variant="eyebrow" tone="secondary">
          Private · 8 runners
        </Text>
      </Section>

      <Section title="Buttons">
        <PrimaryButton label="Start run" icon={Play} size="xl" />
        <PrimaryButton label="Done" />
        <PrimaryButton label="Saving" loading />
        <SecondaryButton label="Share stats" icon={Share2} />
        <DangerButton label="Delete account" />
        <View style={{ flexDirection: 'row', gap: space.md, alignItems: 'center' }}>
          <TextButton label="Not now" />
          <TextButton label="Accent" tone="accent" />
          <IconButton icon={Share2} label="Share" />
        </View>
      </Section>

      <Section title="Elements">
        <SegmentedControl
          label="Week"
          value={segment}
          onChange={setSegment}
          options={[
            { value: 'this', label: 'This week' },
            { value: 'last', label: 'Last week' },
          ]}
        />
        <View style={{ flexDirection: 'row', gap: space.sm }}>
          <Pill label="2nd place" />
          <Pill label="Personal" tone="neutral" />
          <Pill label="Needs attention" tone="danger" />
        </View>
        <ProgressBar fraction={0.32} label="32% to Tempo" />
        <TextField label="Run title" value={text} onChangeText={setText} />
        <InlineStatus title="Offline — showing saved standings." />
        <InlineStatus tone="warning" title="League scoring is paused." body="Your runs are saved and will count when scoring resumes." />
        <InlineStatus tone="danger" title="Couldn’t load your league." body="Pull to try again." />
        <InlineStatus tone="success" title="You’re already in this league." />
        <RowGroup>
          <Row label="Routes" value="Only you" />
          <Row label="League profile" value="Members only" onPress={() => {}} />
          <Row label="Delete account" tone="danger" onPress={() => {}} last />
        </RowGroup>
      </Section>

      <Section title="Progress">
        <TierCard lifetimeXp={820} />
        <TierCard lifetimeXp={897} variant="progress" />
        <WeeklyGoal days={days} goalDays={3} />
        <Card>
          <RunRow title="Friday morning" distanceM={5240} activeMs={1_888_000} units="metric" status="accepted" />
          <RunRow title="Tempo loop" distanceM={80} activeMs={50_000} units="metric" status="personal_only" />
          <RunRow title="Evening run" distanceM={4020} activeMs={1_500_000} units="imperial" status="saved_local" last />
        </Card>
      </Section>

      <Section title="League">
        <LeagueRow
          standing={{
            member_id: 'a',
            rank: 1,
            alias: 'Maya',
            tier: 'Stride',
            weekly_xp: 289,
            is_me: false,
            is_owner: false,
            hidden: false,
          }}
        />
        <LeagueRow
          standing={{
            member_id: 'b',
            rank: 2,
            alias: 'Alex',
            tier: 'Stride',
            weekly_xp: 257,
            is_me: true,
            is_owner: true,
            hidden: false,
          }}
        />
        <LeagueRow
          standing={{
            member_id: 'c',
            rank: 3,
            alias: null,
            tier: null,
            weekly_xp: 245,
            is_me: false,
            is_owner: false,
            hidden: true,
          }}
        />
      </Section>

      <Section title="Recording">
        <View style={{ flexDirection: 'row', gap: space.md, flexWrap: 'wrap' }}>
          <GpsStatus quality="searching" />
          <GpsStatus quality="good" />
          <GpsStatus quality="fair" />
          <GpsStatus quality="weak" />
        </View>
        <View style={{ flexDirection: 'row' }}>
          <MetricBlock value="31:28" label="Time" accessibilityLabel="Time" />
          <MetricBlock value="6:00" label="/ km" accessibilityLabel="Pace" />
        </View>
        <RecordingControls onPause={() => {}} onLock={() => {}} />
        {XP_STATES.map((state) => (
          <XpPanel key={state.kind} state={state} />
        ))}
      </Section>

      <Section title="Art and share">
        <View
          style={{
            flexDirection: 'row',
            gap: space.lg,
            alignItems: 'center',
            flexWrap: 'wrap',
          }}>
          <Monogram size={48} />
          <SlantLanes />
          <TierChevron width={110} height={116} />
          <PosterLanes width={110} height={92} />
        </View>
        <View
          style={{
            alignItems: 'center',
            backgroundColor: colors.surface,
            padding: space.lg,
            borderRadius: 24,
          }}>
          <SharePoster stats={{ distanceM: 5240, activeMs: 1_888_000, units: 'metric' }} format="post" width={280} />
        </View>
      </Section>
    </Screen>
  );
}
