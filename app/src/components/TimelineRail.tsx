import { useRef, useState } from 'react';
import type { Virtualizer } from '@tanstack/react-virtual';
import type { TimeBucketInfo } from '../lib/api';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function formatMonthYear(timeBucket: string): string {
  const [y, m] = timeBucket.slice(0, 7).split('-').map(Number);
  return `${MONTH_NAMES[(m ?? 1) - 1]} ${y}`;
}

// Largest index i such that cumulative[i] <= target (cumulative is sorted,
// strictly increasing once bucket counts are all >0 - buckets with count 0
// never come back from Immich, so no dedup needed here).
function bucketIndexForCount(cumulative: number[], target: number): number {
  let lo = 0;
  let hi = cumulative.length - 2; // cumulative has buckets.length + 1 entries
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cumulative[mid] <= target) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// Right-hand scrubber for the Photos grid - Immich's own timeline has one,
// and so did the design prototype (`showScrubber`/`scrubLabels` in
// `Immich Desktop.dc.html`), but it never made it into the real
// react-virtual-backed rewrite.
//
// Positions are derived from each bucket's *asset count* (exact, from
// Immich - `TimeBucketInfo.count`), not from the virtualizer's pixel
// offsets. An earlier version used `getOffsetForIndex`/`measurementsCache`
// for this, but those are only accurate for buckets that have actually been
// measured in the DOM - offscreen buckets fall back to `estimateSize`, and
// every later offset shifts (sometimes by a lot - a bucket's real height
// depends on its day-header count and current column count, not just a
// flat guess) as buckets scroll into view and get their real height
// measured. That made the year labels visibly jump around while scrolling
// or dragging. Cumulative asset count is stable regardless of what's been
// measured, so labels/hover/thumb no longer move once drawn.
//
// Jumping (click/drag) uses `virtualizer.scrollToIndex` rather than setting
// `scrollTop` directly off a fraction of `getTotalSize()` - same reasoning:
// `getTotalSize()` is only as accurate as the estimate for unmeasured
// buckets, so a naive `fraction * totalSize` can land well short of or past
// the intended month. `scrollToIndex` has its own reconcile loop that keeps
// adjusting the scroll position across the next few frames as the target
// area gets measured, so it converges on the right spot even when the
// estimate was off.
export default function TimelineRail({
  buckets,
  virtualizer,
}: {
  buckets: TimeBucketInfo[];
  virtualizer: Virtualizer<HTMLDivElement, Element>;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ y: number; text: string } | null>(null);

  const cumulative = new Array<number>(buckets.length + 1);
  cumulative[0] = 0;
  for (let i = 0; i < buckets.length; i++) cumulative[i + 1] = cumulative[i] + buckets[i].count;
  const totalCount = cumulative[buckets.length];

  if (!buckets.length || totalCount === 0) return null;

  const yearTicks: { year: string; top: number }[] = [];
  const seenYears = new Set<string>();
  for (let i = 0; i < buckets.length; i++) {
    const year = buckets[i].timeBucket.slice(0, 4);
    if (seenYears.has(year)) continue;
    seenYears.add(year);
    yearTicks.push({ year, top: (cumulative[i] / totalCount) * 100 });
  }

  const range = virtualizer.range;
  const viewStart = range ? cumulative[range.startIndex] / totalCount : 0;
  const viewEnd = range ? cumulative[Math.min(range.endIndex + 1, buckets.length)] / totalCount : 1;
  const viewFrac = Math.max(0.02, viewEnd - viewStart);
  const thumbTop = Math.min(viewStart, 1 - viewFrac);

  const fractionFromClientY = (clientY: number) => {
    const track = trackRef.current;
    if (!track) return 0;
    const rect = track.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientY - rect.top) / Math.max(1, rect.height)));
  };

  const jumpToFraction = (fraction: number) => {
    const target = Math.min(totalCount - 1, Math.max(0, fraction * totalCount));
    virtualizer.scrollToIndex(bucketIndexForCount(cumulative, target), { align: 'start' });
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    jumpToFraction(fractionFromClientY(e.clientY));
    const onMove = (ev: MouseEvent) => jumpToFraction(fractionFromClientY(ev.clientY));
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const track = trackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const fraction = Math.min(1, Math.max(0, y / Math.max(1, rect.height)));
    const index = bucketIndexForCount(cumulative, fraction * totalCount);
    setHover({ y, text: formatMonthYear(buckets[index].timeBucket) });
  };

  return (
    <div
      ref={trackRef}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => setHover(null)}
      style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: 60, zIndex: 8, cursor: 'ns-resize' }}
    >
      <div
        style={{
          position: 'absolute', right: 7, top: 8, bottom: 8, width: 2, borderRadius: 1,
          background: 'var(--border-strong)',
        }}
      />
      {yearTicks.map((t) => (
        <div key={t.year}>
          <div
            style={{
              position: 'absolute', right: 5, top: `${t.top}%`, transform: 'translateY(-50%)',
              width: 7, height: 2, borderRadius: 1, background: 'var(--text-dimmer)', pointerEvents: 'none',
            }}
          />
          <div
            style={{
              position: 'absolute', right: 15, top: `${t.top}%`, transform: 'translateY(-50%)',
              fontSize: 11, fontWeight: 700, color: 'var(--text-dimmer)', whiteSpace: 'nowrap', pointerEvents: 'none',
            }}
          >
            {t.year}
          </div>
        </div>
      ))}
      <div
        style={{
          position: 'absolute', right: 2.5, width: 7, borderRadius: 4, background: 'var(--accent)',
          boxShadow: '0 1px 5px rgba(0,0,0,0.5)', pointerEvents: 'none',
          height: `${viewFrac * 100}%`, top: `${thumbTop * 100}%`,
        }}
      />
      {hover && (
        <div
          style={{
            position: 'absolute', right: 26, top: hover.y, transform: 'translateY(-50%)',
            background: 'var(--accent)', color: '#fff', fontSize: 11, fontWeight: 700,
            padding: '4px 10px', borderRadius: 7, whiteSpace: 'nowrap', pointerEvents: 'none',
            boxShadow: '0 4px 14px rgba(0,0,0,0.55)',
          }}
        >
          {hover.text}
        </div>
      )}
    </div>
  );
}
