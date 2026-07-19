import { useCallback, useEffect, useRef } from 'react';
import type { ProcessingJob } from './api';

// Mirrors useArtJobReconciliation.ts/useEditJobReconciliation.ts exactly, for
// Paste Image Processing's own ProcessingQueue - lets a page track a set of
// job ids it just enqueued (trackJobs) and get a one-shot callback the
// moment each one settles to done/failed, however many polls that takes.
export function useProcessingJobReconciliation(jobs: ProcessingJob[], onSettled: (job: ProcessingJob) => void) {
  const tracked = useRef<Set<number>>(new Set());
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;

  const trackJobs = useCallback((ids: number[]) => {
    for (const id of ids) tracked.current.add(id);
  }, []);

  useEffect(() => {
    if (tracked.current.size === 0) return;
    for (const job of jobs) {
      if (!tracked.current.has(job.jobId)) continue;
      if (job.status === 'done' || job.status === 'failed') {
        tracked.current.delete(job.jobId);
        onSettledRef.current(job);
      }
    }
  }, [jobs]);

  return { trackJobs };
}
