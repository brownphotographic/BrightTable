import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';

// Live 0-100 percentage for the currently-running ART CLI round trip
// Variant 1 export - see commands.rs's ART_ROUND_TRIP_PROGRESS_EVENT for why
// this needs a Tauri event at all (Variant 1 is a single awaited `invoke`
// call with no polled job to attach a percentage to, unlike Variant 2's
// ArtJob::progressPercent). Only one Variant 1 export can ever be in flight
// at a time (the triggering button disables itself while busy), so a single
// global event with no asset-id disambiguation is enough.
//
// Resets to null whenever `active` goes false, so a later busy period starts
// fresh instead of briefly showing the previous run's last percentage.
export function useArtRoundTripProgress(active: boolean): number | null {
  const [progress, setProgress] = useState<number | null>(null);

  useEffect(() => {
    if (!active) {
      setProgress(null);
      return;
    }
    const unlisten = listen<number>('art-round-trip-progress', (e) => setProgress(e.payload));
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [active]);

  return progress;
}
