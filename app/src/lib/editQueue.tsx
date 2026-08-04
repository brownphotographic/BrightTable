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
