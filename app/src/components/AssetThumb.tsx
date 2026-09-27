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

import { useMemo, useState } from 'react';
import { thumbnailSrc, type AssetSummary } from '../lib/api';
import { decodeThumbHash } from '../lib/thumbhash';
import { refreshAssetImage, useImageVersion, useRotatePending } from '../lib/imageVersion';
import { useThumbnailSettings } from '../lib/thumbnailSettings';

// Shared image layer (thumbhash blur placeholder -> real thumbnail, with a
// retry-on-failure state) used by both the main grid and the viewer's
// filmstrip, so both render thumbnails identically. Must be placed inside a
// `position: relative` parent - it fills that parent absolutely.
export default function AssetThumbImage({
  asset,
  size = 'thumbnail',
}: {
  asset: AssetSummary;
  size?: 'thumbnail' | 'preview';
}) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const imgVersion = useImageVersion(asset.id);
  // Set by the Viewer's rotate action once the exiftool write is confirmed
  // (markRotatePending) - Immich's own thumbnail regen job it also kicks off
  // has no completion signal BrightTable can observe, so rather than guess with
  // a timer this tile just surfaces a manual "pull the rotated version" badge
  // instead, same reasoning as the main preview's "Refresh from Server"
  // button (see Viewer.tsx's handleRefreshFromServer doc comment).
  const rotatePending = useRotatePending(asset.id);
  // Preferences → Configuration → Appearance: crop to fill the tile, or show
  // the whole image at its own aspect ratio, letterboxed against the tile's
  // background.
  const { originalAspect } = useThumbnailSettings();
  const objectFit = originalAspect ? 'contain' : 'cover';
  const placeholder = useMemo(
    () => (asset.thumbHash ? decodeThumbHash(asset.thumbHash) : null),
    [asset.thumbHash],
  );

  return (
    <>
      {placeholder && (
        <img
          src={placeholder}
          alt=""
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit,
            filter: 'blur(8px)',
            // Scaled up only to hide the blur's soft edges when cropping - letterboxed,
            // it would overhang the real image's bounds instead.
            transform: originalAspect ? undefined : 'scale(1.1)',
            opacity: loaded ? 0 : 1,
            transition: 'opacity 200ms',
          }}
        />
      )}
      {failed ? (
        // Server returned no thumbnail for this asset (e.g. still generating
        // for a recently-added photo) - a quiet placeholder with a small retry
        // badge beats the browser's broken-image glyph. Only the badge itself
        // is clickable: the rest of the tile passes clicks through
        // (pointer-events: none) so select, shift/ctrl multi-select, and
        // double-click-to-open all work exactly as on a loaded thumbnail.
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
          }}
        >
          <div
            onClick={(e) => {
              // A modified click is a multi-select gesture - let it reach
              // AssetTile even if it happens to land on the badge.
              if (e.shiftKey || e.ctrlKey || e.metaKey) return;
              e.stopPropagation();
              setFailed(false);
            }}
            title="Retry loading this thumbnail"
            style={{
              pointerEvents: 'auto',
              width: 28,
              height: 28,
              borderRadius: 6,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--text-dimmer)',
              fontSize: 20,
              cursor: 'default',
            }}
          >
            ⟳
          </div>
        </div>
      ) : (
        <img
          src={thumbnailSrc(asset.id, size, imgVersion)}
          alt=""
          loading="lazy"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit,
            opacity: loaded ? 1 : 0,
            transition: 'opacity 150ms',
          }}
        />
      )}
      {rotatePending && !failed && (
        // Top-center so it doesn't collide with AssetTile's own corner
        // overlays (select circle top-left, open/stack badge top-right,
        // rating bar bottom-left, favorite/extension bottom-right). Stays up
        // until clicked - clicking is what actually pulls fresh bytes
        // (refreshAssetImage), and is safe to click again if Immich's regen
        // job hasn't landed on the server yet.
        <div
          onClick={(e) => {
            e.stopPropagation();
            refreshAssetImage(asset.id);
          }}
          title="Rotated - click to pull the updated image from the server"
          style={{
            position: 'absolute',
            top: 7,
            left: '50%',
            transform: 'translateX(-50%)',
            width: 20,
            height: 20,
            borderRadius: 6,
            background: 'rgba(0,0,0,0.55)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'default',
            fontSize: 13,
            color: '#fff',
          }}
        >
          ⟳
        </div>
      )}
    </>
  );
}
