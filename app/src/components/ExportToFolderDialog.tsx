import { useState, type CSSProperties } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { exportToFolder, type AssetSummary, type ExportFormat, type MetadataPolicy } from '../lib/api';
import { isRawAsset } from '../lib/filters';
import ExportSizeQualityFields from './ExportSizeQualityFields';
import NoSidecarDialog from './NoSidecarDialog';

// Export to Folder dialog, ported from the design prototype's Export to
// Folder modal (Immich Desktop.dc.html) - enqueues one ExportJob per asset
// onto the backend's ExportQueue (export_queue.rs) and returns immediately;
// progress/results show up in the Activity panel's Export section, same
// "fire and watch the Activity panel" shape as batchArtRoundTrip/startImport.
export default function ExportToFolderDialog({ assets, onClose, onExported }: { assets: AssetSummary[]; onClose: () => void; onExported: () => void }) {
  const [format, setFormat] = useState<ExportFormat>('jpeg');
  // Default to Full size (was 2048px) - RAW assets now headless-convert
  // through ART-cli at full resolution when format is 'jpeg', so there's no
  // reason to default to a downsized export anymore.
  const [sizePx, setSizePx] = useState<number | null>(null);
  const [quality, setQuality] = useState(90);
  const [metadata, setMetadata] = useState<MetadataPolicy>('keep');
  const [destination, setDestination] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Only relevant when format === 'jpeg' - a RAW asset with no saved ART
  // edits still exports fine (ART's default profile), but that's worth
  // flagging before committing, same NoSidecarDialog pattern the Headless
  // RAW Roundtrip batch confirm already uses (PhotosBrowser.tsx's
  // noSidecarBatch). `excludedIds` is what "Exclude Affected" removes.
  const [noSidecarInfo, setNoSidecarInfo] = useState<{ count: number; excludedIds: Set<string> } | null>(null);

  const n = assets.length;

  async function chooseFolder() {
    const picked = await open({ directory: true, multiple: false, title: 'Choose export destination' });
    if (typeof picked === 'string') setDestination(picked);
  }

  async function handleExport() {
    if (!destination.trim()) {
      setError('Choose a destination folder');
      return;
    }
    if (format === 'jpeg') {
      const withoutSidecar = assets.filter((a) => isRawAsset(a) && !a.hasProcessingSidecar).map((a) => a.id);
      if (withoutSidecar.length > 0) {
        setNoSidecarInfo({ count: withoutSidecar.length, excludedIds: new Set(withoutSidecar) });
        return;
      }
    }
    await runExport(assets);
  }

  async function runExport(targets: AssetSummary[]) {
    setBusy(true);
    setError(null);
    try {
      await exportToFolder(
        targets.map((a) => ({ id: a.id, originalPath: a.originalPath, fileName: a.fileName, fileExtension: a.fileExtension, isRaw: isRawAsset(a) })),
        { destination, format, sizePx: format === 'jpeg' ? sizePx : null, quality, metadata },
      );
      onExported();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div
        style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        onClick={busy ? undefined : onClose}
      >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 480,
          maxWidth: '92%',
          maxHeight: '86vh',
          background: '#242424',
          borderRadius: 14,
          boxShadow: '0 24px 70px rgba(0,0,0,0.7)',
          border: '1px solid rgba(255,255,255,0.08)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            height: 50,
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '0 10px 0 18px',
            background: '#303030',
            borderBottom: '1px solid rgba(0,0,0,0.4)',
          }}
        >
          <span style={{ fontSize: 14, fontWeight: 700 }}>Export to Folder</span>
          <span style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.4)' }}>
            · {n} photo{n === 1 ? '' : 's'} selected
          </span>
          <div style={{ flex: 1 }} />
          <div onClick={busy ? undefined : onClose} style={closeBtnStyle}>
            ✕
          </div>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: '18px 22px', minHeight: 0 }}>
          <ExportSizeQualityFields
            format={format}
            onFormatChange={setFormat}
            sizePx={sizePx}
            onSizePxChange={setSizePx}
            quality={quality}
            onQualityChange={setQuality}
            metadata={metadata}
            onMetadataChange={setMetadata}
            hasRawOriginal={assets.some(isRawAsset)}
          />

          <div style={{ fontSize: 11, letterSpacing: '.05em', color: 'rgba(255,255,255,0.45)', margin: '18px 0 8px' }}>DESTINATION</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <div
              style={{
                flex: 1,
                height: 36,
                display: 'flex',
                alignItems: 'center',
                padding: '0 12px',
                borderRadius: 9,
                background: 'rgba(0,0,0,0.3)',
                border: '1px solid rgba(255,255,255,0.1)',
                fontSize: 12.5,
                color: destination ? '#fff' : 'rgba(255,255,255,0.4)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {destination || 'No folder chosen'}
            </div>
            <button onClick={chooseFolder} style={btnSecondary}>
              Choose…
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '13px 18px', borderTop: '1px solid rgba(0,0,0,0.4)', flexShrink: 0 }}>
          {error && <span style={{ fontSize: 12, color: '#ff8080' }}>{error}</span>}
          <div style={{ flex: 1 }} />
          <button onClick={busy ? undefined : onClose} disabled={busy} style={btnSecondary}>
            Cancel
          </button>
          <button onClick={handleExport} disabled={busy || n === 0} style={btnPrimary(!busy && n > 0)}>
            {busy ? 'Exporting…' : `Export ${n} Photo${n === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
      {noSidecarInfo && (
        <NoSidecarDialog
          title="Some RAW Photos Have No Saved Edits"
          message={`${noSidecarInfo.count} of ${n} selected photo${n === 1 ? '' : 's'} have no saved ART edits. Export ${
            noSidecarInfo.count === 1 ? 'it' : 'them'
          } anyway using ART's default processing profile, or exclude ${noSidecarInfo.count === 1 ? 'it' : 'them'} from this export?`}
          primaryLabel="Export with Default Processing"
          secondaryLabel="Exclude Affected"
          onPrimary={async () => {
            setNoSidecarInfo(null);
            await runExport(assets);
          }}
          onSecondary={async () => {
            const { excludedIds } = noSidecarInfo;
            setNoSidecarInfo(null);
            const remaining = assets.filter((a) => !excludedIds.has(a.id));
            if (remaining.length > 0) await runExport(remaining);
            else onClose();
          }}
        />
      )}
    </>
  );
}

export const closeBtnStyle: CSSProperties = {
  width: 30,
  height: 30,
  borderRadius: '50%',
  background: 'rgba(255,255,255,0.08)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'default',
  fontSize: 14,
};

const btnBase: CSSProperties = { height: 38, padding: '0 18px', borderRadius: 9, fontSize: 13, cursor: 'default', border: 'none' };

export const btnSecondary: CSSProperties = { ...btnBase, border: '1px solid rgba(255,255,255,0.14)', background: 'rgba(255,255,255,0.06)', color: '#fff' };

export function btnPrimary(enabled: boolean): CSSProperties {
  return { ...btnBase, padding: '0 22px', background: '#3584e4', color: '#fff', fontWeight: 700, opacity: enabled ? 1 : 0.5, pointerEvents: enabled ? 'auto' : 'none' };
}
