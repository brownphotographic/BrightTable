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
      style={{
        position: 'fixed',
        inset: 0,
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
          background: '#242424',
          borderRadius: 14,
          boxShadow: '0 24px 70px rgba(0,0,0,0.65)',
          border: '1px solid rgba(255,255,255,0.08)',
          padding: 22,
          color: '#fff',
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 10 }}>{title}</div>
        <div style={{ fontSize: 13, lineHeight: 1.5, color: 'rgba(255,255,255,0.75)' }}>{message}</div>
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
  border: '1px solid rgba(255,255,255,0.16)',
  background: 'rgba(255,255,255,0.06)',
  color: '#fff',
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
