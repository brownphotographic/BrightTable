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
