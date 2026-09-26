import type { Journal } from '@/db/journal';
import { PROFILE_RULES } from '@/domain/config';

import type { SyncEngine } from './sync-engine';

/**
 * User actions on saved runs. Local effects are immediate (the run disappears or is
 * renamed at once); the server side goes through the durable outbox.
 */
export function createRunActions(journal: Journal, engine: SyncEngine) {
  return {
    async rename(runId: string, rawTitle: string): Promise<void> {
      const title = rawTitle.trim().replace(/\s+/g, ' ').slice(0, PROFILE_RULES.runTitleMaxLength);
      if (title.length === 0) throw new Error('A title needs at least one character.');
      const upload = (await journal.openOutbox()).find((o) => o.kind === 'upload_run' && o.runId === runId);
      await journal.updateSavedRun(runId, { title });
      if (upload && !upload.progress && upload.attempts === 0 && upload.state === 'pending') {
        // Not sent yet: the upload carries the new title (its request body is still unsent).
        await journal.updateOutbox(upload.id, { payload: { ...upload.payload, title } });
      } else {
        await journal.enqueue('rename_run', runId, { title });
      }
      void engine.run();
    },

    async remove(runId: string, serverRunId: string | null = null): Promise<void> {
      await journal.updateSavedRun(runId, { deleted: true });
      await journal.enqueue('delete_run', runId, serverRunId ? { serverRunId } : {});
      void engine.run();
    },

    /** Moves an item that needed attention back into the queue (e.g. after an app update). */
    async retry(runId: string): Promise<void> {
      for (const item of await journal.openOutbox()) {
        if (item.runId === runId && item.state === 'needs_attention') {
          await journal.updateOutbox(item.id, { state: 'pending', attempts: 0, nextAttemptAt: 0, lastError: null });
        }
      }
      await journal.updateSavedRun(runId, { syncState: 'pending', syncError: null });
      void engine.run();
    },
  };
}

export type RunActions = ReturnType<typeof createRunActions>;
