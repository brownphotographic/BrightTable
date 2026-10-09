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
import type { AssetMetadataPatch, AssetSummary } from '../lib/api';
import MetadataRows from './MetadataRows';

// Rating/Favorite edit via the shared MetadataRows; description editing here
// is specific to this panel (matches the design mockup's grid-context
// metadata pane). Title/Keywords/Creator/Copyright from the mockup aren't
// implemented - Immich's asset model doesn't have those fields, they only
// existed in the mockup's imagined local-sidecar-via-ExifTool model.
export default function MetadataPanel({
  selected,
  onEdit,
  onChangeLens,
}: {
  selected: AssetSummary[];
  onEdit: (id: string, patch: AssetMetadataPatch) => Promise<void>;
  // Opens Change Lens on the whole (non-video) selection, unlike the rest of
  // this panel's edits - same targeting as the context menu's Change Lens.
  onChangeLens?: () => void;
}) {
  const asset = selected[0] ?? null;
  const lensCount = selected.filter((a) => a.type !== 'VIDEO').length;

  // Styled to match the Viewer's Information panel (Viewer.tsx) - same
  // width, background, border and title - so the two read as one panel.
  // Closed from the toolbar's Metadata toggle, same as the Viewer's.
  return (
    <div
      style={{
        width: 288,
        flexShrink: 0,
        borderLeft: '1px solid var(--border-strong)',
        background: 'var(--panel-3)',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
      {asset ? (
        <div style={{ flex: 1, overflow: 'auto', minHeight: 0, padding: 18 }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>Information</div>
          {/* The Viewer shows the file name in its own toolbar; the grid has
              nowhere else to show it, so it's a quiet subtitle here. */}
          <div style={{ marginTop: 4, fontSize: 12, color: 'var(--text-dimmer)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={asset.fileName}>
            {asset.fileName}
          </div>
          {selected.length > 1 && (
            <div
              style={{
                marginTop: 11,
                padding: '9px 11px',
                borderRadius: 9,
                background: 'rgba(53,132,228,0.14)',
                border: '1px solid rgba(53,132,228,0.3)',
                fontSize: 11.5,
                lineHeight: 1.45,
                color: 'var(--accent-text)',
              }}
            >
              Showing {asset.fileName} — {selected.length} photos selected. Editing applies to
              this one only for now.
            </div>
          )}
          <div style={{ marginTop: 14 }}>
            <MetadataRows
              asset={asset}
              onEdit={(patch) => onEdit(asset.id, patch)}
              onChangeLens={onChangeLens}
              changeLensTitle={lensCount > 1 ? `Change lens for ${lensCount} photos…` : 'Change lens…'}
            />
          </div>
          <DescriptionEditor key={asset.id} asset={asset} onEdit={(patch) => onEdit(asset.id, patch)} />
        </div>
      ) : (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', color: 'var(--text-dimmer)', fontSize: 13, lineHeight: 1.6, padding: 30 }}>
          Select a photo to view
          <br />
          its metadata.
        </div>
      )}
    </div>
  );
}

// Also used by the Viewer's Information panel.
export function DescriptionEditor({
  asset,
  onEdit,
}: {
  asset: AssetSummary;
  onEdit: (patch: AssetMetadataPatch) => Promise<void>;
}) {
  const [value, setValue] = useState(asset.description ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keeping this as a controlled draft rather than saving on every keystroke -
  // saves on blur, only if it actually changed.
  useEffect(() => {
    setValue(asset.description ?? '');
    setError(null);
  }, [asset.id, asset.description]);

  async function save() {
    if (value === (asset.description ?? '')) return;
    setBusy(true);
    setError(null);
    try {
      await onEdit({ description: value });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
      <div style={{ fontSize: 10.5, letterSpacing: '.06em', color: 'var(--text-dimmer)', marginBottom: 9 }}>
        CAPTION / DESCRIPTION
      </div>
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        disabled={busy}
        rows={3}
        placeholder="Add a caption…"
        style={{
          width: '100%',
          padding: '8px 11px',
          background: 'var(--surface-sunken)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          color: 'var(--text)',
          fontSize: 13,
          resize: 'vertical',
          fontFamily: 'inherit',
          opacity: busy ? 0.6 : 1,
        }}
      />
      {error && <div style={{ marginTop: 6, fontSize: 11.5, color: '#ff6b6b', lineHeight: 1.4 }}>{error}</div>}
    </div>
  );
}
