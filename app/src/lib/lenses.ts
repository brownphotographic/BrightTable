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

import type { CatalogLens, LensCatalog, LensConfig, LensSpec } from './api';
import type { CopiedLens } from './lensEdit';

// Where a picker entry came from - shown as a badge, and decides grouping.
export type LensSource = 'mapping' | 'custom' | 'library' | 'lensfun';

export interface LensOption {
  key: string;
  spec: LensSpec;
  source: LensSource;
  // lensfun has a correction profile under exactly this model name - what
  // RawTherapee/ART/darktable need to auto-match it.
  hasProfile: boolean;
  displayName: string | null;
}

const num = (s: string | undefined) => (s == null ? null : Number(s.replace(',', '.')));

// TS twin of scripts/gen-lens-catalog.mjs's guessParameters - fills in focal
// range/aperture for library lenses that aren't in lensfun, from their name.
export function guessLensParameters(name: string): { focalMin: number | null; focalMax: number | null; apertureMax: number | null; apertureMaxTele: number | null } {
  let fmin: number | null = null;
  let fmax: number | null = null;
  let amin: number | null = null;
  let amax: number | null = null;
  let m = name.match(/(\d+(?:[.,]\d+)?)(?:\s*-\s*(\d+(?:[.,]\d+)?))?\s*mm/i);
  if (m) {
    fmin = num(m[1]);
    fmax = num(m[2] ?? m[1]);
  }
  m = name.match(/(?:^|[^A-Za-z]|mm)(?:[fF](?:\/\s?)?(?=\d)|1:|1\/)(\d+(?:[.,]\d+)?)(?:\s*-\s*(\d+(?:[.,]\d+)?))?/);
  if (m) {
    amin = num(m[1]);
    amax = num(m[2] ?? m[1]);
  }
  m = name.match(/(?:1:)?(\d+(?:[.,]\d+)?)(?:-(\d+(?:[.,]\d+)?))?\/(\d+(?:[.,]\d+)?)(?:-(\d+))?(?!\d)/);
  if (m && (fmin == null || amin == null)) {
    let [ap, apTele, fo, foTele] = [num(m[1])!, num(m[2] ?? m[1])!, num(m[3])!, num(m[4] ?? m[3])!];
    if (ap > fo) [ap, apTele, fo, foTele] = [fo, foTele, ap, apTele];
    if (fmin == null) {
      fmin = fo;
      fmax = foTele;
    }
    if (amin == null) {
      amin = ap;
      amax = apTele;
    }
  }
  if (amin != null && amax != null && amax < amin) [amin, amax] = [amax, amin];
  return { focalMin: fmin, focalMax: fmax, apertureMax: amin, apertureMaxTele: amax !== amin && fmin !== fmax ? amax : null };
}

export function specFromCatalog(l: CatalogLens): LensSpec {
  return {
    maker: l.maker,
    model: l.model,
    mount: l.mounts[0] ?? null,
    focalMin: l.focalMin ?? 0,
    focalMax: l.focalMax ?? l.focalMin ?? 0,
    apertureMax: l.apertureMax ?? 0,
    apertureMaxTele: l.apertureMaxTele,
  };
}

// A lens known only by the name Immich reports - no maker (the original's
// LensMake isn't in AssetSummary), specs guessed from the name.
export function specFromName(model: string): LensSpec {
  const g = guessLensParameters(model);
  return {
    maker: '',
    model,
    mount: null,
    focalMin: g.focalMin ?? 0,
    focalMax: g.focalMax ?? g.focalMin ?? 0,
    apertureMax: g.apertureMax ?? 0,
    apertureMaxTele: g.apertureMaxTele,
  };
}

export const lensKey = (spec: Pick<LensSpec, 'maker' | 'model'>) => `${spec.maker.trim().toLowerCase()}|${spec.model.trim().toLowerCase()}`;

export function isZoom(spec: LensSpec): boolean {
  return spec.focalMin > 0 && spec.focalMax > spec.focalMin;
}

// "50mm f/2", "24-70mm f/2.8-4", or "" when the spec doesn't know.
export function formatLensSpecs(spec: LensSpec): string {
  const parts: string[] = [];
  if (spec.focalMin > 0) parts.push(isZoom(spec) ? `${spec.focalMin}-${spec.focalMax}mm` : `${spec.focalMin}mm`);
  if (spec.apertureMax > 0) parts.push(spec.apertureMaxTele && spec.apertureMaxTele !== spec.apertureMax ? `f/${spec.apertureMax}-${spec.apertureMaxTele}` : `f/${spec.apertureMax}`);
  return parts.join(' ');
}

