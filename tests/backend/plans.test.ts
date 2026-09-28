import { randomUUID } from 'node:crypto';

import { addDays, competitionDate, weekStartOf } from '@/domain/calendar';
import { generatePlan } from '@/domain/plans/generate';
import type { Plan, PlanAdjustment, PlanInput } from '@/domain/plans/types';

import { expectCode, TestDb, type TestUser } from './helpers/db';
import { runAt, uploadRun } from './helpers/runs';

/**
 * Training plans (docs/ROADMAP.md 3.1), the database's side: saving what recreates a plan, keeping
 * the log through edits, matching runs to sessions, feedback, export and deletion. The engine
 * itself is tested in src/domain/__tests__/plans.test.ts.
 */
let db: TestDb;

beforeAll(async () => {
  db = await TestDb.create();
});

afterAll(async () => {
  await db.close();
});

const ZONE = 'America/Chicago';
const today = competitionDate(Date.now(), ZONE);
/** Two weeks ago Monday: the plan's first two weeks are history. */
const start = addDays(weekStartOf(today), -14);

function planInput(overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    type: 'consistency',
    level: 'intermediate',
    startDate: start,
    raceDate: null,
    goalTimeS: null,
    daysPerWeek: 4,
    longRunDay: 6,
    maxSessionMin: null,
    recentInjury: false,
    history: { weeklyMinutes: [120, 130, 110, 140], longestRunMin: 60, bestEfforts: {} },
    ...overrides,
  };
}

const wire = (plan: Plan) =>
  plan.weeks.flatMap((w) =>
    w.sessions.map((s) => ({
      id: s.id,
      date: s.date,
      week: s.week,
      kind: s.kind,
      title: s.title,
      hard: s.hard,
      duration_s: s.durationS,
      distance_m: s.distanceM,
      effort: s.effort,
      blocks: s.blocks,
      edited: s.edited ?? false,
    })),
  );

async function save(user: TestUser, plan: Plan, options: { id?: string; baseVersion?: number | null; sessions?: unknown[] } = {}) {
  return db.rpc(user, 'save_plan', {
    p_plan_id: options.id ?? randomUUID(),
    p_base_version: options.baseVersion ?? null,
    p_input: plan.input,
    p_adjustments: plan.adjustments,
    p_sessions: options.sessions ?? wire(plan),
    p_engine_version: plan.engineVersion,
    p_time_zone: ZONE,
    p_end_date: plan.endDate,
  });
}

/** A run at midday in Chicago on a date. */
function middayOn(date: string): number {
  return Date.parse(`${date}T18:00:00Z`);
}

type Session = { id: string; date: string; run_id: string | null; matched_by: string | null; feedback: string | null; pain: boolean; duration_s: number; kind: string };
const sessionsOf = (plan: { sessions: Session[] }) => new Map(plan.sessions.map((s) => [s.id, s]));

