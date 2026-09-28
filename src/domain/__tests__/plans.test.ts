import { addDays } from '../calendar';
import {
  ADAPT,
  checkInAdjustments,
  coachPrompts,
  feedbackAdjustments,
  sessionStatus,
  weekProgress,
  type SessionRecord,
} from '../plans/adapt';
import { blocksDurationS, generatePlan, planSessions, PROGRESSION, sessionsOn, validatePlanInput } from '../plans/generate';
import { fitness5kS, heatSlowdown, hrRangeForEffort, hrZones, paceZones, riegel } from '../plans/paces';
import { PLAN_LEVELS, PLAN_TYPES, RUN_WALK_LADDER, TEMPLATES } from '../plans/templates';
import type { Plan, PlanAdjustment, PlanInput } from '../plans/types';

/**
 * Golden cases for the plan engine (docs/ROADMAP.md 3.1): every template, the rules, edits,
 * missed sessions and pauses. A change to a template or a rule shows up here for the coach.
 */

const MONDAY = '2026-10-05';

const input = (overrides: Partial<PlanInput> = {}): PlanInput => ({
  type: '5k',
  level: 'beginner',
  startDate: MONDAY,
  raceDate: null,
  goalTimeS: null,
  daysPerWeek: 3,
  longRunDay: 6,
  maxSessionMin: null,
  recentInjury: false,
  history: { weeklyMinutes: [], longestRunMin: 0, bestEfforts: {} },
  ...overrides,
});

/** One line a week: focus, minutes, then each session's day of the month, kind and minutes. */
const shape = (plan: Plan) =>
  plan.weeks.map(
    (w) => `${w.focus} ${w.minutes}: ${w.sessions.map((s) => `${s.date.slice(8)} ${s.kind} ${Math.round(s.durationS / 60)}`).join(', ')}`,
  );
const minutes = (plan: Plan) => plan.weeks.map((w) => w.minutes);
const session = (plan: Plan, id: string) => planSessions(plan).find((s) => s.id === id);

