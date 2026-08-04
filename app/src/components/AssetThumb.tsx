import { useMemo, useState } from 'react';
import { thumbnailSrc, type AssetSummary } from '../lib/api';
import { decodeThumbHash } from '../lib/thumbhash';
import { refreshAssetImage, useImageVersion, useRotatePending } from '../lib/imageVersion';

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
  // has no completion signal ImmAture can observe, so rather than guess with
  // a timer this tile just surfaces a manual "pull the rotated version" badge
  // instead, same reasoning as the main preview's "Refresh from Server"
  // button (see Viewer.tsx's handleRefreshFromServer doc comment).
  const rotatePending = useRotatePending(asset.id);
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
            objectFit: 'cover',
            filter: 'blur(8px)',
            transform: 'scale(1.1)',
            opacity: loaded ? 0 : 1,
            transition: 'opacity 200ms',
          }}
        />
      )}
      {failed ? (
        // Server returned no thumbnail for this asset (e.g. still generating
        // for a recently-added photo) - a quiet, clickable placeholder beats
        // the browser's broken-image glyph.
        <div
          onClick={(e) => {
            e.stopPropagation();
            setFailed(false);
          }}
          title="Retry loading this thumbnail"
          style={{
            position: 'absolute',
            inset: 0,
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
            objectFit: 'cover',
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