describe('saving a plan', () => {
  it('keeps what recreates the plan, and the sessions the engine laid out', async () => {
    const runner = await db.createRunner('Plan Pat');
    const plan = generatePlan(planInput());
    const saved = await save(runner, plan);
    expect(saved).toMatchObject({ version: 1, type: 'consistency', status: 'active', time_zone: ZONE, start_date: start, end_date: plan.endDate, today });
    expect(saved.input).toEqual(plan.input);
    expect(saved.sessions.map((s: Session) => s.id)).toEqual(wire(plan).map((s) => s.id));
    expect(generatePlan(saved.input, saved.adjustments)).toEqual(plan);
    expect((await db.rpc(runner, 'get_plan')).plan.id).toBe(saved.id);

    // Retrying the same save is refused as stale rather than applied twice.
    await expectCode(save(runner, plan, { id: saved.id, baseVersion: 0 }), 'conflict');
  });

  it('recalculates from today: history stays, open sessions from today on are replaced', async () => {
    const runner = await db.createRunner('Plan Quinn');
    const plan = generatePlan(planInput());
    const first = await save(runner, plan);
    const past = plan.weeks[0]!.sessions[0]!;
    const run = await uploadRun(db, runner, runAt(middayOn(past.date), 5_000, 1_800));
    expect(sessionsOf(await db.rpc(runner, 'get_plan').then((r) => r.plan)).get(past.id)).toMatchObject({ run_id: run.runId, matched_by: 'auto' });

    // Pause from today for a week: the past is untouched, the plan from today on changes.
    const adjustments: PlanAdjustment[] = [{ type: 'pause', from: today, to: addDays(today, 6) }];
    const edited = generatePlan(plan.input, adjustments);
    const next = await db.rpc(runner, 'save_plan', {
      p_plan_id: first.id,
      p_base_version: 1,
      p_input: edited.input,
      p_adjustments: adjustments,
      // A tampered past session is ignored.
      p_sessions: wire(edited).map((s) => (s.id === past.id ? { ...s, duration_s: 60 } : s)),
      p_engine_version: 1,
      p_time_zone: 'UTC',
      p_end_date: edited.endDate,
    });
    expect(next.version).toBe(2);
    expect(next.time_zone).toBe(ZONE);
    const byId = sessionsOf(next);
    expect(byId.get(past.id)).toMatchObject({ run_id: run.runId, duration_s: past.durationS });
    expect(next.sessions.filter((s: Session) => s.date >= today && s.date <= addDays(today, 6))).toEqual([]);
    expect(next.adjustments).toEqual(adjustments);
    // Sessions before today that weren't done stay as they were: missed, not moved.
    const missed = plan.weeks[1]!.sessions.filter((s) => s.date < today);
    for (const s of missed) expect(byId.get(s.id)).toMatchObject({ date: s.date, run_id: null });
  });

  it('refuses stale saves, other people’s plans and bad sessions', async () => {
    const runner = await db.createRunner('Plan Rae');
    const other = await db.createRunner('Plan Sol');
    const plan = generatePlan(planInput());
    const saved = await save(runner, plan);
    await save(runner, plan, { id: saved.id, baseVersion: 1 });
    await expectCode(save(runner, plan, { id: saved.id, baseVersion: 1 }), 'conflict');
    await expectCode(save(other, plan, { id: saved.id, baseVersion: 2 }), 'not_found');
    expect((await db.rpc(other, 'get_plan')).plan).toBeNull();

    const sessions = wire(plan);
    const bad = async (patch: Record<string, unknown>) => save(runner, plan, { sessions: [{ ...sessions[0]!, ...patch }] });
    await expectCode(bad({ id: 'w1-d9' }), 'invalid_input');
    await expectCode(bad({ date: '2020-01-01' }), 'invalid_input');
    await expectCode(bad({ date: '2026-02-30' }), 'invalid_input');
    await expectCode(bad({ kind: 'sprint' }), 'invalid_input');
    await expectCode(bad({ duration_s: 5 }), 'invalid_input');
    await expectCode(bad({ blocks: 'lots' }), 'invalid_input');
    await expectCode(save(runner, plan, { sessions: [sessions[0], sessions[0]] }), 'invalid_input');
    await expectCode(
      db.rpc(runner, 'save_plan', {
        p_plan_id: randomUUID(),
        p_base_version: null,
        p_input: { ...plan.input, startDate: addDays(start, 1) },
        p_adjustments: [],
        p_sessions: [],
        p_engine_version: 1,
        p_time_zone: ZONE,
        p_end_date: plan.endDate,
      }),
      'invalid_input',
    );
    await expectCode(
      db.rpc(runner, 'save_plan', {
        p_plan_id: randomUUID(),
        p_base_version: null,
        p_input: plan.input,
        p_adjustments: [],
        p_sessions: [],
        p_engine_version: 1,
        p_time_zone: 'Mars/Olympus',
        p_end_date: plan.endDate,
      }),
      'invalid_input',
    );
  });

  it('replaces the running plan with a new one, and ends plans on request', async () => {
    const runner = await db.createRunner('Plan Tam');
    const first = await save(runner, generatePlan(planInput()));
    const second = await save(runner, generatePlan(planInput({ type: 'return', level: 'beginner' })));
    const [old] = await db.sql<{ status: string }>('select status from private.training_plans where id = $1', [first.id]);
    expect(old!.status).toBe('replaced');
    await expectCode(save(runner, generatePlan(planInput()), { id: first.id, baseVersion: 1 }), 'plan_ended');

    const ended = await db.rpc(runner, 'end_plan', { p_plan_id: second.id });
    expect(ended.plan.status).toBe('ended');
    // Still shown for a while, so the Train tab can say how it went.
    expect((await db.rpc(runner, 'get_plan')).plan.id).toBe(second.id);
    await expectCode(db.rpc(runner, 'end_plan', { p_plan_id: second.id }), 'plan_ended');
  });

  it('completes a plan once its last day has passed', async () => {
    const runner = await db.createRunner('Plan Uma');
    const raceDay = addDays(start, 6);
    const plan = generatePlan(planInput({ type: '5k', raceDate: raceDay, history: { weeklyMinutes: [90, 90, 90, 90], longestRunMin: 40, bestEfforts: {} } }));
    const run = await uploadRun(db, runner, runAt(middayOn(raceDay), 5_000, 1_500));
    const saved = await save(runner, plan);
    // Runs from before the plan was saved are matched too.
    expect(sessionsOf(saved).get(`w1-d6`)).toMatchObject({ kind: 'race', run_id: run.runId, matched_by: 'auto' });
    expect((await db.rpc(runner, 'get_plan')).plan.status).toBe('completed');
  });
});

