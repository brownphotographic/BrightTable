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

import { useState } from 'react';
import PreferencesLibrary from '../pages/PreferencesLibrary';
import PreferencesShortcuts from '../pages/PreferencesShortcuts';
import PreferencesApplications from '../pages/PreferencesApplications';
import PreferencesConfiguration from '../pages/PreferencesConfiguration';
import PreferencesSharing from '../pages/PreferencesSharing';

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
        background: 'var(--scrim)',
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
          background: 'var(--dialog-bg)',
          borderRadius: 14,
          boxShadow: '0 24px 70px rgba(0,0,0,0.65)',
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
            borderBottom: '1px solid var(--border-strong)',
          }}
        >
          <span style={{ fontSize: 14, fontWeight: 700 }}>Preferences</span>
          <div style={{ flex: 1 }} />
          <div style={{ display: 'flex', gap: 3, background: 'var(--overlay-medium)', padding: 3, borderRadius: 10 }}>
            {tabs.map((t) => (
              <div
                key={t.id}
                onClick={() => setTab(t.id)}
                style={{
                  padding: '6px 12px',
                  borderRadius: 8,
                  fontSize: 12.5,
                  cursor: 'default',
                  background: tab === t.id ? 'var(--accent)' : 'transparent',
                  color: tab === t.id ? '#fff' : 'var(--text-dim)',
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
              background: 'var(--overlay-medium)',
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
                background: 'var(--text)',
                transform: 'rotate(45deg)',
                borderRadius: 1,
              }}
            />
            <div
              style={{
                position: 'absolute',
                width: 12,
                height: 1.7,
                background: 'var(--text)',
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
          ) : tab === 'sharing' ? (
            <PreferencesSharing />
          ) : tab === 'configuration' ? (
            <PreferencesConfiguration />
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
