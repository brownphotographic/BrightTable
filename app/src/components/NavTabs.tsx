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

import { Icon, type IconName } from './Icons';

export type LeftTab = 'photos' | 'albums' | 'people' | 'tags' | 'folders' | 'trash';

// Left-to-right order of the primary views in the toolbar's tab strip. Each
// keeps its own tint (so the tabs stay quickly distinguishable at a glance,
// same as the color dots they replace) but now renders as a Material icon
// rather than a plain colored square, matching the icon+label buttons
// elsewhere in the toolbar (Viewer.tsx, SelectionBar.tsx).
const navDefs: { id: LeftTab; label: string; icon: IconName; color: string }[] = [
  { id: 'photos', label: 'Photos', icon: 'photos', color: '#62a0ea' },
  { id: 'folders', label: 'Folders', icon: 'folder', color: '#9aa0a6' },
  { id: 'albums', label: 'Albums', icon: 'albums', color: '#2ec27e' },
  { id: 'people', label: 'People', icon: 'people', color: '#e5a50a' },
  { id: 'tags', label: 'Tags', icon: 'tags', color: '#9141ac' },
  { id: 'trash', label: 'Trash', icon: 'trash', color: '#e01b24' },
];

// Formerly a standalone left-hand sidebar; now a horizontal strip of tabs
// meant to be rendered inline inside MenuBar's toolbar row, alongside the
// File/Edit/View/Help menus. Connection status and the resource chart that
// used to live in this component's footer moved to TitleBar's connection
// pill (see ConnectionStatusPill.tsx) since there's no footer here anymore.
export default function NavTabs({
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
  const counts: Record<LeftTab, string> = {
    photos: photosCount ? String(photosCount) : '',
    albums: albumsCount ? String(albumsCount) : '',
    people: peopleCount ? String(peopleCount) : '',
    tags: tagsCount ? String(tagsCount) : '',
    folders: photosCount ? String(photosCount) : '',
    trash: trashCount ? String(trashCount) : '',
  };

  return (
    <div style={{ display: 'flex', alignSelf: 'stretch', alignItems: 'stretch', flexShrink: 0 }}>
      {navDefs.map((n) => {
        const isActive = active === n.id;
        return (
          <div
            key={n.id}
            onClick={() => onSelect(n.id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '0 9px',
              fontSize: 12.5,
              fontWeight: isActive ? 600 : 400,
              color: isActive ? 'var(--text)' : 'var(--text-dim)',
              boxShadow: isActive ? 'inset 0 -2px 0 var(--accent)' : 'none',
              cursor: 'default',
              flexShrink: 0,
              whiteSpace: 'nowrap',
            }}
          >
            <span style={{ color: n.color, display: 'flex' }}>
              <Icon name={n.icon} size={15} />
            </span>
            {n.label}
            {counts[n.id] && (
              <span style={{ fontSize: 11, color: 'var(--text-dimmer)', fontVariantNumeric: 'tabular-nums' }}>
                {counts[n.id]}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
