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

import type { CSSProperties } from 'react';
import type { ExportFormat, MetadataPolicy } from '../lib/api';

// Shared Format/Size/Quality/Metadata controls for ExportToFolderDialog and
// ExportToFlickrDialog - identical fields, per the design prototype's Export
// to Folder dialog (Immich Desktop.dc.html), reused rather than duplicated
// across the two real dialogs.
const SIZE_OPTIONS: { label: string; px: number | null }[] = [
  { label: 'Full size', px: null },
  { label: '2048 px', px: 2048 },
  { label: '1024 px', px: 1024 },
  { label: '640 px', px: 640 },
];

const METADATA_OPTIONS: { label: string; value: MetadataPolicy }[] = [
  { label: 'Keep all', value: 'keep' },
  { label: 'Remove GPS only', value: 'removeGps' },
  { label: 'Strip all', value: 'stripAll' },
];

export default function ExportSizeQualityFields({
  format,
  onFormatChange,
  sizePx,
  onSizePxChange,
  quality,
  onQualityChange,
  metadata,
  onMetadataChange,
  hasRawOriginal,
  hasVideo,
}: {
  format: ExportFormat;
  onFormatChange: (f: ExportFormat) => void;
  sizePx: number | null;
  onSizePxChange: (px: number | null) => void;
  quality: number;
  onQualityChange: (q: number) => void;
  metadata: MetadataPolicy;
  onMetadataChange: (m: MetadataPolicy) => void;
  // Whether any selected asset is RAW - only relevant for the "Original"
  // format's in-place exiftool rewrite (see the disclaimer below); the
  // "JPEG" rendition path always produces an ordinary JPEG regardless of
  // source, so it needs no caveat.
  hasRawOriginal: boolean;
  // Whether any selected asset is a video - there's no such thing as a
  // "JPEG rendition" of a video, so the backend always exports/shares those
  // as their true original file regardless of the Format choice below (see
  // export_queue::resolve_rendition). Surfaced here as a note rather than by
  // hiding the JPEG option, since a mixed photo+video selection still uses
  // JPEG for the photos in it.
  hasVideo: boolean;
}) {
  return (
    <div>
      <div style={labelStyle}>FORMAT</div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <FormatCard active={format === 'jpeg'} title="JPEG" subtitle="Rendered & resized" onClick={() => onFormatChange('jpeg')} />
        <FormatCard active={format === 'original'} title="Original" subtitle="Copy the source file" onClick={() => onFormatChange('original')} />
      </div>

      {format === 'jpeg' && hasVideo && (
        <div style={{ fontSize: 11.5, color: 'var(--text-dimmer)', marginBottom: 12, lineHeight: 1.5 }}>
          Videos in this selection are always exported as their original file — size and quality below only apply to
          photos.
        </div>
      )}

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
            <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>JPEG quality</span>
            <span style={{ font: '600 13px ui-monospace,monospace', color: 'var(--accent-text)' }}>{quality}</span>
          </div>
          <input type="range" min={50} max={100} step={1} value={quality} onChange={(e) => onQualityChange(Number(e.target.value))} style={{ width: '100%', marginBottom: 16 }} />
        </>
      )}

      <div style={labelStyle}>METADATA</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {METADATA_OPTIONS.map((opt) => (
          <div key={opt.value} onClick={() => onMetadataChange(opt.value)} style={chipStyle(metadata === opt.value)}>
            {opt.label}
          </div>
        ))}
      </div>
      {format === 'original' && hasRawOriginal && metadata !== 'keep' && (
        <div style={{ fontSize: 11.5, color: 'var(--text-dimmer)', marginTop: 8, lineHeight: 1.5 }}>
          RAW originals are rewritten in place with exiftool — camera maker-note data may not be fully removable on
          all RAW formats.
        </div>
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
        border: active ? '1.5px solid #3584e4' : '1px solid var(--border)',
        background: active ? 'rgba(53,132,228,0.14)' : 'var(--overlay-weak)',
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', marginBottom: 3 }}>{title}</div>
      <div style={{ fontSize: 11.5, color: 'var(--text-dimmer)' }}>{subtitle}</div>
    </div>
  );
}

function chipStyle(active: boolean): CSSProperties {
  return {
    padding: '6px 12px',
    borderRadius: 7,
    fontSize: 12,
    cursor: 'default',
    color: active ? '#fff' : 'var(--text-dim)',
    background: active ? '#3584e4' : 'var(--overlay-weak)',
  };
}

const labelStyle: CSSProperties = { fontSize: 11, letterSpacing: '.05em', color: 'var(--text-dimmer)', marginBottom: 8 };
