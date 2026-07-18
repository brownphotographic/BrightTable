import { useCallback, useEffect, useRef } from 'react';
import type { ArtJob } from './api';

// Mirrors useEditJobReconciliation.ts exactly, for Headless RAW Roundtrip's
// ArtQueue instead of EditQueue - lets a page track a set of job ids it just
// enqueued (trackJobs) and get a one-shot callback the moment each one
// settles to done/failed, however many polls that takes. Drives Variant 2's
// incremental per-asset ingestion (ingestRoundTripExport, called once per
// settled `done` job) rather than waiting for the whole batch to finish.
export function useArtJobReconciliation(jobs: ArtJob[], onSettled: (job: ArtJob) => void) {
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
