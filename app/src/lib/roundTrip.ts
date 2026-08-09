import {
  createStack,
  deleteStack,
  getFolderAssets,
  listStacks,
  regenerateAssetThumbnail,
  scanImmichLibrary,
  setAssetCaptureDate,
  updateAssetMetadata,
  type AssetMetadataPatch,
  type AssetStackInfo,
  type AssetSummary,
  type StackInfo,
} from './api';

// regenerate_asset_thumbnail is a single fire-and-forget POST that only
// *enqueues* Immich's own thumbnailGeneration job - a transient failure of
// that enqueue call (Immich briefly busy with the same batch's own
// library-scan/other regenerate-thumbnail calls) previously meant the
// thumbnail request was silently dropped for good, with nothing left to
// retry it - found live: a handful of assets out of a large batch round trip
// permanently 404ing their own /thumbnail endpoint, needing a manual click
// on AssetThumb.tsx's retry placeholder to notice at all. A few retries with
// a short gap costs nothing (it's one small POST) and closes that window.
async function regenerateThumbnailWithRetry(assetId: string): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 2000));
    const ok = await regenerateAssetThumbnail(assetId).then(
      () => true,
      () => false,
    );
    if (ok) return true;
  }
  return false;
}

// Immich only learns about a round-trip output file once scan_immich_library
// has kicked its own async library-scan job and that job has actually run -
// there's no push notification for "a specific file finished indexing", so
// this just retries the existing get_folder_assets call (already used by the
// Folders view) until the exact filename shows up or the budget runs out.
// ~2 minutes total - confirmed live that Immich's own library scan/indexing
// of a fresh multi-MB JPEG can genuinely take well over the previous ~22s
// budget (found live: an ART CLI round trip export that took several minutes
// to write finished successfully on disk, but BrightTable gave up looking for
// it in Immich before the scan had caught up, so nothing showed up in the
// grid with no error at all). Still bounded, not indefinite, since this is
// silent for the generic (non-ART) round trip's own background listener -
// `ingestRoundTripExportInner` below picks up where this budget runs out via
// `retryIngestInBackground`, so a slow scan doesn't mean the stack never gets
// created, just that it takes longer than this first bounded window.
const DEFAULT_ATTEMPTS = 40;
const DEFAULT_INTERVAL_MS = 3000;

// How long `retryIngestInBackground` keeps checking after the foreground
// budget above gives up - found live: on a large library, Immich's external
// library scan job can sit queued behind other jobs (thumbnail generation,
// a concurrent import) for many minutes, well past DEFAULT_ATTEMPTS'
// ~2-minute window, and nothing was ever re-checking once that window
// closed - the export sat on disk, fully indexed by Immich eventually, but
// permanently un-stacked because `createStack` was never called for it. This
// is the fix: keep polling, much more patiently, instead of giving up for
// good. Also re-nudges `scanImmichLibrary` periodically (not just once up
// front) in case the job Immich queued for the first call already ran and
// missed this file (e.g. it settled to disk a beat after that job's own
// directory snapshot), which would otherwise mean no future scan ever picks
// it up on its own.
const BACKGROUND_ATTEMPTS = 100;
const BACKGROUND_INTERVAL_MS = 15000; // ~25 minutes total
const BACKGROUND_RESCAN_EVERY = 4; // re-trigger scan_immich_library every ~1 minute

