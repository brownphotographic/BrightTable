import { useEffect, useRef, useState } from 'react';
import { getMemoryUsage } from './api';

// Only trust the extrapolated hourly rate once we've actually watched memory
// for a little while - a rate computed from two samples 4s apart would
// amplify any single noisy reading into a wildly misleading %/hr figure.
const MIN_WINDOW_MS = 20_000;
// Bound how far back the "oldest" sample can be, so the rate tracks the
// current trend (useful for spotting a leak that starts partway through a
// session) rather than diluting forever against a session-start baseline.
const MAX_WINDOW_MS = 10 * 60 * 1000;

interface Sample {
  t: number;
  bytes: number;
}

export interface MemoryReading {
  rssBytes: number | null;
  // Estimated fractional change per hour (e.g. 0.032 = "+3.2%/hr"), or null
  // until enough of a window has been observed to trust the extrapolation.
  ratePerHour: number | null;
}

export function useMemoryUsage(intervalMs = 4000): MemoryReading {
  const [reading, setReading] = useState<MemoryReading>({ rssBytes: null, ratePerHour: null });
  const samples = useRef<Sample[]>([]);

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      getMemoryUsage()
        .then((m) => {
          if (cancelled) return;
          const now = Date.now();
          samples.current.push({ t: now, bytes: m.rssBytes });
          samples.current = samples.current.filter((s) => now - s.t <= MAX_WINDOW_MS);

          const oldest = samples.current[0];
          const elapsedMs = now - oldest.t;
          const ratePerHour =
            elapsedMs >= MIN_WINDOW_MS && oldest.bytes > 0
              ? ((m.rssBytes - oldest.bytes) / oldest.bytes) / (elapsedMs / 3_600_000)
              : null;

          setReading({ rssBytes: m.rssBytes, ratePerHour });
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

  return reading;
}

export function formatMemoryRate(ratePerHour: number): string {
  const pct = ratePerHour * 100;
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%/hr`;
}
