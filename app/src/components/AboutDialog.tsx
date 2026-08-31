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

import { useEffect, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { openUrl } from '@tauri-apps/plugin-opener';
import appIcon from '../assets/app-icon.png';

const REPO_URL = 'https://github.com/brownphotographic/BrightTable';
// Kept in sync by hand with COMPATIBILITY.md's row for the current app
// version (and MIN_TESTED_SERVER_VERSION in immich/models.rs for the floor)
// - there's no runtime channel to read either from the frontend.
const TESTED_SERVER_VERSIONS = '3.1.0 (floor and confirmed)';

// Cargo.toml (and therefore getVersion()) must carry a full semver x.y.z,
// but a trailing ".0" patch reads as noise in the UI - "1.1" not "1.1.0".
function formatDisplayVersion(version: string): string {
  const parts = version.split('.');
  return parts.length === 3 && parts[2] === '0' ? `${parts[0]}.${parts[1]}` : version;
}

export default function AboutDialog({ onClose }: { onClose: () => void }) {
  const [appVersion, setAppVersion] = useState<string | null>(null);

  useEffect(() => {
    getVersion().then((v) => setAppVersion(formatDisplayVersion(v)));
  }, []);

  const compatText = `Tested against Immich ${TESTED_SERVER_VERSIONS}`;

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
          width: 380,
          maxWidth: '90%',
          background: 'var(--dialog-bg)',
          borderRadius: 14,
          boxShadow: '0 24px 70px rgba(0,0,0,0.65)',
          border: '1px solid var(--border)',
          padding: 24,
          color: 'var(--text)',
          textAlign: 'center',
        }}
      >
        <img src={appIcon} alt="" style={{ width: 56, height: 56, borderRadius: 14 }} />
        <div style={{ marginTop: 10, fontSize: 17, fontWeight: 700 }}>BrightTable</div>
        <div style={{ marginTop: 4, fontSize: 12.5, color: 'var(--text-dim)' }}>
          {appVersion ? `Version ${appVersion}` : 'Version —'}
        </div>

        <div style={{ height: 1, background: 'var(--overlay-medium)', margin: '18px 0' }} />

        <div style={{ fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.5 }}>{compatText}</div>

        <div
          onClick={() => openUrl(REPO_URL)}
          style={{ marginTop: 10, fontSize: 12.5, color: 'var(--accent)', cursor: 'default' }}
        >
          {REPO_URL.replace('https://', '')}
        </div>

        <div style={{ height: 1, background: 'var(--overlay-medium)', margin: '18px 0' }} />

        <div style={{ fontSize: 11.5, color: 'var(--text-dimmer)' }}>Copyright © 2026 Rob Brown · GPL-3.0 License</div>

        <button
          onClick={onClose}
          style={{
            marginTop: 20,
            height: 34,
            width: '100%',
            borderRadius: 9,
            border: '1px solid var(--border-strong)',
            background: 'var(--overlay-weak)',
            color: 'var(--text)',
            fontSize: 13,
            cursor: 'default',
          }}
        >
          Close
        </button>
      </div>
    </div>
  );
}
