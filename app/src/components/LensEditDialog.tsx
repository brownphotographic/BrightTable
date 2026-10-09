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

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { getLensCatalog, getSearchSuggestions, type AssetSummary, type LensCatalog, type LensEditRequest, type LensMapping, type LensMappingMode, type LensSpec } from '../lib/api';
import { useApplications } from '../lib/applications';
import { useLensConfig } from '../lib/lensConfig';
import type { CopiedLens } from '../lib/lensEdit';
import CopiedLensCard from './CopiedLensCard';
import { Icon } from './Icons';
import { buildLensOptions, copiedLensKeeps, copiedLensName, formatLensSpecs, isZoom, lensKey, specFromName, type LensOption } from '../lib/lenses';
import { requestPreferences } from '../lib/preferencesRequest';
import { LensPicker, lensBtnPrimary, lensBtnSecondary, lensInput } from './LensControls';

const toNum = (s: string) => {
  const n = Number(s.replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
};

// Change Lens - single or bulk. Two independent choices, for the two
// real-world cases this exists for and their mixes:
//  - Lens entry: Replace writes a lens into the lens fields (a manual lens
//    the camera couldn't identify, or one coded as something else); Keep
//    leaves them alone.
//  - Description note: adds "Lens: <lens>" to the description - e.g. for a
//    6-bit coded lens whose code is "close enough" for lens corrections.
// Each gets its own lens list, side by side when both are on, so the entry
// can name the lens whose correction profile to use while the note records
// the lens actually used. The note follows the entry's lens until a
// different one is picked for it.
// Nothing is written until Apply; see lib/lensEdit.tsx for what happens then.
//
// `prefill` (Paste Lens) fills the dialog in from a copied lens, taking
// precedence over a coded-lens mapping's defaults, and reproduces the source
// as it is: Replace with its lens entry at its focal length, plus its note
// (as its own lens when that differs). Only a source with a note but no lens
// pastes as Keep + note. A pasted lens that's part of a mapping gets the
// Coded/Mapped lens switch like any other.
export default function LensEditDialog({
  assets,
  prefill,
  onClose,
  onSubmit,
}: {
  assets: AssetSummary[];
  prefill?: CopiedLens;
  onClose: () => void;
  onSubmit: (request: LensEditRequest) => Promise<void>;
}) {
  const { lensConfig } = useLensConfig();
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

  const prefillKeep = !!prefill && copiedLensKeeps(prefill);
  const [mode, setMode] = useState<LensMappingMode>(prefill ? (prefillKeep ? 'keepAndNote' : 'replace') : (mapping?.mode ?? 'replace'));
  const [addNote, setAddNote] = useState(prefill ? !!prefill.noteLens : mode === 'keepAndNote');
  // Consumed once: the copied focal length, applied when the prefilled entry
  // lens gets selected (instead of the prime's own focal / a blank zoom field).
  const prefillFocal = useRef(prefill?.focalLength ?? null);
  const prefillResolved = useRef(false);
  const [entrySel, setEntrySel] = useState<LensOption | null>(null);
  // null = follow the entry's lens (while Replace is on).
  const [noteSel, setNoteSel] = useState<LensOption | null>(null);
  const [focal, setFocal] = useState('');
  const [fNumber, setFNumber] = useState('');
  const [writeOnce, setWriteOnce] = useState(false);
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
    if (mapping && !prefill) {
      setMode(mapping.mode);
      setAddNote(mapping.mode === 'keepAndNote');
    }
  }, [mapping, prefill]);

  const options = useMemo(() => buildLensOptions(catalog, lensConfig, libraryLenses, currentLenses), [catalog, lensConfig, libraryLenses, currentLenses]);

  // A mapping with exactly one candidate is the answer nine times out of ten
  // - it's the actual lens, so it goes wherever the mapping's mode says the
  // actual lens belongs: the note for Keep, the entry for Replace.
  useEffect(() => {
    if (!prefill && !entrySel && !noteSel && mapping?.candidates.length === 1) {
      const key = lensKey(mapping.candidates[0]);
      const o = options.find((x) => x.key === key);
      if (o) (mapping.mode === 'keepAndNote' ? setNoteSel : setEntrySel)(o);
    }
  }, [mapping, options, entrySel, noteSel, prefill]);

  // Picks the copied lens(es) once the lensfun list has loaded (or failed),
  // so a lens lensfun knows gets its specs/profile badge rather than a guess
  // from its name - which is the fallback when no picker entry has that name.
  useEffect(() => {
    if (!prefill || prefillResolved.current || (!catalog && !loadError)) return;
    prefillResolved.current = true;
    const resolve = (name: string): LensOption => {
      const found = options.find((o) => o.spec.model.trim().toLowerCase() === name.trim().toLowerCase());
      const fallback = specFromName(name);
      return found ?? { key: lensKey(fallback), spec: fallback, source: 'library', hasProfile: false, displayName: null };
    };
    if (prefillKeep) {
      setNoteSel(resolve(copiedLensName(prefill)));
      return;
    }
    const entryName = prefill.lensModel ?? prefill.noteLens;
    if (entryName) setEntrySel(resolve(entryName));
    // Always explicit, even when it names the entry's lens - the note's own
    // default (the coded side of a mapping) mustn't override what's pasted.
    if (prefill.noteLens) setNoteSel(resolve(prefill.noteLens));
  }, [prefill, prefillKeep, options, catalog, loadError]);

  const replace = mode === 'replace';
  const noteOn = addNote;
  const spec = entrySel?.spec ?? null;

  // Coded lens vs Mapped lens - a one-click switch, on both the lens entry
  // and the note, whenever the lens involved is part of a coded-lens mapping:
  // either every selected photo carries the coded lens ("Camera's lens"), or
  // the lens picked / pasted is a mapping's coded lens or one of its
  // candidates ("Coded lens") - e.g. a photo with no lens recorded. The
  // coded side resolves to its picker entry (lensfun's specs when lensfun
  // knows the name); the mapped side to the candidate last used, else the
  // first. A pair is pinned once used (per side), so flipping back and forth
  // stays on the same mapping even when a candidate appears in several.
  const lc = (m: string) => m.trim().toLowerCase();
  const inMapping = (m: LensMapping, model: string) => lc(m.codedLensModel) === lc(model) || m.candidates.some((c) => lc(c.model) === lc(model));
  const toOption = (spec: LensSpec): LensOption => options.find((o) => o.key === lensKey(spec)) ?? options.find((o) => lc(o.spec.model) === lc(spec.model)) ?? { key: lensKey(spec), spec, source: 'mapping', hasProfile: false, displayName: null };
  const [entryMemo, setEntryMemo] = useState<PairMemo | null>(null);
  const [noteMemo, setNoteMemo] = useState<PairMemo | null>(null);
  const pairFor = (sel: LensOption | null, memo: PairMemo | null, fallback: LensMapping | null): LensPair | null => {
    const m =
      mapping ?? (sel ? (memo && inMapping(memo.mapping, sel.spec.model) ? memo.mapping : lensConfig.mappings.find((x) => inMapping(x, sel.spec.model))) : null) ?? fallback;
    if (!m) return null;
    const codedName = mapping ? currentLenses[0] : m.codedLensModel;
    const candidate = sel ? m.candidates.find((c) => lc(c.model) === lc(sel.spec.model)) : undefined;
    const mappedSpec = candidate ?? (memo?.mapping === m ? memo.candidate : m.candidates[0]);
    if (!mappedSpec) return null;
    const source: PairSide = !sel ? 'other' : lc(sel.spec.model) === lc(codedName) ? 'coded' : candidate ? 'mapped' : 'other';
    return { mapping: m, coded: toOption(specFromName(codedName)), mapped: toOption(mappedSpec), source };
  };
  const entryPair = pairFor(entrySel, entryMemo, null);
  const switchEntry = (v: PairSide) => {
    if (!entryPair) return;
    setEntryMemo({ mapping: entryPair.mapping, candidate: entryPair.mapped.spec });
    setEntrySel(v === 'coded' ? entryPair.coded : entryPair.mapped);
  };
  // The note defaults to the mapped side of the entry's pair when there is
  // one (per the user - the note records the lens actually used), else to
  // the entry's own lens; an explicit pick (list, switch, mapping/paste
  // preselect) wins.
  const noteOption = noteSel ?? (entryPair ? entryPair.mapped : replace ? entrySel : null);
  const noteSpec = noteOption?.spec ?? null;
  const notePair = pairFor(noteOption, noteMemo, entryPair?.mapping ?? null);
  const switchNote = (v: PairSide) => {
    if (!notePair) return;
    setNoteMemo({ mapping: notePair.mapping, candidate: notePair.mapped.spec });
    setNoteSel(v === 'coded' ? notePair.coded : notePair.mapped);
  };
  const noteMatchesEntry = !!spec && !!noteSpec && lc(spec.model) === lc(noteSpec.model);
  const codedLabel = mapping ? "Camera's lens" : 'Coded lens';
  const writeOriginal = replace && (lensConfig.writeOriginals || writeOnce);
  const zoom = !!spec && isZoom(spec);
  const focalUnknown = !!spec && spec.focalMin <= 0;
  const focalRequired = replace && (zoom || focalUnknown);
  const focalValue = toNum(focal);
  const focalOutOfRange = zoom && focalValue != null && (focalValue < spec!.focalMin || focalValue > spec!.focalMax);
  const missingPaths = assets.filter((a) => !a.originalPath).length;

  useEffect(() => {
    if (spec && prefillFocal.current != null) {
      setFocal(String(Math.round(prefillFocal.current * 10) / 10));
      prefillFocal.current = null;
      return;
    }
    setFocal(spec && !isZoom(spec) && spec.focalMin > 0 ? String(spec.focalMin) : '');
  }, [spec]);

  const blocker =
    !replace && !noteOn
      ? 'Nothing to change — replace the entry or add a note'
      : replace && !spec
        ? 'Pick the lens for the lens entry'
        : noteOn && !noteSpec
          ? 'Pick the lens for the note'
          : focalRequired && focalValue == null
            ? zoom
              ? 'Enter the as-shot focal length for this zoom'
              : 'Enter the focal length — this lens has none on record'
            : focalOutOfRange
              ? `Focal length must be within ${spec!.focalMin}-${spec!.focalMax}mm`
              : writeOriginal && !exiftoolConfigured
                ? 'Writing originals needs exiftool — set it in Preferences → Applications'
                : null;

  async function apply() {
    const lens = replace ? spec : noteSpec;
    if (!lens || blocker) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({
        lens,
        applyLens: replace,
        addNote: noteOn,
        focalLength: replace ? focalValue : null,
        fNumber: replace ? toNum(fNumber) : null,
        writeOriginalOnce: replace && writeOnce,
        noteLens: replace && noteOn && noteSpec && noteSpec.model !== lens.model ? noteSpec.model : null,
      });
      onClose();
    } catch (e) {
      setError(String(e));
      setSubmitting(false);
    }
  }

  const count = assets.length;
  const currentLabel = currentLenses.length === 0 ? null : currentLenses.length === 1 ? currentLenses[0] : `${currentLenses.length} different lenses`;
  // Plain-English "what Apply does", shown next to it once nothing blocks.
  const summary = [replace && spec ? `Lens → ${spec.model}` : null, noteOn && noteSpec ? `Note → ${lensConfig.notePrefix}${noteSpec.model}` : null].filter(Boolean).join('   ·   ');

  return (
    <div className="window-frame window-frame-overlay" style={{ zIndex: 300, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={submitting ? undefined : onClose}>
      <div onClick={(e) => e.stopPropagation()} style={dialog}>
        <div style={header}>
          <span style={{ fontSize: 15, fontWeight: 700 }}>{prefill ? 'Paste Lens' : 'Change Lens'}</span>
          <span style={{ fontSize: 12.5, color: 'var(--text-dimmer)' }}>
            {count} {count === 1 ? 'photo' : 'photos'}
          </span>
          <span style={currentChip} title={currentLenses.join('\n') || undefined}>
            <Icon name="lens" size={13} />
            {currentLabel ? (
              <>
                Current lens <b style={{ color: 'var(--text)', fontWeight: 600 }}>{currentLabel}</b>
                {codedCount > 0 && codedCount < count && <span> · {count - codedCount} with none</span>}
              </>
            ) : (
              'No lens recorded'
            )}
          </span>
          <div style={{ flex: 1 }} />
          <div onClick={submitting ? undefined : onClose} style={closeBtn}>
            ✕
          </div>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {prefill && <CopiedLensCard lens={prefill} eyebrow="Pasting lens" />}
          {mapping && (
            <div style={infoBox}>
              Mapped in Preferences → Lenses: <b>{mapping.codedLensModel}</b> is really {mapping.candidates.length === 1 ? <b>{mapping.candidates[0].model}</b> : `one of ${mapping.candidates.length} lenses (listed first)`}.
            </div>
          )}
          {loadError && <div style={{ fontSize: 12, color: 'var(--danger)' }}>{loadError}</div>}

          <div style={{ flex: '1 0 auto', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, alignItems: 'stretch' }}>
            <Panel
              title="Lens entry"
              sub="The lens fields — what lens corrections and filters use"
              on={replace}
              toggle={
                <Segmented
                  value={replace ? 'replace' : 'keep'}
                  options={[
                    { value: 'keep', label: 'Keep' },
                    { value: 'replace', label: 'Replace' },
                  ]}
                  onChange={(v) => setMode(v === 'replace' ? 'replace' : 'keepAndNote')}
                />
              }
            >
              {replace ? (
                <>
                  <LensPicker options={options} selectedKey={entrySel?.key ?? null} selectedOption={entrySel} onSelect={setEntrySel} autoFocus height={entryPair ? 176 : 226} />
                  {entryPair && <PairSwitch label="Write" codedLabel={codedLabel} source={entryPair.source} picked={!!entrySel} onChange={switchEntry} />}
                  {spec ? (
                    <div style={resultCard}>
                      <div style={resultLabel}>Writes</div>
                      <div style={{ fontSize: 14, fontWeight: 700 }}>{spec.model}</div>
                      <div style={hintText}>{[spec.maker || 'No maker', formatLensSpecs(spec), spec.mount].filter(Boolean).join(' · ')}</div>
                      <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
                        <label style={fieldLabel}>
                          Focal length (mm){focalRequired ? ' *' : ''}
                          <input value={focal} onChange={(e) => setFocal(e.target.value)} placeholder={zoom ? `${spec.focalMin}-${spec.focalMax}` : '50'} style={lensInput} inputMode="decimal" />
                        </label>
                        <label style={fieldLabel}>
                          Aperture (f/, optional)
                          <input value={fNumber} onChange={(e) => setFNumber(e.target.value)} placeholder="as recorded" style={lensInput} inputMode="decimal" />
                        </label>
                      </div>
                      {!entrySel?.hasProfile && <div style={hintText}>No lensfun correction profile under this name — still written for filtering and search.</div>}
                    </div>
                  ) : (
                    <div style={{ ...resultCard, ...emptyResult }}>Pick the lens to write</div>
                  )}
                  {lensConfig.writeOriginals ? (
                    <div style={hintText}>Original files are rewritten via exiftool{lensConfig.keepOriginalBackup ? ', keeping a backup copy' : ' without a backup'} (Preferences → Lenses).</div>
                  ) : (
                    <div style={codedCount > 0 ? compactWarn : undefined}>
                      {codedCount > 0 && (
                        <div style={{ marginBottom: 6 }}>
                          <b>{count === 1 ? 'The camera already recorded a lens.' : `${codedCount === count ? 'All' : codedCount} of these have a camera-recorded lens.`}</b> Immich keeps showing it unless the original is written.
                        </div>
                      )}
                      <Check checked={writeOnce} onChange={setWriteOnce}>
                        Also write the original files{lensConfig.keepOriginalBackup ? ' (backup kept)' : ' (no backup)'} — needed for darktable
                      </Check>
                    </div>
                  )}
                </>
              ) : (
                <Unchanged title="Lens fields unchanged" detail={currentLabel ? `Stays as ${currentLabel}` : 'No lens is recorded, and none will be written'} />
              )}
            </Panel>

            <Panel
              title="Description note"
              sub={`A "${lensConfig.notePrefix.trim()} …" line in each description`}
              on={noteOn}
              toggle={
                <Segmented
                  value={noteOn ? 'add' : 'none'}
                  options={[
                    { value: 'none', label: 'No note' },
                    { value: 'add', label: 'Add note' },
                  ]}
                  onChange={(v) => setAddNote(v === 'add')}
                />
              }
            >
              {noteOn ? (
                <>
                  <LensPicker options={options} selectedKey={noteOption?.key ?? null} selectedOption={noteOption} onSelect={setNoteSel} autoFocus={!replace} height={notePair ? 176 : 226} />
                  {notePair && <PairSwitch label="Note" codedLabel={codedLabel} source={notePair.source} picked={!!noteOption} onChange={switchNote} />}
                  <div style={{ ...resultCard, ...(noteSpec ? null : emptyResult) }}>
                    {noteSpec ? (
                      <>
                        <div style={resultLabel}>Adds</div>
                        <div style={{ font: '600 13.5px ui-monospace,monospace' }}>
                          {lensConfig.notePrefix}
                          {noteSpec.model}
                        </div>
                        {replace && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                            <span style={hintText}>{noteMatchesEntry ? 'Same lens as the lens entry' : 'A different lens from the lens entry'}</span>
                            {!noteMatchesEntry && entrySel && (
                              <button onClick={() => setNoteSel(entrySel)} style={lensBtnSecondary}>
                                Match lens entry
                              </button>
                            )}
                          </div>
                        )}
                      </>
                    ) : (
                      'Pick the lens to name in the note'
                    )}
                  </div>
                </>
              ) : (
                <Unchanged title="Description unchanged" detail="No lens note is added" />
              )}
            </Panel>
          </div>

          {missingPaths > 0 && <div style={warnBox}>{missingPaths} of these photos has no local path — Change Lens needs file access and will fail for those.</div>}
          {error && <div style={{ fontSize: 12, color: 'var(--danger)' }}>{error}</div>}
        </div>

        <div style={footer}>
          <span style={{ fontSize: 12, color: 'var(--text-dimmer)' }}>Lens not listed?</span>
          <button onClick={() => requestPreferences({ tab: 'lenses', overDialogs: true })} style={lensBtnSecondary}>
            Add it in Lens Preferences…
          </button>
          <div style={{ flex: 1, minWidth: 0, textAlign: 'right', fontSize: 12, color: blocker ? 'var(--text-dimmer)' : 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={blocker ?? summary}>
            {blocker ?? summary}
          </div>
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

// One half of the dialog - Lens entry (left) or Description note (right) -
// with its on/off toggle in its own header, so each side reads on its own.
// An "off" side keeps its full size and says what stays as it is, so
// flipping a toggle never reshuffles the layout.
function Panel({ title, sub, on, toggle, children }: { title: string; sub: string; on: boolean; toggle: ReactNode; children: ReactNode }) {
  return (
    <div
      style={{
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: 14,
        borderRadius: 12,
        background: on ? 'var(--panel)' : 'transparent',
        border: on ? '1px solid var(--border-strong)' : '1px dashed var(--border)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>{title}</div>
          <div style={{ ...hintText, marginTop: 2 }}>{sub}</div>
        </div>
        {toggle}
      </div>
      {children}
    </div>
  );
}

type PairSide = 'coded' | 'mapped' | 'other';
interface PairMemo {
  mapping: LensMapping;
  candidate: LensSpec;
}
interface LensPair {
  mapping: LensMapping;
  coded: LensOption;
  mapped: LensOption;
  source: PairSide;
}

// Coded lens / Mapped lens - shared by the entry ("Write") and the note.
function PairSwitch({ label, codedLabel, source, picked, onChange }: { label: string; codedLabel: string; source: PairSide; picked: boolean; onChange: (v: PairSide) => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ fontSize: 12.5, fontWeight: 600, minWidth: 34 }}>{label}</span>
      <Segmented
        value={source}
        options={[
          { value: 'coded', label: codedLabel },
          { value: 'mapped', label: 'Mapped lens' },
        ]}
        onChange={onChange}
      />
      {source === 'other' && <span style={hintText}>{picked ? 'Another lens picked from the list' : 'or pick any lens from the list'}</span>}
    </div>
  );
}

function Unchanged({ title, detail }: { title: string; detail: string }) {
  return (
    <div style={{ flex: 1, minHeight: 300, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, textAlign: 'center', color: 'var(--text-dimmer)' }}>
      <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-dim)' }}>{title}</div>
      <div style={{ fontSize: 12, maxWidth: 280, overflowWrap: 'anywhere' }}>{detail}</div>
    </div>
  );
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div style={{ display: 'flex', padding: 2, borderRadius: 8, background: 'var(--overlay-weak)', flexShrink: 0 }}>
      {options.map((o) => (
        <div
          key={o.value}
          onClick={() => onChange(o.value)}
          style={{
            padding: '5px 13px',
            borderRadius: 6,
            fontSize: 12.5,
            fontWeight: o.value === value ? 600 : 400,
            cursor: 'default',
            background: o.value === value ? 'var(--accent)' : 'transparent',
            color: o.value === value ? '#fff' : 'var(--text-dim)',
          }}
        >
          {o.label}
        </div>
      ))}
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
  width: 1080,
  maxWidth: '96%',
  // Fixed, so flipping a toggle (or the mapping/paste banners) never makes
  // the dialog jump - the body scrolls instead if a window is too short.
  height: 740,
  maxHeight: '92%',
  background: 'var(--dialog-bg)',
  borderRadius: 14,
  boxShadow: '0 24px 70px rgba(0,0,0,0.7)',
  border: '1px solid var(--border)',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
};
const header: CSSProperties = { height: 54, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 12, padding: '0 12px 0 20px', background: 'var(--panel)', borderBottom: '1px solid rgba(0,0,0,0.4)' };
const closeBtn: CSSProperties = { width: 30, height: 30, borderRadius: '50%', background: 'var(--overlay-medium)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'default', fontSize: 14 };
const footer: CSSProperties = { flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '12px 20px', borderTop: '1px solid rgba(0,0,0,0.3)' };
const fieldLabel: CSSProperties = { flex: 1, display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11.5, color: 'var(--text-dim)' };
const currentChip: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, padding: '4px 10px', borderRadius: 999, background: 'var(--overlay-weak)', fontSize: 12, color: 'var(--text-dimmer)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
const resultCard: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 3, padding: '11px 13px', borderRadius: 10, background: 'var(--surface-sunken)', border: '1px solid var(--border)', minHeight: 64 };
const emptyResult: CSSProperties = { alignItems: 'center', justifyContent: 'center', fontSize: 12.5, color: 'var(--text-dimmer)', border: '1px dashed var(--border)' };
const resultLabel: CSSProperties = { fontSize: 10.5, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: 'var(--accent)' };
const hintText: CSSProperties = { fontSize: 11.5, color: 'var(--text-dimmer)' };
const infoBox: CSSProperties = { fontSize: 12, lineHeight: 1.45, padding: '9px 12px', borderRadius: 9, background: 'var(--overlay-weak)', color: 'var(--text-dim)' };
const compactWarn: CSSProperties = { fontSize: 12, lineHeight: 1.4, padding: '8px 11px', borderRadius: 9, background: 'rgba(229,165,10,0.12)', border: '1px solid rgba(229,165,10,0.35)', color: 'var(--text)' };
const warnBox: CSSProperties = { ...infoBox, background: 'rgba(229,165,10,0.12)', border: '1px solid rgba(229,165,10,0.35)', color: 'var(--text)' };
