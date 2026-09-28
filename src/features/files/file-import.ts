import type { Journal, RunOrigin, SavedRunDraft } from '@/db/journal';
import { FileImportError, parseActivityFile, type ParsedActivity } from '@/domain/file-import';
import { validateRun } from '@/domain/validator';
import { workoutPoints, workoutSegments } from '@/features/health/health-import';
import { defaultRunTitle } from '@/features/recording/run-draft';
import { sha256HexOfBytes, uuidFromHex } from '@/lib/crypto';

/**
 * Import a GPX, TCX or FIT file (docs/ROADMAP.md 2.4). The file becomes a saved run on this phone
 * and syncs like any other; the server keeps it as history because a file can be edited. The run's
 * id comes from the file's contents, so importing the same file twice adds it once.
 */
export type FileImportResult =
  | { kind: 'imported'; runId: string; parsed: ParsedActivity; distanceM: number }
  | { kind: 'already_imported'; runId: string }
  | { kind: 'error'; reason: FileImportError['reason'] };

export function fileImportCopy(reason: FileImportError['reason']): string {
  switch (reason) {
    case 'unknown_format':
      return 'That file isn’t a GPX, TCX or FIT activity.';
    case 'no_points':
      return 'That file has no GPS points to import.';
    default:
      return 'That file couldn’t be read.';
  }
}

export function fileRun(parsed: ParsedActivity, fileName: string, digest: string): { draft: SavedRunDraft; origin: RunOrigin; points: ReturnType<typeof workoutPoints> } {
  const segments = workoutSegments(parsed.start, parsed.end, parsed.pauses);
  const points = workoutPoints(segments, parsed.points);
  const validation = validateRun({ startedAt: parsed.start, endedAt: parsed.end, segments, points, receivedAt: null });
  const title = parsed.name?.trim().slice(0, 60) || defaultRunTitle(parsed.start);
  return {
    draft: {
      title,
      startedAt: parsed.start,
      endedAt: parsed.end,
      activeMs: segments.reduce((sum, s) => sum + (s.endAt - s.startAt), 0),
      distanceM: validation.distanceM,
      segments,
      interrupted: false,
      validation: {
        outcome: validation.outcome,
        reasons: validation.reasons,
        coverage: validation.coverage,
        distanceCm: validation.distanceCm,
        activeMs: validation.activeMs,
      },
      provisionalXp: null,
    },
    points,
    origin: {
      source: 'file_import',
      activityType: parsed.activity,
      sourceApp: (parsed.creator ?? `${parsed.format.toUpperCase()} file`).slice(0, 100),
      sourceDevice: fileName.slice(0, 100),
      externalId: `sha256:${digest}`,
      claimedDistanceM: parsed.distanceM,
      avgHeartRate: parsed.avgHeartRate,
      maxHeartRate: parsed.maxHeartRate,
    },
  };
}

export async function importActivityFile(
  journal: Pick<Journal, 'getSavedRun' | 'saveImportedRun'>,
  file: { name: string; bytes: Uint8Array },
): Promise<FileImportResult> {
  let parsed: ParsedActivity;
  try {
    parsed = parseActivityFile(file.name, file.bytes);
  } catch (error) {
    return { kind: 'error', reason: error instanceof FileImportError ? error.reason : 'unreadable' };
  }
  const digest = await sha256HexOfBytes(file.bytes);
  const runId = uuidFromHex(digest);
  if (await journal.getSavedRun(runId)) return { kind: 'already_imported', runId };
  const { draft, origin, points } = fileRun(parsed, file.name, digest);
  const { created } = await journal.saveImportedRun(runId, draft, points, origin);
  return created ? { kind: 'imported', runId, parsed, distanceM: draft.distanceM } : { kind: 'already_imported', runId };
}