// Merges every lens source into one de-duplicated picker list, highest
// priority first: mapping candidates for the current coded lens, the user's
// own custom lenses, lenses already in the library, then all of lensfun. A
// lens appearing in several sources keeps its highest-priority source but
// takes lensfun's specs/profile flag when lensfun knows the exact name.
export function buildLensOptions(catalog: LensCatalog | null, cfg: LensConfig, libraryLensNames: string[], codedLensModels: string[]): LensOption[] {
  const byModel = new Map<string, CatalogLens>();
  for (const l of catalog?.lenses ?? []) byModel.set(l.model.trim().toLowerCase(), l);

  const out: LensOption[] = [];
  const seen = new Set<string>();
  const push = (spec: LensSpec, source: LensSource) => {
    const key = lensKey(spec);
    const modelKey = spec.model.trim().toLowerCase();
    if (!spec.model.trim() || seen.has(key)) return;
    // A library name that lensfun knows dedupes against the lensfun entry
    // (the library copy has no maker, so its key differs).
    const fromLensfun = byModel.get(modelKey);
    if (fromLensfun && seen.has(lensKey(fromLensfun))) return;
    seen.add(key);
    if (fromLensfun) seen.add(lensKey(fromLensfun));
    const merged = fromLensfun && source !== 'custom' && source !== 'mapping' ? specFromCatalog(fromLensfun) : spec;
    out.push({ key, spec: merged, source, hasProfile: !!fromLensfun, displayName: fromLensfun?.displayName ?? null });
  };

  const coded = new Set(codedLensModels.map((m) => m.trim().toLowerCase()));
  for (const m of cfg.mappings) {
    if (coded.has(m.codedLensModel.trim().toLowerCase())) for (const c of m.candidates) push(c, 'mapping');
  }
  for (const c of cfg.customLenses) push(c, 'custom');
  for (const name of libraryLensNames.filter(isReadableLensName)) {
    const known = byModel.get(name.trim().toLowerCase());
    push(known ? specFromCatalog(known) : specFromName(name), 'library');
  }
  for (const l of catalog?.lenses ?? []) push(specFromCatalog(l), 'lensfun');
  return out;
}

// Immich's lens-name suggestions can include junk that isn't a lens name at
// all: undecodable makernote bytes (rendered as tofu boxes) and placeholder
// specs like "-- mm f/--". Those are left out of the picker.
export function isReadableLensName(name: string): boolean {
  const t = name.trim();
  if (!t || t.includes('\uFFFD') || [...t].some((c) => c.charCodeAt(0) < 0x20 || (c.charCodeAt(0) >= 0x7f && c.charCodeAt(0) <= 0x9f)) || /^-+\s*mm\b/i.test(t) || t.includes('--')) return false;
  // Mostly Latin script (lens names are, even Japanese makers'), with at least one real word or number.
  const chars = [...t.replace(/\s/g, '')];
  const latin = chars.filter((c) => /[\u0020-\u024F\u2010-\u2027]/.test(c)).length;
  return latin / chars.length >= 0.8 && /[A-Za-z]{2,}|\d/.test(t);
}

export function matchesLensQuery(o: LensOption, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = `${o.spec.maker} ${o.spec.model} ${o.displayName ?? ''} ${o.spec.mount ?? ''}`.toLowerCase();
  return q.split(/\s+/).every((w) => hay.includes(w));
}

// The lens named by a description's lens note ("Lens: Zeiss Planar T* 2/50
// ZM" with the default prefix) - null when there's no note, or the prefix is
// blank (no way to tell a note line apart then).
export function readLensNote(description: string, prefix: string): string | null {
  const p = prefix.trim();
  if (!p) return null;
  for (const line of description.split('\n')) {
    const t = line.trim();
    if (t.startsWith(p)) return t.slice(p.length).trim() || null;
  }
  return null;
}

// Paste Lens reproduces the source as it is: its lens entry (Replace) and
// its note, each as recorded - so a target with no lens ends up like the
// source too. Only a source with a note but no lens at all pastes as Keep +
// note.
export function copiedLensKeeps(c: CopiedLens): boolean {
  return !c.lensModel && !!c.noteLens;
}

// The lens a copied lens writes into the lens entry (or, for a note-only
// source, names in the note).
export function copiedLensName(c: CopiedLens): string {
  return c.lensModel ?? c.noteLens ?? '';
}

// TS twin of lens_edit.rs's upsert_lens_note - for the optimistic caption.
export function upsertLensNote(description: string, prefix: string, lensName: string): string {
  const note = `${prefix}${lensName}`;
  const p = prefix.trim();
  const lines = description.split('\n').filter((l) => !p || !l.trimStart().startsWith(p));
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.length ? `${lines.join('\n')}\n${note}` : note;
}
