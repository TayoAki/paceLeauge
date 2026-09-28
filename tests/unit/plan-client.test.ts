import type { ServerPlan } from '@/api/schemas';
import { generatePlan } from '@/domain/plans/generate';
import { PLAN_ENGINE_VERSION, type PlanAdjustment, type PlanInput } from '@/domain/plans/types';
import {
  currentPause,
  defaultStart,
  describeBlocks,
  formatPaceRange,
  formatRaceTime,
  parseRaceTime,
  planHistory,
  planSave,
  planWeeks,
  readPlan,
  resumeAdjustments,
  suggestedLevel,
  todaysSessions,
  wireSessions,
} from '@/features/plans/plan-client';

const input: PlanInput = {
  type: '10k',
  level: 'intermediate',
  startDate: '2026-10-05',
  raceDate: null,
  goalTimeS: null,
  daysPerWeek: 4,
  longRunDay: 6,
  maxSessionMin: null,
  recentInjury: false,
  history: { weeklyMinutes: [140, 150, 160, 150], longestRunMin: 60, bestEfforts: { '5k': 1500 } },
};

/** The server's copy of a plan, as get_plan returns it, on a given day. */
function serverPlan(today: string, adjustments: PlanAdjustment[] = [], done: string[] = []): ServerPlan {
  const plan = generatePlan(input, adjustments);
  return {
    id: 'plan-1',
    version: 3,
    type: '10k',
    status: 'active',
    engine_version: PLAN_ENGINE_VERSION,
    input,
    adjustments,
    time_zone: 'America/Chicago',
    start_date: input.startDate,
    end_date: plan.endDate,
    today,
    created_at_ms: 0,
    updated_at_ms: 0,
    ended_at_ms: null,
    sessions: wireSessions(plan).map((s) => ({
      ...(s as { id: string; date: string; week: number; title: string; hard: boolean; duration_s: number; distance_m: number | null; blocks: never[]; edited: boolean }),
      kind: s.kind as ServerPlan['sessions'][number]['kind'],
      effort: s.effort as ServerPlan['sessions'][number]['effort'],
      run_id: done.includes(s.id as string) ? `run-${s.id as string}` : null,
      matched_by: done.includes(s.id as string) ? 'auto' : null,
      feedback: null,
      pain: false,
      run: null,
    })),
  };
}

describe('reading a saved plan', () => {
  it('recreates the engine’s plan and knows what was done and missed', () => {
    const state = readPlan(serverPlan('2026-10-15', [], ['w1-d1', 'w1-d6']));
    expect(state.readOnly).toBe(false);
    expect(state.plan?.weeks).toHaveLength(10);
    const weeks = planWeeks(state);
    expect(weeks[0]!.sessions.map((s) => s.status)).toEqual(['done', 'missed', 'missed', 'done']);
    expect(weeks[0]!.done).toBe(2);
    expect(weeks[1]).toMatchObject({ current: true, past: false });
    expect(weeks[1]!.sessions.map((s) => s.status)).toEqual(['missed', 'today', 'upcoming', 'upcoming']);
    expect(todaysSessions(state).map((s) => s.session.id)).toEqual(['w2-d3']);
  });

  it('shows sessions in a pause as paused rather than missed', () => {
    const pause: PlanAdjustment = { type: 'pause', from: '2026-10-06', to: '2026-10-09' };
    const server = serverPlan('2026-10-14');
    // History kept the paused week's sessions on the server.
    const state = readPlan({ ...server, adjustments: [pause] });
    expect(planWeeks(state)[0]!.sessions.map((s) => s.status)).toEqual(['paused', 'paused', 'paused', 'missed']);
  });

  it('shows but won’t change a plan saved by a newer app, or a finished one', () => {
    expect(readPlan({ ...serverPlan('2026-10-14'), engine_version: PLAN_ENGINE_VERSION + 1 })).toMatchObject({ plan: null, readOnly: true });
    expect(readPlan({ ...serverPlan('2026-10-14'), adjustments: [{ type: 'teleport' }] })).toMatchObject({ plan: null, readOnly: true });
    expect(readPlan({ ...serverPlan('2026-10-14'), status: 'ended' }).readOnly).toBe(true);
  });

  it('makes the next version with every edit, ready to save', () => {
    const adjustments: PlanAdjustment[] = [{ type: 'rest_instead', sessionId: 'w2-d2' }];
    const { plan, save } = planSave({ planId: 'plan-1', baseVersion: 3, input, adjustments, timeZone: 'America/Chicago' });
    expect(save).toMatchObject({ planId: 'plan-1', baseVersion: 3, engineVersion: PLAN_ENGINE_VERSION, endDate: plan.endDate, adjustments });
    expect(save.sessions.map((s) => s.id)).not.toContain('w2-d2');
    expect(save.sessions[0]).toEqual(expect.objectContaining({ id: 'w1-d1', duration_s: expect.any(Number), edited: false }));
  });
});