export async function pollForNewAsset(
  folderImmichPath: string,
  fileName: string,
  attempts = DEFAULT_ATTEMPTS,
  intervalMs = DEFAULT_INTERVAL_MS,
  onRetry?: (attempt: number) => void,
): Promise<AssetSummary | null> {
  for (let i = 0; i < attempts; i++) {
    const assets = await getFolderAssets(folderImmichPath).catch(() => [] as AssetSummary[]);
    const found = assets.find((a) => a.fileName === fileName);
    if (found) return found;
    onRetry?.(i);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

export interface RoundTripIngestOutcome {
  asset: AssetSummary;
  originalAssetId: string;
  // The caller's own snapshot of the original RAW, threaded straight
  // through rather than making applyRoundTripOutcome re-derive it via
  // assetByIdAll.get(originalAssetId) - that lookup silently no-ops
  // whenever the original's bucket isn't loaded in *this* page's cache,
  // which is routinely true for the late/background outcome path
  // (notifyLateRoundTripOutcome can fire well after the user switched
  // views, or for an original that's simply scrolled out of the windowed
  // range) - see applyRoundTripOutcome's checkSidecarMetadata re-check.
  original: AssetSummary;
  // Non-null once a stack was successfully created/merged - the caller
  // applies both `memberIds`/`info` to its own stackByAssetId map.
  stack: { memberIds: string[]; info: AssetStackInfo } | null;
  // Non-empty only when the original had a rating/favorite/description to
  // carry over. updateAssetMetadata only *enqueues* the XMP/Immich write
  // onto the background EditQueue and returns immediately - see its own doc
  // comment - so previously firing it with a bare `.catch(() => {})` here
  // only ever caught a synchronous rejection, never a real write failure.
  // Found live: ratings silently failing to land on round-trip exports from
  // a large batch, with nothing to show why. The caller must track these ids
  // via its own trackJobs/reconcileJob (exactly like any other edit) so a
  // real failure surfaces and the optimistic patch gets rolled back, instead
  // of vanishing.
  metadataJobIds: number[];
  // The "blank" pre-patch state for exactly the fields `metadataJobIds`'
  // job is writing - correct because `found` is a brand-new asset (Immich's
  // own neutral defaults), unlike prevValuesFor's read of a real existing
  // asset for a normal in-place edit. The caller's rollback registration
  // (`rollbackById.current.set(jobId, { id: asset.id, prevValues })`) uses
  // this to undo the optimistic patch already baked into `asset` above if
  // the job comes back failed.
  metadataPrevValues: Partial<AssetSummary>;
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
  const found = await pollForNewAsset(folderImmichPath, newFileName);
  if (!found) {
    // Don't await - this runs long after the caller (a UI action's own
    // await, or reconcileArtJob's job-settled callback) has already moved
    // on. See BACKGROUND_ATTEMPTS's doc comment: this is what actually
    // creates the stack once a slow scan eventually catches up, instead of
    // silently leaving the export unstacked forever.
    retryIngestInBackground(original, newFileName, folderImmichPath);
    return null;
  }
  return finishIngest(original, found);
}

// Keeps checking for the export long after `ingestRoundTripExportInner`'s own
// bounded budget gave up, re-nudging scan_immich_library periodically along
// the way (see BACKGROUND_RESCAN_EVERY) in case the scan job Immich queued
// for the first call already ran its course and missed this file. Rejoins
// `ingestChain` only for the brief, actually-mutating tail (`finishIngest`)
// once the asset is found - not for the whole multi-minute wait - so a slow
// straggler doesn't hold up every other round trip queued behind it.
function retryIngestInBackground(original: AssetSummary, newFileName: string, folderImmichPath: string): void {
  pollForNewAsset(folderImmichPath, newFileName, BACKGROUND_ATTEMPTS, BACKGROUND_INTERVAL_MS, (attempt) => {
    if (attempt > 0 && attempt % BACKGROUND_RESCAN_EVERY === 0) {
      scanImmichLibrary().catch(() => {});
    }
  })
    .then((found) => {
      if (!found) return;
      const run = ingestChain.then(() => finishIngest(original, found));
      ingestChain = run.catch(() => {});
      return run.then((outcome) => {
        if (outcome) notifyLateRoundTripOutcome(outcome);
      });
    })
    .catch(() => {});
}

const lateOutcomeListeners = new Set<(outcome: RoundTripIngestOutcome) => void>();

// Lets a page apply a round-trip outcome that lands well after the
// interactive call site that triggered it has already returned - e.g. a
// batch export whose Immich indexing straggled past the foreground poll
// budget and only got stacked once `retryIngestInBackground` above caught
// up. Every page that already applies `ingestRoundTripExport`'s direct
// return value (via its own `applyRoundTripOutcome`) should also subscribe
// to this, so a late arrival still gets reflected without the user having to
// notice and manually fix the stack.
export function subscribeLateRoundTripOutcome(listener: (outcome: RoundTripIngestOutcome) => void): () => void {
  lateOutcomeListeners.add(listener);
  return () => {
    lateOutcomeListeners.delete(listener);
  };
}

function notifyLateRoundTripOutcome(outcome: RoundTripIngestOutcome): void {
  for (const listener of lateOutcomeListeners) listener(outcome);
}

// The enrichment + stacking tail shared by the foreground poll
// (`ingestRoundTripExportInner`) and the background retry
// (`retryIngestInBackground`) once `found` is known to exist in Immich.
async function finishIngest(original: AssetSummary, foundAsset: AssetSummary): Promise<RoundTripIngestOutcome> {
  let found = foundAsset;
  // Confirmed live: an asset discovered via scanImmichLibrary (every
  // round-trip export) doesn't reliably get Immich's own thumbnailGeneration
  // job auto-queued the way a normal upload does - left alone, it shows up
  // blank (its own /thumbnail endpoint 404s indefinitely, not just slowly)
  // until something else happens to trigger regeneration. Not awaited (the
  // outcome shouldn't block on it), but retried a few times internally now -
  // see regenerateThumbnailWithRetry's own doc comment.
  void regenerateThumbnailWithRetry(found.id);

  // Look up `original`'s current server-side stack membership via list_stacks
  // rather than trusting `original.stack` (a caller snapshot) or any inline
  // `.stack` field off get_folder_assets/search-metadata - confirmed live
  // that this Immich server version (2.7.5) doesn't populate `stack` on
  // /search/metadata or /timeline/bucket (see list_stacks's doc comment on
  // the Rust side), and get_folder_assets's /view/folder deserializes the
  // exact same AssetResponseDto shape, so it has the same gap. Trusting that
  // field here meant `existingStack` was always undefined, so a round-trip
  // export of an already-stacked original silently created its own separate
  // 2-member stack instead of joining the existing one - and since Immich
  // won't let an asset belong to two stacks, that create then failed
  // (swallowed below), leaving the new export outside any stack entirely.
  const allStacks = await listStacks().catch(() => [] as StackInfo[]);
  const existingStack = allStacks.find((s) => s.assets.some((a) => a.id === original.id));

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
  let metadataJobIds: number[] = [];
  const metadataPrevValues: Partial<AssetSummary> = {};
  if (Object.keys(metadataPatch).length > 0) {
    found = { ...found, ...metadataPatch };
    if ('rating' in metadataPatch) metadataPrevValues.rating = undefined;
    if ('isFavorite' in metadataPatch) metadataPrevValues.isFavorite = false;
    if ('description' in metadataPatch) metadataPrevValues.description = undefined;
    // Only awaited far enough to get the job id(s) back - the actual
    // XMP/Immich write still happens on the background EditQueue, same as
    // any other edit. A synchronous rejection here (read-only mode, over
    // the batch cap) just means no job was ever created, so there's nothing
    // for the caller to track.
    metadataJobIds = await updateAssetMetadata([{ id: found.id, originalPath: found.originalPath }], metadataPatch).catch(
      () => [] as number[],
    );
  }

  let memberIds = [found.id, original.id];
  if (existingStack) {
    await deleteStack(existingStack.id).catch(() => {});
    const extraIds = existingStack.assets.map((a) => a.id).filter((id) => id !== original.id);
    memberIds = [found.id, original.id, ...extraIds];
  }
  const stack = await createStack(memberIds).catch(() => null);
  const stackResult = stack
    ? { memberIds, info: { id: stack.id, primaryAssetId: stack.primaryAssetId, assetCount: memberIds.length } }
    : null;

  return { asset: found, originalAssetId: original.id, original, stack: stackResult, metadataJobIds, metadataPrevValues };
}
