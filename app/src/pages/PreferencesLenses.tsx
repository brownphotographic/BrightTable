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

import { useEffect, useId, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import Switch from '../components/Switch';
import { LensPicker, LensSpecForm, lensBtnSecondary, lensInput } from '../components/LensControls';
import { getLensCatalog, getSearchSuggestions, type LensCatalog, type LensConfig, type LensMapping, type LensMappingMode, type LensSpec } from '../lib/api';
import { useLensConfig } from '../lib/lensConfig';
import { buildLensOptions, formatLensSpecs, lensKey } from '../lib/lenses';

// Preferences → Lenses: how Change Lens writes, the user's own lenses (any
// name - most manual lenses aren't in lensfun), and coded-lens mappings for
// 6-bit coded Leica M lenses that are really something else.
export default function PreferencesLenses() {
  const { lensConfig, saveLensConfig } = useLensConfig();
  const [catalog, setCatalog] = useState<LensCatalog | null>(null);
  const [libraryLenses, setLibraryLenses] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editingLens, setEditingLens] = useState<number | 'new' | null>(null);
  const [notePrefix, setNotePrefix] = useState(lensConfig.notePrefix);

  useEffect(() => setNotePrefix(lensConfig.notePrefix), [lensConfig.notePrefix]);
  useEffect(() => {
    getLensCatalog().then(setCatalog).catch(() => {});
    getSearchSuggestions('camera-lens-model').then(setLibraryLenses).catch(() => {});
  }, []);

  function save(next: LensConfig) {
    setError(null);
    saveLensConfig(next).catch((e) => setError(`Couldn't save: ${e}`));
  }

  function saveCustomLens(spec: LensSpec) {
    const lenses = lensConfig.customLenses.slice();
    if (editingLens === 'new') {
      if (lenses.some((l) => lensKey(l) === lensKey(spec))) {
        setError(`"${spec.model}" is already in your lenses`);
        return;
      }
      lenses.push(spec);
    } else if (typeof editingLens === 'number') {
      lenses[editingLens] = spec;
    }
    lenses.sort((a, b) => a.model.localeCompare(b.model));
    save({ ...lensConfig, customLenses: lenses });
    setEditingLens(null);
  }

  function updateMapping(i: number, next: LensMapping | null) {
    const mappings = lensConfig.mappings.slice();
    if (next) mappings[i] = next;
    else mappings.splice(i, 1);
    save({ ...lensConfig, mappings });
  }

  return (
    <div style={{ maxWidth: 640, margin: '0 auto', padding: '24px 0' }}>
      {error && <div style={{ ...helpText, color: 'var(--danger)', margin: '0 4px 12px' }}>{error}</div>}

      <SectionTitle>Writing lens changes</SectionTitle>
      <div style={panel}>
        <Row label="Write original files" sub="Rewrites LensModel/LensMake/focal length inside the RAW/JPEG itself via exiftool. Needed for darktable, and for Immich when the camera already recorded a (wrong) lens.">
          <Switch checked={lensConfig.writeOriginals} onChange={(v) => save({ ...lensConfig, writeOriginals: v })} />
        </Row>
        <Divider />
        <Row label="Keep a backup of originals" sub="exiftool leaves the untouched file next to it as <name>_original.">
          <Switch checked={lensConfig.keepOriginalBackup} onChange={(v) => save({ ...lensConfig, keepOriginalBackup: v })} />
        </Row>
        <Divider />
        <Row label="Update RawTherapee / ART profiles" sub="Sets an existing .pp3/.arp to use the chosen lens (lensfun manual mode). Profiles are never created.">
          <Switch checked={lensConfig.updateRawProfiles} onChange={(v) => save({ ...lensConfig, updateRawProfiles: v })} />
        </Row>
        <Divider />
        <Row label="Description note prefix" sub={`Added as "${lensConfig.notePrefix}Planar T* 2/50 ZM" on its own line; re-applying replaces it.`}>
          <input
            value={notePrefix}
            onChange={(e) => setNotePrefix(e.target.value)}
            onBlur={() => notePrefix !== lensConfig.notePrefix && notePrefix.trim() && save({ ...lensConfig, notePrefix })}
            style={{ ...lensInput, width: 120 }}
          />
        </Row>
      </div>
      <div style={helpText}>
        Without "Write original files", changes go to the XMP sidecar (read by Immich and BrightTable) and existing RawTherapee/ART profiles. RawTherapee, ART and darktable never read lens info from XMP sidecars.
      </div>

      <SectionTitle>My lenses</SectionTitle>
      <div style={panel}>
        {lensConfig.customLenses.length === 0 && editingLens !== 'new' && <div style={{ padding: '14px 16px', fontSize: 13, color: 'var(--text-dimmer)' }}>No lenses yet. Add any lens by name — manual and adapted lenses most often aren't in lensfun.</div>}
        {lensConfig.customLenses.map((l, i) => (
          <div key={lensKey(l)}>
            {i > 0 && <Divider />}
            {editingLens === i ? (
              <div style={{ padding: 10 }}>
                <LensSpecForm initial={l} onSave={saveCustomLens} onCancel={() => setEditingLens(null)} />
              </div>
            ) : (
              <LensRow spec={l} onEdit={() => setEditingLens(i)} onRemove={() => save({ ...lensConfig, customLenses: lensConfig.customLenses.filter((_, j) => j !== i) })} />
            )}
          </div>
        ))}
        {editingLens === 'new' && (
          <div style={{ padding: 10 }}>
            <LensSpecForm onSave={saveCustomLens} onCancel={() => setEditingLens(null)} saveLabel="Add lens" />
          </div>
        )}
      </div>
      {editingLens !== 'new' && (
        <div style={{ marginTop: 10 }}>
          <button onClick={() => setEditingLens('new')} style={lensBtnSecondary}>
            + Add lens
          </button>
        </div>
      )}
      <div style={helpText}>The model and maker are written exactly as typed. For lens corrections in RawTherapee/ART/darktable, use lensfun's own name (the Change Lens picker marks those with a "profile" badge).</div>

      <SectionTitle>Coded lens mappings</SectionTitle>
      <div style={helpText}>
        For 6-bit coded Leica M lenses (or hand-coded ones) whose code names a different lens. When the photos you open Change Lens on all carry the coded lens, its mapped lenses are listed first and its mode is preselected.
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
        {lensConfig.mappings.map((m, i) => (
          <MappingCard key={i} mapping={m} catalog={catalog} lensConfig={lensConfig} libraryLenses={libraryLenses} onChange={(next) => updateMapping(i, next)} />
        ))}
      </div>
      <div style={{ marginTop: 10 }}>
        <button onClick={() => save({ ...lensConfig, mappings: [...lensConfig.mappings, { codedLensModel: '', mode: 'keepAndNote', candidates: [] }] })} style={lensBtnSecondary}>
          + Add mapping
        </button>
      </div>

      {catalog && (
        <div style={{ ...helpText, marginTop: 28 }}>
          Lens list: {catalog.lenses.length} interchangeable lenses from the{' '}
          <a href={catalog.source.repo} target="_blank" rel="noreferrer" style={{ color: 'var(--accent-text)' }}>
            lensfun
          </a>{' '}
          database{catalog.source.date ? ` (${catalog.source.date})` : ''} — the same database RawTherapee, ART and darktable match against. License {catalog.license}.
        </div>
      )}
    </div>
  );
}

function MappingCard({ mapping, catalog, lensConfig, libraryLenses, onChange }: { mapping: LensMapping; catalog: LensCatalog | null; lensConfig: LensConfig; libraryLenses: string[]; onChange: (next: LensMapping | null) => void }) {
  const [coded, setCoded] = useState(mapping.codedLensModel);
  const [picking, setPicking] = useState(mapping.candidates.length === 0 && !!mapping.codedLensModel);
  useEffect(() => setCoded(mapping.codedLensModel), [mapping.codedLensModel]);

  // Candidates are real lenses - mapping candidates of *other* mappings
  // aren't relevant here, so pass no coded lenses.
  const options = useMemo(() => buildLensOptions(catalog, lensConfig, libraryLenses, []), [catalog, lensConfig, libraryLenses]);
  const datalistId = useId();

  return (
    <div style={{ ...panel, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span style={{ fontSize: 12.5, color: 'var(--text-dim)', flexShrink: 0 }}>Camera says</span>
        <input
          value={coded}
          list={datalistId}
          onChange={(e) => setCoded(e.target.value)}
          onBlur={() => coded.trim() !== mapping.codedLensModel && onChange({ ...mapping, codedLensModel: coded.trim() })}
          placeholder="Coded lens, exactly as shown in the Lens row (e.g. Summicron-M 1:2/50)"
          style={lensInput}
        />
        <datalist id={datalistId}>
          {libraryLenses.map((l) => (
            <option key={l} value={l} />
          ))}
        </datalist>
        <div onClick={() => onChange(null)} title="Remove mapping" style={{ cursor: 'default', color: 'var(--text-dimmer)', padding: '0 4px' }}>
          ✕
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <span style={{ fontSize: 12.5, color: 'var(--text-dim)', marginRight: 4 }}>Default action</span>
        {(
          [
            { value: 'keepAndNote', label: 'Keep lens entry, add note' },
            { value: 'replace', label: 'Replace entry' },
          ] as { value: LensMappingMode; label: string }[]
        ).map((o) => (
          <div key={o.value} onClick={() => onChange({ ...mapping, mode: o.value })} style={segment(mapping.mode === o.value)}>
            {o.label}
          </div>
        ))}
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>Actually one of:</div>
      {mapping.candidates.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-dimmer)' }}>No lenses yet.</div>}
      {mapping.candidates.map((c, i) => (
        <LensRow key={lensKey(c)} spec={c} compact onRemove={() => onChange({ ...mapping, candidates: mapping.candidates.filter((_, j) => j !== i) })} />
      ))}
      {picking ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <LensPicker
            options={options.filter((o) => !mapping.candidates.some((c) => lensKey(c) === o.key))}
            selectedKey={null}
            height={200}
            onSelect={(o) => {
              onChange({ ...mapping, candidates: [...mapping.candidates, o.spec] });
              setPicking(false);
            }}
          />
          <div>
            <button onClick={() => setPicking(false)} style={lensBtnSecondary}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <div>
          <button onClick={() => setPicking(true)} style={lensBtnSecondary}>
            + Add lens
          </button>
        </div>
      )}
    </div>
  );
}

function LensRow({ spec, onEdit, onRemove, compact }: { spec: LensSpec; onEdit?: () => void; onRemove: () => void; compact?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: compact ? '4px 0' : '10px 16px' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{spec.model}</div>
        <div style={{ fontSize: 11.5, color: 'var(--text-dimmer)' }}>{[spec.maker || 'No maker', formatLensSpecs(spec), spec.mount].filter(Boolean).join(' · ')}</div>
      </div>
      {onEdit && (
        <button onClick={onEdit} style={lensBtnSecondary}>
          Edit
        </button>
      )}
      <div onClick={onRemove} title="Remove" style={{ cursor: 'default', color: 'var(--text-dimmer)', padding: '0 4px' }}>
        ✕
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: 14, fontWeight: 700, margin: '26px 4px 10px' }}>{children}</div>;
}

function Row({ label, sub, children }: { label: string; sub?: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', padding: '11px 16px', gap: 14 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5 }}>{label}</div>
        {sub && <div style={{ fontSize: 11.5, color: 'var(--text-dimmer)', marginTop: 2, lineHeight: 1.4 }}>{sub}</div>}
      </div>
      <div style={{ flexShrink: 0 }}>{children}</div>
    </div>
  );
}

function Divider() {
  return <div style={{ height: 1, background: 'var(--border)', marginLeft: 16 }} />;
}

function segment(active: boolean): CSSProperties {
  return {
    padding: '5px 11px',
    borderRadius: 7,
    fontSize: 12.5,
    cursor: 'default',
    background: active ? 'var(--accent)' : 'var(--overlay-weak)',
    color: active ? '#fff' : 'var(--text-dim)',
  };
}

const panel: CSSProperties = {
  background: 'var(--panel)',
  borderRadius: 13,
  overflow: 'hidden',
  border: '1px solid var(--border)',
};

const helpText: CSSProperties = {
  fontSize: 12,
  color: 'var(--text-dimmer)',
  margin: '12px 4px 0',
  lineHeight: 1.5,
};
