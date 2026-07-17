import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { clearCompletedArtJobs, getArtQueueStatus, type ArtJob } from './api';

interface ArtQueueContextValue {
  jobs: ArtJob[];
  pendingCount: number;
  clearCompleted: () => void;
}

const ArtQueueContext = createContext<ArtQueueContextValue | null>(null);

const POLL_MS = 1000;

// Mirrors processingQueue.tsx exactly - Batch RAW Roundtrip's own background
// queue (art_queue.rs) is fully decoupled the same way, so the same "poll on
// a plain interval, share via context" shape applies unchanged.
export function ArtQueueProvider({ children }: { children: ReactNode }) {
  const [jobs, setJobs] = useState<ArtJob[]>([]);
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      getArtQueueStatus()
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
    clearCompletedArtJobs()
      .then(() => setJobs((js) => js.filter((j) => j.status === 'pending' || j.status === 'running')))
      .catch(() => {});
  }, []);

  return <ArtQueueContext.Provider value={{ jobs, pendingCount, clearCompleted }}>{children}</ArtQueueContext.Provider>;
}

export function useArtQueue(): ArtQueueContextValue {
  const ctx = useContext(ArtQueueContext);
  if (!ctx) throw new Error('useArtQueue must be used within an ArtQueueProvider');
  return ctx;
}
