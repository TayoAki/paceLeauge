import { File } from 'expo-file-system';

import { ApiError } from '@/api/errors';
import type { ExportData, RunRoute } from '@/api/schemas';
import {
  buildExportFiles,
  clearExportFiles,
  describeExportError,
  deviceExportWriter,
  EXPORT_DATA_FILE,
  prepareExport,
  progressLabel,
  shareExportFile,
  type ExportApi,
  type ExportFile,
  type ExportProgress,
  type ExportSharer,
  type ExportWriter,
} from '@/features/privacy/export-data';

const T0 = Date.UTC(2026, 8, 20, 7, 0, 0);
const MIN = 60_000;

type ExportRun = ExportData['runs'][number];

function exportRun(id: string, title: string, segments: ExportRun['segments']): ExportRun {
  const start = segments[0]?.startAt ?? T0;
  const end = segments[segments.length - 1]?.endAt ?? T0;
  return {
    id,
    client_run_id: `client-${id}`,
    title,
    started_at_ms: start,
    ended_at_ms: end,
    active_ms: segments.reduce((sum, s) => sum + (s.endAt - s.startAt), 0),
    distance_m: 5240,
    status: 'accepted',
    reason_codes: [],
    coverage: 0.97,
    interrupted: false,
    scoring_state: 'applied',
    xp_award: null,
    version: 2,
    validator_version: 1,
    rule_version: 1,
    finalized_at_ms: end + 1_000,
    segments,
  };
}

const lakefront = exportRun('run-a', 'Lakefront <loop> & back', [
  { index: 0, startAt: T0, endAt: T0 + 10 * MIN },
  { index: 1, startAt: T0 + 12 * MIN, endAt: T0 + 22 * MIN },
]);
const treadmillTest = exportRun('run-b', 'No GPS', [{ index: 0, startAt: T0 + 86_400_000, endAt: T0 + 86_400_000 + 5 * MIN }]);

const EXPORT: ExportData = {
  format: 'paceleague-export',
  format_version: 1,
  generated_at_ms: T0 + 2 * 86_400_000,
  account: { email: 'runner@example.com', alias: 'Riley', units: 'metric', goal_days: 3 },
  lifetime_xp: 897,
  tier: 'Stride',
  runs: [lakefront, treadmillTest],
  daily_scores: [{ date: '2026-09-20', rule_version: 1, distance_cm: 524_000, active_ms: 20 * MIN, xp: 77, revision: 1 }],
  league_memberships: [],
  blocked_count: 0,
};

const ROUTES: Record<string, RunRoute> = {
  'run-a': {
    run_id: 'run-a',
    segments: lakefront.segments,
    // [seq, t, lat, lon, accuracy, segmentIndex] — deliberately out of order.
    points: [
      [4, T0 + 13 * MIN, 41.8801, -87.6201, 5, 1],
      [1, T0 + 1 * MIN, 41.8781, -87.6298, 6, 0],
      [2, T0 + 2 * MIN, 41.8785, -87.6281, 4.5, 0],
      [3, T0 + 3 * MIN, 41.879, -87.6265, null, 0],
      [5, T0 + 14 * MIN, 41.8812, -87.6188, 5, 1],
    ],
  },
  'run-b': { run_id: 'run-b', segments: treadmillTest.segments, points: [] },
};

