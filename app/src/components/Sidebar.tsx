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

import { useLibraryStatus } from '../lib/libraryStatus';
import ResourceChart from './ResourceChart';

export type LeftTab = 'photos' | 'albums' | 'people' | 'tags' | 'folders' | 'trash';

const navDefs: { id: LeftTab; label: string; color: string }[] = [
  { id: 'photos', label: 'Photos', color: '#62a0ea' },
  { id: 'albums', label: 'Albums', color: '#2ec27e' },
  { id: 'people', label: 'People', color: '#e5a50a' },
  { id: 'tags', label: 'Tags', color: '#9141ac' },
  { id: 'folders', label: 'Folders', color: '#9aa0a6' },
];

export default function Sidebar({
  active,
  onSelect,
  photosCount,
  trashCount,
  albumsCount,
  peopleCount,
  tagsCount,
}: {
  active: LeftTab;
  onSelect: (tab: LeftTab) => void;
  photosCount: number;
  trashCount: number;
  albumsCount?: number;
  peopleCount?: number;
  tagsCount?: number;
}) {
  const { status, checking, error } = useLibraryStatus();

  const counts: Record<LeftTab, string> = {
    photos: photosCount ? String(photosCount) : '',
    albums: albumsCount ? String(albumsCount) : '',
    people: peopleCount ? String(peopleCount) : '',
    tags: tagsCount ? String(tagsCount) : '',
    folders: photosCount ? String(photosCount) : '',
    trash: trashCount ? String(trashCount) : '',
  };

  const versionWarning = !!status && !status.serverVersionSupported;
  const dotColor = checking
    ? 'var(--text-dimmer)'
    : status
      ? versionWarning
        ? 'var(--warn)'
        : '#2ec27e'
      : error
        ? '#e01b24'
        : 'var(--text-dimmer)';
  const statusText = checking
    ? 'Connecting…'
    : status
      ? `Connected · ${status.via}${versionWarning ? ' · old server version' : ''}`
      : 'Not connected';

  return (
    <div
      style={{
        width: 212,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        background: 'var(--panel)',
        borderRight: '1px solid var(--border-strong)',
        padding: '10px 9px',
      }}
    >
      {navDefs.map((n) => {
        const isActive = active === n.id;
        return (
          <div
            key={n.id}
            onClick={() => onSelect(n.id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              height: 36,
              padding: '0 11px',
              borderRadius: 9,
              cursor: 'default',
              marginBottom: 1,
              color: isActive ? 'var(--accent-text)' : 'var(--text-dim)',
              background: isActive ? 'rgba(53,132,228,0.28)' : 'transparent',
            }}
          >
            <div
              style={{
                width: 11,
                height: 11,
                borderRadius: 3,
                flexShrink: 0,
                background: isActive ? '#7fb0f0' : n.color,
              }}
            />
            <span style={{ flex: 1, fontSize: 13.5 }}>{n.label}</span>
            <span style={{ fontSize: 11.5, color: 'var(--text-dimmer)', fontVariantNumeric: 'tabular-nums' }}>
              {counts[n.id]}
            </span>
          </div>
        );
      })}

      <div style={{ height: 1, background: 'var(--border)', margin: '7px 4px' }} />
      {(() => {
        const isActive = active === 'trash';
        return (
          <div
            onClick={() => onSelect('trash')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              height: 36,
              padding: '0 11px',
              borderRadius: 9,
              cursor: 'default',
              marginBottom: 1,
              color: isActive ? 'var(--danger)' : 'var(--text-dim)',
              background: isActive ? 'rgba(224,27,36,0.28)' : 'transparent',
            }}
          >
            <div
              style={{
                width: 11,
                height: 11,
                borderRadius: 3,
                flexShrink: 0,
                background: isActive ? '#f47a80' : '#e01b24',
              }}
            />
            <span style={{ flex: 1, fontSize: 13.5 }}>Trash</span>
            <span style={{ fontSize: 11.5, color: 'var(--text-dimmer)', fontVariantNumeric: 'tabular-nums' }}>
              {counts.trash}
            </span>
          </div>
        );
      })()}

      <div style={{ flex: 1 }} />
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 11.5,
          color: 'var(--text-dim)',
          padding: '6px 6px 2px',
        }}
      >
        <div style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: dotColor }} />
        {statusText}
      </div>
      <ResourceChart />
    </div>
  );
}
