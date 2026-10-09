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

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { LensSpec } from '../lib/api';
import { formatLensSpecs, guessLensParameters, matchesLensQuery, type LensOption, type LensSource } from '../lib/lenses';

// Shared by the Change Lens dialog and Preferences → Lenses.

const SOURCE_LABEL: Record<LensSource, string> = {
  mapping: 'Mapped',
  custom: 'My lenses',
  library: 'In library',
  lensfun: 'lensfun',
};

// lensfun alone is ~1300 entries - rendering every row of an unfiltered list
// is wasted work when nobody scrolls that far; typing narrows it instead.
const MAX_ROWS = 200;

// `selectedOption` (when given) is always visible: if the search filters it
// out, it's past MAX_ROWS, or it isn't in `options` at all (a lens picked by
// a switch rather than a click here), it's pinned on top under "Selected".
// A selection made from outside the list is scrolled into view.
export function LensPicker({
  options,
  selectedKey,
  selectedOption,
  onSelect,
  height = 260,
  autoFocus,
}: {
  options: LensOption[];
  selectedKey: string | null;
  selectedOption?: LensOption | null;
  onSelect: (o: LensOption) => void;
  height?: number;
  autoFocus?: boolean;
}) {
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => options.filter((o) => matchesLensQuery(o, query)), [options, query]);
  const capped = filtered.slice(0, MAX_ROWS);
  const pinned = selectedOption && !capped.some((o) => o.key === selectedOption.key) ? selectedOption : null;
  const shown = pinned ? [pinned, ...capped] : capped;
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const clickedKey = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedKey || clickedKey.current === selectedKey) return;
    rowRefs.current.get(selectedKey)?.scrollIntoView({ block: 'nearest' });
  }, [selectedKey]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search lenses… (e.g. summicron 50, nokton, zeiss zm)" style={lensInput} autoFocus={autoFocus} />
      <div style={{ height, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 9, background: 'var(--surface-sunken)' }}>
        {shown.length === 0 && <div style={{ padding: '16px 12px', fontSize: 12.5, color: 'var(--text-dimmer)' }}>No lens matches — add it as a new lens below.</div>}
        {shown.map((o, i) => {
          const selected = o.key === selectedKey;
          const isPinned = pinned != null && i === 0;
          const groupStart = i === 0 || (pinned != null && i === 1) || shown[i - 1].source !== o.source;
          const specs = formatLensSpecs(o.spec);
          return (
            <div key={isPinned ? `pinned:${o.key}` : o.key}>
              {groupStart && <div style={groupHeader}>{isPinned ? 'Selected' : SOURCE_LABEL[o.source]}</div>}
              <div
                ref={(el) => {
                  if (el) rowRefs.current.set(o.key, el);
                  else rowRefs.current.delete(o.key);
                }}
                onClick={() => {
                  clickedKey.current = o.key;
                  onSelect(o);
                }}
                style={{
                  padding: '6px 12px',
                  cursor: 'default',
                  background: selected ? 'rgba(53,132,228,0.18)' : 'transparent',
                  borderLeft: selected ? '3px solid var(--accent)' : '3px solid transparent',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.spec.model}</span>
                  {o.hasProfile && (
                    <span title="lensfun has a correction profile under this exact name" style={badge('rgba(46,194,126,0.18)', '#8ce0ae')}>
                      profile
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--text-dimmer)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {[o.spec.maker || 'No maker', specs, o.spec.mount].filter(Boolean).join(' · ')}
                </div>
              </div>
            </div>
          );
        })}
        {filtered.length > capped.length && (
          <div style={{ padding: '8px 12px', fontSize: 11.5, color: 'var(--text-dimmer)' }}>
            {filtered.length - capped.length} more — keep typing to narrow it down.
          </div>
        )}
      </div>
    </div>
  );
}

const EMPTY_SPEC: LensSpec = { maker: '', model: '', mount: null, focalMin: 0, focalMax: 0, apertureMax: 0, apertureMaxTele: null };

