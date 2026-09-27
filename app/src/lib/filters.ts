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

import type { AssetSummary } from './api';

// Image type only ever discriminates within photos (RAW vs JPEG) - it has
// nothing to say about videos.
export type FileTypeFilter = 'all' | 'raw' | 'jpeg';

// Media type is the broader photos-vs-videos split.
export type MediaTypeFilter = 'all' | 'photos' | 'videos';

// A camera is identified by its EXIF make + model pair - model alone isn't
// unique across makers in principle, and the dropdown shows both anyway.
export interface CameraFilter {
  make: string;
  model: string;
}

export interface Filters {
  minRating: number;
  favOnly: boolean;
  mediaType: MediaTypeFilter;
  format: FileTypeFilter;
  camera: CameraFilter | null;
  // A lens model name, NO_LENS for assets with no lens recorded, or null for any.
  lens: string | null;
  // As-shot focal length (EXIF focalLength, not the lens's range), in mm.
  focal: number | null;
}

export const DEFAULT_FILTERS: Filters = {
  minRating: 0,
  favOnly: false,
  mediaType: 'all',
  format: 'all',
  camera: null,
  lens: null,
  focal: null,
};

// Display label for a camera - most makers already repeat their name at the
// start of the model ("Canon" / "Canon EOS R5", "NIKON CORPORATION" / "NIKON
// Z 6"), so the make is only prefixed when it isn't (Sony's "ILCE-7M4").
export function cameraLabel(camera: CameraFilter): string {
  const brand = camera.make.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  if (!brand || camera.model.toLowerCase().startsWith(brand)) return camera.model;
  return `${camera.make} ${camera.model}`;
}

// `lens` value matching assets with a blank/missing lens model - common for
// manual/adapted glass with no electronic contacts. Can't collide with a real
// lens name, since blank names are never offered as suggestions.
export const NO_LENS = '';

export interface FocalRange {
  min: number;
  max: number;
}

// Focal range a lens covers, read from its name ("FE 24-70mm F2.8 GM",
// "EF50mm f/1.8 STM", "iPhone 13 back camera 5.1mm f/1.6") - Immich has no
// per-lens or library-wide focal length stats, so this is what sizes the
// Filters panel's focal length slider. Null when the name has no "...mm".
export function parseLensFocalRange(lens: string): FocalRange | null {
  const m = /(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))?\s*mm/i.exec(lens);
  if (!m) return null;
  const a = Number(m[1]);
  const b = m[2] ? Number(m[2]) : a;
  if (!(a > 0) || !(b > 0)) return null;
  return { min: Math.min(a, b), max: Math.max(a, b) };
}

// Union of every parseable lens's focal range - null if none parse.
export function focalRangeOfLenses(lenses: string[]): FocalRange | null {
  let range: FocalRange | null = null;
  for (const lens of lenses) {
    const r = parseLensFocalRange(lens);
    if (!r) continue;
    range = range ? { min: Math.min(range.min, r.min), max: Math.max(range.max, r.max) } : r;
  }
  return range;
}

// Immich stores focal lengths as floats (e.g. 23.9999 for a 24mm shot), so
// the chosen focal length matches with this much slack either side.
const FOCAL_TOLERANCE = 0.5;

export const RAW_EXTENSIONS = new Set(['ARW', 'CR2', 'CR3', 'NEF', 'DNG', 'RAF', 'ORF', 'RW2', 'PEF', 'SRW', 'X3F']);

export function isRawExtension(ext: string): boolean {
  return RAW_EXTENSIONS.has(ext);
}

// `.tif`/`.tiff` is deliberately not in RAW_EXTENSIONS - it was the RAW-
// native format on some very old digital cameras (the original Canon 1Ds),
// but it's also an ordinary export/rendition format, and nothing in Immich's
// metadata reliably tells the two apart (checked: neither camera EXIF nor
// pixel dimensions distinguish them). TIF/TIFF is treated uniformly as "not
// RAW" - the old per-asset `isRawOverride` escape hatch (Edit menu -> Toggle
// Canon RAW, see lib/rawOverrides.tsx) is disabled for now, so it's ignored
// here even if still set from before.
export function isRawAsset(asset: AssetSummary): boolean {
  return isRawExtension(asset.fileExtension);
}

// Non-RAW formats the RAW converter CLIs (ART-cli/RawTherapee-cli/darktable-cli)
// can also process, alongside true RAW input - all three tools open and
// develop JPEG/TIFF the same as a RAW file (just skipping RAW-only steps
// like demosaic), so Tweak/Headless Roundtrip aren't actually RAW-exclusive
// at the CLI level - see isRoundTripEligible.
export const ROUND_TRIP_NON_RAW_EXTENSIONS = new Set(['JPG', 'JPEG', 'TIF', 'TIFF']);

// Whether Tweak/Headless Roundtrip can run against this asset - true RAW, or
// one of the non-RAW formats above that the active converter's CLI also
// accepts as input.
export function isRoundTripEligible(asset: AssetSummary): boolean {
  return isRawAsset(asset) || ROUND_TRIP_NON_RAW_EXTENSIONS.has(asset.fileExtension);
}

export function isVideoAsset(asset: AssetSummary): boolean {
  return asset.type === 'VIDEO';
}

// Formats a webview <img> can decode directly, so it's safe to swap in the
// original file (via thumbnailSrc(id, 'original')) as a crisper source once
// zoomed past Immich's fixed-resolution `preview` rendition. Deliberately
// excludes RAW (not browser-decodable at all) and HEIC/TIFF (unreliable
// native <img> decode support across the Chromium/WebKit webviews Tauri
// embeds) - those stay on `preview` at every zoom level, same as before.
const ORIGINAL_ZOOMABLE_EXTENSIONS = new Set(['JPG', 'JPEG', 'PNG', 'WEBP', 'GIF', 'BMP', 'AVIF']);

export function isOriginalZoomable(asset: AssetSummary): boolean {
  return !isRawAsset(asset) && ORIGINAL_ZOOMABLE_EXTENSIONS.has(asset.fileExtension);
}

export function matchesFilters(asset: AssetSummary, filters: Filters): boolean {
  if (filters.favOnly && !asset.isFavorite) return false;
  if (filters.minRating > 0 && (asset.rating ?? 0) < filters.minRating) return false;
  if (filters.mediaType === 'photos' && asset.type !== 'IMAGE') return false;
  if (filters.mediaType === 'videos' && asset.type !== 'VIDEO') return false;
  if (filters.format === 'raw' && !isRawAsset(asset)) return false;
  if (filters.format === 'jpeg' && asset.fileExtension !== 'JPG') return false;
  if (filters.camera && (asset.make !== filters.camera.make || asset.model !== filters.camera.model)) return false;
  if (filters.lens === NO_LENS) {
    if (asset.lensModel?.trim()) return false;
  } else if (filters.lens != null && asset.lensModel !== filters.lens) return false;
  if (filters.focal != null && (asset.focalLength == null || Math.abs(asset.focalLength - filters.focal) > FOCAL_TOLERANCE)) {
    return false;
  }
  return true;
}

export function activeFilterCount(filters: Filters): number {
  return (
    (filters.minRating > 0 ? 1 : 0) +
    (filters.favOnly ? 1 : 0) +
    (filters.mediaType !== 'all' ? 1 : 0) +
    (filters.format !== 'all' ? 1 : 0) +
    (filters.camera ? 1 : 0) +
    (filters.lens != null ? 1 : 0) +
    (filters.focal != null ? 1 : 0)
  );
}
