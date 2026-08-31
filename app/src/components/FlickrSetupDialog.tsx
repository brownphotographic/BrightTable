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

import { useState, type CSSProperties } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { flickrBeginAuth, flickrCompleteAuth, flickrDisconnect, type AppConfig, type FlickrConfig } from '../lib/api';
import { btnPrimary, btnSecondary, closeBtnStyle } from './ExportToFolderDialog';

type Step = 0 | 1 | 2 | 3;

const STEP_LABELS = ['API keys', 'Authorize', 'Verify'];

// "Connect Flickr" wizard, ported from the design prototype's 4-step Flickr
// setup flow (Immich Desktop.dc.html) onto the real OAuth 1.0a handshake in
// flickr.rs: user-supplied app API key/secret -> request token -> browser
// authorize -> paste-back verifier code -> access token, persisted via
// flickr_complete_auth. Opens straight to the "Done"/manage view if Flickr
// is already connected.
export default function FlickrSetupDialog({ flickr, onClose, onConnected }: { flickr: FlickrConfig; onClose: () => void; onConnected: (cfg: AppConfig) => void }) {
  const [step, setStep] = useState<Step>(flickr.connected ? 3 : 0);
  const [apiKey, setApiKey] = useState(flickr.apiKey);
  const [apiSecret, setApiSecret] = useState(flickr.apiSecret);
  const [oauthToken, setOauthToken] = useState('');
  const [oauthTokenSecret, setOauthTokenSecret] = useState('');
  const [authorizeUrl, setAuthorizeUrl] = useState('');
  const [authorized, setAuthorized] = useState(false);
  const [verifier, setVerifier] = useState('');
  const [username, setUsername] = useState(flickr.username);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleContinueFromKeys() {
    if (!apiKey.trim() || !apiSecret.trim()) {
      setError('Enter your API key and shared secret');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await flickrBeginAuth(apiKey.trim(), apiSecret.trim());
      setAuthorizeUrl(res.authorizeUrl);
      setOauthToken(res.oauthToken);
      setOauthTokenSecret(res.oauthTokenSecret);
      setAuthorized(false);
      setStep(1);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleOpenAuth() {
    setAuthorized(true);
    try {
      await openUrl(authorizeUrl);
    } catch {
      // Best-effort - the URL is still shown/usable via the button itself.
    }
  }

  async function handleConnect() {
    if (verifier.trim().length < 6) {
      setError('Enter the verification code Flickr showed you');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const cfg = await flickrCompleteAuth(apiKey.trim(), apiSecret.trim(), oauthToken, oauthTokenSecret, verifier.trim());
      setUsername(cfg.sharing.flickr.username);
      onConnected(cfg);
      setStep(3);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleDisconnect() {
    setBusy(true);
    setError(null);
    try {
      const cfg = await flickrDisconnect();
      onConnected(cfg);
      setApiKey('');
      setApiSecret('');
      setVerifier('');
      setAuthorized(false);
      setStep(0);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="window-frame window-frame-overlay"
      style={{
        zIndex: 320,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onClick={busy ? undefined : onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 440,
          maxWidth: '92%',
          background: 'var(--dialog-bg)',
          borderRadius: 14,
          boxShadow: '0 24px 70px rgba(0,0,0,0.7)',
          border: '1px solid var(--border)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            height: 50,
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '0 10px 0 18px',
            background: 'var(--panel)',
            borderBottom: '1px solid rgba(0,0,0,0.4)',
          }}
        >
          <span style={{ fontSize: 14, fontWeight: 700 }}>Connect Flickr</span>
          <div style={{ flex: 1 }} />
          <div onClick={busy ? undefined : onClose} style={closeBtnStyle}>
            ✕
          </div>
        </div>

        {step < 3 && (
          <div style={{ display: 'flex', alignItems: 'center', padding: '16px 22px 0', gap: 6 }}>
            {STEP_LABELS.map((label, i) => (
              <div key={label} style={{ display: 'flex', alignItems: 'center', flex: i < STEP_LABELS.length - 1 ? 1 : undefined, gap: 6 }}>
                <div
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: '50%',
                    flexShrink: 0,
                    fontSize: 10.5,
                    fontWeight: 700,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: i <= step ? '#fff' : 'var(--text-dimmer)',
                    background: i <= step ? '#3584e4' : 'var(--overlay-medium)',
                  }}
                >
                  {i < step ? '✓' : i + 1}
                </div>
                <span style={{ fontSize: 10.5, color: i <= step ? 'var(--text-dim)' : 'var(--text-dimmer)', flexShrink: 0 }}>{label}</span>
                {i < STEP_LABELS.length - 1 && <div style={{ flex: 1, height: 1, background: i < step ? '#3584e4' : 'var(--overlay-medium)' }} />}
              </div>
            ))}
          </div>
        )}

        <div style={{ padding: '18px 22px', minHeight: 180 }}>
          {step === 0 && (
            <>
              <p style={helperStyle}>
                Create an app on Flickr to get your own API credentials. Open flickr.com/services/apps/create, choose a non-commercial key, then paste the two values
                below.
              </p>
              <FieldLabel>API Key</FieldLabel>
              <TextInput value={apiKey} onChange={setApiKey} placeholder="e.g. a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6" />
              <div style={{ height: 12 }} />
              <FieldLabel>Shared Secret</FieldLabel>
              <TextInput value={apiSecret} onChange={setApiSecret} placeholder="e.g. 0123456789abcdef" />
            </>
          )}

          {step === 1 && (
            <>
              <p style={helperStyle}>
                Authorize BrightTable to access your Flickr account. This opens Flickr in your browser; after you approve, Flickr shows a short verification code to
                paste on the next step.
              </p>
              <div style={{ background: 'var(--overlay-weak)', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 14px', marginBottom: 16 }}>
                <div style={{ fontSize: 10.5, letterSpacing: '.05em', color: 'var(--text-dimmer)', marginBottom: 6 }}>PERMISSIONS REQUESTED</div>
                <div style={{ fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.7 }}>
                  Read your photos &amp; sets
                  <br />
                  Upload &amp; replace photos (write)
                </div>
              </div>
              <button onClick={handleOpenAuth} style={{ ...btnPrimary(true), width: '100%' }}>
                {authorized ? 'Re-open authorization page' : 'Open authorization page'}
              </button>
              {authorized && <div style={{ fontSize: 12, color: '#8ce0ae', marginTop: 10 }}>Browser opened — approve access, then continue.</div>}
            </>
          )}

          {step === 2 && (
            <>
              <p style={helperStyle}>Paste the verification code Flickr showed you after you approved access.</p>
              <input
                value={verifier}
                onChange={(e) => setVerifier(e.target.value)}
                placeholder="xxx-xxx-xxx"
                style={{
                  width: '100%',
                  height: 46,
                  textAlign: 'center',
                  letterSpacing: '.15em',
                  font: '600 16px ui-monospace,monospace',
                  background: 'var(--surface-sunken)',
                  border: '1px solid var(--border)',
                  borderRadius: 9,
                  color: 'var(--text)',
                }}
              />
            </>
          )}

          {step === 3 && (
            <div style={{ textAlign: 'center', padding: '20px 10px' }}>
              <div
                style={{
                  width: 48,
                  height: 48,
                  margin: '0 auto 14px',
                  borderRadius: '50%',
                  background: 'rgba(46,194,126,0.18)',
                  color: '#8ce0ae',
                  fontSize: 22,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                ✓
              </div>
              <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>Flickr connected</div>
              <div style={{ fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.6 }}>
                BrightTable can now upload to {username || 'your Flickr account'}. Choose <b>Share to Flickr…</b> from the right-click menu to publish photos.
              </div>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '13px 18px', borderTop: '1px solid rgba(0,0,0,0.4)', flexShrink: 0 }}>
          {step === 3 ? (
            <span onClick={busy ? undefined : handleDisconnect} style={{ fontSize: 12, color: '#ff8080', cursor: 'default' }}>
              Disconnect
            </span>
          ) : (
            error && <span style={{ fontSize: 12, color: '#ff8080' }}>{error}</span>
          )}
          <div style={{ flex: 1 }} />
          {step > 0 && step < 3 && (
            <button onClick={() => setStep((step - 1) as Step)} disabled={busy} style={btnSecondary}>
              Back
            </button>
          )}
          {step === 0 && (
            <button onClick={handleContinueFromKeys} disabled={busy} style={btnPrimary(!busy)}>
              {busy ? 'Continuing…' : 'Continue'}
            </button>
          )}
          {step === 1 && (
            <button onClick={() => setStep(2)} disabled={!authorized} style={btnPrimary(authorized)}>
              Continue
            </button>
          )}
          {step === 2 && (
            <button onClick={handleConnect} disabled={busy} style={btnPrimary(!busy)}>
              {busy ? 'Connecting…' : 'Connect'}
            </button>
          )}
          {step === 3 && (
            <button onClick={onClose} style={btnPrimary(true)}>
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function FieldLabel({ children }: { children: string }) {
  return <div style={{ fontSize: 11.5, color: 'var(--text-dim)', marginBottom: 5 }}>{children}</div>;
}

function TextInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      style={{
        width: '100%',
        height: 34,
        padding: '0 12px',
        background: 'var(--surface-sunken)',
        border: '1px solid var(--border)',
        borderRadius: 9,
        color: 'var(--text)',
        font: '500 12.5px ui-monospace,monospace',
      }}
    />
  );
}

const helperStyle: CSSProperties = { fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.6, marginBottom: 16 };
