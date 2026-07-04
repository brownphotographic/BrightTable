import { useState, type ReactNode } from 'react';
import PhotosBrowser from './pages/PhotosBrowser';
import PreferencesLibrary from './pages/PreferencesLibrary';

type View = 'photos' | 'preferences';

export default function App() {
  const [view, setView] = useState<View>('photos');

  return (
    <div style={{ height: '100vh', width: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '10px 16px',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
        }}
      >
        <span style={{ fontWeight: 700, marginRight: 16 }}>ImmAture</span>
        <NavButton active={view === 'photos'} onClick={() => setView('photos')}>
          Photos
        </NavButton>
        <div style={{ flex: 1 }} />
        <NavButton active={view === 'preferences'} onClick={() => setView('preferences')}>
          Preferences
        </NavButton>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {view === 'photos' ? (
          <PhotosBrowser />
        ) : (
          <div style={{ height: '100%', overflow: 'auto', padding: '0 24px' }}>
            <PreferencesLibrary />
          </div>
        )}
      </div>
    </div>
  );
}

function NavButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        padding: '6px 12px',
        borderRadius: 8,
        fontSize: 13,
        cursor: 'default',
        background: active ? 'rgba(255,255,255,0.08)' : 'transparent',
        color: active ? '#fff' : 'var(--text-dim)',
      }}
    >
      {children}
    </div>
  );
}
