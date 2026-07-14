import { useState } from 'react';
import PreferencesLibrary from '../pages/PreferencesLibrary';
import PreferencesShortcuts from '../pages/PreferencesShortcuts';
import PreferencesApplications from '../pages/PreferencesApplications';

type PrefsTab = 'library' | 'applications' | 'sharing' | 'configuration' | 'shortcuts';

const tabs: { id: PrefsTab; label: string }[] = [
  { id: 'library', label: 'Library' },
  { id: 'applications', label: 'Applications' },
  { id: 'sharing', label: 'Sharing' },
  { id: 'configuration', label: 'Configuration' },
  { id: 'shortcuts', label: 'Shortcuts' },
];

export default function PreferencesOverlay({
  onClose,
  initialTab = 'library',
}: {
  onClose: () => void;
  initialTab?: PrefsTab;
}) {
  const [tab, setTab] = useState<PrefsTab>(initialTab);

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 90,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 760,
          maxWidth: '94%',
          height: 582,
          maxHeight: '92%',
          background: '#242424',
          borderRadius: 14,
          boxShadow: '0 24px 70px rgba(0,0,0,0.65)',
          border: '1px solid rgba(255,255,255,0.08)',
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
            background: '#303030',
            borderBottom: '1px solid rgba(0,0,0,0.4)',
          }}
        >
          <span style={{ fontSize: 14, fontWeight: 700 }}>Preferences</span>
          <div style={{ flex: 1 }} />
          <div style={{ display: 'flex', gap: 3, background: 'rgba(0,0,0,0.25)', padding: 3, borderRadius: 10 }}>
            {tabs.map((t) => (
              <div
                key={t.id}
                onClick={() => setTab(t.id)}
                style={{
                  padding: '6px 12px',
                  borderRadius: 8,
                  fontSize: 12.5,
                  cursor: 'default',
                  background: tab === t.id ? '#3584e4' : 'transparent',
                  color: tab === t.id ? '#fff' : 'rgba(255,255,255,0.65)',
                }}
              >
                {t.label}
              </div>
            ))}
          </div>
          <div style={{ flex: 1 }} />
          <div
            onClick={onClose}
            style={{
              width: 30,
              height: 30,
              borderRadius: '50%',
              background: 'rgba(255,255,255,0.08)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'default',
              position: 'relative',
            }}
          >
            <div
              style={{
                position: 'absolute',
                width: 12,
                height: 1.7,
                background: '#fff',
                transform: 'rotate(45deg)',
                borderRadius: 1,
              }}
            />
            <div
              style={{
                position: 'absolute',
                width: 12,
                height: 1.7,
                background: '#fff',
                transform: 'rotate(-45deg)',
                borderRadius: 1,
              }}
            />
          </div>
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: '24px 80px', minHeight: 0 }}>
          {tab === 'library' ? (
            <PreferencesLibrary />
          ) : tab === 'shortcuts' ? (
            <PreferencesShortcuts />
          ) : tab === 'applications' ? (
            <PreferencesApplications />
          ) : (
            <div style={{ maxWidth: 480, margin: '60px auto 0', textAlign: 'center', color: 'var(--text-dimmer)' }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-dim)', marginBottom: 8 }}>
                {tabs.find((t) => t.id === tab)?.label}
              </div>
              <div style={{ fontSize: 13, lineHeight: 1.6 }}>
                Not wired up in the real app yet — see the design prototype
                (<code>Immich Desktop.dc.html</code>) for how this pane should look and behave.
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
