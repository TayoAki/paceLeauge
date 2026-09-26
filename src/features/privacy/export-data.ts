import { toApiError } from '@/api/errors';
import type { PaceApi } from '@/api/pace-api';
import type { ExportData, RunRoute } from '@/api/schemas';
import { fromCompact, toGpx } from '@/domain/route-codec';

import { deviceExportWriter, deviceSharer, EXPORT_FOLDER_PREFIX } from './export-device';

/**
 * "Export my data" (REQ-010). The server hands the owner their export through authenticated,
 * owner-checked calls; this module turns it into files the runner keeps: the whole export as
 * pretty-printed JSON plus one GPX file per run with a recorded route.
 *
 * Building the files only talks to the injected API (unit-tested with a fake). Writing them to
 * the cache directory and opening the share sheet are thin device wrappers. The files hold
 * private routes, so earlier copies are removed before each new export and on sign-out.
 */

export type ExportApi = Pick<PaceApi, 'requestExport' | 'getExport' | 'getExportRoute'>;

export interface ExportFile {
  name: string;
  contents: string;
  mimeType: string;
  /** Uniform Type Identifier for the iOS share sheet. */
  uti: string;
  kind: 'data' | 'route';
  /** What the file holds, for display: "All your data" or the run's title. */
  label: string;
  /** When the run started (route files only). */
  startedAtMs: number | null;
}

export interface SavedExportFile extends ExportFile {
  uri: string;
}

export type ExportProgress =
  | { stage: 'requesting' }
  | { stage: 'collecting' }
  | { stage: 'routes'; done: number; total: number }
  | { stage: 'saving' };

export const EXPORT_DATA_FILE = 'paceleague-export.json';
const ROUTE_FETCH_CONCURRENCY = 4;

type ExportRun = ExportData['runs'][number];

/** Runs `fn` over `items` with at most `limit` calls in flight, keeping order; stops on the first failure. */
async function mapWithLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await fn(items[index] as T);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function gpxFileName(run: ExportRun, used: Set<string>): string {
  const date = new Date(run.started_at_ms).toISOString().slice(0, 10);
  const base = `run-${date}-${run.id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8)}`;
  let name = `${base}.gpx`;
  for (let n = 2; used.has(name); n += 1) name = `${base}-${n}.gpx`;
  used.add(name);
  return name;
}

function routeFile(run: ExportRun, route: RunRoute, used: Set<string>): ExportFile {
  return {
    name: gpxFileName(run, used),
    contents: toGpx({ title: run.title, startedAt: run.started_at_ms }, route.segments, route.points.map(fromCompact)),
    mimeType: 'application/gpx+xml',
    uti: 'com.topografix.gpx',
    kind: 'route',
    label: run.title,
    startedAtMs: run.started_at_ms,
  };
}

/**
 * Requests (or reuses) the owner's export and builds its files: `paceleague-export.json`
 * first, then one GPX per run that has route points. Any failed call fails the whole export,
 * so a runner never receives a silently incomplete copy.
 */
export async function buildExportFiles(api: ExportApi, onProgress?: (progress: ExportProgress) => void): Promise<ExportFile[]> {
  onProgress?.({ stage: 'requesting' });
  const { exportId } = await api.requestExport();
  onProgress?.({ stage: 'collecting' });
  const data = await api.getExport(exportId);

  const total = data.runs.length;
  let done = 0;
  onProgress?.({ stage: 'routes', done, total });
  const routes = await mapWithLimit(data.runs, ROUTE_FETCH_CONCURRENCY, async (run) => {
    const route = await api.getExportRoute(exportId, run.id);
    done += 1;
    onProgress?.({ stage: 'routes', done, total });
    return route;
  });

  const files: ExportFile[] = [
    {
      name: EXPORT_DATA_FILE,
      contents: `${JSON.stringify(data, null, 2)}\n`,
      mimeType: 'application/json',
      uti: 'public.json',
      kind: 'data',
      label: 'All your data',
      startedAtMs: null,
    },
  ];
  const used = new Set([EXPORT_DATA_FILE]);
  data.runs.forEach((run, index) => {
    const route = routes[index];
    if (route && route.points.length > 0) files.push(routeFile(run, route, used));
  });
  return files;
}

// -----------------------------------------------------------------------------------------
// Device wrappers (injected so tests can replace them)
// -----------------------------------------------------------------------------------------
export interface ExportWriter {
  /** Writes the files into a new folder and returns them with their file URIs. */
  write(folderName: string, files: readonly ExportFile[]): SavedExportFile[] | Promise<SavedExportFile[]>;
}

// The platform file handling lives in ./export-device(.web).ts.
export { clearExportFiles, deviceExportWriter } from './export-device';

export async function prepareExport(
  api: ExportApi,
  options: { now: number; writer?: ExportWriter; onProgress?: (progress: ExportProgress) => void },
): Promise<SavedExportFile[]> {
  const files = await buildExportFiles(api, options.onProgress);
  options.onProgress?.({ stage: 'saving' });
  return (options.writer ?? deviceExportWriter).write(`${EXPORT_FOLDER_PREFIX}${options.now}`, files);
}

export interface ExportSharer {
  isAvailable(): Promise<boolean>;
  share(uri: string, options: { mimeType: string; UTI: string; dialogTitle: string }): Promise<void>;
}

/** Opens the system share sheet for one file; the runner chooses where it goes. */
export async function shareExportFile(file: SavedExportFile, sharer: ExportSharer = deviceSharer): Promise<'opened' | 'unavailable'> {
  if (!(await sharer.isAvailable())) return 'unavailable';
  await sharer.share(file.uri, {
    mimeType: file.mimeType,
    UTI: file.uti,
    dialogTitle: file.kind === 'data' ? 'Export my data' : `Route: ${file.label}`,
  });
  return 'opened';
}

// -----------------------------------------------------------------------------------------
// Copy
// -----------------------------------------------------------------------------------------
export function progressLabel(progress: ExportProgress): string {
  switch (progress.stage) {
    case 'requesting':
      return 'Preparing your export…';
    case 'collecting':
      return 'Collecting your runs…';
    case 'routes':
      return progress.total === 0 ? 'Collecting your runs…' : `Adding routes · ${progress.done} of ${progress.total}`;
    case 'saving':
      return 'Saving files…';
  }
}

export type ExportFailure = { reauth: true } | { reauth: false; message: string };

/** Recent sign-in is required before an export; everything else becomes calm, specific copy. */
export function describeExportError(error: unknown): ExportFailure {
  switch (toApiError(error).code) {
    case 'recent_auth_required':
      return { reauth: true };
    case 'network':
      return { reauth: false, message: 'You’re offline. Exporting needs a connection.' };
    case 'timeout':
      return { reauth: false, message: 'The connection timed out. Try again.' };
    case 'rate_limited':
      return { reauth: false, message: 'You can export 3 times a day. Try again tomorrow.' };
    case 'auth_expired':
    case 'not_authenticated':
      return { reauth: false, message: 'You’re signed out. Sign in again to export your data.' };
    case 'not_found':
      return { reauth: false, message: 'That export is no longer available. Try again.' };
    default:
      return { reauth: false, message: 'Couldn’t prepare your export. Try again.' };
  }
}
