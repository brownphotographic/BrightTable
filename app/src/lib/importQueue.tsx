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
import { clearCompletedImportJobs, getImportQueueStatus, scanImmichLibrary, type ImportJob } from './api';

interface ImportQueueContextValue {
  jobs: ImportJob[];
  pendingCount: number;
  clearCompleted: () => void;
  // Set only when the most recent post-batch Immich library-scan nudge
  // failed (no/ambiguous library match, or the request itself failed) -
  // the copy already succeeded either way, this is purely advisory. Never
  // set on success, so a transient earlier failure doesn't linger forever.
  nudgeError: string | null;
}

const ImportQueueContext = createContext<ImportQueueContextValue | null>(null);

const POLL_MS = 1000;

// Structurally identical to EditQueueProvider (lib/editQueue.tsx) - a
// second, independent poll/context rather than folding into that one, so
// the already-tested edit queue stays untouched. See ActivityPanel.tsx for
// where both get read together into one combined UI.
export function ImportQueueProvider({ children }: { children: ReactNode }) {
  const [jobs, setJobs] = useState<ImportJob[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [nudgeError, setNudgeError] = useState<string | null>(null);
  // Tracks the previous poll's pendingCount so a >0 -> 0 transition (a
  // batch just fully drained) can be detected without a separate "was an
  // import running" flag - the ImportDialog itself has usually already
  // closed by the time this fires, so this is the one place that reliably
  // sees the whole batch finish.
  const prevPendingRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      getImportQueueStatus()
        .then((status) => {
          if (cancelled) return;
          setJobs(status.jobs);
          setPendingCount(status.pendingCount);
          if (prevPendingRef.current > 0 && status.pendingCount === 0) {
            scanImmichLibrary()
              .then(() => setNudgeError(null))
              .catch((e) => setNudgeError(String(e)));
          }
          prevPendingRef.current = status.pendingCount;
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
    clearCompletedImportJobs()
      .then(() => setJobs((js) => js.filter((j) => j.status === 'pending' || j.status === 'copying')))
      .catch(() => {});
  }, []);

  return (
    <ImportQueueContext.Provider value={{ jobs, pendingCount, clearCompleted, nudgeError }}>
      {children}
    </ImportQueueContext.Provider>
  );
}

export function useImportQueue(): ImportQueueContextValue {
  const ctx = useContext(ImportQueueContext);
  if (!ctx) throw new Error('useImportQueue must be used within an ImportQueueProvider');
  return ctx;
}
