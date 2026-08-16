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
import { clearCompletedProcessingJobs, getProcessingQueueStatus, type ProcessingJob } from './api';

interface ProcessingQueueContextValue {
  jobs: ProcessingJob[];
  pendingCount: number;
  clearCompleted: () => void;
  // Forces an immediate out-of-cycle poll instead of waiting up to POLL_MS
  // for the next scheduled tick - see the doc comment below on why this
  // exists specifically for this queue and not edit/import/art's identical
  // shape.
  refresh: () => void;
}

const ProcessingQueueContext = createContext<ProcessingQueueContextValue | null>(null);

const POLL_MS = 1000;

// Mirrors editQueue.tsx exactly - Paste Image Processing's own background
// queue (processing_queue.rs) is fully decoupled the same way the edit
// queue is, so the same "poll on a plain interval, share via context" shape
// applies unchanged. One deliberate addition over editQueue.tsx's shape,
// though: `refresh`. A processing job is just a small local sidecar file
// copy (no Immich HTTP round trip the way an edit job has), so a batch paste
// across several photos can fully finish well inside one POLL_MS window -
// found live: pasting image processing across 10 photos completed with the
// TitleBar pill never appearing at all, since pendingCount went 0 -> 10 -> 0
// entirely between two scheduled polls. Callers that enqueue jobs now also
// call `refresh()` right after, which - because the poll always lands before
// the newly-queued jobs have had a chance to reach the front of the
// bounded-concurrency worker - reliably observes the fresh Pending jobs at
// least once before they can complete unseen.
export function ProcessingQueueProvider({ children }: { children: ReactNode }) {
  const [jobs, setJobs] = useState<ProcessingJob[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const mounted = useRef(true);

  const poll = useCallback(() => {
    getProcessingQueueStatus()
      .then((status) => {
        if (!mounted.current) return;
        setJobs(status.jobs);
        setPendingCount(status.pendingCount);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    mounted.current = true;
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      mounted.current = false;
      clearInterval(id);
    };
  }, [poll]);

  const clearCompleted = useCallback(() => {
    clearCompletedProcessingJobs()
      .then(() => setJobs((js) => js.filter((j) => j.status === 'pending' || j.status === 'copying')))
      .catch(() => {});
  }, []);

  return (
    <ProcessingQueueContext.Provider value={{ jobs, pendingCount, clearCompleted, refresh: poll }}>{children}</ProcessingQueueContext.Provider>
  );
}

export function useProcessingQueue(): ProcessingQueueContextValue {
  const ctx = useContext(ProcessingQueueContext);
  if (!ctx) throw new Error('useProcessingQueue must be used within a ProcessingQueueProvider');
  return ctx;
}
