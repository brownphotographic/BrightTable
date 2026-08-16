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

export interface Filters {
  minRating: number;
  favOnly: boolean;
  mediaType: MediaTypeFilter;
  format: FileTypeFilter;
}

export const DEFAULT_FILTERS: Filters = { minRating: 0, favOnly: false, mediaType: 'all', format: 'all' };

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
  return true;
}

export function activeFilterCount(filters: Filters): number {
  return (
    (filters.minRating > 0 ? 1 : 0) +
    (filters.favOnly ? 1 : 0) +
    (filters.mediaType !== 'all' ? 1 : 0) +
    (filters.format !== 'all' ? 1 : 0)
  );
}
