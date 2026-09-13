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

import { useEffect, useState } from 'react';
import { getAsset, untagAssets, type AssetMetadataPatch, type AssetSummary, type TagSummary } from '../lib/api';
import { formatCamera, formatDims, formatExposure, formatSize, formatTaken } from '../lib/exifFormat';
import { bumpTagsVersion, useTagsVersion } from '../lib/tagsVersion';

// Shared EXIF row list used by both the viewer's Info panel and the grid's
// Metadata panel, so the two stay visually and factually consistent.
// `onEdit` is optional - pass it to make Rating/Favorite/Tags clickable; omit
// it for a purely read-only render.
export default function MetadataRows({
  asset,
  onEdit,
}: {
  asset: AssetSummary;
  onEdit?: (patch: AssetMetadataPatch) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // `asset.tags` itself is always empty here - Immich doesn't join the tags
  // relation on any of the listing endpoints an AssetSummary normally comes
  // from (timeline/album/person/tag/search results), only on GET
  // /assets/{id} (see getAsset's doc comment in lib/api.ts). Fetched fresh
  // whenever the shown asset changes, since this is a single-asset panel,
  // not a grid tile.
  const { tags, error: tagsError, removeTag } = useAssetTags(asset.id);

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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '9px 0', borderBottom: '1px solid var(--border)' }}>
        <span style={{ fontSize: 12.5, color: 'var(--text-dimmer)' }}>Favorite</span>
        <div
          onClick={() => apply({ isFavorite: !asset.isFavorite })}
          title={onEdit ? (asset.isFavorite ? 'Remove from favorites' : 'Add to favorites') : undefined}
          style={{ cursor: 'default', opacity: busy ? 0.5 : 1 }}
        >
          <Heart filled={asset.isFavorite} size={16} filledColor="var(--icon-filled)" dimColor="var(--text-faint)" />
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '9px 0', marginTop: 2 }}>
        <span style={{ fontSize: 12.5, color: 'var(--text-dimmer)' }}>Rating</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: busy ? 0.5 : 1 }}>
          <div style={{ display: 'flex', gap: 4 }}>
            {[1, 2, 3, 4, 5].map((v) => (
              <div key={v} onClick={() => apply({ rating: v === (asset.rating || 0) ? 0 : v })} style={{ cursor: 'default' }}>
                <Star filled={v <= (asset.rating || 0)} size={18} color="var(--icon-filled)" dimColor="var(--text-faint)" />
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
      {tagsError && (
        <div style={{ padding: '9px 0 2px', marginTop: 2, borderTop: '1px solid var(--border)', fontSize: 11.5, color: '#ff6b6b', lineHeight: 1.4 }}>
          Couldn't load tags — {tagsError}.
        </div>
      )}
      {tags && tags.length > 0 && (
        <div style={{ padding: '9px 0 2px', marginTop: 2, borderTop: '1px solid var(--border)' }}>
          <div style={{ fontSize: 12.5, color: 'var(--text-dimmer)', marginBottom: 8 }}>Tags</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {tags.map((t) => (
              <div
                key={t.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 5,
                  padding: onEdit ? '3px 5px 3px 9px' : '3px 9px',
                  borderRadius: 999,
                  // Fixed dark chip regardless of theme (unlike the
                  // ✕/border colors elsewhere in this file) - the user asked
                  // for a consistent, always-legible pill rather than one
                  // that goes low-contrast in light mode.
                  background: '#3a3a3a',
                  color: '#fff',
                  fontSize: 11.5,
                }}
              >
                <div style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: t.color ?? '#fff' }} />
                {t.name}
                {onEdit && (
                  <div
                    onClick={() => removeTag(t.id)}
                    title={`Remove "${t.name}" tag`}
                    style={{ cursor: 'default', color: '#fff', fontSize: 11, padding: '0 2px' }}
                  >
                    ✕
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
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
        borderBottom: last ? 'none' : '1px solid var(--border)',
      }}
    >
      <span style={{ fontSize: 12.5, color: 'var(--text-dimmer)' }}>{label}</span>
      <span style={{ fontSize: 12.5, textAlign: 'right' }}>{value}</span>
    </div>
  );
}

// `dimColor` is the "unfilled/inactive" fill - defaults to the theme-aware
// dim-text var, but callers that render these on a fixed (non-theme)
// background - e.g. SelectionBar's permanently dark bar - pass an explicit
// fixed color instead so they don't go invisible when the app theme flips.
export function Star({
  filled,
  size = 14,
  dimColor = 'var(--text-dimmer)',
  color = '#fff',
}: {
  filled: boolean;
  size?: number;
  dimColor?: string;
  color?: string;
}) {
  return (
    <div
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        clipPath: 'polygon(50% 0,61% 35%,98% 35%,68% 57%,79% 91%,50% 70%,21% 91%,32% 57%,2% 35%,39% 35%)',
        background: filled ? color : dimColor,
      }}
    />
  );
}

// Digikam/RT/ART's "rejected" culling flag, maps to Immich rating -1.
export function RejectIcon({ active, size = 14, dimColor = 'var(--text-dimmer)' }: { active: boolean; size?: number; dimColor?: string }) {
  const color = active ? '#ff6b6b' : dimColor;
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: `1.6px solid ${color}`, boxSizing: 'border-box' }} />
      <div style={{ position: 'absolute', left: '12%', top: '50%', width: '76%', height: 1.6, background: color, transform: 'rotate(-45deg)' }} />
    </div>
  );
}

