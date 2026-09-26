import { useEffect, useRef, useState } from 'react';

import type { TrackPoint } from '@/domain/types';
import { useAccount } from '@/features/account/account-provider';

/**
 * Route points of a local run, refreshed incrementally while it records (at most every
 * `intervalMs`). Used only by the owner's private screens.
 */
export function useRunPoints(runId: string | null, live = false, intervalMs = 4_000): TrackPoint[] {
  const { state } = useAccount();
  const journal = state.status === 'ready' ? state.runtime.journal : null;
  const [loaded, setLoaded] = useState<{ runId: string; points: TrackPoint[] } | null>(null);
  const lastSeq = useRef<{ runId: string | null; seq: number }>({ runId: null, seq: -1 });

  useEffect(() => {
    if (!journal || !runId) return;
    let alive = true;
    let pending = false;
    const pull = async () => {
      if (pending) return;
      pending = true;
      try {
        const from = lastSeq.current.runId === runId ? lastSeq.current.seq : -1;
        const next = await journal.getRunPoints(runId, from);
        if (!alive) return;
        if (from === -1) lastSeq.current = { runId, seq: -1 };
        if (next.length === 0 && from !== -1) return;
        lastSeq.current = { runId, seq: next[next.length - 1]?.seq ?? from };
        setLoaded((prev) => ({ runId, points: prev && prev.runId === runId && from !== -1 ? [...prev.points, ...next] : next }));
      } finally {
        pending = false;
      }
    };
    void pull();
    const timer = live ? setInterval(() => void pull(), intervalMs) : null;
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
    };
  }, [journal, runId, live, intervalMs]);

  return loaded && loaded.runId === runId ? loaded.points : [];
}
