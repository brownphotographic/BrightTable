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

import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { getLensCatalog, getSearchSuggestions, type AssetSummary, type LensCatalog, type LensEditRequest, type LensMappingMode, type LensSpec } from '../lib/api';
import { useApplications } from '../lib/applications';
import { useLensConfig } from '../lib/lensConfig';
import { buildLensOptions, formatLensSpecs, isZoom, lensKey, type LensOption } from '../lib/lenses';
import { LensPicker, LensSpecForm, lensBtnPrimary, lensBtnSecondary, lensInput } from './LensControls';

const toNum = (s: string) => {
  const n = Number(s.replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
};

// Change Lens - single or bulk. Two modes, matching the two real-world
// cases this exists for:
//  - Replace: a manual lens the camera couldn't identify (or a lens coded
//    as something else) - write the chosen lens into the lens fields.
//  - Keep + note: a 6-bit coded lens whose code is "close enough" for lens
//    corrections - leave the coded lens alone, note the real one in the
//    description.
// Nothing is written until Apply; see lib/lensEdit.tsx for what happens then.
export default function LensEditDialog({ assets, onClose, onSubmit }: { assets: AssetSummary[]; onClose: () => void; onSubmit: (request: LensEditRequest) => Promise<void> }) {
  const { lensConfig, saveLensConfig } = useLensConfig();
  const { exiftoolConfigured } = useApplications();
  const [catalog, setCatalog] = useState<LensCatalog | null>(null);
  const [libraryLenses, setLibraryLenses] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const currentLenses = useMemo(() => [...new Set(assets.map((a) => a.lensModel?.trim() ?? '').filter(Boolean))], [assets]);
  const codedCount = assets.filter((a) => a.lensModel?.trim()).length;
  const mapping = useMemo(
    () => (currentLenses.length === 1 ? lensConfig.mappings.find((m) => m.codedLensModel.trim().toLowerCase() === currentLenses[0].toLowerCase()) : undefined),
    [currentLenses, lensConfig.mappings],
  );

  const [mode, setMode] = useState<LensMappingMode>(mapping?.mode ?? 'replace');
  const [addNote, setAddNote] = useState(mode === 'keepAndNote');
  const [selected, setSelected] = useState<LensOption | null>(null);
  const [focal, setFocal] = useState('');
  const [fNumber, setFNumber] = useState('');
  const [writeOnce, setWriteOnce] = useState(false);
  const [adding, setAdding] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getLensCatalog()
      .then(setCatalog)
      .catch((e) => setLoadError(`Couldn't load the lensfun lens list: ${e}`));
    getSearchSuggestions('camera-lens-model')
      .then(setLibraryLenses)
      .catch(() => {});
  }, []);

  // The mapping's own mode is the sensible default once config loads.
  useEffect(() => {
    if (mapping) {
      setMode(mapping.mode);
      setAddNote(mapping.mode === 'keepAndNote');
    }
  }, [mapping]);

  const options = useMemo(() => buildLensOptions(catalog, lensConfig, libraryLenses, currentLenses), [catalog, lensConfig, libraryLenses, currentLenses]);

  // A mapping with exactly one candidate is the answer nine times out of ten.
  useEffect(() => {
    if (!selected && mapping?.candidates.length === 1) {
      const key = lensKey(mapping.candidates[0]);
      const o = options.find((x) => x.key === key);
      if (o) setSelected(o);
    }
  }, [mapping, options, selected]);

  const spec = selected?.spec ?? null;
  const replace = mode === 'replace';
  const noteOn = mode === 'keepAndNote' || addNote;
  const writeOriginal = replace && (lensConfig.writeOriginals || writeOnce);
  const zoom = !!spec && isZoom(spec);
  const focalUnknown = !!spec && spec.focalMin <= 0;
  const focalRequired = replace && (zoom || focalUnknown);
  const focalValue = toNum(focal);
  const focalOutOfRange = zoom && focalValue != null && (focalValue < spec!.focalMin || focalValue > spec!.focalMax);
  const missingPaths = assets.filter((a) => !a.originalPath).length;

  useEffect(() => {
    setFocal(spec && !isZoom(spec) && spec.focalMin > 0 ? String(spec.focalMin) : '');
  }, [spec]);

  const blocker = !spec
    ? 'Pick a lens'
    : focalRequired && focalValue == null
      ? zoom
        ? 'Enter the as-shot focal length for this zoom'
        : 'Enter the focal length — this lens has none on record'
      : focalOutOfRange
        ? `Focal length must be within ${spec.focalMin}-${spec.focalMax}mm`
        : writeOriginal && !exiftoolConfigured
          ? 'Writing originals needs exiftool — set it in Preferences → Applications'
          : null;

  async function apply() {
    if (!spec || blocker) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({
        lens: spec,
        applyLens: replace,
        addNote: noteOn,
        focalLength: replace ? focalValue : null,
        fNumber: replace ? toNum(fNumber) : null,
        writeOriginalOnce: replace && writeOnce,
      });
      onClose();
    } catch (e) {
      setError(String(e));
      setSubmitting(false);
    }
  }

  async function addCustom(newSpec: LensSpec) {
    setError(null);
    const exists = lensConfig.customLenses.some((c) => lensKey(c) === lensKey(newSpec));
    try {
      if (!exists) await saveLensConfig({ ...lensConfig, customLenses: [...lensConfig.customLenses, newSpec] });
      setSelected({ key: lensKey(newSpec), spec: newSpec, source: 'custom', hasProfile: false, displayName: null });
      setAdding(false);
    } catch (e) {
      setError(`Couldn't save the new lens: ${e}`);
    }
  }

  const count = assets.length;

  return (
    <div className="window-frame window-frame-overlay" style={{ zIndex: 300, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={submitting ? undefined : onClose}>
      <div onClick={(e) => e.stopPropagation()} style={dialog}>
        <div style={header}>
          <span style={{ fontSize: 14, fontWeight: 700 }}>Change Lens</span>
          <span style={{ fontSize: 12.5, color: 'var(--text-dimmer)' }}>
            · {count} {count === 1 ? 'photo' : 'photos'}
          </span>
          <div style={{ flex: 1 }} />
          <div onClick={submitting ? undefined : onClose} style={closeBtn}>
            ✕
          </div>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 14, minHeight: 0 }}>
          <div style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>
            Current lens:{' '}
            {currentLenses.length === 0 ? (
              <i>none recorded</i>
            ) : (
              <b style={{ color: 'var(--text)' }}>
                {currentLenses.slice(0, 3).join(', ')}
                {currentLenses.length > 3 && ` +${currentLenses.length - 3} more`}
              </b>
            )}
            {codedCount > 0 && codedCount < count && ` (${count - codedCount} with none)`}
          </div>

          <div style={{ display: 'flex', gap: 6 }}>
            <ModeButton
              active={replace}
              onClick={() => {
                // The note is implied by Keep; for Replace it's an opt-in extra.
                if (!replace) setAddNote(false);
                setMode('replace');
              }} title="Replace the lens" sub="Write the chosen lens into the lens fields" />
            <ModeButton active={!replace} onClick={() => setMode('keepAndNote')} title="Keep lens, add note" sub={`Leave the lens as is; add "${lensConfig.notePrefix}…" to the description`} />
          </div>

          {mapping && (
            <div style={infoBox}>
              Mapped in Preferences → Lenses: <b>{mapping.codedLensModel}</b> is really {mapping.candidates.length === 1 ? <b>{mapping.candidates[0].model}</b> : `one of ${mapping.candidates.length} lenses (listed first)`}.
            </div>
          )}

          {loadError && <div style={{ fontSize: 12, color: 'var(--danger)' }}>{loadError}</div>}
          {adding ? (
            <LensSpecForm onSave={addCustom} onCancel={() => setAdding(false)} saveLabel="Add to my lenses" />
          ) : (
            <>
              <LensPicker options={options} selectedKey={selected?.key ?? null} onSelect={setSelected} autoFocus />
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button onClick={() => setAdding(true)} style={lensBtnSecondary}>
                  + Add new lens…
                </button>
                <span style={{ fontSize: 11.5, color: 'var(--text-dimmer)' }}>For a lens that isn't listed — any name you like.</span>
              </div>
            </>
          )}

          {spec && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 12, border: '1px solid var(--border)', borderRadius: 10 }}>
              <div style={{ fontSize: 13 }}>
                <b>{spec.model}</b>
                <span style={{ color: 'var(--text-dimmer)' }}> · {[spec.maker || 'no maker', formatLensSpecs(spec)].filter(Boolean).join(' · ')}</span>
              </div>
              {replace && (
                <div style={{ display: 'flex', gap: 10 }}>
                  <label style={fieldLabel}>
                    As-shot focal length (mm){focalRequired ? ' *' : ''}
                    <input value={focal} onChange={(e) => setFocal(e.target.value)} placeholder={zoom ? `${spec.focalMin}-${spec.focalMax}` : '50'} style={lensInput} inputMode="decimal" />
                  </label>
                  <label style={fieldLabel}>
                    As-shot aperture (f/, optional)
                    <input value={fNumber} onChange={(e) => setFNumber(e.target.value)} placeholder="leave as recorded" style={lensInput} inputMode="decimal" />
                  </label>
                </div>
              )}
              {replace && (
                <Check checked={addNote} onChange={setAddNote}>
                  Also add "{lensConfig.notePrefix}
                  {spec.model}" to the description
                </Check>
              )}
              {!selected?.hasProfile && replace && <div style={hintText}>lensfun has no correction profile under this name, so RawTherapee/ART/darktable won't auto-correct it — it's still written for filtering and search.</div>}
            </div>
          )}

          {replace && spec && !lensConfig.writeOriginals && (
            <div style={codedCount > 0 ? warnBox : infoBox}>
              {codedCount > 0 ? (
                <>
                  <b>
                    {count === 1 ? 'This photo already has' : codedCount === count ? 'These photos already have' : `${codedCount} of these photos already ${codedCount === 1 ? 'has' : 'have'}`} a lens recorded by the camera.
                  </b>{' '}
                  Immich (and BrightTable's lens filter) will keep showing it unless the original file is written too. darktable only ever reads the original.
                </>
              ) : (
                <>Writes the XMP sidecar (Immich, BrightTable) and any existing RawTherapee/ART profile. darktable only reads lens info from the original file.</>
              )}
              <div style={{ marginTop: 8 }}>
                <Check checked={writeOnce} onChange={setWriteOnce}>
                  Write the original files for this edit{lensConfig.keepOriginalBackup ? ' (a backup copy is kept)' : ' (no backup — see Preferences → Lenses)'}
                </Check>
              </div>
            </div>
          )}
          {replace && lensConfig.writeOriginals && <div style={infoBox}>Original files will be rewritten via exiftool{lensConfig.keepOriginalBackup ? ', keeping a backup copy next to each' : ' without a backup'} (Preferences → Lenses).</div>}
          {missingPaths > 0 && <div style={warnBox}>{missingPaths} of these photos has no local path — Change Lens needs file access and will fail for those.</div>}
          {error && <div style={{ fontSize: 12, color: 'var(--danger)' }}>{error}</div>}
        </div>

        <div style={footer}>
          {blocker && spec && <span style={{ flex: 1, fontSize: 12, color: 'var(--text-dimmer)' }}>{blocker}</span>}
          <button onClick={onClose} disabled={submitting} style={lensBtnSecondary}>
            Cancel
          </button>
          <button onClick={apply} disabled={submitting || !!blocker} style={lensBtnPrimary(!submitting && !blocker)}>
            {submitting ? 'Applying…' : `Apply to ${count}`}
          </button>
        </div>
      </div>
    </div>
  );
}

