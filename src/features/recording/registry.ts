import type { RecorderService } from './recorder-service';

/**
 * Connects the module-scope background task to the recorder. In the foreground the account
 * provider registers its recorder; after a background relaunch the headless resolver opens
 * the recording account's journal and creates one.
 */
let active: RecorderService | null = null;
let resolving: Promise<RecorderService | null> | null = null;
let headlessResolver: (() => Promise<RecorderService | null>) | null = null;

export function setActiveRecorder(recorder: RecorderService | null): void {
  active = recorder;
}

export function getActiveRecorder(): RecorderService | null {
  return active;
}

export function setHeadlessResolver(resolver: () => Promise<RecorderService | null>): void {
  headlessResolver = resolver;
}

export async function recorderForTask(): Promise<RecorderService | null> {
  if (active) return active;
  if (!headlessResolver) return null;
  resolving ??= headlessResolver().finally(() => {
    resolving = null;
  });
  const recorder = await resolving;
  active ??= recorder;
  return active;
}
