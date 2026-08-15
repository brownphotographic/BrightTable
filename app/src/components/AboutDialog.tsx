import { useEffect, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { openUrl } from '@tauri-apps/plugin-opener';
import appIcon from '../assets/app-icon.png';

const REPO_URL = 'https://github.com/brownphotographic/BrightTable';
// Kept in sync by hand with COMPATIBILITY.md's row for the current app
// version (and MIN_TESTED_SERVER_VERSION in immich/models.rs for the floor)
// - there's no runtime channel to read either from the frontend.
const TESTED_SERVER_VERSIONS = '3.1.0 (floor and confirmed)';

export default function AboutDialog({ onClose }: { onClose: () => void }) {
  const [appVersion, setAppVersion] = useState<string | null>(null);

  useEffect(() => {
    getVersion().then(setAppVersion);
  }, []);

  const compatText = `Tested against Immich ${TESTED_SERVER_VERSIONS}`;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
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
