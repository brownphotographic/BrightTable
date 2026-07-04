import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import {
  getConfig,
  saveLibraryConfig,
  testConnection,
  type LibraryConfig,
} from '../lib/api';

const emptyLib: LibraryConfig = {
  connMode: 'lan',
  lanUrl: '',
  tailscaleUrl: '',
  apiKey: '',
  shareType: 'nfs',
  localRoot: '',
  immichRoot: '',
  readOnly: true,
  maxDeletePerSession: 25,
};

type Status = { kind: 'idle' | 'ok' | 'error'; text: string };

function effUrl(lib: LibraryConfig): { url: string; via: string } {
  if (lib.connMode === 'tailscale') return { url: lib.tailscaleUrl, via: 'via Tailscale' };
  if (lib.connMode === 'auto')
    return lib.tailscaleUrl ? { url: lib.tailscaleUrl, via: 'Auto → Tailscale' } : { url: lib.lanUrl, via: 'Auto → LAN' };
  return { url: lib.lanUrl, via: 'via LAN' };
}

export default function PreferencesLibrary() {
  const [lib, setLibState] = useState<LibraryConfig>(emptyLib);
  const [status, setStatus] = useState<Status>({ kind: 'idle', text: 'Not connected' });
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getConfig()
      .then((cfg) => setLibState(cfg.library))
      .catch((e) => setStatus({ kind: 'error', text: String(e) }))
      .finally(() => setLoading(false));
  }, []);

  function setLib<K extends keyof LibraryConfig>(field: K, value: LibraryConfig[K]) {
    setLibState((s) => ({ ...s, [field]: value }));
  }

  async function onTest() {
    setTesting(true);
    setStatus({ kind: 'idle', text: 'Testing…' });
    try {
      const res = await testConnection(lib);
      setStatus({
        kind: 'ok',
        text: `Connected · Immich ${res.serverVersion} · ${res.userEmail}`,
      });
    } catch (e) {
      setStatus({ kind: 'error', text: String(e) });
    } finally {
      setTesting(false);
    }
  }

  async function onSave() {
    setSaving(true);
    try {
      await saveLibraryConfig(lib);
      setStatus({ kind: 'ok', text: 'Saved' });
    } catch (e) {
      setStatus({ kind: 'error', text: String(e) });
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div style={{ padding: 24 }}>Loading…</div>;

  const active = effUrl(lib);
  const dotColor = status.kind === 'ok' ? 'var(--ok)' : status.kind === 'error' ? 'var(--danger)' : 'rgba(255,255,255,0.3)';

  return (
    <div style={{ maxWidth: 560, margin: '0 auto', padding: '24px 0' }}>
      <div style={{ fontSize: 14, fontWeight: 700, margin: '0 4px 12px' }}>Immich Server</div>
      <div style={panel}>
        <Row label="Connect over">
          <Segmented
            value={lib.connMode}
            options={[
              { value: 'lan', label: 'LAN' },
              { value: 'tailscale', label: 'Tailscale' },
              { value: 'auto', label: 'Auto' },
            ]}
            onChange={(v) => setLib('connMode', v as LibraryConfig['connMode'])}
          />
        </Row>
        <Divider />
        <Row label="LAN endpoint">
          <input
            value={lib.lanUrl}
            onChange={(e) => setLib('lanUrl', e.target.value)}
            placeholder="http://immich.home:2283/api"
            style={inputRight}
          />
        </Row>
        <Divider />
        <Row label="Tailscale URL">
          <input
            value={lib.tailscaleUrl}
            onChange={(e) => setLib('tailscaleUrl', e.target.value)}
            placeholder="http://immich.tailnet-xxxx.ts.net/api"
            style={inputRight}
          />
        </Row>
        <Divider />
        <Row label="API Key">
          <input
            type="password"
            value={lib.apiKey}
            onChange={(e) => setLib('apiKey', e.target.value)}
            placeholder="Paste an Immich API key"
            style={inputRight}
          />
        </Row>
      </div>

      <div style={activeBar}>
        <span style={activeTag}>ACTIVE</span>
        <span style={{ font: '500 12px ui-monospace,monospace', color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {active.url || '(not set)'}
        </span>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11.5, color: 'var(--text-dimmer)', whiteSpace: 'nowrap' }}>{active.via}</span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 11, margin: '18px 4px 0' }}>
        <div style={{ width: 8, height: 8, borderRadius: '50%', background: dotColor, flexShrink: 0 }} />
        <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>{status.text}</span>
        <div style={{ flex: 1 }} />
        <button onClick={onTest} disabled={testing} style={btnSecondary}>
          {testing ? 'Testing…' : 'Test Connection'}
        </button>
        <button onClick={onSave} disabled={saving} style={btnPrimary}>
          {saving ? 'Saving…' : 'Connect'}
        </button>
      </div>

      <div style={helpText}>
        Generate a key under Account Settings → API Keys in Immich. For a viewer/stacker
        client, the <code>asset.read</code> and <code>stack.*</code> scopes are sufficient.
      </div>

      <div style={{ fontSize: 14, fontWeight: 700, margin: '26px 4px 8px' }}>Originals on Disk</div>
      <div style={{ fontSize: 12.5, color: 'var(--text-dimmer)', margin: '0 4px 13px', lineHeight: 1.5 }}>
        RAW editors open files from the filesystem, not from Immich. Point ImmAture at the
        same NFS/SMB share Immich indexes so it can hand the editor a real path.
      </div>
      <div style={panel}>
        <Row label="Share type" wide>
          <Segmented
            value={lib.shareType}
            options={[
              { value: 'nfs', label: 'NFS' },
              { value: 'smb', label: 'SMB' },
            ]}
            onChange={(v) => setLib('shareType', v as LibraryConfig['shareType'])}
          />
        </Row>
        <Divider />
        <Row label="Local mount" wide>
          <input
            value={lib.localRoot}
            onChange={(e) => setLib('localRoot', e.target.value)}
            placeholder="/mnt/nfs/Rob/Images"
            style={inputRight}
          />
        </Row>
        <Divider />
        <Row label="Immich library path" wide>
          <input
            value={lib.immichRoot}
            onChange={(e) => setLib('immichRoot', e.target.value)}
            placeholder="/photos"
            style={inputRight}
          />
        </Row>
      </div>

      <div style={{ fontSize: 14, fontWeight: 700, margin: '26px 4px 8px' }}>Safety</div>
      <div style={{ fontSize: 12.5, color: 'var(--text-dimmer)', margin: '0 4px 13px', lineHeight: 1.5 }}>
        While testing against a real server, keep read-only mode on. Turning it off enables
        write operations (e.g. deletes), capped per app session.
      </div>
      <div style={panel}>
        <Row label="Read-only mode" wide>
          <Switch checked={lib.readOnly} onChange={(v) => setLib('readOnly', v)} />
        </Row>
        <Divider />
        <Row label="Max deletions / session" wide>
          <input
            type="number"
            min={0}
            value={lib.maxDeletePerSession}
            disabled={lib.readOnly}
            onChange={(e) => setLib('maxDeletePerSession', Math.max(0, Number(e.target.value) || 0))}
            style={{ ...inputRight, opacity: lib.readOnly ? 0.4 : 1, width: 90, flex: 'unset' }}
          />
        </Row>
      </div>
      <div style={helpText}>
        {lib.readOnly
          ? 'Read-only mode is on — all write operations (delete, stack, rating, edit) are refused by the app.'
          : `Deletes are enforced against a per-session cap of ${lib.maxDeletePerSession}, tracked in the app's Rust backend.`}
      </div>
    </div>
  );
}

