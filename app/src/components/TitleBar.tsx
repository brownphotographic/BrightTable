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

import type { ReactNode } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import ActivityIndicator from './ActivityIndicator';
import ConnectionStatusPill from './ConnectionStatusPill';
import { useWindowControls } from '../lib/windowControls';
import appIcon from '../assets/app-icon.png';

const appWindow = getCurrentWindow();

const tabLabels: Record<string, string> = {
  photos: 'Photos',
  albums: 'Albums',
  people: 'People',
  tags: 'Tags',
  folders: 'Folders',
  trash: 'Trash',
};

function WindowButtons({ reversed }: { reversed?: boolean }) {
  const minimizeBtn = (
    <WinButton key="minimize" onClick={() => appWindow.minimize()} idleBg="var(--overlay-weak)" hoverBg="var(--overlay-strong)">
      <div style={{ width: 9, height: 1.6, background: 'var(--text)', borderRadius: 1, marginTop: 6 }} />
    </WinButton>
  );
  const maximizeBtn = (
    <WinButton key="maximize" onClick={() => appWindow.toggleMaximize()} idleBg="var(--overlay-weak)" hoverBg="var(--overlay-strong)">
      <div style={{ width: 8, height: 8, border: '1.6px solid var(--text)', borderRadius: 2 }} />
    </WinButton>
  );
  const closeBtn = (
    <WinButton key="close" onClick={() => appWindow.close()} idleBg="rgba(0,0,0,0.35)" hoverBg="#e01b24">
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
  );

  const buttons = reversed ? [closeBtn, maximizeBtn, minimizeBtn] : [minimizeBtn, maximizeBtn, closeBtn];

  return <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>{buttons}</div>;
}

export default function TitleBar({
  activeTab,
  onOpenActivity,
  onOpenLibrarySettings,
}: {
  activeTab: string;
  onOpenActivity: () => void;
  onOpenLibrarySettings: () => void;
}) {
  const { position } = useWindowControls();
  const onLeft = position === 'left';

  return (
    <div
      data-tauri-drag-region
      style={{
        height: 38,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: onLeft ? '0 12px 0 8px' : '0 8px 0 12px',
        background: 'var(--panel-3)',
        borderBottom: '1px solid var(--border-strong)',
      }}
    >
      {onLeft && <WindowButtons reversed />}
      {onLeft && <div style={{ width: 1, height: 18, background: 'var(--overlay-medium)' }} />}
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0, pointerEvents: 'none' }}>
        <img
          src={appIcon}
          alt=""
          style={{ width: 18, height: 18, borderRadius: 5, display: 'block' }}
        />
        <span style={{ fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap', flexShrink: 0 }}>BrightTable</span>
        <span
          style={{
            fontSize: 12.5,
            color: 'var(--text-dimmer)',
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
      <div style={{ marginRight: 8 }}>
        <ConnectionStatusPill onOpenLibrarySettings={onOpenLibrarySettings} />
      </div>
      {!onLeft && <WindowButtons />}
    </div>
  );
}

function WinButton({
  onClick,
  idleBg,
  hoverBg,
  children,
}: {
  onClick: () => void;
  idleBg: string;
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
        background: idleBg,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'default',
        position: 'relative',
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = hoverBg)}
      onMouseLeave={(e) => (e.currentTarget.style.background = idleBg)}
    >
      {children}
    </div>
  );
}