describe('pauses', () => {
  it('knows the pause running today, and ends it early', () => {
    const adjustments: PlanAdjustment[] = [
      { type: 'pause', from: '2026-10-01', to: '2026-10-03' },
      { type: 'pause', from: '2026-10-12', to: '2026-10-25' },
      { type: 'pause', from: '2026-11-02', to: '2026-11-04' },
    ];
    const state = readPlan(serverPlan('2026-10-15', adjustments));
    expect(currentPause(state)).toEqual(adjustments[1]);
    expect(resumeAdjustments(adjustments, '2026-10-15')).toEqual([
      adjustments[0],
      { type: 'pause', from: '2026-10-12', to: '2026-10-14' },
    ]);
  });
});

describe('setup', () => {
  it('starts this week from Monday to Thursday, else next Monday', () => {
    expect(defaultStart('2026-10-05')).toEqual({ startDate: '2026-10-05', firstDay: null });
    expect(defaultStart('2026-10-07')).toEqual({ startDate: '2026-10-05', firstDay: '2026-10-07' });
    expect(defaultStart('2026-10-09')).toEqual({ startDate: '2026-10-12', firstDay: null });
  });

  it('reads history from stats, recent runs and recent records', () => {
    const now = Date.parse('2026-10-05T12:00:00Z');
    const history = planHistory({
      now,
      stats: {
        from: '2026-09-07',
        to: '2026-10-04',
        bucket: 'week',
        activity: 'run',
        buckets: [90, 0, 120, 150].map((m, i) => ({ start: `w${i}`, runs: 2, days: 2, distance_m: 10_000, active_ms: m * 60_000 })),
        total: { runs: 8, days: 8, distance_m: 40_000, active_ms: 0 } as never,
        previous_year: { runs: 0, days: 0, distance_m: 0, active_ms: 0 } as never,
      },
      records: {
        records: [
          { effort: '5k', distance_m: 5000, efforts: 3, best: { run_id: 'a', elapsed_ms: 1_500_000, started_at_ms: now - 30 * 86_400_000, title: '' } },
          { effort: '10k', distance_m: 10_000, efforts: 1, best: { run_id: 'b', elapsed_ms: 3_000_000, started_at_ms: now - 400 * 86_400_000, title: '' } },
        ],
        longest_run: null,
      },
      runs: [
        { startedAtMs: now - 3 * 86_400_000, activeMs: 55 * 60_000 },
        { startedAtMs: now - 40 * 86_400_000, activeMs: 100 * 60_000 },
      ],
    });
    expect(history).toEqual({ weeklyMinutes: [90, 0, 120, 150], longestRunMin: 55, bestEfforts: { '5k': 1500 } });
    expect(suggestedLevel(history)).toBe('intermediate');
    expect(suggestedLevel({ ...history, weeklyMinutes: [] })).toBe('beginner');
  });

  it('reads and writes race times', () => {
    expect(parseRaceTime('25:30')).toBe(1530);
    expect(parseRaceTime('1:52:00')).toBe(6720);
    expect(parseRaceTime('45')).toBe(2700);
    expect(parseRaceTime('1:75')).toBeNull();
    expect(parseRaceTime('fast')).toBeNull();
    expect(formatRaceTime(1530)).toBe('25:30');
    expect(formatRaceTime(6720)).toBe('1:52:00');
  });
});

describe('words', () => {
  it('describes a workout and its paces', () => {
    const plan = generatePlan(input);
    const intervals = plan.weeks.flatMap((w) => w.sessions).find((s) => s.kind === 'intervals')!;
    expect(describeBlocks(intervals.blocks)).toEqual(['12 min easy warm-up', '3 × 4 min hard, 2 min easy recovery', '5 min easy cool-down']);
    expect(formatPaceRange({ fastSPerKm: 300, slowSPerKm: 330 }, 'metric')).toBe('5:00–5:30 /km');
    expect(formatPaceRange({ fastSPerKm: 300, slowSPerKm: 330 }, 'imperial')).toBe('8:03–8:51 /mi');
  });
});
