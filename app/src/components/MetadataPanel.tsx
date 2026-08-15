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
  onClose,
  onEdit,
}: {
  selected: AssetSummary[];
  onClose: () => void;
  onEdit: (id: string, patch: AssetMetadataPatch) => Promise<void>;
}) {
  const asset = selected[0] ?? null;

  return (
    <div
      style={{
        width: 312,
        flexShrink: 0,
        borderLeft: '1px solid rgba(0,0,0,0.4)',
        background: 'var(--surface-sunken)',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
      <div
        style={{
          height: 46,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '0 8px 0 16px',
          borderBottom: '1px solid rgba(0,0,0,0.35)',
        }}
      >
        <span style={{ fontSize: 14, fontWeight: 700 }}>Metadata</span>
        <div style={{ flex: 1 }} />
        <div
          onClick={onClose}
          style={{
            width: 28,
            height: 28,
            borderRadius: '50%',
            background: 'var(--overlay-medium)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'default',
            position: 'relative',
          }}
        >
          <div style={{ position: 'absolute', width: 11, height: 1.6, background: 'var(--text)', transform: 'rotate(45deg)', borderRadius: 1 }} />
          <div style={{ position: 'absolute', width: 11, height: 1.6, background: 'var(--text)', transform: 'rotate(-45deg)', borderRadius: 1 }} />
        </div>
      </div>

      {asset ? (
        <div style={{ flex: 1, overflow: 'auto', minHeight: 0, padding: '14px 16px' }}>
          <div style={{ font: '600 12.5px ui-monospace,monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
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
          <div style={{ marginTop: 18 }}>
            <MetadataRows asset={asset} onEdit={(patch) => onEdit(asset.id, patch)} />
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

function DescriptionEditor({
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
