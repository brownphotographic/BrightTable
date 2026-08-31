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

import { useState, type CSSProperties } from 'react';

// Generic confirm modal for consequential actions (delete, restore, empty
// trash) - none existed in the app yet. Stays open and shows an inline error
// on failure instead of closing optimistically; only closes itself once
// `onConfirm` actually resolves.
export default function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = true,
  onConfirm,
  onClose,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="window-frame window-frame-overlay"
      style={{
        zIndex: 300,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onClick={busy ? undefined : onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 400,
          maxWidth: '90%',
          background: 'var(--dialog-bg)',
          borderRadius: 14,
          boxShadow: '0 24px 70px rgba(0,0,0,0.65)',
          border: '1px solid var(--border)',
          padding: 22,
          color: 'var(--text)',
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 10 }}>{title}</div>
        <div style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--text-dim)' }}>{message}</div>
        {error && <div style={{ marginTop: 12, fontSize: 12, color: 'var(--danger)', lineHeight: 1.4 }}>{error}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
          <button onClick={onClose} disabled={busy} style={btnSecondary}>
            {cancelLabel}
          </button>
          <button onClick={handleConfirm} disabled={busy} style={danger ? btnDanger : btnPrimary}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

const btnBase: CSSProperties = {
  height: 34,
  padding: '0 16px',
  borderRadius: 9,
  fontSize: 13,
  cursor: 'default',
  border: 'none',
};

const btnSecondary: CSSProperties = {
  ...btnBase,
  border: '1px solid var(--border-strong)',
  background: 'var(--overlay-weak)',
  color: 'var(--text)',
};

const btnPrimary: CSSProperties = {
  ...btnBase,
  background: 'var(--accent)',
  color: '#fff',
  fontWeight: 700,
};

const btnDanger: CSSProperties = {
  ...btnBase,
  background: '#c0392b',
  color: '#fff',
  fontWeight: 700,
};
