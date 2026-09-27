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


import { useEffect, useState, type CSSProperties } from 'react';
import { getSearchSuggestions } from '../lib/api';
import { cameraLabel, focalRangeOfLenses, NO_LENS, parseLensFocalRange, type CameraFilter, type Filters } from '../lib/filters';

// The Filters panel unmounts whenever it closes, so suggestion lists are
// cached at module level - reopening shows the last-known lists straight
// away while a fresh fetch (picking up newly imported cameras/lenses) runs.
const suggestionCache = new Map<string, unknown>();

function useSuggestions<T>(key: string, fetch: () => Promise<T>): T | undefined {
  const [fetched, setFetched] = useState<{ key: string; value: T } | null>(null);
  useEffect(() => {
    let live = true;
    fetch()
      .then((value) => {
        suggestionCache.set(key, value);
        if (live) setFetched({ key, value });
      })
      // Non-fatal - the dropdowns just fall back to their "Any" option.
      .catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return fetched?.key === key ? fetched.value : (suggestionCache.get(key) as T | undefined);
}

// Immich only suggests models per make, so every make's models are fetched
// to build the make + model pairs the Camera dropdown lists.
async function fetchCameras(): Promise<CameraFilter[]> {
  const makes = await getSearchSuggestions('camera-make');
  const perMake = await Promise.all(
    makes.map(async (make) => (await getSearchSuggestions('camera-model', make)).map((model) => ({ make, model }))),
  );
  return perMake.flat().sort((a, b) => cameraLabel(a).localeCompare(cameraLabel(b), undefined, { sensitivity: 'base' }));
}

const cameraKey = (c: CameraFilter) => `${c.make}\u0000${c.model}`;

// <select> values for the Lens dropdown's two non-lens options - the empty
// string is taken by "Any lens", so NO_LENS gets its own key here.
const ANY_LENS_OPTION = '';
const NO_LENS_OPTION = '\u0000none';

// Slider resolution - positions map onto the focal range logarithmically, so
// the short end (where 16 vs 24mm matters) gets as much travel as the long.
const FOCAL_STEPS = 200;
// Used only when no lens name in scope has a parseable focal length.
const FALLBACK_FOCAL_RANGE = { min: 10, max: 600 };

// Camera, Lens and Focal Length rows of the Filters panel (see MenuBar).
export default function ExifFilters({
  filters,
  onFiltersChange,
}: {
  filters: Filters;
  onFiltersChange: (next: Filters) => void;
}) {
  const cameras = useSuggestions('cameras', fetchCameras) ?? [];
  const camera = filters.camera;
  // Lenses narrow to the ones actually used on the chosen camera.
  const lenses =
    useSuggestions(camera ? `lenses:${cameraKey(camera)}` : 'lenses', () =>
      getSearchSuggestions('camera-lens-model', camera?.make, camera?.model),
    ) ?? [];

  // The chosen camera/lens may not be in a list that's still loading (or
  // stale) - keep it selectable so the <select> doesn't show the wrong value.
  const cameraOptions = camera && !cameras.some((c) => cameraKey(c) === cameraKey(camera)) ? [camera, ...cameras] : cameras;
  const lensOptions = filters.lens && !lenses.includes(filters.lens) ? [filters.lens, ...lenses] : lenses;

  // The slider spans only what's in scope: the chosen lens's own range, else
  // the union of every lens in the Lens list (all lenses, or the chosen
  // camera's).
  const focalRange =
    (filters.lens ? parseLensFocalRange(filters.lens) : null) ?? focalRangeOfLenses(lenses) ?? FALLBACK_FOCAL_RANGE;
  const { min: lo, max: hi } = focalRange;
  const fine = hi - lo < 20;
  const round = (mm: number) => (fine ? Math.round(mm * 10) / 10 : Math.round(mm));
  const posToMm = (p: number) => round(lo * Math.pow(hi / lo, p / FOCAL_STEPS));
  const mmToPos = (mm: number) =>
    Math.max(0, Math.min(FOCAL_STEPS, Math.round((FOCAL_STEPS * Math.log(mm / lo)) / Math.log(hi / lo))));
  const focalPos = filters.focal == null ? 0 : mmToPos(filters.focal);
  // Raw text while the box is being typed in, so a half-typed "2" on the way
  // to "24" (or a cleared box) isn't overwritten by the committed value.
  const [focalDraft, setFocalDraft] = useState<string | null>(null);

  const focalDisabled = filters.mediaType === 'videos';

  return (
    <>
      <div style={sectionLabel}>CAMERA</div>
      <select
        value={camera ? cameraKey(camera) : ''}
        onChange={(e) => {
          const next = cameraOptions.find((c) => cameraKey(c) === e.target.value) ?? null;
          // Lens list and focal range both depend on the camera - clear them
          // rather than leave a lens (or focal length) it may never have used.
          onFiltersChange({ ...filters, camera: next, lens: null, focal: null });
        }}
        style={{ ...selectStyle, marginBottom: 13 }}
      >
        <option value="">Any camera</option>
        {cameraOptions.map((c) => (
          <option key={cameraKey(c)} value={cameraKey(c)}>
            {cameraLabel(c)}
          </option>
        ))}
      </select>

      <div style={sectionLabel}>LENS</div>
      <select
        value={filters.lens == null ? ANY_LENS_OPTION : filters.lens === NO_LENS ? NO_LENS_OPTION : filters.lens}
        onChange={(e) => {
          const v = e.target.value;
          const lens = v === ANY_LENS_OPTION ? null : v === NO_LENS_OPTION ? NO_LENS : v;
          onFiltersChange({ ...filters, lens, focal: null });
        }}
        style={{ ...selectStyle, marginBottom: 13 }}
      >
        <option value={ANY_LENS_OPTION}>Any lens</option>
        <option value={NO_LENS_OPTION}>No lens</option>
        {lensOptions.map((l) => (
          <option key={l} value={l}>
            {l}
          </option>
        ))}
      </select>

      <div style={{ opacity: focalDisabled ? 0.4 : 1, pointerEvents: focalDisabled ? 'none' : 'auto', marginBottom: 13 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
          <span style={{ ...sectionLabel, marginBottom: 0 }}>FOCAL LENGTH</span>
          {filters.focal == null ? (
            <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>Any</span>
          ) : (
            <span
              onClick={() => {
                setFocalDraft(null);
                onFiltersChange({ ...filters, focal: null });
              }}
              title="Clear focal length"
              style={{ fontSize: 12, color: 'var(--text-dim)', cursor: 'default' }}
            >
              {filters.focal} mm ×
            </span>
          )}
        </div>
        {lo === hi ? (
          <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>{lo} mm prime - every shot is at this focal length.</div>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="range"
                min={0}
                max={FOCAL_STEPS}
                value={focalPos}
                onChange={(e) => {
                  setFocalDraft(null);
                  onFiltersChange({ ...filters, focal: posToMm(Number(e.target.value)) });
                }}
                // Dimmed until a focal length is picked - the thumb has to sit
                // somewhere, but at the left end it isn't a real selection.
                style={{ flex: 1, minWidth: 0, opacity: filters.focal == null ? 0.45 : 1, accentColor: 'var(--accent)' }}
              />
              <input
                type="number"
                min={0}
                step={fine ? 0.1 : 1}
                placeholder="Any"
                value={focalDraft ?? (filters.focal == null ? '' : String(filters.focal))}
                onChange={(e) => {
                  const text = e.target.value;
                  setFocalDraft(text);
                  const mm = Number(text);
                  if (text.trim() === '') onFiltersChange({ ...filters, focal: null });
                  else if (mm > 0) onFiltersChange({ ...filters, focal: mm });
                }}
                onBlur={() => setFocalDraft(null)}
                style={focalInput}
              />
              <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>mm</span>
            </div>
            <div
              style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5, color: 'var(--text-dimmer)', marginTop: 3, marginRight: 96 }}
            >
              <span>{lo} mm</span>
              <span>{hi} mm</span>
            </div>
          </>
        )}
      </div>
    </>
  );
}

const sectionLabel: CSSProperties = { fontSize: 11, letterSpacing: '.05em', color: 'var(--text-dimmer)', marginBottom: 8 };

const focalInput: CSSProperties = {
  width: 56,
  height: 26,
  padding: '0 6px',
  borderRadius: 7,
  fontSize: 12.5,
  border: '1px solid var(--border-strong)',
  background: 'var(--overlay-weak)',
  color: 'var(--text)',
  textAlign: 'right',
};

const selectStyle: CSSProperties = {
  width: '100%',
  height: 30,
  padding: '0 8px',
  borderRadius: 7,
  fontSize: 12.5,
  border: '1px solid var(--border-strong)',
  background: 'var(--overlay-weak)',
  color: 'var(--text)',
  cursor: 'default',
};