const toNum = (s: string) => {
  const n = Number(s.replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

// Free-text lens entry - the maker/model strings are written verbatim to
// LensMake/LensModel, so this never "corrects" what the user typed. Focal
// length/aperture are prefilled from the model name when left blank.
export function LensSpecForm({ initial, onSave, onCancel, saveLabel = 'Save lens' }: { initial?: LensSpec; onSave: (spec: LensSpec) => void; onCancel: () => void; saveLabel?: string }) {
  const start = initial ?? EMPTY_SPEC;
  const [maker, setMaker] = useState(start.maker);
  const [model, setModel] = useState(start.model);
  const [mount, setMount] = useState(start.mount ?? '');
  const [focalMin, setFocalMin] = useState(start.focalMin ? String(start.focalMin) : '');
  const [focalMax, setFocalMax] = useState(start.focalMax && start.focalMax !== start.focalMin ? String(start.focalMax) : '');
  const [aperture, setAperture] = useState(start.apertureMax ? String(start.apertureMax) : '');
  const [apertureTele, setApertureTele] = useState(start.apertureMaxTele ? String(start.apertureMaxTele) : '');

  const guessed = useMemo(() => guessLensParameters(model), [model]);

  function save() {
    const fmin = toNum(focalMin) || guessed.focalMin || 0;
    const fmax = toNum(focalMax) || (focalMin ? fmin : guessed.focalMax ?? fmin);
    const amax = toNum(aperture) || guessed.apertureMax || 0;
    const tele = toNum(apertureTele) || (aperture ? 0 : guessed.apertureMaxTele ?? 0);
    onSave({
      maker: maker.trim(),
      model: model.trim(),
      mount: mount.trim() || null,
      focalMin: fmin,
      focalMax: Math.max(fmax, fmin),
      apertureMax: amax,
      apertureMaxTele: tele && tele !== amax ? tele : null,
    });
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, padding: 12, border: '1px solid var(--border)', borderRadius: 10, background: 'var(--overlay-weak)' }}>
      <label style={fieldLabel}>
        Model (written to LensModel)
        <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="e.g. Planar T* 2/50 ZM" style={lensInput} autoFocus />
      </label>
      <label style={fieldLabel}>
        Maker (written to LensMake)
        <input value={maker} onChange={(e) => setMaker(e.target.value)} placeholder="e.g. Zeiss" style={lensInput} />
      </label>
      <label style={fieldLabel}>
        Focal length (mm) — min / max for a zoom
        <div style={{ display: 'flex', gap: 6 }}>
          <input value={focalMin} onChange={(e) => setFocalMin(e.target.value)} placeholder={guessed.focalMin ? String(guessed.focalMin) : '50'} style={lensInput} inputMode="decimal" />
          <input value={focalMax} onChange={(e) => setFocalMax(e.target.value)} placeholder={guessed.focalMax && guessed.focalMax !== guessed.focalMin ? String(guessed.focalMax) : 'prime'} style={lensInput} inputMode="decimal" />
        </div>
      </label>
      <label style={fieldLabel}>
        Widest aperture (f/) — and at the long end
        <div style={{ display: 'flex', gap: 6 }}>
          <input value={aperture} onChange={(e) => setAperture(e.target.value)} placeholder={guessed.apertureMax ? String(guessed.apertureMax) : '2'} style={lensInput} inputMode="decimal" />
          <input value={apertureTele} onChange={(e) => setApertureTele(e.target.value)} placeholder={guessed.apertureMaxTele ? String(guessed.apertureMaxTele) : 'same'} style={lensInput} inputMode="decimal" />
        </div>
      </label>
      <label style={fieldLabel}>
        Mount (optional)
        <input value={mount} onChange={(e) => setMount(e.target.value)} placeholder="e.g. Leica M" style={lensInput} />
      </label>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end', gap: 8 }}>
        <button onClick={onCancel} style={lensBtnSecondary}>
          Cancel
        </button>
        <button onClick={save} disabled={!model.trim()} style={lensBtnPrimary(!!model.trim())}>
          {saveLabel}
        </button>
      </div>
    </div>
  );
}

function badge(bg: string, color: string): CSSProperties {
  return { fontSize: 10, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', padding: '1px 6px', borderRadius: 999, background: bg, color, flexShrink: 0 };
}

const groupHeader: CSSProperties = {
  position: 'sticky',
  top: 0,
  padding: '6px 12px 4px',
  fontSize: 10.5,
  letterSpacing: '.06em',
  textTransform: 'uppercase',
  color: 'var(--text-dimmer)',
  background: 'var(--surface-sunken)',
  zIndex: 1,
};

const fieldLabel: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11.5, color: 'var(--text-dim)' };

export const lensInput: CSSProperties = {
  height: 32,
  padding: '0 10px',
  background: 'var(--surface-sunken)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  color: 'var(--text)',
  fontSize: 13,
  minWidth: 0,
  width: '100%',
  boxSizing: 'border-box',
};

const btnBase: CSSProperties = { height: 32, padding: '0 14px', borderRadius: 8, border: 'none', fontSize: 12.5, cursor: 'default', whiteSpace: 'nowrap' };

export const lensBtnSecondary: CSSProperties = { ...btnBase, border: '1px solid var(--border-strong)', background: 'var(--overlay-weak)', color: 'var(--text)' };

export function lensBtnPrimary(enabled: boolean): CSSProperties {
  return { ...btnBase, background: '#3584e4', color: '#fff', fontWeight: 700, opacity: enabled ? 1 : 0.45 };
}