describe('matching runs to sessions', () => {
  it('matches a run on the planned day, lets the runner choose, and lets go of deleted runs', async () => {
    const runner = await db.createRunner('Plan Val');
    const plan = generatePlan(planInput());
    const saved = await save(runner, plan);
    const [a, b] = plan.weeks[0]!.sessions;
    // A run on a day without a session completes nothing.
    const restDay = addDays(a!.date, 1) === b!.date ? addDays(b!.date, 1) : addDays(a!.date, 1);
    expect(plan.weeks[0]!.sessions.some((s) => s.date === restDay)).toBe(false);
    const offDay = await uploadRun(db, runner, runAt(middayOn(restDay), 4_000, 1_400));
    const onDay = await uploadRun(db, runner, runAt(middayOn(a!.date), 5_000, 1_800));
    const second = await uploadRun(db, runner, runAt(middayOn(a!.date) + 3_600_000, 3_000, 1_000));

    let view = sessionsOf((await db.rpc(runner, 'get_plan')).plan);
    expect(view.get(a!.id)).toMatchObject({ run_id: onDay.runId, matched_by: 'auto' });
    expect([...view.values()].some((s) => s.run_id === offDay.runId || s.run_id === second.runId)).toBe(false);

    // The runner says the rest-day run was session b.
    let picked = await db.rpc(runner, 'match_plan_session', { p_plan_id: saved.id, p_session_id: b!.id, p_run_id: offDay.runId });
    expect(sessionsOf(picked).get(b!.id)).toMatchObject({ run_id: offDay.runId, matched_by: 'runner' });
    // …then that none of their runs was session a.
    picked = await db.rpc(runner, 'match_plan_session', { p_plan_id: saved.id, p_session_id: a!.id, p_run_id: null });
    expect(sessionsOf(picked).get(a!.id)).toMatchObject({ run_id: null, matched_by: 'runner' });
    // Settled by the runner, so a later pass leaves it alone.
    await db.sql('select private.match_plan_runs($1)', [saved.id]);
    view = sessionsOf((await db.rpc(runner, 'get_plan')).plan);
    expect(view.get(a!.id)).toMatchObject({ run_id: null, matched_by: 'runner' });

    await db.rpc(runner, 'delete_run', { p_run_id: offDay.runId });
    view = sessionsOf((await db.rpc(runner, 'get_plan')).plan);
    expect(view.get(b!.id)).toMatchObject({ run_id: null, matched_by: null });

    const stranger = await db.createRunner('Plan Wes');
    const theirs = await uploadRun(db, stranger, runAt(middayOn(a!.date), 5_000, 1_800));
    await expectCode(db.rpc(runner, 'match_plan_session', { p_plan_id: saved.id, p_session_id: b!.id, p_run_id: theirs.runId }), 'not_found');
  });

  it('never matches walks, and a run changed to a walk lets go', async () => {
    const runner = await db.createRunner('Plan Xan');
    const plan = generatePlan(planInput());
    await save(runner, plan);
    const s = plan.weeks[0]!.sessions[0]!;
    await uploadRun(db, runner, runAt(middayOn(s.date), 3_000, 2_400), { extra: { p_activity_type: 'walk' } });
    expect(sessionsOf((await db.rpc(runner, 'get_plan')).plan).get(s.id)!.run_id).toBeNull();

    const run = await uploadRun(db, runner, runAt(middayOn(s.date) + 7_200_000, 5_000, 1_800));
    expect(sessionsOf((await db.rpc(runner, 'get_plan')).plan).get(s.id)!.run_id).toBe(run.runId);
    await db.sql(`update public.runs set activity_type = 'walk' where id = $1`, [run.runId]);
    expect(sessionsOf((await db.rpc(runner, 'get_plan')).plan).get(s.id)!.run_id).toBeNull();
  });
});

describe('feedback', () => {
  it('records how a session felt and a pain flag', async () => {
    const runner = await db.createRunner('Plan Yas');
    const plan = generatePlan(planInput());
    const saved = await save(runner, plan);
    const s = plan.weeks[0]!.sessions[0]!;
    const result = await db.rpc(runner, 'set_session_feedback', { p_plan_id: saved.id, p_session_id: s.id, p_feedback: 'too_hard', p_pain: true });
    expect(sessionsOf(result).get(s.id)).toMatchObject({ feedback: 'too_hard', pain: true });
    await expectCode(db.rpc(runner, 'set_session_feedback', { p_plan_id: saved.id, p_session_id: s.id, p_feedback: 'meh', p_pain: false }), 'invalid_input');
    await expectCode(db.rpc(runner, 'set_session_feedback', { p_plan_id: saved.id, p_session_id: 'w99-d1', p_feedback: 'easy', p_pain: false }), 'not_found');
  });
});

describe('export and deletion', () => {
  it('exports plans with their sessions, and deletes them with the account', async () => {
    const runner = await db.createRunner('Plan Zed');
    const plan = generatePlan(planInput());
    const saved = await save(runner, plan);
    const job = await db.rpc(runner, 'request_export');
    const data = await db.rpc(runner, 'get_export', { p_export_id: job.export_id });
    expect(data.training_plans).toHaveLength(1);
    expect(data.training_plans[0]).toMatchObject({ id: saved.id, type: 'consistency', input: plan.input });
    expect(data.training_plans[0].sessions).toHaveLength(wire(plan).length);

    await db.sql('select private.purge_user_data($1)', [runner.id]);
    const left = await db.sql('select 1 from private.training_plans where user_id = $1 union all select 1 from private.plan_sessions where user_id = $1', [runner.id]);
    expect(left).toEqual([]);
  });
});
