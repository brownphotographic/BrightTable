import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { clearCompletedExportJobs, getExportQueueStatus, type ExportJob } from './api';

interface ExportQueueContextValue {
  jobs: ExportJob[];
  pendingCount: number;
  clearCompleted: () => void;
}

const ExportQueueContext = createContext<ExportQueueContextValue | null>(null);

const POLL_MS = 1000;

// Mirrors artQueue.tsx (minus its stall-detection, which is specific to
// ART-cli's own multi-minute renders - a folder write / Flickr upload is a
// short-lived step with no comparable "wedged" failure mode to watch for).
export function ExportQueueProvider({ children }: { children: ReactNode }) {
  const [jobs, setJobs] = useState<ExportJob[]>([]);
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      getExportQueueStatus()
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
    clearCompletedExportJobs()
      .then(() => setJobs((js) => js.filter((j) => j.status === 'pending' || j.status === 'running')))
      .catch(() => {});
  }, []);

  return <ExportQueueContext.Provider value={{ jobs, pendingCount, clearCompleted }}>{children}</ExportQueueContext.Provider>;
}

export function useExportQueue(): ExportQueueContextValue {
  const ctx = useContext(ExportQueueContext);
  if (!ctx) throw new Error('useExportQueue must be used within an ExportQueueProvider');
  return ctx;
}
