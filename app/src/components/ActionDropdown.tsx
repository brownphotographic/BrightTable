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

import { useEffect, useRef, useState } from 'react';
import type { MenuAction } from '../lib/actionMenu';

// A button that opens a small popup list of MenuActions on click - used by
// SelectionBar to collapse its lower-frequency action groups (Stack/Edit/
// Paste/More) so the bar itself stays a fixed handful of controls instead of
// growing one button per action and wrapping. Visually mirrors
// ContextMenu.tsx's popup (border/shadow/hover treatment) rather than
// inventing a second style for "a list of clickable labels".
export default function ActionDropdown({
  label,
  actions,
  variant = 'dark',
}: {
  label: string;
  actions: MenuAction[];
  // 'dark' (default) is SelectionBar's always-dark-bar look (hardcoded white-on-rgba).
  // 'plain' follows the app's light/dark theme via CSS vars instead - for use in a
  // theme-following header (Viewer's), where hardcoded white text would go invisible
  // against a light background.
  variant?: 'dark' | 'plain';
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (actions.length === 0) return null;

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          height: 32,
          padding: '0 12px',
          border: 'none',
          borderRadius: 8,
          background:
            variant === 'plain'
              ? open
                ? 'var(--overlay-medium)'
                : 'var(--overlay-weak)'
              : open
                ? 'rgba(255,255,255,0.16)'
                : 'rgba(255,255,255,0.08)',
          color: variant === 'plain' ? 'var(--text)' : '#fff',
          fontSize: 12.5,
          cursor: 'default',
        }}
      >
        {label}
        <div
          style={{
            width: 0,
            height: 0,
            borderLeft: '3.5px solid transparent',
            borderRight: '3.5px solid transparent',
            borderTop: '4.5px solid currentColor',
            marginTop: 1,
          }}
        />
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: 38,
            left: 0,
            minWidth: 220,
            background: 'var(--panel)',
            border: '1px solid var(--border)',
            borderRadius: 11,
            boxShadow: '0 12px 34px rgba(0,0,0,0.6)',
            padding: 6,
            zIndex: 130,
          }}
        >
          {actions.map((action) => (
            <div
              key={action.id}
              onClick={() => {
                if (action.disabled) return;
                setOpen(false);
                action.onClick();
              }}
              title={action.disabledReason}
              style={{
                display: 'flex',
                alignItems: 'center',
                height: 31,
                padding: '0 11px',
                borderRadius: 7,
                fontSize: 13.5,
                cursor: 'default',
                color: action.disabled ? 'var(--text-dimmer)' : 'var(--text)',
                pointerEvents: action.disabled ? 'none' : 'auto',
              }}
              onMouseEnter={(e) => {
                if (action.disabled) return;
                e.currentTarget.style.background = '#3584e4';
                e.currentTarget.style.color = '#fff';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent';
                e.currentTarget.style.color = action.disabled ? 'var(--text-dimmer)' : 'var(--text)';
              }}
            >
              {action.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
