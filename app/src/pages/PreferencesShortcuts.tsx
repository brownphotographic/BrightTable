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

import { useEffect, type CSSProperties } from 'react';
import { formatShortcut, prettyShortcut, SHORTCUT_DEFS, useShortcuts } from '../lib/shortcuts';

export default function PreferencesShortcuts() {
  const { shortcuts, resetDefaults, capturing: capturingId, beginCapture, cancelCapture, commitCapture } =
    useShortcuts();

  useEffect(() => {
    if (!capturingId) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        cancelCapture();
        return;
      }
      if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return;
      commitCapture(capturingId, formatShortcut(e));
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [capturingId, cancelCapture, commitCapture]);

  return (
    <div style={{ maxWidth: 560, margin: '0 auto', padding: '24px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '0 4px 12px' }}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>Keyboard Shortcuts</div>
        <button onClick={resetDefaults} style={resetBtn}>
          Reset to defaults
        </button>
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--text-dimmer)', margin: '0 4px 14px', lineHeight: 1.5 }}>
        Click a shortcut, then press the key or combination you want to assign. Press Esc to cancel.
      </div>
      <div style={panel}>
        {SHORTCUT_DEFS.map((def, i) => {
          const capturing = capturingId === def.id;
          return (
            <div key={def.id}>
              <div style={row}>
                <span style={{ fontSize: 13.5, color: 'var(--text-dim)' }}>{def.label}</span>
                <div
                  onClick={() => beginCapture(def.id)}
                  style={{
                    minWidth: 88,
                    height: 30,
                    padding: '0 12px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: 8,
                    font: '600 12px ui-monospace,monospace',
                    cursor: 'default',
                    color: capturing ? 'var(--accent-text)' : 'var(--text)',
                    background: capturing ? 'rgba(53,132,228,0.28)' : 'var(--surface-sunken)',
                    boxShadow: `inset 0 0 0 1px ${capturing ? 'var(--accent)' : 'var(--border-strong)'}`,
                  }}
                >
                  {capturing ? 'Press a key…' : prettyShortcut(shortcuts[def.id]) || '—'}
                </div>
              </div>
              {i < SHORTCUT_DEFS.length - 1 && <Divider />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Divider() {
  return <div style={{ height: 1, background: 'var(--border)', marginLeft: 16 }} />;
}

const panel: CSSProperties = {
  background: 'var(--panel)',
  borderRadius: 13,
  overflow: 'hidden',
  border: '1px solid var(--border)',
};

const row: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '11px 16px',
};

const resetBtn: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  height: 32,
  padding: '0 14px',
  border: '1px solid var(--border-strong)',
  borderRadius: 8,
  background: 'var(--overlay-weak)',
  color: 'var(--text)',
  fontSize: 12.5,
  cursor: 'default',
};