export function Heart({
  filled,
  size = 13,
  dimColor = 'var(--text-dimmer)',
  filledColor = '#ff6b6b',
}: {
  filled: boolean;
  size?: number;
  dimColor?: string;
  filledColor?: string;
}) {
  const s = size * (7 / 13);
  const color = filled ? filledColor : dimColor;
  return (
    <div style={{ position: 'relative', width: size, height: size * (12 / 13) }}>
      <div style={{ width: s, height: s, background: color, transform: 'rotate(45deg)', position: 'absolute', left: s * 0.43, top: s * 0.43 }} />
      <div style={{ width: s, height: s, background: color, borderRadius: '50%', position: 'absolute', left: 0, top: 0 }} />
      <div style={{ width: s, height: s, background: color, borderRadius: '50%', position: 'absolute', left: s * 0.86, top: 0 }} />
    </div>
  );
}

// Fetches the given asset's real tags via GET /assets/{id} (the only
// endpoint Immich actually includes them on) whenever `assetId` changes.
// `tags` is null while loading/unknown - `tags && tags.length > 0` on the
// caller's check treats that the same as "none" until it resolves, so no
// loading-spinner state was worth adding for what's normally a near-instant
// single-asset fetch. A failure is surfaced via `error` (and always logged)
// rather than silently treated as "no tags" - that distinction matters for
// diagnosing a stale build (a Tauri command added this session not yet
// picked up by a running `tauri dev`/binary shows up here as "command
// get_asset not found") versus a real "this asset genuinely has none".
function useAssetTags(assetId: string): { tags: TagSummary[] | null; error: string | null; removeTag: (tagId: string) => void } {
  const [tags, setTags] = useState<TagSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped by AddToTagDialog/TagsBrowser's Remove from Tag/this hook's own
  // removeTag below whenever a tag<->asset link changes anywhere in the app -
  // see lib/tagsVersion.ts's doc comment. `assetId` alone doesn't change when
  // the *currently shown* asset's tags are edited, so without this the panel
  // kept showing whatever it fetched on mount until the asset was reselected.
  const tagsVersion = useTagsVersion(assetId);

  useEffect(() => {
    let cancelled = false;
    setTags(null);
    setError(null);
    getAsset(assetId)
      .then((a) => {
        if (!cancelled) setTags(a.tags);
      })
      .catch((e) => {
        console.error('Failed to load tags for asset', assetId, e);
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [assetId, tagsVersion]);

  // DELETE /tags/{id}/assets isn't gated by TAG_ASSIGN_DISABLED_REASON (that
  // only covers *assignment*, see featureFlags.ts), so this needs no flag
  // check. Re-fetches via the version bump rather than removing the pill
  // optimistically, so this stays the single code path (shared with
  // AddToTagDialog/TagsBrowser) that keeps every open panel for this asset
  // in sync rather than just the one the click happened in.
  function removeTag(tagId: string) {
    untagAssets(tagId, [assetId])
      .catch((e) => {
        console.error('Failed to remove tag', tagId, 'from asset', assetId, e);
        setError(String(e));
      })
      .finally(() => bumpTagsVersion(assetId));
  }

  return { tags, error, removeTag };
}
