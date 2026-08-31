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

import { useEffect, useRef } from 'react';

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

// A thin separator between logical groups of items (Organize / Stacking /
// Copy-Paste / Utility / Destructive - see each page's contextMenuItems) -
// callers push `DIVIDER` between groups the same way SelectionBar uses a
// vertical rule between its own button groups.
export const DIVIDER = { divider: true } as const;
export type ContextMenuEntry = ContextMenuItem | typeof DIVIDER;

// The app's first right-click context menu - a dumb, reusable positioned
// popup. Callers own what items appear; this only handles placement,
// dismissal (outside click / Escape), and matching the existing dropdown
// look (see MenuBar.tsx's TopMenu/filter panels).
export default function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: ContextMenuEntry[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Callers push DIVIDER unconditionally between logical groups regardless
  // of whether the group on either side actually ended up empty (most of
  // these items are individually conditional) - collapsing consecutive/
  // leading/trailing dividers here means every caller doesn't have to track
  // that itself.
  const normalized: ContextMenuEntry[] = [];
  for (const item of items) {
    const isDivider = 'divider' in item;
    if (isDivider && (normalized.length === 0 || 'divider' in normalized[normalized.length - 1])) continue;
    normalized.push(item);
  }
  while (normalized.length > 0 && 'divider' in normalized[normalized.length - 1]) normalized.pop();

  useEffect(() => {
    const onPointerDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      style={{
        position: 'fixed',
        left: x,
        top: y,
        minWidth: 210,
        background: 'var(--panel)',
        border: '1px solid var(--border)',
        borderRadius: 11,
        boxShadow: '0 12px 34px rgba(0,0,0,0.6)',
        padding: 6,
        zIndex: 120,
      }}
    >
      {normalized.map((item, i) => {
        if ('divider' in item) {
          return <div key={i} style={{ height: 1, margin: '5px 4px', background: 'var(--border)' }} />;
        }
        return (
        <div
          key={i}
          onClick={() => {
            if (item.disabled) return;
            onClose();
            item.onClick();
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            height: 31,
            padding: '0 11px',
            borderRadius: 7,
            fontSize: 13.5,
            cursor: 'default',
            color: item.disabled ? 'var(--text-dimmer)' : 'var(--text)',
            pointerEvents: item.disabled ? 'none' : 'auto',
          }}
          onMouseEnter={(e) => {
            if (item.disabled) return;
            e.currentTarget.style.background = '#3584e4';
            e.currentTarget.style.color = '#fff';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.color = item.disabled ? 'var(--text-dimmer)' : 'var(--text)';
          }}
        >
          {item.label}
        </div>
        );
      })}
    </div>
  );
}
