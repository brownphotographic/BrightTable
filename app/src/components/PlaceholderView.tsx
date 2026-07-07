export default function PlaceholderView({ label }: { label: string }) {
  return (
    <div style={{ padding: 60, textAlign: 'center', color: 'var(--text-dimmer)' }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-dim)', marginBottom: 8 }}>{label}</div>
      <div style={{ fontSize: 13, lineHeight: 1.6 }}>Not built in the real app yet — placeholder data only in the design prototype.</div>
    </div>
  );
}
