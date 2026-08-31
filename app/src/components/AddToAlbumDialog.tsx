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

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { addAssetsToAlbum, createAlbum, listAlbums, thumbnailSrc, type AlbumSummary } from '../lib/api';

// Modal for adding the current selection to an album - opened from
// SelectionBar's "Add to Album" button (Photos/Folders/AlbumsBrowser's album
// detail) and from the equivalent context-menu item. Lists every existing
// album to pick from, or lets the user type a brand new album name inline -
// either path is a single click/Enter away, no separate "create album" flow
// to visit first.
export default function AddToAlbumDialog({
  assetIds,
  onClose,
  onAdded,
}: {
  assetIds: string[];
  onClose: () => void;
  onAdded?: (albumId: string, albumName: string) => void;
}) {
  const [albums, setAlbums] = useState<AlbumSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [newName, setNewName] = useState('');
  const [busyAlbumId, setBusyAlbumId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    listAlbums()
      .then(setAlbums)
      .catch((e) => setError(String(e)));
  }, []);

  const filtered = useMemo(() => {
    if (!albums) return [];
    const q = search.trim().toLowerCase();
    if (!q) return albums;
    return albums.filter((a) => a.albumName.toLowerCase().includes(q));
  }, [albums, search]);

  const count = assetIds.length;

  async function handleAdd(album: AlbumSummary) {
    setBusyAlbumId(album.id);
    setError(null);
    try {
      await addAssetsToAlbum(album.id, assetIds);
      onAdded?.(album.id, album.albumName);
      onClose();
    } catch (e) {
      setError(String(e));
      setBusyAlbumId(null);
    }
  }

  async function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    setError(null);
    try {
      const album = await createAlbum(name, assetIds);
      onAdded?.(album.id, album.albumName);
      onClose();
    } catch (e) {
      setError(String(e));
      setCreating(false);
    }
  }

  return (
    <div
      className="window-frame window-frame-overlay"
      style={{
        zIndex: 300,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 420,
          maxWidth: '92%',
          height: 520,
          maxHeight: '86%',
          background: 'var(--dialog-bg)',
          borderRadius: 14,
          boxShadow: '0 24px 70px rgba(0,0,0,0.7)',
          border: '1px solid var(--border)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div style={{ height: 50, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10, padding: '0 10px 0 18px', background: 'var(--panel)', borderBottom: '1px solid rgba(0,0,0,0.4)' }}>
          <span style={{ fontSize: 14, fontWeight: 700 }}>Add to Album</span>
          <span style={{ fontSize: 12.5, color: 'var(--text-dimmer)' }}>· {count} selected</span>
          <div style={{ flex: 1 }} />
          <div onClick={onClose} style={{ width: 30, height: 30, borderRadius: '50%', background: 'var(--overlay-medium)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'default', fontSize: 14 }}>
            ✕
          </div>
        </div>

        <div style={{ flexShrink: 0, padding: '14px 18px 12px', borderBottom: '1px solid rgba(0,0,0,0.3)', display: 'flex', gap: 8 }}>
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreate();
            }}
            placeholder="New album name…"
            style={inputStyle}
          />
          <button onClick={handleCreate} disabled={creating || !newName.trim()} style={btnPrimary(!creating && !!newName.trim())}>
            {creating ? 'Creating…' : 'Create'}
          </button>
        </div>

        <div style={{ flexShrink: 0, padding: '10px 18px 0' }}>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search albums…" style={inputStyle} />
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: '10px 10px 14px', minHeight: 0 }}>
          {error && <div style={{ fontSize: 12, color: 'var(--danger)', padding: '4px 8px 10px' }}>{error}</div>}
          {!albums && !error && <div style={{ padding: '20px 8px', color: 'var(--text-dimmer)', fontSize: 13 }}>Loading albums…</div>}
          {albums && filtered.length === 0 && (
            <div style={{ padding: '20px 8px', color: 'var(--text-dimmer)', fontSize: 13 }}>
              {albums.length === 0 ? 'No albums yet — create one above.' : 'No albums match your search.'}
            </div>
          )}
          {filtered.map((a) => (
            <div
              key={a.id}
              onClick={() => (busyAlbumId ? undefined : handleAdd(a))}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                height: 52,
                padding: '0 8px',
                borderRadius: 9,
                cursor: 'default',
                opacity: busyAlbumId && busyAlbumId !== a.id ? 0.5 : 1,
              }}
            >
              <div style={{ width: 40, height: 40, borderRadius: 6, overflow: 'hidden', flexShrink: 0, background: 'var(--surface-sunken)' }}>
                {a.albumThumbnailAssetId && <img src={thumbnailSrc(a.albumThumbnailAssetId)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.albumName}</div>
                <div style={{ fontSize: 11.5, color: 'var(--text-dimmer)' }}>
                  {a.assetCount} photo{a.assetCount === 1 ? '' : 's'}
                </div>
              </div>
              {busyAlbumId === a.id && <span style={{ fontSize: 11.5, color: 'var(--text-dimmer)' }}>Adding…</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const inputStyle: CSSProperties = {
  flex: 1,
  height: 34,
  padding: '0 12px',
  background: 'var(--surface-sunken)',
  border: '1px solid var(--border)',
  borderRadius: 9,
  color: 'var(--text)',
  fontSize: 13,
};

const btnBase: CSSProperties = {
  height: 34,
  padding: '0 16px',
  borderRadius: 9,
  border: 'none',
  fontSize: 12.5,
  cursor: 'default',
  whiteSpace: 'nowrap',
};

function btnPrimary(enabled: boolean): CSSProperties {
  return {
    ...btnBase,
    background: '#3584e4',
    color: '#fff',
    fontWeight: 700,
    opacity: enabled ? 1 : 0.5,
    pointerEvents: enabled ? 'auto' : 'none',
  };
}
