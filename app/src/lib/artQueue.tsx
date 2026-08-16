/*
 * BrightTable // Copyright (C) 2026 Rob Brown
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { clearCompletedRawCliJobs, getRawCliQueueStatus, type ArtJob } from './api';

interface ArtQueueContextValue {
  jobs: ArtJob[];
  pendingCount: number;
  clearCompleted: () => void;
  // Job ids that have been `running` continuously for longer than
  // `STALL_THRESHOLD_MS` with no sign of finishing - see this module's
  // `runningSinceRef` doc comment for why elapsed running time (not stalled
  // progress-percent) is the signal.
  stalledJobIds: Set<number>;
}

const ArtQueueContext = createContext<ArtQueueContextValue | null>(null);

const POLL_MS = 1000;

// How long a job can sit in `running` before the Activity panel calls it out
// as possibly stuck rather than just slow. `ART-cli`'s own `--progress`
// output can legitimately go quiet for a while between checkpoints (it's not
// a steady stream), so "no percent change in N seconds" would false-positive
// on real, working exports - elapsed wall-clock time in `running` is the
// more robust signal. 5 minutes is comfortably past the "several minutes for
// one real-world export" baseline noted in `art::ART_CLI_RUN_TIMEOUT`'s doc
// comment, while still surfacing well before that 20-minute hard timeout -
// the exact gap the NFS-mount-hang case in `art_queue.rs` needs a warning
// for, since a job wedged in `D` state (uninterruptible network I/O) shows
// no other symptom until the timeout finally fires.
const STALL_THRESHOLD_MS = 5 * 60 * 1000;

// Mirrors processingQueue.tsx exactly - Headless RAW Roundtrip's own
// background queue (art_queue.rs) is fully decoupled the same way, so the
// same "poll on a plain interval, share via context" shape applies unchanged.
export function ArtQueueProvider({ children }: { children: ReactNode }) {
  const [jobs, setJobs] = useState<ArtJob[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [stalledJobIds, setStalledJobIds] = useState<Set<number>>(new Set());
  // First-observed-`running` timestamp per job id, kept in a ref (not state)
  // since it's an internal bookkeeping map, not something a render should
  // depend on directly - only the derived `stalledJobIds` triggers renders,
  // and only when its membership actually changes. Lives for the provider's
  // whole lifetime (mounted once at app level), not just while the Activity
  // panel happens to be open, so a stall is caught even if the user never
  // has the panel open to watch it.
  const runningSinceRef = useRef<Map<number, number>>(new Map());

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      getRawCliQueueStatus()
        .then((status) => {
          if (cancelled) return;
          setJobs(status.jobs);
          setPendingCount(status.pendingCount);

          const now = Date.now();
          const runningSince = runningSinceRef.current;
          const stillRunningIds = new Set(status.jobs.filter((j) => j.status === 'running').map((j) => j.jobId));
          for (const id of runningSince.keys()) {
            if (!stillRunningIds.has(id)) runningSince.delete(id);
          }
          const nextStalled = new Set<number>();
          for (const job of status.jobs) {
            if (job.status !== 'running') continue;
            const since = runningSince.get(job.jobId) ?? now;
            if (!runningSince.has(job.jobId)) runningSince.set(job.jobId, since);
            if (now - since > STALL_THRESHOLD_MS) nextStalled.add(job.jobId);
          }
          setStalledJobIds((prev) => (setsEqual(prev, nextStalled) ? prev : nextStalled));
        })
        .catch(() => {});
    };
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const clearCompleted = useCallback(() => {
    clearCompletedRawCliJobs()
      .then(() => setJobs((js) => js.filter((j) => j.status === 'pending' || j.status === 'running')))
      .catch(() => {});
  }, []);

  return (
    <ArtQueueContext.Provider value={{ jobs, pendingCount, clearCompleted, stalledJobIds }}>{children}</ArtQueueContext.Provider>
  );
}

function setsEqual(a: Set<number>, b: Set<number>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

export function useArtQueue(): ArtQueueContextValue {
  const ctx = useContext(ArtQueueContext);
  if (!ctx) throw new Error('useArtQueue must be used within an ArtQueueProvider');
  return ctx;
}
