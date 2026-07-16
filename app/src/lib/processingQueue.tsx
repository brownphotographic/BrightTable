import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { clearCompletedProcessingJobs, getProcessingQueueStatus, type ProcessingJob } from './api';

interface ProcessingQueueContextValue {
  jobs: ProcessingJob[];
  pendingCount: number;
  clearCompleted: () => void;
}

const ProcessingQueueContext = createContext<ProcessingQueueContextValue | null>(null);

const POLL_MS = 1000;

// Mirrors editQueue.tsx exactly - Paste Image Processing's own background
// queue (processing_queue.rs) is fully decoupled the same way the edit
// queue is, so the same "poll on a plain interval, share via context" shape
// applies unchanged.
export function ProcessingQueueProvider({ children }: { children: ReactNode }) {
  const [jobs, setJobs] = useState<ProcessingJob[]>([]);
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      getProcessingQueueStatus()
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
    clearCompletedProcessingJobs()
      .then(() => setJobs((js) => js.filter((j) => j.status === 'pending' || j.status === 'copying')))
      .catch(() => {});
  }, []);

  return <ProcessingQueueContext.Provider value={{ jobs, pendingCount, clearCompleted }}>{children}</ProcessingQueueContext.Provider>;
}

export function useProcessingQueue(): ProcessingQueueContextValue {
  const ctx = useContext(ProcessingQueueContext);
  if (!ctx) throw new Error('useProcessingQueue must be used within a ProcessingQueueProvider');
  return ctx;
}
