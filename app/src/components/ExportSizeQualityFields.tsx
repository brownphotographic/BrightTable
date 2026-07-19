import type { CSSProperties } from 'react';
import type { ExportFormat } from '../lib/api';

// Shared Format/Size/Quality controls for ExportToFolderDialog and
// ExportToFlickrDialog - identical fields, per the design prototype's Export
// to Folder dialog (Immich Desktop.dc.html), reused rather than duplicated
// across the two real dialogs.
const SIZE_OPTIONS: { label: string; px: number | null }[] = [
  { label: 'Full size', px: null },
  { label: '2048 px', px: 2048 },
  { label: '1024 px', px: 1024 },
  { label: '640 px', px: 640 },
];

export default function ExportSizeQualityFields({
  format,
  onFormatChange,
  sizePx,
  onSizePxChange,
  quality,
  onQualityChange,
}: {
  format: ExportFormat;
  onFormatChange: (f: ExportFormat) => void;
  sizePx: number | null;
  onSizePxChange: (px: number | null) => void;
  quality: number;
  onQualityChange: (q: number) => void;
}) {
  return (
    <div>
      <div style={labelStyle}>FORMAT</div>
      <div style={{ display: 'flex', gap: 8, marginBottom: format === 'jpeg' ? 16 : 0 }}>
        <FormatCard active={format === 'jpeg'} title="JPEG" subtitle="Rendered & resized" onClick={() => onFormatChange('jpeg')} />
        <FormatCard active={format === 'original'} title="Original" subtitle="Copy the source file" onClick={() => onFormatChange('original')} />
      </div>

      {format === 'jpeg' && (
        <>
          <div style={labelStyle}>SIZE</div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
            {SIZE_OPTIONS.map((opt) => (
              <div key={opt.label} onClick={() => onSizePxChange(opt.px)} style={chipStyle(sizePx === opt.px)}>
                {opt.label}
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.85)' }}>JPEG quality</span>
            <span style={{ font: '600 13px ui-monospace,monospace', color: '#7fb0f0' }}>{quality}</span>
          </div>
          <input type="range" min={50} max={100} step={1} value={quality} onChange={(e) => onQualityChange(Number(e.target.value))} style={{ width: '100%' }} />
        </>
      )}
    </div>
  );
}

function FormatCard({ active, title, subtitle, onClick }: { active: boolean; title: string; subtitle: string; onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      style={{
        flex: 1,
        padding: '12px 14px',
        borderRadius: 10,
        cursor: 'default',
        border: active ? '1.5px solid #3584e4' : '1px solid rgba(255,255,255,0.1)',
        background: active ? 'rgba(53,132,228,0.14)' : 'rgba(255,255,255,0.04)',
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 700, color: '#fff', marginBottom: 3 }}>{title}</div>
      <div style={{ fontSize: 11.5, color: 'rgba(255,255,255,0.5)' }}>{subtitle}</div>
    </div>
  );
}

function chipStyle(active: boolean): CSSProperties {
  return {
    padding: '6px 12px',
    borderRadius: 7,
    fontSize: 12,
    cursor: 'default',
    color: active ? '#fff' : 'rgba(255,255,255,0.7)',
    background: active ? '#3584e4' : 'rgba(255,255,255,0.06)',
  };
}

const labelStyle: CSSProperties = { fontSize: 11, letterSpacing: '.05em', color: 'rgba(255,255,255,0.45)', marginBottom: 8 };
