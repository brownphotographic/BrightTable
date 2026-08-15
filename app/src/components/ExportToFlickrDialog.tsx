import { useEffect, useState } from 'react';
import {
  exportToFlickr,
  flickrListAlbums,
  type AssetSummary,
  type ExportFormat,
  type FlickrAlbum,
  type FlickrAlbumSelection,
  type FlickrPrivacy,
  type MetadataPolicy,
} from '../lib/api';
import { isRawAsset, isVideoAsset } from '../lib/filters';
import ExportSizeQualityFields from './ExportSizeQualityFields';
import { btnPrimary, btnSecondary, closeBtnStyle } from './ExportToFolderDialog';
import NoSidecarDialog from './NoSidecarDialog';

const PRIVACY_OPTIONS: { value: FlickrPrivacy; label: string }[] = [
  { value: 'public', label: 'Public' },
  { value: 'friendsFamily', label: 'Friends & Family' },
  { value: 'private', label: 'Private' },
];

const NEW_ALBUM_VALUE = '__new__';
const NO_ALBUM_VALUE = '__none__';

// Export to Flickr (Share to Flickr…) - the album/privacy counterpart to
// ExportToFolderDialog, enqueuing one ExportJob per asset onto the same
// backend ExportQueue (export_queue.rs), delivered via flickr.rs's OAuth 1.0a
// upload instead of a local file write.
export default function ExportToFlickrDialog({ assets, onClose, onExported }: { assets: AssetSummary[]; onClose: () => void; onExported: () => void }) {
  const [format, setFormat] = useState<ExportFormat>('jpeg');
  // Default to Full size (was 2048px) - RAW assets now headless-convert
  // through ART-cli at full resolution when format is 'jpeg', so there's no
  // reason to default to a downsized export anymore.
  const [sizePx, setSizePx] = useState<number | null>(null);
  const [quality, setQuality] = useState(90);
  const [metadata, setMetadata] = useState<MetadataPolicy>('keep');
  const [privacy, setPrivacy] = useState<FlickrPrivacy>('public');
  const [albums, setAlbums] = useState<FlickrAlbum[]>([]);
  const [albumsError, setAlbumsError] = useState<string | null>(null);
  const [selectedAlbumId, setSelectedAlbumId] = useState<string>(NO_ALBUM_VALUE);
  const [newAlbumTitle, setNewAlbumTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Same NoSidecarDialog interstitial as ExportToFolderDialog - see its
  // identical comment.
  const [noSidecarInfo, setNoSidecarInfo] = useState<{ count: number; excludedIds: Set<string> } | null>(null);

  const n = assets.length;

  useEffect(() => {
    let cancelled = false;
    flickrListAlbums()
      .then((list) => {
        if (!cancelled) setAlbums(list);
      })
      .catch((e) => {
        if (!cancelled) setAlbumsError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleShare() {
    if (selectedAlbumId === NEW_ALBUM_VALUE && !newAlbumTitle.trim()) {
      setError('Enter a name for the new album');
      return;
    }
    if (format === 'jpeg') {
      const withoutSidecar = assets.filter((a) => isRawAsset(a) && !a.hasProcessingSidecar).map((a) => a.id);
      if (withoutSidecar.length > 0) {
        setNoSidecarInfo({ count: withoutSidecar.length, excludedIds: new Set(withoutSidecar) });
        return;
      }
    }
    await runShare(assets);
  }

  async function runShare(targets: AssetSummary[]) {
    setBusy(true);
    setError(null);
    try {
      const album: FlickrAlbumSelection =
        selectedAlbumId === NO_ALBUM_VALUE
          ? { kind: 'none' }
          : selectedAlbumId === NEW_ALBUM_VALUE
            ? { kind: 'new', title: newAlbumTitle.trim() }
            : { kind: 'existing', id: selectedAlbumId };
      await exportToFlickr(
        targets.map((a) => ({
          id: a.id,
          originalPath: a.originalPath,
          fileName: a.fileName,
          fileExtension: a.fileExtension,
          isRaw: isRawAsset(a),
          isVideo: isVideoAsset(a),
        })),
        { album, privacy, format, sizePx: format === 'jpeg' ? sizePx : null, quality, metadata },
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
          background: 'var(--dialog-bg)',
          borderRadius: 14,
          boxShadow: '0 24px 70px rgba(0,0,0,0.7)',
          border: '1px solid var(--border)',
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
            background: 'var(--panel)',
            borderBottom: '1px solid rgba(0,0,0,0.4)',
          }}
        >
          <span style={{ fontSize: 14, fontWeight: 700 }}>Share to Flickr</span>
          <span style={{ fontSize: 12.5, color: 'var(--text-dimmer)' }}>
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
            hasVideo={assets.some(isVideoAsset)}
          />

          <div style={{ fontSize: 11, letterSpacing: '.05em', color: 'var(--text-dimmer)', margin: '18px 0 8px' }}>ALBUM</div>
          {albumsError && <div style={{ fontSize: 11.5, color: 'var(--warn)', marginBottom: 8, lineHeight: 1.5 }}>{albumsError}</div>}
          <select
            value={selectedAlbumId}
            onChange={(e) => setSelectedAlbumId(e.target.value)}
            style={{
              width: '100%',
              height: 36,
              padding: '0 10px',
              borderRadius: 9,
              background: 'var(--surface-sunken)',
              border: '1px solid var(--border)',
              color: 'var(--text)',
              fontSize: 12.5,
            }}
          >
            <option value={NO_ALBUM_VALUE}>No album</option>
            <option value={NEW_ALBUM_VALUE}>+ New album…</option>
            {albums.map((a) => (
              <option key={a.id} value={a.id}>
                {a.title} ({a.photoCount})
              </option>
            ))}
          </select>
          {selectedAlbumId === NEW_ALBUM_VALUE && (
            <input
              value={newAlbumTitle}
              onChange={(e) => setNewAlbumTitle(e.target.value)}
              placeholder="New album name"
              style={{
                width: '100%',
                height: 34,
                marginTop: 8,
                padding: '0 12px',
                background: 'var(--surface-sunken)',
                border: '1px solid var(--border)',
                borderRadius: 9,
                color: 'var(--text)',
                fontSize: 13,
              }}
            />
          )}

          <div style={{ fontSize: 11, letterSpacing: '.05em', color: 'var(--text-dimmer)', margin: '18px 0 8px' }}>PRIVACY</div>
          <div style={{ display: 'flex', gap: 6 }}>
            {PRIVACY_OPTIONS.map((opt) => (
              <div
                key={opt.value}
                onClick={() => setPrivacy(opt.value)}
                style={{
                  flex: 1,
                  height: 32,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 12,
                  borderRadius: 7,
                  cursor: 'default',
                  color: privacy === opt.value ? '#fff' : 'var(--text-dim)',
                  background: privacy === opt.value ? '#3584e4' : 'var(--overlay-weak)',
                }}
              >
                {opt.label}
              </div>
            ))}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '13px 18px', borderTop: '1px solid rgba(0,0,0,0.4)', flexShrink: 0 }}>
          {error && <span style={{ fontSize: 12, color: '#ff8080' }}>{error}</span>}
          <div style={{ flex: 1 }} />
          <button onClick={busy ? undefined : onClose} disabled={busy} style={btnSecondary}>
            Cancel
          </button>
          <button onClick={handleShare} disabled={busy || n === 0} style={btnPrimary(!busy && n > 0)}>
            {busy ? 'Sharing…' : `Share ${n} Photo${n === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
      </div>
      {noSidecarInfo && (
        <NoSidecarDialog
          title="Some RAW Photos Have No Saved Edits"
          message={`${noSidecarInfo.count} of ${n} selected photo${n === 1 ? '' : 's'} have no saved ART edits. Share ${
            noSidecarInfo.count === 1 ? 'it' : 'them'
          } anyway using ART's default processing profile, or exclude ${noSidecarInfo.count === 1 ? 'it' : 'them'} from this share?`}
          primaryLabel="Share with Default Processing"
          secondaryLabel="Exclude Affected"
          onPrimary={async () => {
            setNoSidecarInfo(null);
            await runShare(assets);
          }}
          onSecondary={async () => {
            const { excludedIds } = noSidecarInfo;
            setNoSidecarInfo(null);
            const remaining = assets.filter((a) => !excludedIds.has(a.id));
            if (remaining.length > 0) await runShare(remaining);
            else onClose();
          }}
        />
      )}
    </>
  );
}
