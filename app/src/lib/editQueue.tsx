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
import { clearCompletedEditJobs, getEditQueueStatus, type EditJob } from './api';

interface EditQueueContextValue {
  jobs: EditJob[];
  pendingCount: number;
  clearCompleted: () => void;
}

const EditQueueContext = createContext<EditQueueContextValue | null>(null);

const POLL_MS = 1000;

// Polls get_edit_queue_status on a plain interval (same shape as
// useResourceUsage.ts) rather than a Tauri event stream per edit - the queue
// is already fully decoupled from the optimistic UI (see edit_queue.rs), so
// a transition missed or coalesced between polls only affects how
// granularly "in progress" briefly renders, never correctness. Polled once
// here and shared via context so the TitleBar indicator, ActivityPanel, and
// both browser pages' reconciliation all read from one shared poll instead
// of each hitting the command independently.
export function EditQueueProvider({ children }: { children: ReactNode }) {
  const [jobs, setJobs] = useState<EditJob[]>([]);
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      getEditQueueStatus()
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
    clearCompletedEditJobs()
      .then(() => setJobs((js) => js.filter((j) => j.status === 'pending' || j.status === 'writing')))
      .catch(() => {});
  }, []);

  return <EditQueueContext.Provider value={{ jobs, pendingCount, clearCompleted }}>{children}</EditQueueContext.Provider>;
}

export function useEditQueue(): EditQueueContextValue {
  const ctx = useContext(EditQueueContext);
  if (!ctx) throw new Error('useEditQueue must be used within an EditQueueProvider');
  return ctx;
}
