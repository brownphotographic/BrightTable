import { useEffect, useRef, useState } from 'react';
import { getResourceUsage } from './api';

// One sample per second, kept for a minute - matches the rolling chart's
// fixed 1-minute x-axis extent.
export const SAMPLE_INTERVAL_MS = 1000;
const WINDOW_MS = 60_000;

export interface ResourceSample {
  t: number;
  ramPercent: number;
  cpuPercent: number;
}

export interface ResourceHistory {
  samples: ResourceSample[];
  latest: ResourceSample | null;
  rssBytes: number | null;
}

export function useResourceUsage(intervalMs = SAMPLE_INTERVAL_MS): ResourceHistory {
  const [history, setHistory] = useState<ResourceHistory>({ samples: [], latest: null, rssBytes: null });
  const samples = useRef<ResourceSample[]>([]);

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      getResourceUsage()
        .then((r) => {
          if (cancelled) return;
          const now = Date.now();
          const sample: ResourceSample = { t: now, ramPercent: r.ramPercent, cpuPercent: r.cpuPercent };
          samples.current = [...samples.current, sample].filter((s) => now - s.t <= WINDOW_MS);
          setHistory({ samples: samples.current, latest: sample, rssBytes: r.rssBytes });
        })
        .catch(() => {});
    };
    poll();
    const id = setInterval(poll, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [intervalMs]);

  return history;
}
