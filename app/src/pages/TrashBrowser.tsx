import { useEffect, useState, type CSSProperties } from 'react';
import { deleteAssets, emptyTrash, getTrashedAssets, restoreAssets, type AssetSummary } from '../lib/api';
import AssetThumbImage from '../components/AssetThumb';
import ConfirmDialog from '../components/ConfirmDialog';

// No multi-select here (unlike the main grid) - trash items are acted on one
// at a time via hover actions, or all at once via Empty Trash. A much
// smaller surface than PhotosBrowser's selection model, which didn't seem
// worth duplicating for what's normally a short-lived, low-traffic view.
export default function TrashBrowser({ onCount }: { onCount?: (n: number) => void }) {
  const [assets, setAssets] = useState<AssetSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  useEffect(() => {
    getTrashedAssets()
      .then((a) => {
        setAssets(a);
        onCount?.(a.length);
      })
      .catch((e) => setError(String(e)));
    // Deliberately runs once on mount only, matching PhotosBrowser's pattern -
    // onCount's identity changing on re-renders shouldn't refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleRestore(id: string) {
    await restoreAssets([id]);
    setAssets((a) => {
      const next = (a ?? []).filter((x) => x.id !== id);
      onCount?.(next.length);
      return next;
    });
  }

  async function handleDeleteForever(id: string) {
    await deleteAssets([id], true);
    setAssets((a) => {
      const next = (a ?? []).filter((x) => x.id !== id);
      onCount?.(next.length);
      return next;
    });
  }

  if (error) {
    return (
      <div style={{ padding: 24, color: 'var(--text-dim)' }}>
        Couldn't load the trash — {error}.
      </div>
    );
  }

  if (!assets) {
    return <div style={{ padding: 24, color: 'var(--text-dim)' }}>Loading trash…</div>;
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0, padding: 24, background: 'var(--canvas)' }}>
        {assets.length === 0 ? (
          <div style={{ color: 'var(--text-dimmer)', fontSize: 13 }}>Trash is empty.</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(168px, 1fr))', gap: 12 }}>
            {assets.map((a) => (
              <TrashTile
                key={a.id}
                asset={a}
                onRestore={() => handleRestore(a.id)}
                onDeleteForever={() => setConfirmDeleteId(a.id)}
              />
            ))}
          </div>
        )}
      </div>
      <div
        style={{
          height: 30,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 13,
          // Extra right padding keeps "Empty Trash" clear of the window's
          // bottom-right resize grip (see ResizeHandles.tsx).
          padding: '0 28px 0 12px',
          background: 'var(--panel-3)',
          borderTop: '1px solid rgba(0,0,0,0.4)',
          fontSize: 11.5,
          color: 'var(--text-dimmer)',
        }}
      >
        <span>{assets.length} in trash</span>
        <div style={{ flex: 1 }} />
        {assets.length > 0 && (
          <div onClick={() => setConfirmEmpty(true)} style={{ cursor: 'default', color: '#ff8080' }}>
            Empty Trash
          </div>
        )}
      </div>

      {confirmEmpty && (
        <ConfirmDialog
          title="Empty trash?"
          message={`This permanently deletes all ${assets.length} photo${assets.length === 1 ? '' : 's'} in the trash. This cannot be undone.`}
          confirmLabel="Empty Trash"
          onConfirm={async () => {
            await emptyTrash();
            setAssets([]);
            onCount?.(0);
          }}
          onClose={() => setConfirmEmpty(false)}
        />
      )}
      {confirmDeleteId && (
        <ConfirmDialog
          title="Delete forever?"
          message="This permanently deletes this photo. This cannot be undone."
          confirmLabel="Delete Forever"
          onConfirm={() => handleDeleteForever(confirmDeleteId)}
          onClose={() => setConfirmDeleteId(null)}
        />
      )}
    </div>
  );
}

function TrashTile({
  asset,
  onRestore,
  onDeleteForever,
}: {
  asset: AssetSummary;
  onRestore: () => Promise<void>;
  onDeleteForever: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleRestoreClick(e: React.MouseEvent) {
    e.stopPropagation();
    setBusy(true);
    setError(null);
    try {
      await onRestore();
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  }

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        aspectRatio: '3 / 2',
        borderRadius: 8,
        overflow: 'hidden',
        position: 'relative',
        background: 'var(--surface-sunken)',
        boxShadow: '0 0 0 1px var(--border)',
      }}
    >
      <AssetThumbImage asset={asset} />
      {hovered && !error && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
          }}
        >
          <button onClick={handleRestoreClick} disabled={busy} style={pillBtn}>
            {busy ? 'Restoring…' : 'Restore'}
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDeleteForever();
            }}
            disabled={busy}
            style={{ ...pillBtn, background: '#c0392b' }}
          >
            Delete Forever
          </button>
        </div>
      )}
      {error && (
        <div
          onClick={(e) => {
            e.stopPropagation();
            setError(null);
          }}
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(0,0,0,0.7)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            textAlign: 'center',
            padding: 8,
            fontSize: 11,
            color: 'var(--danger)',
            lineHeight: 1.4,
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
}

const pillBtn: CSSProperties = {
  height: 28,
  padding: '0 14px',
  borderRadius: 14,
  border: 'none',
  background: 'var(--accent)',
  color: '#fff',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'default',
};
