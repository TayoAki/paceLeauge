import { randomUUID } from 'node:crypto';

import { allocateSegmentsToDays } from '@/domain/allocation';
import { destinationPoint } from '@/domain/geo';
import { normalizeAccuracy, normalizeCoordinate } from '@/domain/route-codec';
import { buildSyntheticRun, steadyRun, type SyntheticRun } from '@/domain/synthetic';
import type { TrackPoint } from '@/domain/types';
import { validateRun } from '@/domain/validator';

import { TestDb, type TestUser } from './helpers/db';
import { chunksFor, startArgs } from './helpers/runs';

/**
 * The device shows provisional numbers from src/domain; the server's private.validate_run
 * is authoritative. They must agree: same outcome, reasons, segment/day allocation and
 * active time exactly; distance to the centimetre.
 */

let db: TestDb;
let runner: TestUser;

beforeAll(async () => {
  db = await TestDb.create();
  runner = await db.createRunner('Parity Runner');
});

afterAll(async () => {
  await db.close();
});

/** Deterministic PRNG (mulberry32). */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A noisy, realistic-ish route: jitter, speed changes, dropouts, spikes, duplicates, bad accuracy. */
function randomRun(seed: number): SyntheticRun {
  const rand = prng(seed);
  const startChoices = [
    Date.parse('2026-09-22T11:00:00Z'),
    Date.parse('2026-09-23T04:40:00Z'), // crosses midnight CDT
    Date.parse('2025-11-03T05:20:00Z'), // crosses midnight after fall-back
    Date.parse('2026-03-08T07:30:00Z'), // spring-forward morning
  ];
  const startAt = (startChoices[seed % startChoices.length] as number) + Math.floor(rand() * 600) * 1000;
  const segments = 1 + Math.floor(rand() * 3);
  // Some seeds are deliberately short, sparse or vehicle-fast so every outcome is exercised.
  const short = seed % 7 === 0;
  const sparse = seed % 5 === 0;
  const vehicle = seed % 6 === 0;
  const run = buildSyntheticRun({
    startAt,
    legs: Array.from({ length: segments * 2 - 1 }, (_, i) =>
      i % 2 === 1
        ? { kind: 'pause' as const, durationS: 30 + Math.floor(rand() * 200), movedM: rand() * 300 }
        : {
            kind: 'run' as const,
            durationS: short ? 20 + Math.floor(rand() * 30) : 120 + Math.floor(rand() * 1500),
            speedMps: vehicle && i === 0 ? 14 + rand() * 10 : 2 + rand() * 3,
            bearingDeg: rand() * 360,
            sampleIntervalS: sparse ? 18 : rand() < 0.2 ? 2 : 1,
            accuracyM: 3 + rand() * 12,
            dropouts: rand() < 0.5 ? [[100 + Math.floor(rand() * 50), 130 + Math.floor(rand() * 60)]] : undefined,
          },
    ),
  });
  const points = run.points.map((p): TrackPoint => {
    const jitter = destinationPoint(p, rand() * 360, rand() * 4);
    return { ...p, lat: normalizeCoordinate(jitter.lat), lon: normalizeCoordinate(jitter.lon) };
  });
  // Spikes, poor-accuracy samples, duplicates and a swapped pair.
  for (let k = 0; k < 4; k += 1) {
    const i = Math.floor(rand() * points.length);
    const p = points[i];
    if (!p) continue;
    const r = rand();
    if (r < 0.35) {
      const far = destinationPoint(p, rand() * 360, 200 + rand() * 800);
      points[i] = { ...p, lat: normalizeCoordinate(far.lat), lon: normalizeCoordinate(far.lon) };
    } else if (r < 0.6) {
      points[i] = { ...p, accuracyM: normalizeAccuracy(60 + rand() * 100) };
    } else if (r < 0.8) {
      points.push({ ...p, seq: 100_000 + k });
    } else if (i + 1 < points.length) {
      const q = points[i + 1] as TrackPoint;
      points[i] = { ...q, seq: p.seq };
      points[i + 1] = { ...p, seq: q.seq };
    }
  }
  return { ...run, points };
}

