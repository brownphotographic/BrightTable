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
export default function GridLoupePane({ assetId }: { assetId: string | null }) {
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

  const diameter = Math.max(0, Math.min(size.w, size.h) * 0.94);

  // A rectangle of aspect ratio r, scaled so its *diagonal* equals the
  // circle's diameter, is the largest such rectangle whose every corner (and
  // so every point) stays within the circle - i.e. the whole photo visible,
  // none of it clipped. Falls back to a square (the safe inscribed-square
  // case) for the one frame before the image's real aspect ratio is known.
  const r = aspect ?? 1;
  const boxH = diameter / Math.sqrt(r * r + 1);
  const boxW = r * boxH;

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
        background: 'var(--canvas)',
      }}
    >
      {assetId && diameter > 0 && (
        <div
          style={{
            width: diameter,
            height: diameter,
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
