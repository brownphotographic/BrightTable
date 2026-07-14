import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { listInstalledApps, type AppChoice, type AppKind } from '../lib/api';

// Kind badge colors match the design prototype's own appColor/appBg/appText
// map (Immich Desktop.dc.html) exactly, so this reads as a continuation of
// that visual language rather than a new one.
const KIND_COLOR: Record<AppKind, string> = {
  flatpak: '#3584e4',
  snap: '#e95420',
  appimage: '#2ec27e',
  native: '#9141ac',
  custom: '#5e5c64',
};

const KIND_LABEL: Record<AppKind, string> = {
  flatpak: 'Flatpak',
  snap: 'Snap',
  appimage: 'AppImage',
  native: 'Native',
  custom: 'Custom',
};

export default function AppPickerDialog({
  roleLabel,
  onClose,
  onPick,
}: {
  roleLabel: string;
  onClose: () => void;
  onPick: (choice: AppChoice) => void;
}) {
  const [apps, setApps] = useState<AppChoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [browseError, setBrowseError] = useState<string | null>(null);

  useEffect(() => {
    listInstalledApps()
      .then(setApps)
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return apps;
    return apps.filter((a) => a.name.toLowerCase().includes(q) || a.exec.toLowerCase().includes(q));
  }, [apps, filter]);

  async function pickOther() {
    setBrowseError(null);
    try {
      const path = await open({ multiple: false, directory: false, title: `Choose an application for ${roleLabel}` });
      if (!path || typeof path !== 'string') return;
      const base = path.split('/').pop() ?? path;
      const kind: AppKind = base.toLowerCase().endsWith('.appimage') ? 'appimage' : 'custom';
      onPick({ name: base, exec: path, kind });
    } catch (e) {
      setBrowseError(String(e));
    }
  }

  return (
    <div style={overlay} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={dialog}>
        <div style={header}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700 }}>Select Application</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-dimmer)', marginTop: 2 }}>Choose the application for {roleLabel}</div>
          </div>
          <div onClick={onClose} style={closeBtn}>
            <div style={closeLine1} />
            <div style={closeLine2} />
          </div>
        </div>

        <div style={{ padding: '0 20px 12px' }}>
          <input
            autoFocus
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter…"
            style={filterInput}
          />
        </div>

        <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
          {loading ? (
            <div style={emptyState}>Scanning installed applications…</div>
          ) : filtered.length === 0 ? (
            <div style={emptyState}>No applications found{filter ? ' matching your filter' : ''}.</div>
          ) : (
            filtered.map((app, i) => (
              <div key={`${app.exec}-${i}`} onClick={() => onPick(app)} style={appRow}>
                <div style={{ ...avatar, background: KIND_COLOR[app.kind] }}>{app.name.charAt(0).toUpperCase()}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, color: '#fff' }}>{app.name}</div>
                  <div style={execText}>{app.exec}</div>
                </div>
                <span style={{ ...kindBadge, background: `${KIND_COLOR[app.kind]}26`, color: KIND_COLOR[app.kind] }}>
                  {KIND_LABEL[app.kind]}
                </span>
              </div>
            ))
          )}
        </div>

        <div onClick={pickOther} style={{ ...appRow, borderTop: '1px solid var(--border)' }}>
          <div style={{ ...avatar, background: 'rgba(255,255,255,0.1)' }}>+</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, color: '#fff' }}>Other application…</div>
            <div style={execText}>Browse the filesystem for an executable or AppImage</div>
          </div>
        </div>
        {browseError && <div style={{ ...emptyState, color: 'var(--danger)', padding: '0 20px 14px' }}>{browseError}</div>}
      </div>
    </div>
  );
}

const overlay: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 310,
  background: 'rgba(0,0,0,0.55)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const dialog: CSSProperties = {
  width: 480,
  maxWidth: '90%',
  height: 480,
  maxHeight: '80%',
  background: '#242424',
  borderRadius: 14,
  boxShadow: '0 24px 70px rgba(0,0,0,0.65)',
  border: '1px solid rgba(255,255,255,0.08)',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  color: '#fff',
};

const header: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  padding: '18px 20px 14px',
};

const closeBtn: CSSProperties = {
  width: 26,
  height: 26,
  borderRadius: '50%',
  background: 'rgba(255,255,255,0.08)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'default',
  position: 'relative',
  flexShrink: 0,
};

const closeLine1: CSSProperties = {
  position: 'absolute',
  width: 11,
  height: 1.6,
  background: '#fff',
  transform: 'rotate(45deg)',
  borderRadius: 1,
};

const closeLine2: CSSProperties = { ...closeLine1, transform: 'rotate(-45deg)' };

const filterInput: CSSProperties = {
  width: '100%',
  height: 32,
  padding: '0 10px',
  background: 'rgba(0,0,0,0.3)',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 7,
  color: '#fff',
  fontSize: 13,
};

const appRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '10px 20px',
  cursor: 'default',
  borderBottom: '1px solid var(--border)',
};

const avatar: CSSProperties = {
  width: 30,
  height: 30,
  borderRadius: 8,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 13,
  fontWeight: 700,
  color: '#fff',
  flexShrink: 0,
};

const execText: CSSProperties = {
  font: '500 11.5px ui-monospace,monospace',
  color: 'var(--text-dimmer)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  marginTop: 1,
};

const kindBadge: CSSProperties = {
  fontSize: 10.5,
  fontWeight: 700,
  padding: '3px 8px',
  borderRadius: 6,
  flexShrink: 0,
};

const emptyState: CSSProperties = {
  padding: '30px 20px',
  textAlign: 'center',
  fontSize: 13,
  color: 'var(--text-dimmer)',
};
