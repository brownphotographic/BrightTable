import { useEffect, useState } from 'react';
import { exportToFlickr, flickrListAlbums, type AssetSummary, type ExportFormat, type FlickrAlbum, type FlickrAlbumSelection, type FlickrPrivacy } from '../lib/api';
import ExportSizeQualityFields from './ExportSizeQualityFields';
import { btnPrimary, btnSecondary, closeBtnStyle } from './ExportToFolderDialog';

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
  const [sizePx, setSizePx] = useState<number | null>(2048);
  const [quality, setQuality] = useState(90);
  const [privacy, setPrivacy] = useState<FlickrPrivacy>('public');
  const [albums, setAlbums] = useState<FlickrAlbum[]>([]);
  const [albumsError, setAlbumsError] = useState<string | null>(null);
  const [selectedAlbumId, setSelectedAlbumId] = useState<string>(NO_ALBUM_VALUE);
  const [newAlbumTitle, setNewAlbumTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        assets.map((a) => ({ id: a.id, originalPath: a.originalPath, fileName: a.fileName, fileExtension: a.fileExtension })),
        { album, privacy, format, sizePx: format === 'jpeg' ? sizePx : null, quality },
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
          <span style={{ fontSize: 14, fontWeight: 700 }}>Share to Flickr</span>
          <span style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.4)' }}>
            · {n} photo{n === 1 ? '' : 's'} selected
          </span>
          <div style={{ flex: 1 }} />
          <div onClick={busy ? undefined : onClose} style={closeBtnStyle}>
            ✕
          </div>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: '18px 22px', minHeight: 0 }}>
          <ExportSizeQualityFields format={format} onFormatChange={setFormat} sizePx={sizePx} onSizePxChange={setSizePx} quality={quality} onQualityChange={setQuality} />

          <div style={{ fontSize: 11, letterSpacing: '.05em', color: 'rgba(255,255,255,0.45)', margin: '18px 0 8px' }}>ALBUM</div>
          {albumsError && <div style={{ fontSize: 11.5, color: '#ffd699', marginBottom: 8, lineHeight: 1.5 }}>{albumsError}</div>}
          <select
            value={selectedAlbumId}
            onChange={(e) => setSelectedAlbumId(e.target.value)}
            style={{
              width: '100%',
              height: 36,
              padding: '0 10px',
              borderRadius: 9,
              background: 'rgba(0,0,0,0.3)',
              border: '1px solid rgba(255,255,255,0.1)',
              color: '#fff',
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
                background: 'rgba(0,0,0,0.3)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 9,
                color: '#fff',
                fontSize: 13,
              }}
            />
          )}

          <div style={{ fontSize: 11, letterSpacing: '.05em', color: 'rgba(255,255,255,0.45)', margin: '18px 0 8px' }}>PRIVACY</div>
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
                  color: privacy === opt.value ? '#fff' : 'rgba(255,255,255,0.7)',
                  background: privacy === opt.value ? '#3584e4' : 'rgba(255,255,255,0.06)',
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
  );
}