function Row({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', padding: '11px 16px', gap: 14 }}>
      <span style={{ fontSize: 13.5, width: wide ? 150 : 120, flexShrink: 0, color: 'rgba(255,255,255,0.85)' }}>{label}</span>
      <div style={{ flex: 1, display: 'flex', justifyContent: 'flex-end' }}>{children}</div>
    </div>
  );
}

function Divider() {
  return <div style={{ height: 1, background: 'var(--border)', marginLeft: 16 }} />;
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      {options.map((o) => (
        <div
          key={o.value}
          onClick={() => onChange(o.value)}
          style={{
            padding: '5px 11px',
            borderRadius: 7,
            fontSize: 12.5,
            cursor: 'default',
            background: value === o.value ? 'var(--accent)' : 'rgba(255,255,255,0.06)',
            color: value === o.value ? '#fff' : 'rgba(255,255,255,0.7)',
          }}
        >
          {o.label}
        </div>
      ))}
    </div>
  );
}

function Switch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div
      onClick={() => onChange(!checked)}
      style={{
        width: 40,
        height: 22,
        borderRadius: 11,
        background: checked ? 'var(--accent)' : 'rgba(255,255,255,0.15)',
        cursor: 'default',
        position: 'relative',
        transition: 'background 0.15s',
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: 2,
          left: checked ? 20 : 2,
          width: 18,
          height: 18,
          borderRadius: '50%',
          background: '#fff',
          transition: 'left 0.15s',
        }}
      />
    </div>
  );
}

const panel: CSSProperties = {
  background: 'var(--panel)',
  borderRadius: 13,
  overflow: 'hidden',
  border: '1px solid var(--border)',
};

const inputRight: CSSProperties = {
  flex: 1,
  minWidth: 0,
  height: 32,
  padding: '0 10px',
  background: 'rgba(0,0,0,0.3)',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 7,
  color: '#fff',
  font: '500 12.5px ui-monospace,monospace',
  textAlign: 'left',
};

const activeBar: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  background: 'var(--panel-2)',
  border: '1px solid var(--border)',
  borderRadius: 11,
  padding: '10px 13px',
  marginTop: 11,
};

const activeTag: CSSProperties = {
  font: '600 10px ui-monospace,monospace',
  color: '#90bdf4',
  background: 'rgba(53,132,228,0.18)',
  padding: '2px 7px',
  borderRadius: 5,
  flexShrink: 0,
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

const btnPrimary: CSSProperties = {
  ...btnBase,
  background: 'var(--accent)',
  color: '#fff',
  fontWeight: 700,
  padding: '0 18px',
};

const helpText: CSSProperties = {
  fontSize: 12,
  color: 'var(--text-dimmer)',
  margin: '16px 4px 0',
  lineHeight: 1.5,
};
