import { useState } from 'react';
import type { AssetMetadataPatch, AssetSummary } from '../lib/api';
import { formatCamera, formatDims, formatExposure, formatSize, formatTaken } from '../lib/exifFormat';

// Shared EXIF row list used by both the viewer's Info panel and the grid's
// Metadata panel, so the two stay visually and factually consistent.
// `onEdit` is optional - pass it to make Rating/Favorite clickable; omit it
// for a purely read-only render.
export default function MetadataRows({
  asset,
  onEdit,
}: {
  asset: AssetSummary;
  onEdit?: (patch: AssetMetadataPatch) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function apply(patch: AssetMetadataPatch) {
    if (!onEdit || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onEdit(patch);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      <InfoRow label="Taken" value={formatTaken(asset)} />
      <InfoRow label="Camera" value={formatCamera(asset)} />
      <InfoRow label="Lens" value={asset.lensModel || '—'} />
      <InfoRow label="Exposure" value={formatExposure(asset)} />
      <InfoRow label="Dimensions" value={formatDims(asset)} />
      <InfoRow label="Size" value={formatSize(asset.fileSizeInByte)} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '9px 0', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
        <span style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.5)' }}>Favorite</span>
        <div
          onClick={() => apply({ isFavorite: !asset.isFavorite })}
          title={onEdit ? (asset.isFavorite ? 'Remove from favorites' : 'Add to favorites') : undefined}
          style={{ cursor: 'default', opacity: busy ? 0.5 : 1 }}
        >
          <Heart filled={asset.isFavorite} size={16} />
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '9px 0', marginTop: 2 }}>
        <span style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.5)' }}>Rating</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: busy ? 0.5 : 1 }}>
          <div style={{ display: 'flex', gap: 4 }}>
            {[1, 2, 3, 4, 5].map((v) => (
              <div key={v} onClick={() => apply({ rating: v === (asset.rating || 0) ? 0 : v })} style={{ cursor: 'default' }}>
                <Star filled={v <= (asset.rating || 0)} size={18} />
              </div>
            ))}
          </div>
          <div
            onClick={() => apply({ rating: asset.rating === -1 ? 0 : -1 })}
            title="Reject"
            style={{ cursor: 'default' }}
          >
            <RejectIcon active={asset.rating === -1} size={16} />
          </div>
        </div>
      </div>
      {error && <div style={{ marginTop: 8, fontSize: 11.5, color: '#ff6b6b', lineHeight: 1.4 }}>{error}</div>}
    </div>
  );
}

export function InfoRow({ label, value, last }: { label: string; value: string; last?: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        gap: 12,
        padding: '9px 0',
        borderBottom: last ? 'none' : '1px solid rgba(255,255,255,0.07)',
      }}
    >
      <span style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.5)' }}>{label}</span>
      <span style={{ fontSize: 12.5, textAlign: 'right' }}>{value}</span>
    </div>
  );
}

export function Star({ filled, size = 14 }: { filled: boolean; size?: number }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        clipPath: 'polygon(50% 0,61% 35%,98% 35%,68% 57%,79% 91%,50% 70%,21% 91%,32% 57%,2% 35%,39% 35%)',
        background: filled ? '#fff' : 'rgba(255,255,255,0.25)',
      }}
    />
  );
}

// Digikam/RT/ART's "rejected" culling flag, maps to Immich rating -1.
export function RejectIcon({ active, size = 14 }: { active: boolean; size?: number }) {
  const color = active ? '#ff6b6b' : 'rgba(255,255,255,0.25)';
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: `1.6px solid ${color}`, boxSizing: 'border-box' }} />
      <div style={{ position: 'absolute', left: '12%', top: '50%', width: '76%', height: 1.6, background: color, transform: 'rotate(-45deg)' }} />
    </div>
  );
}

export function Heart({ filled, size = 13 }: { filled: boolean; size?: number }) {
  const s = size * (7 / 13);
  const color = filled ? '#ff6b6b' : 'rgba(255,255,255,0.25)';
  return (
    <div style={{ position: 'relative', width: size, height: size * (12 / 13) }}>
      <div style={{ width: s, height: s, background: color, transform: 'rotate(45deg)', position: 'absolute', left: s * 0.43, top: s * 0.43 }} />
      <div style={{ width: s, height: s, background: color, borderRadius: '50%', position: 'absolute', left: 0, top: 0 }} />
      <div style={{ width: s, height: s, background: color, borderRadius: '50%', position: 'absolute', left: s * 0.86, top: 0 }} />
    </div>
  );
}
