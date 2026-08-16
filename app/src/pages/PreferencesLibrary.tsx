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

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import {
  getConfig,
  saveLibraryConfig,
  testConnection,
  type LibraryConfig,
} from '../lib/api';
import { useLibraryStatus } from '../lib/libraryStatus';
import Switch from '../components/Switch';

const emptyLib: LibraryConfig = {
  connMode: 'lan',
  lanUrl: '',
  tailscaleUrl: '',
  apiKey: '',
  shareType: 'nfs',
  localRoot: '',
  immichRoot: '',
  uploadedLocalRoot: '',
  uploadedImmichRoot: '',
  readOnly: true,
  maxWritesPerBatch: 25,
  maxConcurrentMetadataScans: 4,
};

type Status = { kind: 'idle' | 'ok' | 'error'; text: string };

// Auto mode actually probes LAN reachability on the Rust side (see
// `immich::resolve_connection`) rather than statically preferring Tailscale
// whenever a URL is configured for it - this preview can't run that probe
// (it's just a label before Test Connection/Connect does real work), so when
// both are configured it shows the LAN-first policy instead of guessing.
function effUrl(lib: LibraryConfig): { url: string; via: string } {
  if (lib.connMode === 'tailscale') return { url: lib.tailscaleUrl, via: 'via Tailscale' };
  if (lib.connMode === 'auto') {
    if (lib.lanUrl && lib.tailscaleUrl) return { url: lib.lanUrl, via: 'Auto (LAN if reachable, else Tailscale)' };
    return lib.tailscaleUrl ? { url: lib.tailscaleUrl, via: 'Auto → Tailscale' } : { url: lib.lanUrl, via: 'Auto → LAN' };
  }
  return { url: lib.lanUrl, via: 'via LAN' };
}

