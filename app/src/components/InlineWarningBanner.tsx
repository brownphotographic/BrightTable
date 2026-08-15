// Extracted verbatim from the amber banner previously duplicated in
// PhotosBrowser.tsx/FoldersBrowser.tsx - pure de-duplication, no behavior
// change.
export default function InlineWarningBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '6px 14px',
        background: '#4a2f0a',
        color: 'var(--warn)',
        fontSize: 12.5,
        flexShrink: 0,
      }}
    >
      <span style={{ flex: 1 }}>{message}</span>
      <span onClick={onDismiss} style={{ cursor: 'default', opacity: 0.8 }}>
        ✕
      </span>
    </div>
  );
}
