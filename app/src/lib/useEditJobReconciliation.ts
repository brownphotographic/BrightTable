import { useCallback, useEffect, useRef } from 'react';
import type { EditJob } from './api';

// Lets a page track a set of job ids it just optimistically applied
// (trackJobs) and get a one-shot callback the moment each one settles to
// done/failed, however many polls that takes - a job untracked here (or
// already settled) is silently ignored. Keeps EditQueueProvider itself
// ignorant of any page's own rollback bookkeeping (PhotosBrowser/
// FoldersBrowser's jobId -> {id, prevValues} map).
export function useEditJobReconciliation(jobs: EditJob[], onSettled: (job: EditJob) => void) {
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
