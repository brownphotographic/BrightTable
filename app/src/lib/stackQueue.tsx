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

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { clearCompletedStackJobs, getStackQueueStatus, type StackJob } from './api';

interface StackQueueContextValue {
  jobs: StackJob[];
  pendingCount: number;
  clearCompleted: () => void;
}

const StackQueueContext = createContext<StackQueueContextValue | null>(null);

const POLL_MS = 1000;

// Same shape/rationale as EditQueueProvider (editQueue.tsx) - polls
// get_stack_queue_status on a plain interval rather than a Tauri event
// stream, shared via context so the TitleBar indicator and ActivityPanel
// both read from one poll. This is purely for display; useStacking.ts's
// waitForStackJobs (below) polls the same command independently, on a
// tighter interval, since it blocks a caller's own async continuation
// rather than just driving UI.
export function StackQueueProvider({ children }: { children: ReactNode }) {
  const [jobs, setJobs] = useState<StackJob[]>([]);
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      getStackQueueStatus()
        .then((status) => {
          if (cancelled) return;
          setJobs(status.jobs);
          setPendingCount(status.pendingCount);
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
    clearCompletedStackJobs()
      .then(() => setJobs((js) => js.filter((j) => j.status === 'pending' || j.status === 'working')))
      .catch(() => {});
  }, []);

  return <StackQueueContext.Provider value={{ jobs, pendingCount, clearCompleted }}>{children}</StackQueueContext.Provider>;
}

export function useStackQueue(): StackQueueContextValue {
  const ctx = useContext(StackQueueContext);
  if (!ctx) throw new Error('useStackQueue must be used within a StackQueueProvider');
  return ctx;
}

const WAIT_POLL_MS = 200;

// Plain async function, not a hook - useStacking.ts's multi-stack
// operations are imperative callbacks (not components), and need to
// actually block their own continuation until a wave of jobs they just
// enqueued has settled (e.g. a dependent Create must wait for its Dissolve
// wave to finish first). Deliberately independent of StackQueueProvider's
// 1s UI poll - this cadence affects how quickly a dependent step can
// proceed, not just how fresh a display looks, so it polls tighter.
export async function waitForStackJobs(jobIds: number[]): Promise<StackJob[]> {
  if (jobIds.length === 0) return [];
  const pending = new Set(jobIds);
  const settled = new Map<number, StackJob>();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const status = await getStackQueueStatus();
    for (const job of status.jobs) {
      if (pending.has(job.jobId) && (job.status === 'done' || job.status === 'failed')) {
        settled.set(job.jobId, job);
        pending.delete(job.jobId);
      }
    }
    if (pending.size === 0) break;
    await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
  }
  return jobIds.map((id) => settled.get(id)!);
}