function fakeApi(overrides: Partial<ExportApi> = {}): ExportApi {
  return {
    requestExport: jest.fn(async () => ({ exportId: 'exp-1', expiresAtMs: T0 + 86_400_000 })),
    getExport: jest.fn(async () => EXPORT),
    getExportRoute: jest.fn(async (_exportId: string, runId: string) => {
      const route = ROUTES[runId];
      if (!route) throw new ApiError('not_found');
      return route;
    }),
    ...overrides,
  };
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe('export builder', () => {
  it('writes the whole export as pretty-printed JSON, then one GPX per run with a route', async () => {
    const api = fakeApi();
    const files = await buildExportFiles(api);

    expect(files.map((f) => [f.name, f.kind, f.mimeType])).toEqual([
      [EXPORT_DATA_FILE, 'data', 'application/json'],
      ['run-2026-09-20-runa.gpx', 'route', 'application/gpx+xml'],
    ]);
    const data = files[0]!;
    expect(data.contents).toBe(`${JSON.stringify(EXPORT, null, 2)}\n`);
    expect(JSON.parse(data.contents)).toEqual(EXPORT);

    expect(api.getExport).toHaveBeenCalledWith('exp-1');
    expect(api.getExportRoute).toHaveBeenCalledTimes(2);
    expect(api.getExportRoute).toHaveBeenCalledWith('exp-1', 'run-a');
    expect(api.getExportRoute).toHaveBeenCalledWith('exp-1', 'run-b');
  });

  it('builds GPX with one <trkseg> per active segment and every point in time order', async () => {
    const files = await buildExportFiles(fakeApi());
    const gpx = files.find((f) => f.kind === 'route')!;

    expect(gpx.label).toBe('Lakefront <loop> & back');
    expect(gpx.startedAtMs).toBe(T0);
    expect(gpx.contents).toContain('<gpx version="1.1" creator="PaceLeague"');
    expect(gpx.contents).toContain('<name>Lakefront &lt;loop&gt; &amp; back</name>');
    expect(count(gpx.contents, '<trkseg>')).toBe(lakefront.segments.length);
    expect(count(gpx.contents, '</trkseg>')).toBe(lakefront.segments.length);
    expect(count(gpx.contents, '<trkpt ')).toBe(5);

    const [, first, second] = gpx.contents.split('<trkseg>');
    expect(count(first!, '<trkpt ')).toBe(3);
    expect(count(second!, '<trkpt ')).toBe(2);
    expect(first!.indexOf('lon="-87.6298"')).toBeLessThan(first!.indexOf('lon="-87.6265"'));
    expect(first).toContain(`<time>${new Date(T0 + MIN).toISOString()}</time>`);
  });

  it('reports each stage, then saves through the injected writer into a timestamped folder', async () => {
    const progress: ExportProgress[] = [];
    const written: { folder: string; files: readonly ExportFile[] }[] = [];
    const writer: ExportWriter = {
      write: (folder, files) => {
        written.push({ folder, files });
        return files.map((f) => ({ ...f, uri: `file:///cache/${folder}/${f.name}` }));
      },
    };

    const saved = await prepareExport(fakeApi(), { now: 1_700_000_000_000, writer, onProgress: (p) => progress.push(p) });

    expect(progress.map((p) => p.stage)).toEqual(['requesting', 'collecting', 'routes', 'routes', 'routes', 'saving']);
    expect(progress.filter((p) => p.stage === 'routes')).toEqual([
      { stage: 'routes', done: 0, total: 2 },
      { stage: 'routes', done: 1, total: 2 },
      { stage: 'routes', done: 2, total: 2 },
    ]);
    expect(written).toHaveLength(1);
    expect(written[0]!.folder).toBe('paceleague-export-1700000000000');
    expect(saved.map((f) => f.uri)).toEqual([
      'file:///cache/paceleague-export-1700000000000/paceleague-export.json',
      'file:///cache/paceleague-export-1700000000000/run-2026-09-20-runa.gpx',
    ]);
    expect(progressLabel({ stage: 'routes', done: 1, total: 2 })).toBe('Adding routes · 1 of 2');
  });

  it('never returns a partial export when a route call fails', async () => {
    const api = fakeApi({ getExportRoute: jest.fn(async () => Promise.reject(new ApiError('network'))) });
    const writer: ExportWriter = { write: jest.fn(() => []) };

    await expect(prepareExport(api, { now: 1, writer })).rejects.toMatchObject({ code: 'network' });
    expect(writer.write).not.toHaveBeenCalled();
  });

  it('asks for a recent sign-in and explains offline and rate-limited failures', async () => {
    const needsReauth = fakeApi({ requestExport: jest.fn(async () => Promise.reject(new ApiError('recent_auth_required'))) });
    const failure = await buildExportFiles(needsReauth).catch((e: unknown) => describeExportError(e));

    expect(failure).toEqual({ reauth: true });
    expect(needsReauth.getExport).not.toHaveBeenCalled();
    expect(describeExportError(new ApiError('network'))).toEqual({ reauth: false, message: 'You’re offline. Exporting needs a connection.' });
    expect(describeExportError(new ApiError('rate_limited'))).toEqual({ reauth: false, message: 'You can export 3 times a day. Try again tomorrow.' });
    expect(describeExportError(new Error('disk full'))).toEqual({ reauth: false, message: 'Couldn’t prepare your export. Try again.' });
  });
});

describe('export delivery', () => {
  it('opens the share sheet for the JSON file only when sharing is available', async () => {
    const shared: unknown[] = [];
    const sharer = (available: boolean): ExportSharer => ({
      isAvailable: async () => available,
      share: async (uri, options) => void shared.push({ uri, ...options }),
    });
    const [data] = await prepareExport(fakeApi(), {
      now: 1,
      writer: { write: (folder, files) => files.map((f) => ({ ...f, uri: `file:///cache/${folder}/${f.name}` })) },
    });

    await expect(shareExportFile(data!, sharer(false))).resolves.toBe('unavailable');
    expect(shared).toEqual([]);
    await expect(shareExportFile(data!, sharer(true))).resolves.toBe('opened');
    expect(shared).toEqual([
      { uri: 'file:///cache/paceleague-export-1/paceleague-export.json', mimeType: 'application/json', UTI: 'public.json', dialogTitle: 'Export my data' },
    ]);
  });

  it('writes files into the cache directory and removes every earlier export', async () => {
    // jest-expo backs expo-file-system with an in-memory file system.
    const first = await prepareExport(fakeApi(), { now: 1, writer: deviceExportWriter });
    const second = await prepareExport(fakeApi(), { now: 2, writer: deviceExportWriter });

    expect(second[0]!.uri).toContain('/paceleague-export-2/paceleague-export.json');

    expect(new File(first[0]!.uri).exists).toBe(false);
    expect(new File(second[0]!.uri).textSync()).toBe(second[0]!.contents);
    expect(new File(second[1]!.uri).textSync()).toContain('<trkseg>');

    clearExportFiles();
    expect(second.every((f) => !new File(f.uri).exists)).toBe(true);
  });
});
