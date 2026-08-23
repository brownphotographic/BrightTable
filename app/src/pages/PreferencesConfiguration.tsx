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
import { open } from '@tauri-apps/plugin-dialog';
import { clearThumbCache, getConfig, getThumbCacheInfo, saveSettingsFolder, saveShareVault, type ThumbCacheStats } from '../lib/api';
import ConfirmDialog from '../components/ConfirmDialog';
import { useWindowControls } from '../lib/windowControls';
import { useTheme } from '../lib/theme';

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
  const { position, setPosition } = useWindowControls();
  const { themeMode, setThemeMode } = useTheme();
  const [settingsFolder, setSettingsFolder] = useState<string | null>(null);
  const [folderLoading, setFolderLoading] = useState(true);
  const [folderSaving, setFolderSaving] = useState(false);
  const [folderError, setFolderError] = useState<string | null>(null);
  const [shareVault, setShareVault] = useState(false);
  const [vaultSaving, setVaultSaving] = useState(false);

  useEffect(() => {
    getThumbCacheInfo()
      .then(setStats)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    getConfig()
      .then((cfg) => {
        setSettingsFolder(cfg.settingsFolder);
        setShareVault(cfg.shareVault);
      })
      .catch((e) => setFolderError(String(e)))
      .finally(() => setFolderLoading(false));
  }, []);

  async function onClear() {
    setStats(await clearThumbCache());
  }

  async function onChooseSettingsFolder() {
    const picked = await open({ directory: true, title: 'Choose a folder for config.json' });
    if (!picked || Array.isArray(picked)) return;
    setFolderSaving(true);
    setFolderError(null);
    try {
      const cfg = await saveSettingsFolder(picked);
      setSettingsFolder(cfg.settingsFolder);
    } catch (e) {
      setFolderError(String(e));
    } finally {
      setFolderSaving(false);
    }
  }

  async function onUseDefaultSettingsFolder() {
    setFolderSaving(true);
    setFolderError(null);
    try {
      const cfg = await saveSettingsFolder(null);
      setSettingsFolder(cfg.settingsFolder);
    } catch (e) {
      setFolderError(String(e));
    } finally {
      setFolderSaving(false);
    }
  }

  async function onToggleShareVault(next: boolean) {
    setVaultSaving(true);
    setFolderError(null);
    try {
      const cfg = await saveShareVault(next);
      setShareVault(cfg.shareVault);
    } catch (e) {
      setFolderError(String(e));
    } finally {
      setVaultSaving(false);
    }
  }

  return (
    <div style={{ maxWidth: 560, margin: '0 auto', padding: '24px 0' }}>
      <div style={{ fontSize: 14, fontWeight: 700, margin: '0 4px 12px' }}>Appearance</div>
      <div style={panel}>
        <Row label="Theme">
          <Segmented
            value={themeMode}
            options={[
              { value: 'dark', label: 'Dark' },
              { value: 'light', label: 'Light' },
            ]}
            onChange={setThemeMode}
          />
        </Row>
      </div>

      <div style={{ fontSize: 14, fontWeight: 700, margin: '26px 4px 12px' }}>Window</div>
      <div style={panel}>
        <Row label="Window buttons">
          <Segmented
            value={position}
            options={[
              { value: 'left', label: 'Left' },
              { value: 'right', label: 'Right' },
            ]}
            onChange={setPosition}
          />
        </Row>
      </div>
      <div style={helpText}>
        Which side of the title bar the minimize/maximize/close buttons appear on.
      </div>

      <div style={{ fontSize: 14, fontWeight: 700, margin: '26px 4px 12px' }}>Config File Location</div>
      <div style={panel}>
        <Row label="Location">
          <span style={pathText}>
            {folderLoading ? 'Loading…' : settingsFolder || 'Default'}
          </span>
        </Row>
      </div>
      <div style={helpText}>
        Where config.json is stored. Point every install (dev, AppImage, Flatpak) at the same
        folder to share one set of settings between them. Immich/Flickr sign-in stays separate
        per install either way, since it's kept in an encrypted vault, not this file — unless
        you opt in below.
      </div>
      {folderError && <div style={{ ...helpText, color: 'var(--danger)' }}>{folderError}</div>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 11, margin: '10px 4px 0' }}>
        <div style={{ flex: 1 }} />
        {settingsFolder && (
          <button onClick={onUseDefaultSettingsFolder} disabled={folderSaving || folderLoading} style={btnSecondary}>
            Use Default
          </button>
        )}
        <button onClick={onChooseSettingsFolder} disabled={folderSaving || folderLoading} style={btnSecondary}>
          Choose Folder…
        </button>
      </div>

      {settingsFolder && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', margin: '14px 4px 0', gap: 10 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'default' }}>
              <input
                type="checkbox"
                checked={shareVault}
                disabled={vaultSaving || folderLoading}
                onChange={(e) => onToggleShareVault(e.target.checked)}
              />
              Also share Immich/Flickr sign-in in this folder
            </label>
          </div>
          <div style={helpText}>
            Moves the encrypted login vault into the same folder so every install shares one
            sign-in too, instead of each needing its own. Takes effect the next time each
            install is restarted, and only ever adopts a vault already sitting there rather than
            overwriting it. Only turn this on for a folder that stays on this machine — the
            vault's decryption key travels with it, so a synced or cloud-backed folder would
            expose your Immich/Flickr credentials anywhere that folder ends up.
          </div>
        </>
      )}

      <div style={{ fontSize: 14, fontWeight: 700, margin: '26px 4px 12px' }}>Thumbnail Cache</div>
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
      <span style={{ fontSize: 13.5, width: 90, flexShrink: 0, color: 'var(--text-dim)' }}>{label}</span>
      <div style={{ flex: 1, display: 'flex', justifyContent: 'flex-end', overflow: 'hidden' }}>{children}</div>
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

const pathText: CSSProperties = {
  fontSize: 12,
  font: '500 12px ui-monospace,monospace',
  color: 'var(--text-dim)',
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
  background: 'var(--overlay-weak)',
  color: 'var(--text)',
};
