import { useMemo, useState } from 'react';
import { thumbnailSrc, type AssetSummary } from '../lib/api';
import { decodeThumbHash } from '../lib/thumbhash';
import { useImageVersion } from '../lib/imageVersion';

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
    </>
  );
}
