import {
  createStack,
  deleteStack,
  getFolderAssets,
  getStack,
  scanImmichLibrary,
  setAssetCaptureDate,
  updateAssetMetadata,
  type AssetMetadataPatch,
  type AssetStackInfo,
  type AssetSummary,
} from './api';

// Immich only learns about a round-trip output file once scan_immich_library
// has kicked its own async library-scan job and that job has actually run -
// there's no push notification for "a specific file finished indexing", so
// this just retries the existing get_folder_assets call (already used by the
// Folders view) until the exact filename shows up or the budget runs out.
// ~2 minutes total - confirmed live that Immich's own library scan/indexing
// of a fresh multi-MB JPEG can genuinely take well over the previous ~22s
// budget (found live: an ART CLI round trip export that took several minutes
// to write finished successfully on disk, but ImmAture gave up looking for
// it in Immich before the scan had caught up, so nothing showed up in the
// grid with no error at all). Still bounded, not indefinite, since this is
// silent for the generic (non-ART) round trip's own background listener.
const DEFAULT_ATTEMPTS = 40;
const DEFAULT_INTERVAL_MS = 3000;

export async function pollForNewAsset(
  folderImmichPath: string,
  fileName: string,
  attempts = DEFAULT_ATTEMPTS,
  intervalMs = DEFAULT_INTERVAL_MS,
): Promise<AssetSummary | null> {
  for (let i = 0; i < attempts; i++) {
    const assets = await getFolderAssets(folderImmichPath).catch(() => [] as AssetSummary[]);
    const found = assets.find((a) => a.fileName === fileName);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

export interface RoundTripIngestOutcome {
  asset: AssetSummary;
  originalAssetId: string;
  // Non-null once a stack was successfully created/merged - the caller
  // applies both `memberIds`/`info` to its own stackByAssetId map.
  stack: { memberIds: string[]; info: AssetStackInfo } | null;
}

// The shared "a round-trip output file now exists in Immich" ingestion tail:
// polls for the new asset, corrects its capture date, carries the original's
// rating/favorite/description onto it, and creates (or merges into an
// existing) stack pairing it with its RAW original. Touches no React state
// itself - PhotosBrowser.tsx's 'round-trip-file-detected' listener (which
// still owns its own matchesVersionSuffix candidate-matching step before
// calling this) and both ART CLI round-trip variants (which already know
// `newFileName` deterministically, with no candidate matching needed) all
// apply the returned outcome to their own assetCache/stackByAssetId.
//
// Returns `null` if the export never actually showed up in Immich within the
// polling budget, or if `original` has no server-side path to derive its
// containing folder from.
export async function ingestRoundTripExport(
  original: AssetSummary,
  newFileName: string,
): Promise<RoundTripIngestOutcome | null> {
  if (!original.originalPath) return null;
  const slash = original.originalPath.lastIndexOf('/');
  const folderImmichPath = slash === -1 ? '' : original.originalPath.slice(0, slash);

  await scanImmichLibrary().catch(() => {});
  let found = await pollForNewAsset(folderImmichPath, newFileName);
  if (!found) return null;

  // RAW editors' exported JPEGs frequently carry no EXIF DateTimeOriginal of
  // their own, so Immich indexes them under "now" instead of the original's
  // real capture time - correct it both server-side and in the object about
  // to be inserted, so the new asset lands in the same day group as the
  // original it belongs next to rather than under today's date.
  if (found.fileCreatedAt !== original.fileCreatedAt) {
    setAssetCaptureDate(found.id, original.fileCreatedAt).catch(() => {});
    found = { ...found, fileCreatedAt: original.fileCreatedAt };
  }

  // Carries the original's rating/favorite/description onto the round-trip
  // output too - a freshly-created asset otherwise starts with none of it.
  const metadataPatch: AssetMetadataPatch = {};
  if (original.rating != null) metadataPatch.rating = original.rating;
  if (original.isFavorite) metadataPatch.isFavorite = original.isFavorite;
  if (original.description) metadataPatch.description = original.description;
  if (Object.keys(metadataPatch).length > 0) {
    found = { ...found, ...metadataPatch };
    updateAssetMetadata([{ id: found.id, originalPath: found.originalPath }], metadataPatch).catch(() => {});
  }

  let memberIds = [found.id, original.id];
  const existingStackId = original.stack?.id;
  if (existingStackId) {
    const existing = await getStack(existingStackId).catch(() => null);
    if (existing) {
      await deleteStack(existingStackId).catch(() => {});
      const extraIds = existing.assets.map((a) => a.id).filter((id) => id !== original.id);
      memberIds = [found.id, original.id, ...extraIds];
    }
  }
  const stack = await createStack(memberIds).catch(() => null);
  const stackResult = stack
    ? { memberIds, info: { id: stack.id, primaryAssetId: stack.primaryAssetId, assetCount: memberIds.length } }
    : null;

  return { asset: found, originalAssetId: original.id, stack: stackResult };
}
