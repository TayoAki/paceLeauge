import { COACH_TEMPLATES, coachNote, type CoachNoteInput, type CoachRule } from '../coach-notes';
import { paceZones } from '../plans/paces';

const zones = paceZones(1500, 300); // 5K in 25:00: easy 6:06–7:06 /km
const base: CoachNoteInput = { runId: 'run-1', distanceM: 8_000, activeMs: 50 * 60_000 };
const rule = (input: Partial<CoachNoteInput>) => coachNote({ ...base, ...input })?.rule ?? null;

describe('coach notes', () => {
  it('has at least one template for every rule, each a sentence or two', () => {
    for (const [name, templates] of Object.entries(COACH_TEMPLATES)) {
      expect(templates.length).toBeGreaterThan(0);
      for (const t of templates) {
        expect(t.length).toBeLessThanOrEqual(120);
        expect(t).toMatch(/[.!]$/);
        if (name !== 'record') expect(t).not.toContain('{');
      }
    }
  });

  it('picks the rule in order: firsts and records, then the plan, then the run itself', () => {
    expect(rule({ firstRun: true, newRecord: '5k' })).toBe('first_run');
    expect(rule({ newRecord: '5k', session: { kind: 'easy', effort: 'easy', durationS: 3000 } })).toBe('record');
    expect(rule({ session: { kind: 'race', effort: 'race', durationS: 1500 } })).toBe('race_done');
    expect(rule({ session: { kind: 'run_walk', effort: 'easy', durationS: 1800 } })).toBe('run_walk_done');
    expect(rule({ session: { kind: 'tempo', effort: 'tempo', durationS: 6000 } })).toBe('short_of_plan');
    expect(rule({ session: { kind: 'easy', effort: 'easy', durationS: 1800 } })).toBe('over_plan');
    expect(rule({ session: { kind: 'intervals', effort: 'interval', durationS: 3000 } })).toBe('hard_done');
    expect(rule({ session: { kind: 'long', effort: 'easy', durationS: 3000 } })).toBe('long_done');
  });

  it('knows an easy day run too fast from one held easy', () => {
    const easy = { kind: 'easy' as const, effort: 'easy' as const, durationS: 3000 };
    // 8 km in 50 min is 6:15 /km: easy for this runner.
    expect(rule({ session: easy, zones })).toBe('easy_on_pace');
    // 8 km in 40 min is 5:00 /km: far quicker than easy.
    expect(rule({ session: { ...easy, durationS: 2400 }, zones, activeMs: 40 * 60_000 })).toBe('easy_too_fast');
    // Without paces, effort can't be judged.
    expect(rule({ session: { ...easy, durationS: 2400 }, activeMs: 40 * 60_000 })).toBe('easy_on_pace');
  });

  it('reads pacing from splits when there was no plan', () => {
    expect(rule({ splitPacesS: [380, 375, 370, 360, 355, 350] })).toBe('negative_split');
    expect(rule({ splitPacesS: [360, 362, 358, 361, 359] })).toBe('even_pace');
    expect(rule({ splitPacesS: [340, 370, 390, 420] })).toBeNull();
    expect(rule({ weekGoalMet: true, splitPacesS: [340, 370, 390, 420] })).toBe('week_goal');
  });

  it('says nothing about very short activities, and the same thing every time for a run', () => {
    expect(coachNote({ ...base, activeMs: 30_000, firstRun: true })).toBeNull();
    const a = coachNote({ ...base, newRecord: '10k' });
    expect(a?.text).toMatch(/10K/);
    expect(coachNote({ ...base, newRecord: '10k' })).toEqual(a);
    const texts = new Set(['a', 'b', 'c', 'd', 'e', 'f'].map((id) => coachNote({ ...base, runId: id, firstRun: true })!.text));
    expect(texts.size).toBe(COACH_TEMPLATES.first_run.length);
  });

  it('maps every rule to its templates', () => {
    const rules = Object.keys(COACH_TEMPLATES) as CoachRule[];
    expect(rules.sort()).toEqual(
      ['even_pace', 'easy_on_pace', 'easy_too_fast', 'first_run', 'hard_done', 'long_done', 'negative_split', 'over_plan', 'race_done', 'record', 'run_walk_done', 'short_of_plan', 'week_goal'].sort(),
    );
  });
});
