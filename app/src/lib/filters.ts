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
// pixel dimensions distinguish them). So TIFF defaults to "not RAW", and the
// user marks individual exceptions via `isRawOverride` (Edit menu -> Toggle
// Canon RAW, see lib/rawOverrides.tsx) instead of guessing.
export function isRawAsset(asset: AssetSummary): boolean {
  return !!asset.isRawOverride || isRawExtension(asset.fileExtension);
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
