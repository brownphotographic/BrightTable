import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { thumbHashToDataURL } from 'thumbhash';
import {
  getTimelineBuckets,
  getTimelineBucketAssets,
  thumbnailSrc,
  type AssetSummary,
  type TimeBucketInfo,
} from '../lib/api';

// `new Date("2026-06-01")` parses bare (time-less) date strings as UTC midnight,
// then toLocaleDateString() renders that back in the local timezone - shifting
// the displayed date back a day for any timezone behind UTC. Parsing the y/m/d
// components ourselves and building a local Date avoids that shift entirely.
function parseCalendarDate(dateStr: string): Date {
  const [y, m, d] = dateStr.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
}

const COLUMNS_GUESS = 6;
const ROW_HEIGHT_GUESS = 170;
const MONTH_HEADER_HEIGHT = 34;
const DAY_HEADER_HEIGHT = 26;

export default function PhotosBrowser() {
  const [buckets, setBuckets] = useState<TimeBucketInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Fetched asset data is cached permanently per bucket (cheap - just ids/dates,
  // not images) so scrolling back to an already-visited month is instant. Only
  // the DOM (thumbnail <img> elements) is virtualized/torn down when scrolled
  // out of view - that's what actually bounds memory/DOM size for a huge library.
  const [assetCache, setAssetCache] = useState<Record<string, AssetSummary[]>>({});
  const inFlight = useRef<Set<string>>(new Set());
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getTimelineBuckets()
      .then(setBuckets)
      .catch((e) => setError(String(e)));
  }, []);

  const virtualizer = useVirtualizer({
    count: buckets?.length ?? 0,
    getScrollElement: () => containerRef.current,
    estimateSize: (index) => {
      const b = buckets![index];
      const rows = Math.ceil(b.count / COLUMNS_GUESS);
      const dayHeadersGuess = Math.min(b.count, 28);
      return MONTH_HEADER_HEIGHT + dayHeadersGuess * DAY_HEADER_HEIGHT + rows * ROW_HEIGHT_GUESS;
    },
    overscan: 3,
  });

  useEffect(() => {
    if (!buckets) return;
    for (const item of virtualizer.getVirtualItems()) {
      const bucket = buckets[item.index];
      if (assetCache[bucket.timeBucket] || inFlight.current.has(bucket.timeBucket)) continue;
      inFlight.current.add(bucket.timeBucket);
      getTimelineBucketAssets(bucket.timeBucket)
        .then((assets) => setAssetCache((c) => ({ ...c, [bucket.timeBucket]: assets })))
        .catch(() => setAssetCache((c) => ({ ...c, [bucket.timeBucket]: [] })))
        .finally(() => inFlight.current.delete(bucket.timeBucket));
    }
  });

  if (error) {
    return (
      <div style={{ padding: 24, color: 'var(--text-dim)' }}>
        Couldn't load the library — {error}. Check Preferences → Library.
      </div>
    );
  }

  if (!buckets) {
    return <div style={{ padding: 24, color: 'var(--text-dim)' }}>Loading timeline…</div>;
  }

  if (buckets.length === 0) {
    return <div style={{ padding: 24, color: 'var(--text-dim)' }}>No assets found.</div>;
  }

  return (
    <div ref={containerRef} style={{ overflow: 'auto', height: '100%', padding: '0 24px' }}>
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
        {virtualizer.getVirtualItems().map((item) => {
          const bucket = buckets[item.index];
          return (
            <div
              key={bucket.timeBucket}
              ref={virtualizer.measureElement}
              data-index={item.index}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${item.start}px)`,
                paddingTop: 16,
              }}
            >
              <BucketContent bucket={bucket} assets={assetCache[bucket.timeBucket]} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function BucketContent({ bucket, assets }: { bucket: TimeBucketInfo; assets?: AssetSummary[] }) {
  const monthLabel = parseCalendarDate(bucket.timeBucket).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
  });

  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-dim)', margin: '0 0 10px' }}>
        {monthLabel} <span style={{ color: 'var(--text-dimmer)', fontWeight: 400 }}>· {bucket.count}</span>
      </div>
      {assets ? (
        <DayGroups assets={assets} />
      ) : (
        <div style={{ color: 'var(--text-dimmer)', fontSize: 12.5 }}>Loading…</div>
      )}
    </div>
  );
}

function DayGroups({ assets }: { assets: AssetSummary[] }) {
  const groups = new Map<string, AssetSummary[]>();
  for (const a of assets) {
    const day = a.fileCreatedAt.slice(0, 10);
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day)!.push(a);
  }
  return (
    <>
      {[...groups.entries()].map(([day, items]) => (
        <div key={day} style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11.5, color: 'var(--text-dimmer)', margin: '0 0 8px' }}>
            {parseCalendarDate(day).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 6 }}>
            {items.map((a) => (
              <Thumb key={a.id} asset={a} />
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

// Immich ships a ~25-byte thumbhash per asset in the bucket data already - just
// unused until now. Decoding it client-side gives an instant blurred preview
// with zero network cost, which is most of why Immich's own web UI feels
// instant: something appears immediately, then sharpens once the real
// thumbnail (network-fetched, possibly cached) arrives.
function decodeThumbHash(base64: string): string | null {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return thumbHashToDataURL(bytes);
  } catch {
    return null;
  }
}

function Thumb({ asset }: { asset: AssetSummary }) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const placeholder = useMemo(
    () => (asset.thumbHash ? decodeThumbHash(asset.thumbHash) : null),
    [asset.thumbHash],
  );

  return (
    <div
      style={{
        aspectRatio: '1',
        borderRadius: 8,
        overflow: 'hidden',
        background: 'var(--panel)',
        position: 'relative',
      }}
    >
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
          onClick={() => setFailed(false)}
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
          src={thumbnailSrc(asset.id)}
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
    </div>
  );
}
