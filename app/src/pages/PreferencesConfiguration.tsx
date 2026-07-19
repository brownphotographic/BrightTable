import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { clearThumbCache, getThumbCacheInfo, type ThumbCacheStats } from '../lib/api';
import ConfirmDialog from '../components/ConfirmDialog';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

export default function PreferencesConfiguration() {
  const [stats, setStats] = useState<ThumbCacheStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    getThumbCacheInfo()
      .then(setStats)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  async function onClear() {
    setStats(await clearThumbCache());
  }

  return (
    <div style={{ maxWidth: 560, margin: '0 auto', padding: '24px 0' }}>
      <div style={{ fontSize: 14, fontWeight: 700, margin: '0 4px 12px' }}>Thumbnail Cache</div>
      <div style={{ fontSize: 12.5, color: 'var(--text-dimmer)', margin: '0 4px 16px', lineHeight: 1.5 }}>
        Thumbnails fetched from Immich are kept on disk so scrolling through the library doesn't
        re-download the same images. This cache grows over time and isn't automatically trimmed —
        clear it below to reclaim disk space. Cleared thumbnails simply re-download the next time
        you view them.
      </div>
      <div style={panel}>
        <Row label="Location">
          <span style={pathText}>{loading ? 'Loading…' : stats?.dir || '—'}</span>
        </Row>
        <Divider />
        <Row label="Size">
          <span style={{ fontSize: 13 }}>
            {loading ? 'Loading…' : stats ? `${formatSize(stats.sizeBytes)} · ${stats.fileCount.toLocaleString()} files` : '—'}
          </span>
        </Row>
      </div>
      {error && <div style={{ ...helpText, color: 'var(--danger)' }}>{error}</div>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 11, margin: '18px 4px 0' }}>
        <div style={{ flex: 1 }} />
        <button onClick={() => setConfirming(true)} disabled={loading} style={btnSecondary}>
          Clear Cache
        </button>
      </div>

      {confirming && (
        <ConfirmDialog
          title="Clear Thumbnail Cache"
          message="This deletes every cached thumbnail from disk. They'll simply re-download from the server the next time you view them — nothing else is affected."
          confirmLabel="Clear Cache"
          danger={false}
          onConfirm={onClear}
          onClose={() => setConfirming(false)}
        />
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', padding: '11px 16px', gap: 14 }}>
      <span style={{ fontSize: 13.5, width: 90, flexShrink: 0, color: 'rgba(255,255,255,0.85)' }}>{label}</span>
      <div style={{ flex: 1, display: 'flex', justifyContent: 'flex-end', overflow: 'hidden' }}>{children}</div>
    </div>
  );
}

function Divider() {
  return <div style={{ height: 1, background: 'var(--border)', marginLeft: 16 }} />;
}

const panel: CSSProperties = {
  background: 'var(--panel)',
  borderRadius: 13,
  overflow: 'hidden',
  border: '1px solid var(--border)',
};

const pathText: CSSProperties = {
  fontSize: 12,
  font: '500 12px ui-monospace,monospace',
  color: 'rgba(255,255,255,0.75)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const helpText: CSSProperties = {
  fontSize: 12,
  color: 'var(--text-dimmer)',
  margin: '16px 4px 0',
  lineHeight: 1.5,
};

const btnBase: CSSProperties = {
  height: 36,
  padding: '0 16px',
  borderRadius: 9,
  fontSize: 13,
  cursor: 'default',
  border: 'none',
};

const btnSecondary: CSSProperties = {
  ...btnBase,
  border: '1px solid var(--border-strong)',
  background: 'rgba(255,255,255,0.06)',
  color: '#fff',
};
