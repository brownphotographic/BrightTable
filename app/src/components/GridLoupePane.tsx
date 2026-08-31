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
import { thumbnailSrc } from '../lib/api';
import { useImageVersion } from '../lib/imageVersion';

// The right-hand pane of grid loupe mode - unlike Viewer.tsx's detail-view
// loupe (a small circle that magnifies a zoomed-in region under the cursor),
// this shows the *whole* hovered thumbnail's image, uncropped and
// unmagnified, in one large circle - closer to holding a real loupe over a
// contact sheet than a magnifying glass. Empty whenever nothing is hovered
// (cursor over the gap between tiles, or loupe mode just turned on).
export default function GridLoupePane({ assetId, large = false }: { assetId: string | null; large?: boolean }) {
  const paneRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const version = useImageVersion(assetId ?? '');
  // The image's own aspect ratio, read once it loads - used to size it so
  // its *whole rectangle* (not just its bounding square) stays inscribed in
  // the circle, so no part of the photo is clipped by the circular mask.
  // Reset on every asset change so the previous photo's aspect never gets
  // applied to the next one for the one frame before it loads.
  const [aspect, setAspect] = useState<number | null>(null);
  useEffect(() => setAspect(null), [assetId]);

  useEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      setSize({ w: width, h: height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const r = aspect ?? 1;

  let boxW: number;
  let boxH: number;
  if (large) {
    // Large just shows the photo itself, no circular loupe mask - scaled to
    // the largest size that fits within 95% of *both* the pane's width and
    // height (real best-fit, like CSS object-fit: contain), not picked from
    // the photo's own portrait/landscape orientation alone - that ignored
    // the pane's own shape and could leave a much bigger letterboxing gap on
    // one axis than the pane's other axis actually required.
    const maxW = size.w * 0.95;
    const maxH = size.h * 0.95;
    if (maxW / r <= maxH) {
      boxW = maxW;
      boxH = maxW / r;
    } else {
      boxH = maxH;
      boxW = maxH * r;
    }
  } else {
    // Small keeps the circle within whichever dimension of the pane is
    // tighter, so it's never trimmed by the pane's own edges.
    const diameter = Math.min(size.w, size.h) * 0.94;
    boxH = diameter / Math.sqrt(r * r + 1);
    boxW = r * boxH;
  }

  return (
    <div
      ref={paneRef}
      style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 0,
        minWidth: 0,
        // Large's box (above) isn't clamped to the pane's *other* axis, so
        // it can be taller (or wider) than the pane itself - overflow:
        // hidden here would crop the photo right at the pane's own edge in
        // that case. Small's circle never exceeds the pane, so hiding
        // overflow there is just a no-op safety net, not load-bearing.
        overflow: large ? 'visible' : 'hidden',
        background: 'var(--canvas)',
      }}
    >
      {assetId && large && (
        <img
          src={thumbnailSrc(assetId, 'preview', version)}
          alt=""
          onLoad={(e) => {
            const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
            if (w > 0 && h > 0) setAspect(w / h);
          }}
          style={{ width: boxW, height: boxH, objectFit: 'contain', boxShadow: '0 0 0 1px var(--border-strong)' }}
        />
      )}
      {assetId && !large && (
        <div
          style={{
            // A rectangle of aspect ratio r, scaled so its *diagonal* equals
            // the circle's diameter, is the largest such rectangle whose
            // every corner (and so every point) stays within the circle -
            // i.e. the whole photo visible at full size, corners touching
            // the circle, none of it ever clipped by the circular mask.
            width: Math.sqrt(boxW * boxW + boxH * boxH),
            height: Math.sqrt(boxW * boxW + boxH * boxH),
            borderRadius: '50%',
            overflow: 'hidden',
            // Fixed to the light theme's --surface-sunken value (not the
            // theme token itself) so any letterboxing around a non-square
            // photo looks the same in light and dark mode, rather than
            // flipping to near-black in dark mode.
            background: '#e2e2e2',
            boxShadow: '0 0 0 1px var(--border-strong), 0 12px 40px rgba(0,0,0,.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <img
            src={thumbnailSrc(assetId, 'preview', version)}
            alt=""
            onLoad={(e) => {
              const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
              if (w > 0 && h > 0) setAspect(w / h);
            }}
            style={{ width: boxW, height: boxH, objectFit: 'contain' }}
          />
        </div>
      )}
    </div>
  );
}
