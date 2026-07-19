import { useEffect, useState, type CSSProperties } from 'react';
import { getConfig, type AppConfig, type SharingConfig } from '../lib/api';
import FlickrSetupDialog from '../components/FlickrSetupDialog';

const emptySharing: SharingConfig = {
  flickr: { apiKey: '', apiSecret: '', oauthToken: '', oauthTokenSecret: '', username: '', userNsid: '', connected: false },
  mastodonEnabled: false,
  pixelfedEnabled: false,
  loopsEnabled: false,
};

// Preferences → Sharing ("Share Targets"), ported from the design
// prototype's card grid (Immich Desktop.dc.html). Flickr is the one real,
// working connection (see FlickrSetupDialog.tsx / flickr.rs); Mastodon/
// PixelFed/Loops are visible "coming soon" cards for visual parity with the
// prototype, with no real upload logic behind them yet.
export default function PreferencesSharing() {
  const [sharing, setSharing] = useState<SharingConfig>(emptySharing);
  const [loading, setLoading] = useState(true);
  const [flickrDialogOpen, setFlickrDialogOpen] = useState(false);

  useEffect(() => {
    getConfig()
      .then((cfg) => setSharing(cfg.sharing))
      .finally(() => setLoading(false));
  }, []);

  function applyConfig(cfg: AppConfig) {
    setSharing(cfg.sharing);
  }

  if (loading) return <div style={{ padding: 24 }}>Loading…</div>;

  return (
    <div style={{ maxWidth: 560, margin: '0 auto', padding: '24px 0' }}>
      <div style={{ fontSize: 14, fontWeight: 700, margin: '0 4px 8px' }}>Share Targets</div>
      <div style={{ fontSize: 12.5, color: 'var(--text-dimmer)', margin: '0 4px 16px', lineHeight: 1.5 }}>
        Enable the services you publish to and connect your account. Enabled targets appear in the right-click <b>Share</b> menu and are processed through the
        export queue.
      </div>

      <ServiceCard
        color="#0063dc"
        letter="F"
        name="Flickr"
        blurb="Photo hosting & sharing"
        statusOk={sharing.flickr.connected}
        statusText={
          sharing.flickr.connected ? `API connected · upload ready${sharing.flickr.username ? ` · ${sharing.flickr.username}` : ''}` : 'API not connected — set up access to upload'
        }
        actionLabel={sharing.flickr.connected ? 'Manage…' : 'Set up API access'}
        onAction={() => setFlickrDialogOpen(true)}
      />
      <div style={{ height: 10 }} />
      <ComingSoonCard color="#6364ff" letter="M" name="Mastodon" blurb="Federated social posts" />
      <div style={{ height: 10 }} />
      <ComingSoonCard color="#10c18b" letter="P" name="PixelFed" blurb="Federated photo sharing" />
      <div style={{ height: 10 }} />
      <ComingSoonCard color="#ff4f38" letter="L" name="Loops" blurb="Short video loops" />

      {flickrDialogOpen && <FlickrSetupDialog flickr={sharing.flickr} onClose={() => setFlickrDialogOpen(false)} onConnected={applyConfig} />}
    </div>
  );
}

function Avatar({ color, letter }: { color: string; letter: string }) {
  return (
    <div
      style={{
        width: 38,
        height: 38,
        borderRadius: 10,
        flexShrink: 0,
        background: color,
        color: '#fff',
        fontSize: 15,
        fontWeight: 700,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {letter}
    </div>
  );
}

function ServiceCard({
  color,
  letter,
  name,
  blurb,
  statusOk,
  statusText,
  actionLabel,
  onAction,
}: {
  color: string;
  letter: string;
  name: string;
  blurb: string;
  statusOk: boolean;
  statusText: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div style={panel}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 13, padding: '13px 16px' }}>
        <Avatar color={color} letter={letter} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: '#fff' }}>{name}</div>
          <div style={{ fontSize: 11.5, color: 'var(--text-dimmer)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{blurb}</div>
        </div>
      </div>
      <div style={{ height: 1, background: 'var(--border)', marginLeft: 16 }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px' }}>
        <div style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: statusOk ? 'var(--ok)' : 'var(--warn)' }} />
        <span style={{ fontSize: 12, color: 'var(--text-dim)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{statusText}</span>
        <button onClick={onAction} style={btnSecondary}>
          {actionLabel}
        </button>
      </div>
    </div>
  );
}

function ComingSoonCard({ color, letter, name, blurb }: { color: string; letter: string; name: string; blurb: string }) {
  return (
    <div style={{ ...panel, opacity: 0.55 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 13, padding: '13px 16px' }}>
        <Avatar color={color} letter={letter} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: '#fff' }}>{name}</div>
          <div style={{ fontSize: 11.5, color: 'var(--text-dimmer)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{blurb}</div>
        </div>
        <span
          style={{
            fontSize: 10.5,
            fontWeight: 700,
            letterSpacing: '.03em',
            color: 'var(--text-dimmer)',
            background: 'rgba(255,255,255,0.06)',
            padding: '4px 9px',
            borderRadius: 6,
            flexShrink: 0,
          }}
        >
          COMING SOON
        </span>
      </div>
    </div>
  );
}

const panel: CSSProperties = {
  background: 'var(--panel)',
  borderRadius: 13,
  overflow: 'hidden',
  border: '1px solid var(--border)',
};

const btnBase: CSSProperties = { height: 30, padding: '0 12px', borderRadius: 8, fontSize: 12, cursor: 'default', border: 'none', flexShrink: 0 };

const btnSecondary: CSSProperties = { ...btnBase, border: '1px solid var(--border-strong)', background: 'rgba(255,255,255,0.06)', color: '#fff' };
