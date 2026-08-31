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
import { Heart, RejectIcon, Star } from './MetadataRows';
import ActionDropdown from './ActionDropdown';
import { groupActions, type MenuAction } from '../lib/actionMenu';

// Floating action bar shown above the grid whenever the selection is
// non-empty. Every page builds its own `actions: MenuAction[]` (grouped via
// the `group` field - see lib/actionMenu.ts) the same way it already builds
// its own ContextMenu items, using the shared lib/useAssetActions.ts hook for
// the handler implementations so labels/gating can't drift between pages.
// Only Favorite/Rate stay as dedicated props rather than actions - their
// buttons reflect live selection state (icon fill, current stars) rather
// than just firing a click.
//
// Low-frequency/long-labeled actions (`organize`/`stack`/`edit`/`copyPaste`/
// `share`/`more` groups) collapse into ActionDropdown buttons so this bar
// stays a fixed handful of controls instead of one button per action
// wrapping to multiple lines - see the design discussion this replaced the
// old named-prop version for. `primary` is for anything that should stay an
// inline button rather than nest in a dropdown (nothing currently uses it -
// Add to Album/Add to Tag moved into the `organize` group - but the slot
// stays available); `destructive` actions (Move to Trash, Remove from
// Album/Tag) stay trailing inline buttons in the danger color.
export default function SelectionBar({
  count,
  onCancel,
  onFavorite,
  allFavorited,
  onRate,
  actions,
}: {
  count: number;
  onCancel: () => void;
  onFavorite: () => void;
  allFavorited: boolean;
  onRate: (rating: number) => void;
  actions: MenuAction[];
}) {
  const groups = groupActions(actions);
  const hasDropdowns =
    groups.organize.length > 0 ||
    groups.stack.length > 0 ||
    groups.edit.length > 0 ||
    groups.copyPaste.length > 0 ||
    groups.share.length > 0 ||
    groups.more.length > 0;
  return (
    <div
      style={{
        height: 46,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '0 14px',
        background: '#26313f',
        borderBottom: '1px solid rgba(53,132,228,0.4)',
      }}
    >
      <div
        onClick={onCancel}
        title="Deselect"
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
          flexShrink: 0,
        }}
      >
        <div style={{ position: 'absolute', width: 12, height: 1.7, background: '#fff', transform: 'rotate(45deg)', borderRadius: 1 }} />
        <div style={{ position: 'absolute', width: 12, height: 1.7, background: '#fff', transform: 'rotate(-45deg)', borderRadius: 1 }} />
      </div>
      <span style={{ fontSize: 14, fontWeight: 700, color: '#fff' }}>{count} selected</span>
      <div style={{ flex: 1 }} />
      <RatingGroup onRate={onRate} />
      <BarButton onClick={onFavorite} title={allFavorited ? 'Remove from favorites' : 'Add to favorites'}>
        <Heart filled={allFavorited} size={13} dimColor="rgba(255,255,255,0.3)" />
        Favorite
      </BarButton>
      {groups.primary.map((action) => (
        <BarButton key={action.id} onClick={action.onClick} disabled={action.disabled} title={action.disabledReason}>
          {action.label}
        </BarButton>
      ))}
      {hasDropdowns && <div style={{ width: 1, height: 22, background: 'rgba(255,255,255,0.12)' }} />}
      {groups.organize.length > 0 && <ActionDropdown label="Organize" actions={groups.organize} />}
      {groups.stack.length > 0 && <ActionDropdown label="Stack" actions={groups.stack} />}
      {groups.edit.length > 0 && <ActionDropdown label="Edit" actions={groups.edit} />}
      {groups.copyPaste.length > 0 && <ActionDropdown label="Copy/Paste" actions={groups.copyPaste} />}
      {groups.share.length > 0 && <ActionDropdown label="Share" actions={groups.share} />}
      {groups.more.length > 0 && <ActionDropdown label="More" actions={groups.more} />}
      <div style={{ width: 1, height: 22, background: 'rgba(255,255,255,0.12)' }} />
      {groups.destructive.map((action) => (
        <BarButton key={action.id} onClick={action.onClick} disabled={action.disabled} title={action.disabledReason} color="#ff8080">
          {action.label}
        </BarButton>
      ))}
    </div>
  );
}

function BarButton({
  onClick,
  disabled,
  color,
  title,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  color?: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      title={title}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        height: 32,
        padding: '0 13px',
        border: 'none',
        borderRadius: 8,
        background: 'rgba(255,255,255,0.08)',
        color: color ?? '#fff',
        fontSize: 12.5,
        cursor: 'default',
        opacity: disabled ? 0.4 : 1,
      }}
    >
      {children}
    </button>
  );
}

// No "current value" to reflect here - the selection can have mixed ratings,
// so this is a plain set-rating input (all stars unfilled at rest) rather
// than a display of any one asset's rating, unlike MetadataRows' single-asset
// rating row.
function RatingGroup({ onRate }: { onRate: (rating: number) => void }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        height: 32,
        padding: '0 10px',
        borderRadius: 8,
        background: 'rgba(255,255,255,0.08)',
      }}
    >
      <button
        onClick={() => onRate(0)}
        title="Clear rating"
        style={{
          border: 'none',
          background: 'none',
          padding: 0,
          fontSize: 11,
          fontWeight: 700,
          color: 'rgba(255,255,255,0.55)',
          cursor: 'default',
        }}
      >
        0
      </button>
      <div style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.15)' }} />
      <div style={{ display: 'flex', gap: 4 }}>
        {[1, 2, 3, 4, 5].map((v) => (
          <button
            key={v}
            onClick={() => onRate(v)}
            title={`Rate ${v} star${v === 1 ? '' : 's'}`}
            style={{ border: 'none', background: 'none', padding: 0, cursor: 'default' }}
          >
            <Star filled={false} size={14} dimColor="rgba(255,255,255,0.3)" />
          </button>
        ))}
      </div>
      <div style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.15)' }} />
      <button
        onClick={() => onRate(-1)}
        title="Reject"
        style={{ border: 'none', background: 'none', padding: 0, cursor: 'default' }}
      >
        <RejectIcon active={false} size={14} dimColor="rgba(255,255,255,0.3)" />
      </button>
    </div>
  );
}