const NAMED_CASES: [string, SyntheticRun][] = [
  ['fixture friday', steadyRun(Date.parse('2026-09-25T12:00:00Z'), 5240, 1888)],
  ['too short', steadyRun(Date.parse('2026-09-25T12:00:00Z'), 80, 70)],
  ['sparse sampling', steadyRun(Date.parse('2026-09-25T12:00:00Z'), 2000, 600, { sampleIntervalS: 20 })],
  ['fast average', steadyRun(Date.parse('2026-09-25T12:00:00Z'), 4000, 500)],
  [
    'vehicle stretch',
    (() => {
      const r = buildSyntheticRun({
        startAt: Date.parse('2026-09-25T12:00:00Z'),
        legs: [
          { kind: 'run', durationS: 300, speedMps: 3 },
          { kind: 'run', durationS: 120, speedMps: 22 },
          { kind: 'run', durationS: 300, speedMps: 3 },
        ],
      });
      return { ...r, segments: [{ index: 0, startAt: r.startedAt, endAt: r.endedAt }], points: r.points.map((p) => ({ ...p, segmentIndex: 0 })) };
    })(),
  ],
  [
    'bad cold start',
    (() => {
      const r = steadyRun(Date.parse('2026-09-25T12:00:00Z'), 2400, 800);
      const first = r.points[0] as TrackPoint;
      const bad = destinationPoint(first, 200, 600);
      r.points[0] = { ...first, lat: normalizeCoordinate(bad.lat), lon: normalizeCoordinate(bad.lon) };
      return r;
    })(),
  ],
  ['midnight crossing', steadyRun(Date.parse('2026-09-23T04:50:00Z'), 3700, 1200)],
  ['no points at all', { ...steadyRun(Date.parse('2026-09-25T12:00:00Z'), 1000, 400), points: [] }],
];

async function serverValidation(run: SyntheticRun): Promise<any> {
  const start = await db.rpc(runner, 'start_run_upload', startArgs(run, randomUUID()));
  const receivedAt = run.endedAt + 5_000;
  await db.sql('update public.runs set first_received_at = to_timestamp($2::bigint / 1000.0) where id = $1', [start.run_id, receivedAt]);
  for (const c of chunksFor(run)) {
    await db.rpc(runner, 'put_route_chunk', { p_run_id: start.run_id, p_seq: c.seq, p_points: c.body, p_checksum: c.checksum });
  }
  const row = await db.one<{ v: any }>('select private.validate_run($1, to_timestamp($2::bigint / 1000.0)) as v', [start.run_id, receivedAt]);
  return row.v;
}

function compare(name: string, run: SyntheticRun, server: any) {
  const local = validateRun({ ...run, receivedAt: run.endedAt + 5_000 });
  const context = `${name}`;
  expect({ context, outcome: server.outcome, reasons: server.reasons }).toEqual({ context, outcome: local.outcome, reasons: local.reasons });
  expect(server.active_ms).toBe(local.activeMs);
  expect(Math.abs(Number(server.distance_cm) - local.distanceCm)).toBeLessThanOrEqual(1);
  expect(Math.abs(server.distance_m - local.distanceM)).toBeLessThan(1e-6);
  expect(Math.abs(server.coverage - local.coverage)).toBeLessThan(1e-12);
  expect(server.diagnostics).toMatchObject({
    usable_samples: local.diagnostics.usableSamples,
    unusable_samples: local.diagnostics.unusableSamples,
    duplicate_samples: local.diagnostics.duplicateSamples,
    outside_segment_samples: local.diagnostics.outsideSegmentSamples,
    jump_samples: local.diagnostics.jumpSamples,
    teleports: local.diagnostics.teleports,
    gaps: local.diagnostics.gaps,
    anchor_outliers: local.diagnostics.anchorOutliers,
  });
  const localAlloc = allocateSegmentsToDays(local.segments).map((a) => ({
    segment_index: a.segmentIndex,
    competition_date: a.competitionDate,
    active_ms: a.activeMs,
    segment_start_ms: a.segmentStartAt,
    distance_cm: a.distanceCm,
  }));
  const serverAlloc = (server.allocations as any[]).map((a) => ({ ...a, segment_start_ms: Number(a.segment_start_ms), distance_cm: Number(a.distance_cm) }));
  expect(serverAlloc.map(({ distance_cm, ...rest }) => rest)).toEqual(localAlloc.map(({ distance_cm, ...rest }) => rest));
  serverAlloc.forEach((a, i) => expect(Math.abs(a.distance_cm - (localAlloc[i]?.distance_cm ?? NaN))).toBeLessThanOrEqual(1));
  return local;
}

describe('TypeScript ↔ SQL validator parity', () => {
  it.each(NAMED_CASES)('%s', async (name, run) => {
    compare(name, run, await serverValidation(run));
  });

  it('agrees on 40 seeded noisy routes (spikes, gaps, duplicates, pauses, midnight and DST)', async () => {
    const outcomes = new Map<string, number>();
    let exactCm = 0;
    for (let seed = 1; seed <= 40; seed += 1) {
      const run = randomRun(seed);
      const server = await serverValidation(run);
      const local = compare(`seed ${seed}`, run, server);
      outcomes.set(local.outcome, (outcomes.get(local.outcome) ?? 0) + 1);
      if (Number(server.distance_cm) === local.distanceCm) exactCm += 1;
    }
    // The battery exercises every outcome, and centimetres match exactly in practice.
    expect([...outcomes.keys()].sort()).toEqual(['accepted', 'personal_only', 'review']);
    expect(exactCm).toBeGreaterThanOrEqual(38);
  });
});
