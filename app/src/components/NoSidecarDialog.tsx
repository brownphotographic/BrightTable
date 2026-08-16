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

// Shown whenever ART closed (Variant 1) or a batch target was about to be
// queued (Variant 2) with no `.arp`/`.pp3` ever written - no edit made or
// saved - so there's nothing new to export by default. Mirrors ConfirmDialog's
// look, but - unlike a plain confirm/cancel - both buttons here are real,
// independent, potentially-failing actions (see useNoSidecarChoice.tsx for
// Variant 1's usage; PhotosBrowser.tsx/FoldersBrowser.tsx's batch confirm
// flow for Variant 2's), so neither can reuse ConfirmDialog's "onClose fires
// after a successful confirm too" behavior - each button manages its own
// busy/error state independently, and a backdrop click/Escape maps to
// `onSecondary` (the lighter-footprint of the two - "cancel" for a single
// image, "exclude just the affected ones" for a batch).
export default function NoSidecarDialog({
  title = 'No Edits Saved in ART',
  message = "This photo has no saved ART edits, so there's nothing new to export. Export it anyway using ART's default processing profile, or cancel this export?",
  primaryLabel = 'Export with Default Processing',
  secondaryLabel = 'Cancel Processing',
  onPrimary,
  onSecondary,
}: {
  title?: string;
  message?: string;
  primaryLabel?: string;
  secondaryLabel?: string;
  onPrimary: () => Promise<void>;
  onSecondary: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<'primary' | 'secondary' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(which: 'primary' | 'secondary', action: () => Promise<void>) {
    setBusy(which);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(String(e));
      setBusy(null);
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 300,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onClick={busy ? undefined : () => run('secondary', onSecondary)}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 420,
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
          <button onClick={() => run('secondary', onSecondary)} disabled={!!busy} style={btnSecondary}>
            {busy === 'secondary' ? 'Working…' : secondaryLabel}
          </button>
          <button onClick={() => run('primary', onPrimary)} disabled={!!busy} style={btnPrimary}>
            {busy === 'primary' ? 'Working…' : primaryLabel}
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
