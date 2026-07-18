import {
  createStack,
  deleteStack,
  getFolderAssets,
  getStack,
  regenerateAssetThumbnail,
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

// Serializes every call app-wide (Viewer.tsx's Variant 1, PhotosBrowser/
// FoldersBrowser's Variant 2 batch reconciliation, and the generic round-trip
// file-watcher listener all funnel through this one function). Found live:
// running Headless RAW Roundtrip across 2+ RAW assets that were already
// stacked together produced overlapping createStack/deleteStack calls for
// the *same* underlying stack, corrupting it (Immich's own "trashing one
// stacked asset takes its siblings with it" behavior then made this look
// like a mass delete) - each ingestion's "does this original already have a
// stack, and who else is in it" read raced every sibling's still-in-flight
// dissolve-then-recreate of that exact stack. Serializing so each ingestion
// only ever starts once the previous one has fully landed - combined with
// re-reading `original`'s stack membership fresh (see below) instead of
// trusting a snapshot that may already be stale by the time this runs -
// closes the race.
let ingestChain: Promise<unknown> = Promise.resolve();

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
export function ingestRoundTripExport(original: AssetSummary, newFileName: string): Promise<RoundTripIngestOutcome | null> {
  const run = ingestChain.then(() => ingestRoundTripExportInner(original, newFileName));
  // Swallow here so one caller's rejection/`null` doesn't wedge the shared
  // chain for every later caller - `run` (returned below, unswallowed) is
  // still each individual caller's own real result.
  ingestChain = run.catch(() => {});
  return run;
}

async function ingestRoundTripExportInner(original: AssetSummary, newFileName: string): Promise<RoundTripIngestOutcome | null> {
  if (!original.originalPath) return null;
  const slash = original.originalPath.lastIndexOf('/');
  const folderImmichPath = slash === -1 ? '' : original.originalPath.slice(0, slash);

  await scanImmichLibrary().catch(() => {});
  let found = await pollForNewAsset(folderImmichPath, newFileName);
  if (!found) return null;

  // Confirmed live: an asset discovered via scanImmichLibrary (every
  // round-trip export) doesn't reliably get Immich's own thumbnailGeneration
  // job auto-queued the way a normal upload does - left alone, it shows up
  // blank (its own /thumbnail endpoint 404s indefinitely, not just slowly)
  // until something else happens to trigger regeneration. Fire-and-forget,
  // same "best-effort, doesn't block the outcome" treatment as
  // setAssetCaptureDate/updateAssetMetadata below.
  regenerateAssetThumbnail(found.id).catch(() => {});

  // Re-fetch `original`'s own current server-side stack membership rather
  // than trusting `original.stack` - that's a snapshot the caller captured
  // before this export (or a just-settled sibling export sharing the same
  // stack, now serialized ahead of this one - see `ingestChain` above) ran,
  // and may already point at a stack id Immich has since dissolved/replaced.
  // Folder listing was just fetched by pollForNewAsset anyway, so this is one
  // more of the same call, not a new kind of request.
  const freshSiblings = await getFolderAssets(folderImmichPath).catch(() => [] as AssetSummary[]);
  const freshOriginal = freshSiblings.find((a) => a.id === original.id) ?? original;

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
  const existingStackId = freshOriginal.stack?.id;
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
