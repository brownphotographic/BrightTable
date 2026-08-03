import { useEffect, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { openUrl } from '@tauri-apps/plugin-opener';

const REPO_URL = 'https://github.com/brownphotographic/ImmAture';
// Kept in sync by hand with COMPATIBILITY.md's row for the current app
// version (and MIN_TESTED_SERVER_VERSION in immich/models.rs for the floor)
// - there's no runtime channel to read either from the frontend.
const TESTED_SERVER_VERSIONS = '2.7.5 (floor) – 3.0.1 (confirmed)';

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
          background: '#242424',
          borderRadius: 14,
          boxShadow: '0 24px 70px rgba(0,0,0,0.65)',
          border: '1px solid rgba(255,255,255,0.08)',
          padding: 24,
          color: '#fff',
          textAlign: 'center',
        }}
      >
        <div style={{ fontSize: 17, fontWeight: 700 }}>ImmAture</div>
        <div style={{ marginTop: 4, fontSize: 12.5, color: 'rgba(255,255,255,0.55)' }}>
          {appVersion ? `Version ${appVersion}` : 'Version —'}
        </div>

        <div style={{ height: 1, background: 'rgba(255,255,255,0.1)', margin: '18px 0' }} />

        <div style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.75)', lineHeight: 1.5 }}>{compatText}</div>

        <div
          onClick={() => openUrl(REPO_URL)}
          style={{ marginTop: 10, fontSize: 12.5, color: 'var(--accent)', cursor: 'default' }}
        >
          {REPO_URL.replace('https://', '')}
        </div>

        <div style={{ height: 1, background: 'rgba(255,255,255,0.1)', margin: '18px 0' }} />

        <div style={{ fontSize: 11.5, color: 'rgba(255,255,255,0.45)' }}>Copyright © 2026 Rob Brown · MIT License</div>

        <button
          onClick={onClose}
          style={{
            marginTop: 20,
            height: 34,
            width: '100%',
            borderRadius: 9,
            border: '1px solid rgba(255,255,255,0.16)',
            background: 'rgba(255,255,255,0.06)',
            color: '#fff',
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
