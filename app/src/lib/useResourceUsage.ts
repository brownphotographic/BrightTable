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

import { useEffect, useRef, useState } from 'react';
import { getResourceUsage } from './api';

// One sample per second, kept for a minute - matches the rolling chart's
// fixed 1-minute x-axis extent.
export const SAMPLE_INTERVAL_MS = 1000;
const WINDOW_MS = 60_000;

export interface ResourceSample {
  t: number;
  systemRamPercent: number;
  cpuPercent: number;
}

export interface ResourceHistory {
  samples: ResourceSample[];
  latest: ResourceSample | null;
  appRssBytes: number | null;
}

export function useResourceUsage(intervalMs = SAMPLE_INTERVAL_MS): ResourceHistory {
  const [history, setHistory] = useState<ResourceHistory>({ samples: [], latest: null, appRssBytes: null });
  const samples = useRef<ResourceSample[]>([]);

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      getResourceUsage()
        .then((r) => {
          if (cancelled) return;
          const now = Date.now();
          const sample: ResourceSample = { t: now, systemRamPercent: r.systemRamPercent, cpuPercent: r.cpuPercent };
          samples.current = [...samples.current, sample].filter((s) => now - s.t <= WINDOW_MS);
          setHistory({ samples: samples.current, latest: sample, appRssBytes: r.appRssBytes });
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