export default function PreferencesLibrary() {
  const [lib, setLibState] = useState<LibraryConfig>(emptyLib);
  const [status, setStatus] = useState<Status>({ kind: 'idle', text: 'Not connected' });
  const [versionWarning, setVersionWarning] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [diskSaving, setDiskSaving] = useState(false);
  const [diskStatus, setDiskStatus] = useState<Status>({ kind: 'idle', text: '' });
  const [safetySaving, setSafetySaving] = useState(false);
  const [safetyError, setSafetyError] = useState<string | null>(null);
  const { refresh: refreshSharedStatus } = useLibraryStatus();

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
      // Below the lowest version this app's actually been verified against
      // (see MIN_TESTED_SERVER_VERSION in the Rust client) - not a hard
      // block, just a heads-up that something might behave oddly.
      setVersionWarning(
        res.serverVersionSupported
          ? null
          : `Immich ${res.serverVersion} is older than the lowest version BrightTable has been tested against (2.7.5) — some features may not work correctly.`,
      );
      refreshSharedStatus();
    } catch (e) {
      setStatus({ kind: 'error', text: String(e) });
      setVersionWarning(null);
    } finally {
      setTesting(false);
    }
  }

  async function onSave() {
    setSaving(true);
    try {
      await saveLibraryConfig(lib);
      setStatus({ kind: 'ok', text: 'Saved' });
      refreshSharedStatus();
    } catch (e) {
      setStatus({ kind: 'error', text: String(e) });
    } finally {
      setSaving(false);
    }
  }

  // The "Originals on Disk" panels (Share type / External Library / Immich
  // Uploads) have no save path of their own otherwise - without this,
  // editing them only ever updates local React state via setLib(), and the
  // only way to actually persist it was the unrelated-looking "Connect"
  // button up in the Server section, which is exactly what caused settings
  // typed here to silently never reach config.json in practice.
  async function onSaveDiskPaths() {
    setDiskSaving(true);
    setDiskStatus({ kind: 'idle', text: '' });
    try {
      await saveLibraryConfig(lib);
      setDiskStatus({ kind: 'ok', text: 'Saved' });
      refreshSharedStatus();
    } catch (e) {
      setDiskStatus({ kind: 'error', text: String(e) });
    } finally {
      setDiskSaving(false);
    }
  }

  // The Safety controls save themselves immediately rather than waiting for
  // the "Connect" button up in the Server section - a safety toggle that
  // silently does nothing until an unrelated button is clicked is exactly
  // the kind of thing that gets missed.
  async function persistSafety(overrides?: Partial<LibraryConfig>) {
    const next = overrides ? { ...lib, ...overrides } : lib;
    if (overrides) setLibState(next);
    setSafetySaving(true);
    setSafetyError(null);
    try {
      await saveLibraryConfig(next);
      refreshSharedStatus();
    } catch (e) {
      setSafetyError(String(e));
    } finally {
      setSafetySaving(false);
    }
  }

  if (loading) return <div style={{ padding: 24 }}>Loading…</div>;

  const active = effUrl(lib);
  const dotColor = status.kind === 'ok' ? 'var(--ok)' : status.kind === 'error' ? 'var(--danger)' : 'var(--text-dimmer)';

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
        <span style={{ font: '500 12px ui-monospace,monospace', color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
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

      {versionWarning && (
        <div style={{ ...helpText, color: 'var(--warn)', margin: '10px 4px 0' }}>{versionWarning}</div>
      )}

      <div style={helpText}>
        Generate a key under Account Settings → API Keys in Immich. For a viewer/stacker
        client, the <code>asset.read</code> and <code>stack.*</code> scopes are sufficient.
      </div>

      <div style={{ fontSize: 14, fontWeight: 700, margin: '26px 4px 8px' }}>Originals on Disk</div>
      <div style={{ fontSize: 12.5, color: 'var(--text-dimmer)', margin: '0 4px 13px', lineHeight: 1.5 }}>
        RAW editors open files from the filesystem, not from Immich. Point BrightTable at the
        same shares Immich indexes so it can hand the editor a real path. Immich reports a
        different path prefix depending on how an asset got in — an External Library asset
        keeps its real folder path, while one uploaded directly (phone app or browser) lives
        under Immich's own internal storage instead — so each needs its own mapping below.
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
      </div>

      <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-dim)', margin: '16px 4px 8px' }}>
        External Library
      </div>
      <div style={panel}>
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

      <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-dim)', margin: '16px 4px 8px' }}>
        Immich Uploads
      </div>
      <div style={panel}>
        <Row label="Local mount" wide>
          <input
            value={lib.uploadedLocalRoot}
            onChange={(e) => setLib('uploadedLocalRoot', e.target.value)}
            placeholder="/mnt/nfs/Rob/Immich_Uploaded/library/admin"
            style={inputRight}
          />
        </Row>
        <Divider />
        <Row label="Immich upload path" wide>
          <input
            value={lib.uploadedImmichRoot}
            onChange={(e) => setLib('uploadedImmichRoot', e.target.value)}
            placeholder="/photos/library/admin"
            style={inputRight}
          />
        </Row>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 11, margin: '10px 4px 0' }}>
        {diskStatus.text && (
          <span style={{ fontSize: 12.5, color: diskStatus.kind === 'error' ? 'var(--danger)' : 'var(--ok)' }}>
            {diskStatus.text}
          </span>
        )}
        <div style={{ flex: 1 }} />
        <button onClick={onSaveDiskPaths} disabled={diskSaving} style={btnPrimary}>
          {diskSaving ? 'Saving…' : 'Save'}
        </button>
      </div>

      <div style={{ fontSize: 14, fontWeight: 700, margin: '26px 4px 8px' }}>Safety</div>
      <div style={{ fontSize: 12.5, color: 'var(--text-dimmer)', margin: '0 4px 13px', lineHeight: 1.5 }}>
        While testing against a real server, keep read-only mode on. Turning it off enables
        write operations (delete, rating, favorite, description edits), capped per action.
      </div>
      <div style={panel}>
        <Row label="Read-only mode" wide>
          <Switch checked={lib.readOnly} onChange={(v) => persistSafety({ readOnly: v })} />
        </Row>
        <Divider />
        <Row label="Max assets / edit" wide>
          <input
            type="number"
            min={0}
            value={lib.maxWritesPerBatch}
            disabled={lib.readOnly}
            onChange={(e) => setLib('maxWritesPerBatch', Math.max(0, Number(e.target.value) || 0))}
            onBlur={() => persistSafety()}
            style={{ ...inputRight, opacity: lib.readOnly ? 0.4 : 1, width: 90, flex: 'unset' }}
          />
        </Row>
      </div>
      <div style={{ ...helpText, color: safetyError ? 'var(--danger)' : helpText.color }}>
        {safetySaving
          ? 'Saving…'
          : safetyError
            ? `Couldn't save: ${safetyError}`
            : lib.readOnly
              ? 'Read-only mode is on — all write operations (delete, rating, favorite, description edits) are refused by the app.'
              : `A single delete or edit action can affect at most ${lib.maxWritesPerBatch} assets - e.g. selecting 30 photos and rating them all at once is refused if this is 25.`}
      </div>

      <div style={{ fontSize: 14, fontWeight: 700, margin: '26px 4px 8px' }}>Performance</div>
      <div style={{ fontSize: 12.5, color: 'var(--text-dimmer)', margin: '0 4px 13px', lineHeight: 1.5 }}>
        Scrolling through the grid checks each visible photo's sidecar/embedded metadata against
        your local library mount. Too many of these at once can saturate a slow NFS/SMB share and
        slow everything else down (including unrelated apps using the same share) - cap it lower
        for a slow or remote mount, higher for a fast local one.
      </div>
      <div style={panel}>
        <Row label="Concurrent metadata scans" wide>
          <input
            type="number"
            min={1}
            max={16}
            value={lib.maxConcurrentMetadataScans}
            onChange={(e) => setLib('maxConcurrentMetadataScans', Math.min(16, Math.max(1, Number(e.target.value) || 1)))}
            onBlur={() => persistSafety()}
            style={{ ...inputRight, width: 90, flex: 'unset' }}
          />
        </Row>
      </div>
      <div style={helpText}>Takes effect after restarting the app.</div>
    </div>
  );
}

function Row({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', padding: '11px 16px', gap: 14 }}>
      <span style={{ fontSize: 13.5, width: wide ? 150 : 120, flexShrink: 0, color: 'var(--text-dim)' }}>{label}</span>
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
            background: value === o.value ? 'var(--accent)' : 'var(--overlay-weak)',
            color: value === o.value ? '#fff' : 'var(--text-dim)',
          }}
        >
          {o.label}
        </div>
      ))}
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
  background: 'var(--surface-sunken)',
  border: '1px solid var(--border-strong)',
  borderRadius: 7,
  color: 'var(--text)',
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
  color: 'var(--accent-text)',
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
  background: 'var(--overlay-weak)',
  color: 'var(--text)',
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