function ModeButton({ active, onClick, title, sub }: { active: boolean; onClick: () => void; title: string; sub: string }) {
  return (
    <div
      onClick={onClick}
      style={{
        flex: 1,
        padding: '8px 12px',
        borderRadius: 10,
        cursor: 'default',
        border: active ? '1.5px solid var(--accent)' : '1px solid var(--border)',
        background: active ? 'rgba(53,132,228,0.12)' : 'transparent',
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 700 }}>{title}</div>
      <div style={{ fontSize: 11.5, color: 'var(--text-dimmer)' }}>{sub}</div>
    </div>
  );
}

export function Check({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, cursor: 'default' }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{children}</span>
    </label>
  );
}

const dialog: CSSProperties = {
  width: 560,
  maxWidth: '94%',
  height: 720,
  maxHeight: '90%',
  background: 'var(--dialog-bg)',
  borderRadius: 14,
  boxShadow: '0 24px 70px rgba(0,0,0,0.7)',
  border: '1px solid var(--border)',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
};
const header: CSSProperties = { height: 50, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10, padding: '0 10px 0 18px', background: 'var(--panel)', borderBottom: '1px solid rgba(0,0,0,0.4)' };
const closeBtn: CSSProperties = { width: 30, height: 30, borderRadius: '50%', background: 'var(--overlay-medium)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'default', fontSize: 14 };
const footer: CSSProperties = { flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, padding: '12px 18px', borderTop: '1px solid rgba(0,0,0,0.3)' };
const fieldLabel: CSSProperties = { flex: 1, display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11.5, color: 'var(--text-dim)' };
const hintText: CSSProperties = { fontSize: 11.5, color: 'var(--text-dimmer)' };
const infoBox: CSSProperties = { fontSize: 12, lineHeight: 1.45, padding: '9px 12px', borderRadius: 9, background: 'var(--overlay-weak)', color: 'var(--text-dim)' };
const warnBox: CSSProperties = { ...infoBox, background: 'rgba(229,165,10,0.12)', border: '1px solid rgba(229,165,10,0.35)', color: 'var(--text)' };
