import type { ReactNode } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import ActivityIndicator from './ActivityIndicator';

const appWindow = getCurrentWindow();

const tabLabels: Record<string, string> = {
  photos: 'Photos',
  albums: 'Albums',
  people: 'People',
  folders: 'Folders',
  trash: 'Trash',
};

export default function TitleBar({ activeTab, onOpenActivity }: { activeTab: string; onOpenActivity: () => void }) {
  return (
    <div
      data-tauri-drag-region
      style={{
        height: 38,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '0 8px 0 12px',
        background: 'linear-gradient(#323232, #2e2e2e)',
        borderBottom: '1px solid rgba(0,0,0,0.5)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0, pointerEvents: 'none' }}>
        <div
          style={{
            width: 18,
            height: 18,
            borderRadius: 5,
            background: 'linear-gradient(135deg, #62a0ea, #1c71d8)',
            boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.18)',
          }}
        />
        <span style={{ fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap', flexShrink: 0 }}>ImmAture</span>
        <span
          style={{
            fontSize: 12.5,
            color: 'rgba(255,255,255,.42)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          — {tabLabels[activeTab] ?? activeTab}
        </span>
      </div>
      <div style={{ flex: 1 }} />
      <div style={{ marginRight: 8 }}>
        <ActivityIndicator onClick={onOpenActivity} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <WinButton onClick={() => appWindow.minimize()} hoverBg="rgba(255,255,255,0.18)">
          <div style={{ width: 9, height: 1.6, background: '#fff', borderRadius: 1, marginTop: 6 }} />
        </WinButton>
        <WinButton onClick={() => appWindow.toggleMaximize()} hoverBg="rgba(255,255,255,0.18)">
          <div style={{ width: 8, height: 8, border: '1.6px solid #fff', borderRadius: 2 }} />
        </WinButton>
        <WinButton onClick={() => appWindow.close()} hoverBg="#e01b24">
          <div style={{ position: 'relative', width: 11, height: 11 }}>
            <div
              style={{
                position: 'absolute',
                width: 11,
                height: 1.6,
                background: '#fff',
                borderRadius: 1,
                transform: 'rotate(45deg)',
                top: 4.7,
              }}
            />
            <div
              style={{
                position: 'absolute',
                width: 11,
                height: 1.6,
                background: '#fff',
                borderRadius: 1,
                transform: 'rotate(-45deg)',
                top: 4.7,
              }}
            />
          </div>
        </WinButton>
      </div>
    </div>
  );
}

function WinButton({
  onClick,
  hoverBg,
  children,
}: {
  onClick: () => void;
  hoverBg: string;
  children: ReactNode;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        width: 24,
        height: 24,
        borderRadius: '50%',
        background: 'rgba(255,255,255,0.09)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'default',
        position: 'relative',
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = hoverBg)}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.09)')}
    >
      {children}
    </div>
  );
}