describe('every template', () => {
  it('follows the rules on its own, at every level, for every number of days and long-run day', () => {
    const problems: string[] = [];
    const histories = [
      { weeklyMinutes: [], longestRunMin: 0, bestEfforts: {} },
      { weeklyMinutes: [90, 120, 100, 130], longestRunMin: 50, bestEfforts: { '5k': 1560 } },
    ];
    for (const type of PLAN_TYPES) {
      const tpl = TEMPLATES[type];
      for (const level of PLAN_LEVELS) {
        for (let days = tpl.minDays; days <= 6; days++) {
          for (const longRunDay of [0, 2, 5, 6]) {
            for (const history of histories) {
              const name = `${type}/${level}/${days}d/L${longRunDay}/${history.longestRunMin}`;
              const plan = generatePlan(input({ type, level, daysPerWeek: days, longRunDay, history }));
              if (plan.warnings.length) problems.push(`${name}: ${JSON.stringify(plan.warnings)}`);
              const sessions = planSessions(plan);
              if (new Set(sessions.map((s) => s.id)).size !== sessions.length) problems.push(`${name}: duplicate ids`);
              for (const week of plan.weeks) {
                const most = week.focus === 'race' ? 3 : Math.min(days, tpl.maxDays[level]);
                if (week.sessions.length > most) problems.push(`${name} w${week.index}: ${week.sessions.length} sessions`);
                for (const s of week.sessions) {
                  if (s.date < week.startDate || s.date > addDays(week.startDate, 6)) problems.push(`${name} ${s.id}: outside its week`);
                  if (s.kind !== 'race' && blocksDurationS(s.blocks) !== s.durationS) problems.push(`${name} ${s.id}: steps don't add up`);
                  if (s.durationS < 15 * 60) problems.push(`${name} ${s.id}: too short`);
                }
              }
              if (tpl.race) {
                const last = sessions[sessions.length - 1];
                if (last?.kind !== 'race' || last.date !== plan.endDate) problems.push(`${name}: doesn't end with the race`);
              }
            }
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('is deterministic', () => {
    const a = generatePlan(input({ type: 'half', level: 'intermediate', daysPerWeek: 5 }));
    const b = generatePlan(input({ type: 'half', level: 'intermediate', daysPerWeek: 5 }));
    expect(a).toEqual(b);
  });

  it('writes a beginner 5K: small steps, a lighter week every third, one hard session from week 2', () => {
    expect(shape(generatePlan(input()))).toEqual([
      'build 60: 06 easy 15, 08 easy 20, 11 long 25',
      'build 65: 13 tempo 25, 15 easy 15, 18 long 25',
      'lighter 50: 20 easy 15, 22 easy 15, 25 long 20',
      'build 70: 27 tempo 25, 29 easy 15, 01 long 30',
      'build 75: 03 intervals 25, 05 easy 20, 08 long 30',
      'lighter 55: 10 easy 15, 12 easy 15, 15 long 25',
      'build 80: 17 intervals 25, 19 easy 25, 22 long 30',
      'race 75: 24 easy 20, 26 easy 20, 29 race 35',
    ]);
  });

  it('takes a new runner from one-minute runs to 30 minutes without stopping', () => {
    const plan = generatePlan(input({ type: 'start_running', daysPerWeek: 5 }));
    expect(plan.weeks.map((w) => w.sessions.length)).toEqual([3, 3, 3, 3, 3, 3, 3, 3]);
    expect(plan.weeks.map((w) => w.sessions[0]!.title)).toEqual([
      'Run/walk: 8 × 1 min',
      'Run/walk: 7 × 90 s',
      'Run/walk: 6 × 2 min',
      'Run/walk: 5 × 3 min',
      'Run/walk: 4 × 5 min',
      'Run/walk: 3 × 8 min',
      'Run/walk: 2 × 15 min',
      'Run 30 min',
    ]);
    // Runners who can already run a little start further up the ladder.
    expect(generatePlan(input({ type: 'start_running', level: 'intermediate' })).weeks).toHaveLength(RUN_WALK_LADDER.length - 2);
  });

  it('builds a half marathon to a race date: base weeks first, then the build, taper and race', () => {
    const plan = generatePlan(
      input({
        type: 'half',
        level: 'intermediate',
        daysPerWeek: 4,
        longRunDay: 5,
        raceDate: '2027-01-16',
        goalTimeS: 6600,
        history: { weeklyMinutes: [150, 170, 160, 180], longestRunMin: 80, bestEfforts: { '10k': 3000, '5k': 1450 } },
      }),
    );
    expect(shape(plan)).toEqual([
      'base 165: 05 tempo 35, 07 easy 30, 08 easy 35, 10 long 65',
      'base 165: 12 intervals 35, 14 easy 30, 15 easy 35, 17 long 65',
      'base 165: 19 tempo 35, 21 easy 30, 22 easy 35, 24 long 65',
      'build 180: 26 intervals 35, 28 steady 35, 29 easy 40, 31 long 70',
      'build 200: 02 tempo 40, 04 steady 40, 05 easy 45, 07 long 75',
      'build 220: 09 intervals 45, 11 steady 45, 12 easy 45, 14 long 85',
      'lighter 165: 16 tempo 35, 18 easy 30, 19 easy 35, 21 long 65',
      'build 230: 23 intervals 45, 25 steady 45, 26 easy 50, 28 long 90',
      'build 255: 30 tempo 50, 02 steady 50, 03 easy 60, 05 long 95',
      'build 280: 07 intervals 55, 09 steady 55, 10 easy 65, 12 long 105',
      'lighter 210: 14 tempo 40, 16 easy 45, 17 easy 45, 19 long 80',
      'build 295: 21 intervals 60, 23 steady 60, 24 easy 65, 26 long 110',
      'build 310: 28 tempo 60, 30 steady 60, 31 easy 70, 02 long 120',
      'taper 250: 04 intervals 50, 06 easy 50, 07 easy 55, 09 long 95',
      'race 170: 13 easy 30, 14 easy 30, 16 race 110',
    ]);
    expect(plan.warnings).toEqual([]);
    expect(plan.predictedTimeS).toBe(6620);
    // Race pace is the goal's: 6,600 s over 21.1 km.
    expect(plan.zones?.race).toEqual({ fastSPerKm: 310, slowSPerKm: 316 });
    expect(session(plan, 'w13-d5')?.title).toBe('Long run, steady finish');
  });

  it('writes long runs no longer than the runner will go, and no longer than their history allows at first', () => {
    const capped = generatePlan(input({ type: 'marathon', level: 'intermediate', daysPerWeek: 4, maxSessionMin: 90 }));
    const sessions = planSessions(capped).filter((s) => s.kind !== 'race');
    expect(Math.max(...sessions.map((s) => s.durationS))).toBe(90 * 60);
    expect(capped.warnings).toEqual([]);

    const history = { weeklyMinutes: [200, 200, 200, 200], longestRunMin: 40, bestEfforts: {} };
    const plan = generatePlan(input({ type: 'half', level: 'intermediate', daysPerWeek: 4, history }));
    expect(session(plan, 'w1-d6')).toMatchObject({ kind: 'long', durationS: 50 * 60 });
  });
});

describe('where a plan starts', () => {
  const start = (overrides: Partial<PlanInput>) => generatePlan(input({ type: '10k', level: 'intermediate', daysPerWeek: 4, ...overrides })).weeks[0]!;

  it('starts from the last four weeks, zero weeks included, within the template’s range', () => {
    const history = (weeklyMinutes: number[]) => ({ weeklyMinutes, longestRunMin: 60, bestEfforts: {} });
    expect(start({ history: history([100, 0, 120, 140]) }).minutes).toBe(90);
    // Nothing recorded: the template's own start.
    expect(start({}).minutes).toBe(140);
    // Never below half the template's start, never above most of its peak.
    expect(start({ history: history([10, 10, 10, 10]) }).minutes).toBe(70);
    expect(start({ history: history([600, 600, 600, 600]) }).minutes).toBe(215);
  });

  it('starts lower after an injury', () => {
    expect(start({ recentInjury: true }).minutes).toBe(105);
  });

  it('can start partway through the first week', () => {
    const plan = generatePlan(input({ firstDay: '2026-10-08' }));
    expect(plan.weeks[0]!.sessions.map((s) => s.date)).toEqual(['2026-10-08', '2026-10-11']);
    expect(plan.weeks[0]!.daysOff).toBe(3);
  });
});

describe('race day', () => {
  it('rests the day before, runs nothing hard in the two days before, and stops after the race', () => {
    // A Monday race after Wednesday long runs puts the last hard session on the Sunday before.
    const plan = generatePlan(input({ type: '10k', level: 'intermediate', daysPerWeek: 5, longRunDay: 2, raceDate: '2026-12-07' }));
    const sessions = planSessions(plan);
    const race = sessions[sessions.length - 1]!;
    expect(race).toMatchObject({ kind: 'race', date: '2026-12-07', distanceM: 10_000 });
    expect(sessions.filter((s) => s.date >= addDays(race.date, -2) && s.date < race.date).every((s) => !s.hard)).toBe(true);
    expect(plan.warnings).toEqual([]);
  });

  it('warns when the race is too soon, and still gets the runner there', () => {
    const plan = generatePlan(input({ type: 'marathon', level: 'intermediate', daysPerWeek: 4, raceDate: '2026-11-15' }));
    expect(plan.warnings).toContainEqual({ code: 'short_runway' });
    expect(plan.weeks.map((w) => w.focus)).toEqual(['build', 'build', 'build', 'taper', 'taper', 'race']);
  });

  it('warns when a goal outruns what the plan can build, and trains at the pace it can', () => {
    const history = { weeklyMinutes: [150, 150, 150, 150], longestRunMin: 60, bestEfforts: { '5k': 1500 } };
    const plan = generatePlan(input({ type: '10k', level: 'intermediate', daysPerWeek: 4, goalTimeS: 2400, history }));
    expect(plan.predictedTimeS).toBe(3127);
    expect(plan.warnings).toContainEqual({ code: 'goal_ambitious' });
    // Ten weeks allow 6% faster than today: 2,939 s, not the goal's 2,400.
    expect(plan.zones?.race).toEqual({ fastSPerKm: 291, slowSPerKm: 297 });
    expect(session(plan, 'w10-d6')?.durationS).toBe(2400);

    const finishOnly = generatePlan(input({ type: '10k', level: 'intermediate', daysPerWeek: 4, history }));
    expect(finishOnly.warnings).toEqual([]);
  });

  it('trains by effort when there are no best efforts', () => {
    expect(generatePlan(input()).zones).toBeNull();
  });
});

describe('pausing', () => {
  const tenK = (adjustments: PlanAdjustment[] = []) =>
    generatePlan(input({ type: '10k', level: 'intermediate', daysPerWeek: 4 }), adjustments);

  it('drops sessions during a short pause and leaves the rest of the plan alone', () => {
    const before = tenK();
    const after = tenK([{ type: 'pause', from: '2026-10-21', to: '2026-10-23' }]);
    expect(planSessions(after).filter((s) => s.date >= '2026-10-21' && s.date <= '2026-10-23')).toEqual([]);
    expect(after.weeks[2]!.daysOff).toBe(3);
    expect(minutes(after).slice(3)).toEqual(minutes(before).slice(3));
  });

  it('comes back lower after a longer pause, easing in with fewer hard sessions, and keeps the race day', () => {
    const before = tenK();
    const after = tenK([{ type: 'pause', from: '2026-10-19', to: '2026-10-28' }]);
    // A race plan's week paused throughout is lost; the race stays put.
    expect(after.weeks[2]).toMatchObject({ focus: 'paused', daysOff: 7, sessions: [] });
    expect(after.endDate).toBe(before.endDate);
    // Back on a Thursday: the rest of that week is easy, and the level is down a quarter.
    const back = after.weeks[3]!;
    expect(back.sessions.every((s) => s.date > '2026-10-28' && !s.hard)).toBe(true);
    expect(after.weeks[4]!.minutes).toBeLessThan(before.weeks[4]!.minutes * 0.85);
    expect(after.warnings).toEqual([]);
  });

  it('carries a plan without a race on after the pause, a week later', () => {
    const before = generatePlan(input({ type: 'consistency', level: 'intermediate', daysPerWeek: 4 }));
    const after = generatePlan(input({ type: 'consistency', level: 'intermediate', daysPerWeek: 4 }), [
      { type: 'pause', from: '2026-10-12', to: '2026-11-01' },
    ]);
    expect(after.weeks.map((w) => w.focus).slice(0, 5)).toEqual(['build', 'paused', 'paused', 'paused', 'build']);
    expect(after.weeks).toHaveLength(before.weeks.length + 3);
    // Three weeks off: back at 60% of the level, holding for a week.
    expect(after.weeks[4]!.minutes).toBeLessThanOrEqual(Math.round(before.weeks[0]!.minutes * 0.6) + 5);
  });

  it('steps run/walk back a rung after a pause of more than a week, then climbs again', () => {
    const plan = generatePlan(input({ type: 'start_running' }), [{ type: 'pause', from: '2026-10-20', to: '2026-10-31' }]);
    expect(plan.weeks.map((w) => w.sessions[0]?.title ?? w.focus)).toEqual([
      'Run/walk: 8 × 1 min',
      'Run/walk: 7 × 90 s',
      'paused',
      'paused',
      'Run/walk: 7 × 90 s',
      'Run/walk: 6 × 2 min',
      'Run/walk: 5 × 3 min',
      'Run/walk: 4 × 5 min',
      'Run/walk: 3 × 8 min',
      'Run/walk: 2 × 15 min',
      'Run 30 min',
    ]);
  });

  it('treats a pause of more than twelve weeks as twelve', () => {
    const plan = generatePlan(input({ type: 'consistency' }), [{ type: 'pause', from: '2026-10-05', to: '2027-10-05' }]);
    expect(plan.weeks.filter((w) => w.focus === 'paused')).toHaveLength(PROGRESSION.maxPauseDays / 7);
  });
});

describe('week edits', () => {
  const fiveK = (adjustments: PlanAdjustment[] = []) =>
    generatePlan(input({ type: '5k', level: 'intermediate', daysPerWeek: 4 }), adjustments);

  it('repeats a week at the same minutes, making room before the race', () => {
    const before = fiveK();
    const after = fiveK([{ type: 'repeat_week', week: 2 }]);
    expect(shape(after)[2]!.replace(/: .*/, '')).toBe(shape(after)[1]!.replace(/: .*/, ''));
    expect(after.weeks[2]!.sessions.map((s) => s.title)).toEqual(after.weeks[1]!.sessions.map((s) => s.title));
    expect(after.weeks).toHaveLength(before.weeks.length);
    expect(after.endDate).toBe(before.endDate);
  });

  it('skips a race-plan week as rest, and a week of another plan by moving on', () => {
    const rest = fiveK([{ type: 'skip_week', week: 3 }]);
    expect(rest.weeks[2]).toMatchObject({ focus: 'paused', sessions: [] });

    const plan = generatePlan(input({ type: 'start_running' }), [{ type: 'skip_week', week: 2 }]);
    expect(plan.weeks.map((w) => w.sessions[0]!.title).slice(0, 2)).toEqual(['Run/walk: 8 × 1 min', 'Run/walk: 6 × 2 min']);
    expect(plan.weeks).toHaveLength(7);
  });

  it('lightens a week and builds on from there', () => {
    const before = fiveK();
    const after = fiveK([{ type: 'lighten', week: 3, factor: 0.85 }]);
    expect(after.weeks[2]!.minutes).toBeLessThan(before.weeks[2]!.minutes);
    expect(after.weeks[4]!.minutes).toBeLessThan(before.weeks[4]!.minutes);
    expect(minutes(after).slice(0, 2)).toEqual(minutes(before).slice(0, 2));
  });
});

describe('session edits', () => {
  const fiveK = (adjustments: PlanAdjustment[] = []) =>
    generatePlan(input({ type: '5k', level: 'intermediate', daysPerWeek: 4 }), adjustments);

  it('moves and swaps sessions, within a week or across weeks', () => {
    const plan = fiveK([
      { type: 'move', sessionId: 'w2-d6', toDate: '2026-10-17' },
      { type: 'move', sessionId: 'w3-d4', toDate: '2026-10-26' },
      { type: 'swap', a: 'w5-d1', b: 'w5-d4' },
    ]);
    expect(session(plan, 'w2-d6')).toMatchObject({ date: '2026-10-17', kind: 'long', edited: true });
    expect(session(plan, 'w3-d4')).toMatchObject({ date: '2026-10-26', week: 4 });
    expect(plan.weeks[3]!.sessions.map((s) => s.id)).toContain('w3-d4');
    const base = fiveK();
    expect(session(plan, 'w5-d1')!.date).toBe(session(base, 'w5-d4')!.date);
    expect(session(plan, 'w5-d4')!.date).toBe(session(base, 'w5-d1')!.date);
  });

  it('changes a session’s length or effort, and swaps it for an easy run or rest', () => {
    const plan = fiveK([
      { type: 'set_duration', sessionId: 'w2-d6', durationS: 3600 },
      { type: 'set_duration', sessionId: 'w2-d1', durationS: 2400 },
      { type: 'set_effort', sessionId: 'w3-d1', effort: 'easy' },
      { type: 'easy_instead', sessionId: 'w4-d1' },
      { type: 'rest_instead', sessionId: 'w4-d4' },
    ]);
    expect(session(plan, 'w2-d6')).toMatchObject({ durationS: 3600, edited: true });
    const intervals = session(plan, 'w2-d1')!;
    expect(intervals.durationS).toBe(2400);
    expect(blocksDurationS(intervals.blocks)).toBe(2400);
    expect(session(plan, 'w3-d1')).toMatchObject({ kind: 'easy', hard: false, effort: 'easy' });
    expect(session(plan, 'w4-d1')).toMatchObject({ kind: 'easy', title: 'Easy run', hard: false });
    expect(session(plan, 'w4-d4')).toBeUndefined();
    expect(plan.weeks[3]!.minutes).toBeLessThan(fiveK().weeks[3]!.minutes);
  });

  it('warns rather than blocks when an edit breaks a rule', () => {
    const plan = fiveK([
      { type: 'move', sessionId: 'w2-d3', toDate: '2026-10-14' },
      { type: 'set_effort', sessionId: 'w3-d4', effort: 'interval' },
      { type: 'set_duration', sessionId: 'w5-d6', durationS: 5 * 3600 },
    ]);
    expect(plan.warnings).toEqual([
      { code: 'two_hard_days', week: 2, sessionId: 'w2-d3' },
      { code: 'two_hard_days', week: 3, sessionId: 'w3-d4' },
      { code: 'too_many_hard', week: 3 },
      { code: 'big_jump', week: 5 },
      { code: 'long_run_share', week: 5 },
    ]);
    const capped = generatePlan(input({ type: '5k', level: 'intermediate', daysPerWeek: 4, maxSessionMin: 45 }), [
      { type: 'set_duration', sessionId: 'w5-d6', durationS: 3600 },
    ]);
    expect(capped.warnings).toContainEqual({ code: 'over_max_session', week: 5, sessionId: 'w5-d6' });
  });

  it('recalculates from a week-level edit onward: earlier session edits there lapse', () => {
    const plan = fiveK([
      { type: 'move', sessionId: 'w2-d1', toDate: '2026-10-14' },
      { type: 'move', sessionId: 'w5-d1', toDate: '2026-11-04' },
      { type: 'pause', from: '2026-10-28', to: '2026-10-30' },
      { type: 'move', sessionId: 'w6-d1', toDate: '2026-11-11' },
    ]);
    expect(session(plan, 'w2-d1')!.date).toBe('2026-10-14');
    expect(session(plan, 'w5-d1')!.date).toBe('2026-11-03');
    expect(session(plan, 'w6-d1')!.date).toBe('2026-11-11');
  });

  it('ignores edits to sessions that don’t exist, and moves outside the plan', () => {
    const plan = fiveK([
      { type: 'move', sessionId: 'w1-d1', toDate: '2027-06-01' },
      { type: 'set_duration', sessionId: 'nope', durationS: 600 },
      { type: 'rest_instead', sessionId: 'w99-d1' },
    ]);
    expect(planSessions(plan)).toEqual(planSessions(fiveK()));
  });
});

describe('listening to the runner', () => {
  const plan = generatePlan(input({ type: '10k', level: 'intermediate', daysPerWeek: 4 }));
  const week2 = plan.weeks[1]!.sessions;
  const record = (sessionId: string, fields: Partial<SessionRecord> = {}): SessionRecord => ({
    sessionId,
    done: true,
    feedback: null,
    pain: false,
    ...fields,
  });

  it('lightens the next week after two "too hard" answers, once', () => {
    const records = [record(week2[0]!.id, { feedback: 'too_hard' }), record(week2[1]!.id, { feedback: 'hard' })];
    expect(feedbackAdjustments(plan, records)).toEqual([]);
    records.push(record(week2[2]!.id, { feedback: 'too_hard' }));
    const lighten = feedbackAdjustments(plan, records);
    expect(lighten).toEqual([{ type: 'lighten', week: 3, factor: ADAPT.lightenFactor }]);
    const lighter = generatePlan(plan.input, lighten);
    expect(feedbackAdjustments(lighter, records)).toEqual([]);
    expect(lighter.weeks[2]!.minutes).toBeLessThan(plan.weeks[2]!.minutes);
    expect(coachPrompts(lighter, records, '2026-10-20')).toContainEqual({ kind: 'lightened', week: 3 });
  });

  it('swaps the day for an easy run or rest when the runner isn’t feeling 100%', () => {
    const hardDay = planSessions(plan).find((s) => s.hard)!;
    expect(checkInAdjustments(plan, hardDay.date, 'easy')).toEqual([{ type: 'easy_instead', sessionId: hardDay.id }]);
    expect(checkInAdjustments(plan, hardDay.date, 'rest')).toEqual([{ type: 'rest_instead', sessionId: hardDay.id }]);
    expect(checkInAdjustments(plan, hardDay.date, 'rest', [record(hardDay.id)])).toEqual([]);
    const restDay = addDays(hardDay.date, 1);
    expect(sessionsOn(plan, restDay)).toEqual([]);
    expect(checkInAdjustments(plan, restDay, 'easy')).toEqual([]);
  });

  it('brings up a pain flag for a week', () => {
    const s = week2[0]!;
    const records = [record(s.id, { pain: true })];
    expect(coachPrompts(plan, records, s.date)).toEqual([{ kind: 'pain', sessionId: s.id }]);
    expect(coachPrompts(plan, records, addDays(s.date, 8))).toEqual([]);
  });

  it('drops missed sessions instead of cramming them in, and offers a pause after a stretch of them', () => {
    const sessions = planSessions(plan);
    const done = sessions.filter((s) => s.date < '2026-10-19').map((s) => record(s.id));
    const today = '2026-10-29';
    // The plan is the same whatever was missed: nothing moves to the days after.
    expect(generatePlan(plan.input, plan.adjustments)).toEqual(plan);
    expect(sessions.filter((s) => s.date >= '2026-10-19' && s.date < today).map((s) => sessionStatus(s, undefined, today))).toEqual([
      'missed',
      'missed',
      'missed',
      'missed',
      'missed',
    ]);
    const prompts = coachPrompts(plan, done, today);
    expect(prompts).toEqual([{ kind: 'missed', pause: { type: 'pause', from: '2026-10-20', to: '2026-10-28' } }]);
    // Taking the offer eases the way back.
    const paused = generatePlan(plan.input, [(prompts[0] as { pause: PlanAdjustment }).pause]);
    expect(paused.weeks[4]!.minutes).toBeLessThan(plan.weeks[4]!.minutes);
    expect(coachPrompts(paused, done, today)).toEqual([]);
    // Too soon to offer.
    expect(coachPrompts(plan, done, '2026-10-24')).toEqual([]);
  });

  it('counts a week’s done sessions', () => {
    const records = new Map(week2.slice(0, 2).map((s) => [s.id, record(s.id)]));
    expect(weekProgress(plan.weeks[1]!, records)).toEqual({ planned: week2.length, done: 2 });
    expect(sessionStatus(week2[3]!, undefined, week2[3]!.date)).toBe('today');
    expect(sessionStatus(week2[3]!, undefined, week2[0]!.date)).toBe('upcoming');
  });
});

describe('setup answers', () => {
  it('names what is wrong', () => {
    expect(validatePlanInput(input())).toBeNull();
    expect(validatePlanInput(input({ startDate: '2026-10-06' }))).toBe('bad_start');
    expect(validatePlanInput(input({ startDate: '2026-02-30' }))).toBe('bad_start');
    expect(validatePlanInput(input({ firstDay: '2026-10-12' }))).toBe('bad_first_day');
    expect(validatePlanInput(input({ raceDate: '2026-10-01' }))).toBe('bad_race_date');
    expect(validatePlanInput(input({ type: 'consistency', raceDate: '2026-12-01' }))).toBe('bad_race_date');
    expect(validatePlanInput(input({ raceDate: '2027-12-01' }))).toBe('race_too_far');
    expect(validatePlanInput(input({ goalTimeS: 60 }))).toBe('bad_goal');
    expect(validatePlanInput(input({ type: 'return', goalTimeS: 1800 }))).toBe('bad_goal');
    expect(validatePlanInput(input({ daysPerWeek: 7 }))).toBe('bad_days');
    expect(validatePlanInput(input({ type: 'marathon', daysPerWeek: 2 }))).toBe('too_few_days');
    expect(validatePlanInput(input({ longRunDay: 7 }))).toBe('bad_long_run_day');
    expect(validatePlanInput(input({ maxSessionMin: 10 }))).toBe('bad_max_session');
    expect(() => generatePlan(input({ daysPerWeek: 1 }))).toThrow(RangeError);
  });
});

describe('paces', () => {
  it('predicts race times with Riegel’s formula from efforts of a mile or more', () => {
    expect(Math.round(riegel(1500, 5000, 10_000))).toBe(3127);
    expect(fitness5kS({ '1k': 200, '10k': 3000 })).toBe(1439);
    expect(fitness5kS({ '1k': 200 })).toBeNull();
    expect(fitness5kS({ '5k': 1500, '10k': 3300 })).toBe(1500);
  });

  it('orders the zones from easy to interval, easy the widest', () => {
    const z = paceZones(1500, 290);
    expect(z.easy).toEqual({ fastSPerKm: 366, slowSPerKm: 426 });
    expect(z.interval.slowSPerKm).toBeLessThan(z.tempo.fastSPerKm);
    expect(z.tempo.slowSPerKm).toBeLessThan(z.steady.fastSPerKm);
    expect(z.steady.slowSPerKm).toBeLessThan(z.easy.fastSPerKm);
  });

  it('slows down for heat and humidity, and says when not to run hard at all', () => {
    expect(heatSlowdown(10, 5)).toBe(0);
    expect(heatSlowdown(25, 15)).toBe(0.03);
    expect(heatSlowdown(38, 28)).toBeNull();
  });

  it('gives heart-rate zones and a range for each effort', () => {
    expect(hrZones(190)[1]).toEqual({ low: 114, high: 133 });
    expect(hrRangeForEffort(190, 'easy')).toEqual({ low: 114, high: 137 });
  });
});
