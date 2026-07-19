import { invoke } from '@tauri-apps/api/core';

export type ConnMode = 'lan' | 'tailscale' | 'auto';
export type ShareType = 'nfs' | 'smb';

export interface LibraryConfig {
  connMode: ConnMode;
  lanUrl: string;
  tailscaleUrl: string;
  apiKey: string;
  shareType: ShareType;
  // Path mapping for the External Library Immich reads in place (RAW
  // editors' own working folder) - server-side prefix + its local mount.
  localRoot: string;
  immichRoot: string;
  // Second, separate path mapping for assets uploaded directly into Immich
  // (mobile app / web upload), which live under Immich's own internal
  // storage root rather than the external library's folder tree.
  uploadedLocalRoot: string;
  uploadedImmichRoot: string;
  readOnly: boolean;
  maxWritesPerBatch: number;
}

export interface SmartStackSettings {
  mode: 'name' | 'version' | 'time';
  suffix: string;
  tolerance: number;
}

// Mirrors apps.rs's AppKind - Native/Flatpak/Snap are detected from real
// `.desktop` entries; AppImage/Custom only ever come from the picker's own
// "Other application…" file-browse fallback (see AppPickerDialog.tsx).
export type AppKind = 'native' | 'flatpak' | 'snap' | 'appimage' | 'custom';

export interface AppChoice {
  name: string;
  exec: string;
  kind: AppKind;
  // Extra flags inserted before the file argument on launch (e.g. ART's
  // `-s` Simple editor mode) - see apps.rs's AppChoice for why this exists.
  extraArgs: string;
}

export interface ApplicationsConfig {
  rawEditor: AppChoice | null;
  externalEditor: AppChoice | null;
  // Path to the ART-cli binary - a plain string (no .desktop entry exists for
  // it, so it needs its own file-browse UI, not the app picker). A non-empty
  // value is the single signal that switches "Tweak RAW Roundtrip"/the new
  // "Headless RAW Roundtrip" action over to the ART CLI round trip - see
  // lib/applications.tsx's derived `artRoundTripEnabled`.
  artCliPath: string;
}

export type FolderDepth = 'flat' | 'yearMonth';

export interface ImportSettings {
  folderDepth: FolderDepth;
  lastSourcePath: string | null;
  // How many copies run at once - read once at app startup to size the
  // backend queue's semaphore (see queue.rs's `run`), so changing this
  // takes effect next launch, not live mid-session.
  maxConcurrentJobs: number;
}

// Flickr OAuth 1.0a credentials/tokens - stored in plaintext in config.json,
// same precedent as LibraryConfig.apiKey (no OS keychain integration exists
// anywhere in this app).
export interface FlickrConfig {
  apiKey: string;
  apiSecret: string;
  oauthToken: string;
  oauthTokenSecret: string;
  username: string;
  userNsid: string;
  connected: boolean;
}

// Preferences → Sharing. Only Flickr has a real, working connection today -
// Mastodon/PixelFed/Loops are "coming soon" cards in PreferencesSharing.tsx
// with nothing but an enabled flag to persist.
export interface SharingConfig {
  flickr: FlickrConfig;
  mastodonEnabled: boolean;
  pixelfedEnabled: boolean;
  loopsEnabled: boolean;
}

export interface AppConfig {
  library: LibraryConfig;
  settingsFolder: string | null;
  shortcuts: Record<string, string>;
  smartStack: SmartStackSettings;
  applications: ApplicationsConfig;
  import: ImportSettings;
  rawOverrides: string[];
  sharing: SharingConfig;
}

export interface ConnectionStatus {
  ok: boolean;
  resolvedUrl: string;
  via: string;
  serverVersion: string;
  userEmail: string;
  serverVersionSupported: boolean;
}

export interface TimeBucketInfo {
  timeBucket: string;
  count: number;
}

export interface AssetStackInfo {
  id: string;
  primaryAssetId: string;
  assetCount: number;
}

export interface AssetSummary {
  id: string;
  fileName: string;
  fileCreatedAt: string;
  isFavorite: boolean;
  type: 'IMAGE' | 'VIDEO';
  thumbHash: string | null;
  fileExtension: string;
  rating: number | null;
  city: string | null;
  country: string | null;
  make: string | null;
  model: string | null;
  lensModel: string | null;
  fNumber: number | null;
  focalLength: number | null;
  iso: number | null;
  exposureTime: string | null;
  exifImageWidth: number | null;
  exifImageHeight: number | null;
  fileSizeInByte: number | null;
  description: string | null;
  stack: AssetStackInfo | null;
  // Server-side path (real filesystem path for an External Library asset, or
  // Immich's own internal upload-storage path otherwise) - used to resolve a
  // real local file for RAW-editor sidecar read/write. Absent for Trash view
  // assets, which is fine since sidecar sync/copy-paste don't apply there.
  originalPath: string | null;
  // Client-only annotation, overlaid from RawOverridesProvider wherever an
  // AssetSummary is displayed (see lib/rawOverrides.tsx) - Immich itself has
  // no concept of this, so it's absent (not just false) on any AssetSummary
  // straight off the wire (e.g. a fresh getStack() result) until re-mapped.
  isRawOverride?: boolean;
  // Client-only annotation, overlaid from a page's `unsyncedMetadata` map -
  // set only when a local sidecar/embedded file has a rating and/or
  // description Immich doesn't have yet (see checkSidecarMetadata below).
  // Absent once synced or when no gap exists in either field.
  unsyncedMetadata?: UnsyncedMetadata;
  // Client-only annotation, overlaid the same way as `unsyncedMetadata` -
  // whether this asset currently has an ART/RawTherapee processing sidecar
  // (`.arp`/`.pp3`) on disk, piggybacked onto the same checkSidecarMetadata
  // scan. Gates whether "Copy Image Processing" is enabled for this asset -
  // independent of `unsyncedMetadata` (a processing sidecar can exist with
  // no metadata gap, and vice versa).
  hasProcessingSidecar?: boolean;
}

export interface StackInfo {
  id: string;
  primaryAssetId: string;
  assets: AssetSummary[];
}

// Payload of the 'round-trip-file-detected' Tauri event (see round_trip.rs)
// - emitted whenever a new, non-junk file settles into a folder ImmAture is
// watching for round-trip output. `candidates` lists every asset currently
// registered as pending in that folder (usually just one); it's up to the
// listener to decide via matchesVersionSuffix (smartStack.ts) whether any of
// them is a real match for `newFileName`, not this event itself.
export interface RoundTripCandidate {
  originalAssetId: string;
  originalFileName: string;
}

export interface RoundTripFileDetected {
  candidates: RoundTripCandidate[];
  newFileName: string;
  folderImmichPath: string;
}

export interface AssetMetadataPatch {
  rating?: number;
  isFavorite?: boolean;
  description?: string;
}

// What updateAssetMetadata needs per asset to mirror a rating/description
// edit into that asset's own `.xmp` sidecar, in addition to the Immich PUT -
// see the Rust command's doc comment for why the sidecar write matters (it's
// the mechanism that actually persists a rating edit for External Library
// assets, not a best-effort mirror of an already-durable Immich write).
export interface MetadataEditTarget {
  id: string;
  originalPath: string | null;
}

export type EditJobStatus = 'pending' | 'writing' | 'done' | 'failed';

// Mirrors edit_queue.rs's EditJob - one row of the background edit queue's
// advisory activity panel. The frontend's correctness never depends on this;
// only what the ActivityPanel/EditQueueIndicator display, and rollback
// decisions made by useEditJobReconciliation.
export interface EditJob {
  jobId: number;
  assetId: string;
  rating: number | null;
  isFavorite: boolean | null;
  description: string | null;
  status: EditJobStatus;
  createdAtMs: number;
  finishedAtMs: number | null;
  // Fatal - the XMP sidecar write failed, so the optimistic patch must be
  // rolled back.
  error: string | null;
  // Non-fatal - the sidecar write (the authoritative mechanism) succeeded,
  // but Immich's own PUT failed. Visible-only, never a rollback trigger.
  immichWarning: string | null;
}

export interface EditQueueStatus {
  jobs: EditJob[];
  pendingCount: number;
}

export function getConfig(): Promise<AppConfig> {
  return invoke('get_config');
}

export function saveLibraryConfig(cfg: LibraryConfig): Promise<AppConfig> {
  return invoke('save_library_config', { cfg });
}

export function saveShortcuts(shortcuts: Record<string, string>): Promise<AppConfig> {
  return invoke('save_shortcuts', { shortcuts });
}

export function saveSmartStackSettings(settings: SmartStackSettings): Promise<AppConfig> {
  return invoke('save_smart_stack_settings', { settings });
}

export function setRawOverrides(assetIds: string[], isRaw: boolean): Promise<AppConfig> {
  return invoke('set_raw_overrides', { assetIds, isRaw });
}

export function saveApplicationsConfig(cfg: ApplicationsConfig): Promise<AppConfig> {
  return invoke('save_applications_config', { cfg });
}

// Best-effort scan of installed native/Flatpak/Snap apps for the app picker -
// never rejects; an empty list just means nothing was found on this system.
export function listInstalledApps(): Promise<AppChoice[]> {
  return invoke('list_installed_apps');
}

// Resolves the asset's local path and spawns the chosen editor on it. Unlike
// every other mutating call in this file, this isn't gated by read-only mode
// - it launches a third-party process and touches no Immich data itself.
//
// `originalAssetId`/`originalFileName` register a round-trip watch on the
// asset's folder (see round_trip.rs) so a matching output file the editor
// saves back can be picked up automatically - see the
// 'round-trip-file-detected' listener in PhotosBrowser.tsx. Omit either to
// launch without registering a watch.
export function launchEditor(
  originalPath: string | null,
  appChoice: AppChoice,
  originalAssetId?: string | null,
  originalFileName?: string | null,
): Promise<void> {
  return invoke('launch_editor', { originalPath, appChoice, originalAssetId, originalFileName });
}

// "Show in File Manager" - resolves the asset's local path server-side and
// asks the desktop to reveal (and where supported, select) it - see
// reveal.rs. Not gated by read-only mode, same reasoning as launchEditor:
// this only ever reads the path, it launches a viewer, not an editor.
export function revealInFileManager(originalPath: string): Promise<void> {
  return invoke('reveal_in_file_manager', { originalPath });
}

export function testConnection(cfg: LibraryConfig): Promise<ConnectionStatus> {
  return invoke('test_connection', { cfg });
}

export function getTimelineBuckets(): Promise<TimeBucketInfo[]> {
  return invoke('get_timeline_buckets');
}

export function getTimelineBucketAssets(timeBucket: string): Promise<AssetSummary[]> {
  return invoke('get_timeline_bucket_assets', { timeBucket });
}

// Real server-side folder structure (see paths.rs/mod.rs's `/view/folder*`
// wrappers) - one entry per directory that directly contains at least one
// asset, e.g. "upload/library/admin/2024/09". Nothing to do with capture
// date; this is what FoldersBrowser builds its tree from.
export function getFolderPaths(): Promise<string[]> {
  return invoke('get_folder_paths');
}

// Direct-child assets of one exact folder path (non-recursive - matches how
// a real file browser navigates one folder at a time).
export function getFolderAssets(path: string): Promise<AssetSummary[]> {
  return invoke('get_folder_assets', { path });
}

export function deleteAssets(ids: string[], permanent = false): Promise<void> {
  return invoke('delete_assets', { ids, permanent });
}

export function getTrashedAssets(): Promise<AssetSummary[]> {
  return invoke('get_trashed_assets');
}

export function restoreAssets(ids: string[]): Promise<void> {
  return invoke('restore_assets', { ids });
}

export function emptyTrash(): Promise<void> {
  return invoke('empty_trash');
}

// Enqueues the edit onto the backend's background EditQueue and returns
// immediately with the assigned job ids (one per target, same order) - it
// does not wait for the XMP/Immich writes themselves. Rejects synchronously
// only for a structural reason (read-only mode, over the batch cap), before
// anything was enqueued; a per-job failure discovered later surfaces via
// getEditQueueStatus polling instead.
export function updateAssetMetadata(
  targets: MetadataEditTarget[],
  patch: AssetMetadataPatch,
): Promise<number[]> {
  return invoke('update_asset_metadata', {
    targets,
    rating: patch.rating ?? null,
    isFavorite: patch.isFavorite ?? null,
    description: patch.description ?? null,
  });
}

export function getEditQueueStatus(): Promise<EditQueueStatus> {
  return invoke('get_edit_queue_status');
}

export function clearCompletedEditJobs(): Promise<void> {
  return invoke('clear_completed_edit_jobs');
}

export function forceQuit(): Promise<void> {
  return invoke('force_quit');
}

export function createStack(ids: string[]): Promise<StackInfo> {
  return invoke('create_stack', { ids });
}

export function getStack(stackId: string): Promise<StackInfo> {
  return invoke('get_stack', { stackId });
}

// Every stack in the whole library, unscoped by bucket/date - see the note
// on the Rust side for why this exists (this server version doesn't inline
// stack info on the bulk timeline/search endpoints).
export function listStacks(): Promise<StackInfo[]> {
  return invoke('list_stacks');
}

export function setStackPick(stackId: string, assetId: string): Promise<void> {
  return invoke('set_stack_pick', { stackId, assetId });
}

// Corrects an asset's indexed capture date - used by the round-trip watcher
// once it finds the editor's output file, since that file often has no EXIF
// DateTimeOriginal of its own and gets indexed under "now" otherwise. See
// the Rust side for why this bypasses the edit queue.
export function setAssetCaptureDate(assetId: string, dateTimeOriginal: string): Promise<void> {
  return invoke('set_asset_capture_date', { assetId, dateTimeOriginal });
}

// Nudges Immich into generating a thumbnail for an asset right away - see
// commands::regenerate_asset_thumbnail's doc comment for why round-trip
// exports need this (Immich doesn't reliably auto-queue it for assets
// discovered via a Library scan the way it does for a normal upload).
export function regenerateAssetThumbnail(assetId: string): Promise<void> {
  return invoke('regenerate_asset_thumbnail', { assetId });
}

export function deleteStack(stackId: string): Promise<void> {
  return invoke('delete_stack', { stackId });
}

export interface UnsyncedMetadata {
  rating?: number;
  description?: string;
}

export interface MetadataSyncQuery {
  assetId: string;
  originalPath: string | null;
  currentRating: number | null;
  currentDescription: string | null;
}

export interface MetadataSyncResult {
  assetId: string;
  rating: number | null;
  description: string | null;
  hasProcessingSidecar: boolean;
}

// Read-only, best-effort - resolves silently to an empty/partial result if
// no local path mapping is configured or an asset's path doesn't resolve;
// only errors on the structural "nothing configured at all" case (see
// check_sidecar_metadata in commands.rs). Immich already having a value
// wins independently per field, so a result may carry just one of
// rating/description.
export function checkSidecarMetadata(queries: MetadataSyncQuery[]): Promise<MetadataSyncResult[]> {
  return invoke('check_sidecar_metadata', { queries });
}

// Enqueues Paste Image Processing onto the backend's background
// ProcessingQueue and returns immediately with the assigned job ids (one per
// target, same order/shape as updateAssetMetadata). Rejects synchronously
// for a structural reason (read-only mode, over the batch cap, or the
// source has no processing sidecar at all) before anything is queued; a
// per-job copy failure discovered later surfaces via
// getProcessingQueueStatus polling instead.
export function pasteImageProcessing(sourceOriginalPath: string, targets: MetadataEditTarget[]): Promise<number[]> {
  return invoke('paste_image_processing', { sourceOriginalPath, targets });
}

export type ProcessingJobStatus = 'pending' | 'copying' | 'done' | 'failed';

// Mirrors processing_queue.rs's ProcessingJob - one row of Paste Image
// Processing's advisory activity panel.
export interface ProcessingJob {
  jobId: number;
  targetAssetId: string;
  status: ProcessingJobStatus;
  createdAtMs: number;
  finishedAtMs: number | null;
  error: string | null;
}

export interface ProcessingQueueStatus {
  jobs: ProcessingJob[];
  pendingCount: number;
}

export function getProcessingQueueStatus(): Promise<ProcessingQueueStatus> {
  return invoke('get_processing_queue_status');
}

export function clearCompletedProcessingJobs(): Promise<void> {
  return invoke('clear_completed_processing_jobs');
}

// Variant 1 of the ART CLI round trip (see the feature plan): opens ART
// itself (launchArtRoundTrip awaits ART's own process exit as the "done
// editing" signal - a long-running invoke, not fire-and-forget like
// launchEditor), then runs ART-cli to produce the export deterministically
// and returns its generated filename. Only reachable when
// applications.artCliPath is non-empty (see useApplications' derived
// artRoundTripEnabled) - the generic (non-ART) "Tweak RAW Roundtrip" flow
// keeps calling launchEditor unchanged. `id` is only used backend-side to
// label/thumbnail this export's row in the shared ArtQueue board (see
// art_queue.rs's `start_manual`), so it shows up in ActivityIndicator/
// ActivityPanel alongside Headless RAW Roundtrip jobs.
// Mirrors commands.rs's ArtRoundTripOutcome: either the export actually
// happened, or ART closed with no `.arp`/`.pp3` ever written (no edit made or
// saved) - in which case the caller is expected to show a choice ("use ART's
// default profile anyway" vs. "cancel") via finishArtRoundTripWithDefaultProfile/
// cancelArtRoundTrip rather than treating this as a hard failure.
export type ArtRoundTripOutcome =
  | { kind: 'exported'; exportFileName: string }
  | { kind: 'noSidecar'; jobId: number; rawPath: string; exportPath: string };

export function launchArtRoundTrip(
  id: string,
  originalPath: string | null,
  fileName: string,
  fileExtension: string,
  rawEditor: AppChoice,
): Promise<ArtRoundTripOutcome> {
  return invoke('launch_art_round_trip', { id, originalPath, fileName, fileExtension, rawEditor });
}

// Second half of the no-sidecar choice - runs ART-cli against the
// already-resolved rawPath/exportPath (from a `noSidecar` outcome) using
// ART's default profile, the user's alternative to cancelling.
export function finishArtRoundTripWithDefaultProfile(jobId: number, rawPath: string, exportPath: string): Promise<string> {
  return invoke('finish_art_round_trip_with_default_profile', { jobId, rawPath, exportPath });
}

// The other half - releases the reserved export path placeholder and marks
// the queue row as cancelled, for when the user picks "cancel" instead.
export function cancelArtRoundTrip(jobId: number, exportPath: string): Promise<void> {
  return invoke('cancel_art_round_trip', { jobId, exportPath });
}

// One Headless RAW Roundtrip target - mirrors MetadataEditTarget plus the
// fileName/fileExtension the backend's export-naming logic needs.
export interface ArtRoundTripTarget {
  id: string;
  originalPath: string | null;
  fileName: string;
  fileExtension: string;
}

// Enqueues Variant 2 (Headless RAW Roundtrip) onto the backend's background
// ArtQueue and returns immediately with the assigned job ids - same
// "enqueue and let the frontend poll" shape as startImport/
// pasteImageProcessing. Accepts one target or many; the CLI renders each in
// turn.
export function batchArtRoundTrip(targets: ArtRoundTripTarget[]): Promise<number[]> {
  return invoke('batch_art_round_trip', { targets });
}

export type ArtJobStatus = 'pending' | 'running' | 'done' | 'failed';

// Mirrors art_queue.rs's ArtJob - one row of Headless RAW Roundtrip's
// advisory activity panel.
export interface ArtJob {
  jobId: number;
  assetId: string;
  status: ArtJobStatus;
  // Set once `done` - the generated export's bare filename, so
  // useArtJobReconciliation can call ingestRoundTripExport without a second
  // round trip to discover it.
  exportFileName: string | null;
  // Live 0-100 percentage while `running`, parsed backend-side from
  // ART-cli's own `--progress` output - null until the first progress line
  // arrives, and left at its last value (not reset) once the job settles.
  progressPercent: number | null;
  createdAtMs: number;
  finishedAtMs: number | null;
  error: string | null;
  // True once cancel_art_job has been requested for this job while it was
  // still pending/running - see art_queue.rs's ArtJob::cancel_requested.
  cancelRequested: boolean;
}

export interface ArtQueueStatus {
  jobs: ArtJob[];
  pendingCount: number;
}

export function getArtQueueStatus(): Promise<ArtQueueStatus> {
  return invoke('get_art_queue_status');
}

export function clearCompletedArtJobs(): Promise<void> {
  return invoke('clear_completed_art_jobs');
}

// Cancels one still-pending/running ART round trip job (Headless RAW
// Roundtrip's queue or a Variant 1 interactive round trip, both tracked on
// the same board) - the Activity panel's "Cancel Selected" bulk action.
// Resolves to false if the job had already finished by the time the backend
// looked at it, which isn't an error - just nothing left to cancel.
export function cancelArtJob(jobId: number): Promise<boolean> {
  return invoke('cancel_art_job', { jobId });
}

// Grid cells render at ~160px - "thumbnail" (~30KB) is the right size for that.
// "preview" (~1MB, full viewer resolution) is reserved for a future detail view.
export function thumbnailSrc(assetId: string, size: 'thumbnail' | 'preview' = 'thumbnail'): string {
  return `immich-thumb://thumbnail/${assetId}?size=${size}`;
}

export interface MemoryUsage {
  rssBytes: number;
}

export function getMemoryUsage(): Promise<MemoryUsage> {
  return invoke('get_memory_usage');
}

export interface ThumbCacheStats {
  dir: string;
  sizeBytes: number;
  fileCount: number;
}

export function getThumbCacheInfo(): Promise<ThumbCacheStats> {
  return invoke('get_thumb_cache_info');
}

export function clearThumbCache(): Promise<ThumbCacheStats> {
  return invoke('clear_thumb_cache');
}

export function saveImportSettings(settings: ImportSettings): Promise<AppConfig> {
  return invoke('save_import_settings', { settings });
}

export interface RemovableVolume {
  name: string;
  mountPoint: string;
}

// Quick-pick list above the plain folder-browse fallback in the Import
// dialog - best-effort, an empty list just falls back to manual browsing.
export function listRemovableVolumes(): Promise<RemovableVolume[]> {
  return invoke('list_removable_volumes');
}

// Mirrors capture_time.rs's CaptureTime - the date/time used to name an
// imported file (yyyymmdd_hh-mm-ss) and place it under a yyyy/yyyy_mm
// folder.
export interface CaptureTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

// Mirrors scan.rs's ScannedFile - one file found on the import source.
export interface ScannedFile {
  sourcePath: string;
  extension: string;
  sizeBytes: number;
  partialHash: string;
  captureTime: CaptureTime;
  captureTimeIsExif: boolean;
}

// Mirrors scan.rs's ScannedGroup - one basename group (e.g. a RAW+JPEG
// pair), grouped scoped to its own source directory (see scan.rs's own
// doc comment for why that scoping matters).
export interface ScannedGroup {
  basename: string;
  files: ScannedFile[];
  captureTime: CaptureTime;
  alreadyImported: boolean;
}

export interface ImportScanSummary {
  groups: ScannedGroup[];
  newCount: number;
  alreadyImportedCount: number;
  pairedCount: number;
  totalFiles: number;
}

// Scans the chosen source folder and returns both aggregate counts and the
// full group plan, so startImport doesn't need a second scan/hash pass over
// what could be a slow card reader.
export function scanImportSource(sourcePath: string): Promise<ImportScanSummary> {
  return invoke('scan_import_source', { sourcePath });
}

// Enqueues the copy jobs for every not-already-imported group and returns
// immediately with the assigned job ids - poll getImportQueueStatus for
// progress, same shape as updateAssetMetadata/getEditQueueStatus.
export function startImport(groups: ScannedGroup[], folderDepth: FolderDepth): Promise<number[]> {
  return invoke('start_import', { groups, folderDepth });
}

export type ImportJobStatus = 'pending' | 'copying' | 'done' | 'failed';

// Mirrors queue.rs's ImportJob.
export interface ImportJob {
  jobId: number;
  sourcePath: string;
  destPath: string;
  status: ImportJobStatus;
  sizeBytes: number;
  // Live while `copying` (updated roughly every 10s from the actual copy),
  // left at its last value on `failed` rather than reset - shows how far a
  // failed copy got.
  bytesCopied: number;
  createdAtMs: number;
  finishedAtMs: number | null;
  error: string | null;
}

export interface ImportQueueStatus {
  jobs: ImportJob[];
  pendingCount: number;
}

export function getImportQueueStatus(): Promise<ImportQueueStatus> {
  return invoke('get_import_queue_status');
}

export function clearCompletedImportJobs(): Promise<void> {
  return invoke('clear_completed_import_jobs');
}

// Auto-matches the configured External Library path against Immich's own
// libraries and triggers a Library Scan so it discovers the files an
// import batch just copied onto disk, without waiting on Immich's own
// periodic scan schedule. Call once per import batch, once every job in
// that batch has settled (not per-file) - the copy already succeeded
// either way, so a rejection here is just advisory.
export function scanImmichLibrary(): Promise<void> {
  return invoke('scan_immich_library');
}

// ---------------------------------------------------------------------
// Sharing & Export (Export to Folder / Export to Flickr) - see
// export_queue.rs/flickr.rs for the backend queue and OAuth client these
// wrap.
// ---------------------------------------------------------------------

export function saveSharingConfig(cfg: SharingConfig): Promise<AppConfig> {
  return invoke('save_sharing_config', { cfg });
}

export interface FlickrBeginAuthResult {
  authorizeUrl: string;
  oauthToken: string;
  oauthTokenSecret: string;
}

// Step 0 -> Step 1 of FlickrSetupDialog's wizard: exchanges the user's own
// Flickr app API key/secret for a request token and the URL to open in the
// system browser. Doesn't persist anything yet - the request token pair is
// only good until flickrCompleteAuth (or abandoned).
export function flickrBeginAuth(apiKey: string, apiSecret: string): Promise<FlickrBeginAuthResult> {
  return invoke('flickr_begin_auth', { apiKey, apiSecret });
}

// Step 2 -> Step 3: exchanges the request token + the verification code the
// user pasted back in for a real access token, and persists the whole
// connected FlickrConfig to config.json.
export function flickrCompleteAuth(
  apiKey: string,
  apiSecret: string,
  oauthToken: string,
  oauthTokenSecret: string,
  verifier: string,
): Promise<AppConfig> {
  return invoke('flickr_complete_auth', { apiKey, apiSecret, oauthToken, oauthTokenSecret, verifier });
}

export function flickrDisconnect(): Promise<AppConfig> {
  return invoke('flickr_disconnect');
}

export interface FlickrAlbum {
  id: string;
  title: string;
  photoCount: number;
}

export function flickrListAlbums(): Promise<FlickrAlbum[]> {
  return invoke('flickr_list_albums');
}

// One asset to export - mirrors ArtRoundTripTarget, the same shape already
// built for the ART CLI round trip.
export interface ExportAssetTarget {
  id: string;
  originalPath: string | null;
  fileName: string;
  fileExtension: string;
}

export type ExportFormat = 'jpeg' | 'original';

export interface FolderExportOptions {
  destination: string;
  format: ExportFormat;
  // Longest-edge target in pixels, fit-within (aspect preserved) - ignored
  // for `original` format. `null` means "full size" (Immich's own preview
  // resolution, just re-encoded at `quality`).
  sizePx: number | null;
  // 1-100, ignored for `original` format.
  quality: number;
}

// Enqueues one ExportJob per asset onto the backend's background
// ExportQueue and returns immediately with the assigned job ids - same
// "enqueue and let the frontend poll" shape as batchArtRoundTrip/startImport.
export function exportToFolder(assets: ExportAssetTarget[], options: FolderExportOptions): Promise<number[]> {
  return invoke('export_to_folder', { assets, options });
}

export type FlickrPrivacy = 'public' | 'friendsFamily' | 'private';

export type FlickrAlbumSelection = { kind: 'none' } | { kind: 'existing'; id: string } | { kind: 'new'; title: string };

export interface FlickrExportOptions {
  album: FlickrAlbumSelection;
  privacy: FlickrPrivacy;
  format: ExportFormat;
  sizePx: number | null;
  quality: number;
}

export function exportToFlickr(assets: ExportAssetTarget[], options: FlickrExportOptions): Promise<number[]> {
  return invoke('export_to_flickr', { assets, options });
}

export type ExportJobStatus = 'pending' | 'running' | 'done' | 'failed';
export type ExportTargetKind = 'folder' | 'flickr';

// Mirrors export_queue.rs's ExportJob - one row of the Export section in the
// advisory activity panel.
export interface ExportJob {
  jobId: number;
  assetId: string;
  target: ExportTargetKind;
  status: ExportJobStatus;
  // Set once `done` - the delivered file's name (on disk, or as uploaded to
  // Flickr).
  exportFileName: string | null;
  // No natural mid-point to report (a folder write / Flickr upload is a
  // single short-lived step, not ART-cli's multi-minute render) - null while
  // running, 100 the instant a job succeeds.
  progressPercent: number | null;
  createdAtMs: number;
  finishedAtMs: number | null;
  error: string | null;
  cancelRequested: boolean;
}

export interface ExportQueueStatus {
  jobs: ExportJob[];
  pendingCount: number;
}

export function getExportQueueStatus(): Promise<ExportQueueStatus> {
  return invoke('get_export_queue_status');
}

export function cancelExportJob(jobId: number): Promise<boolean> {
  return invoke('cancel_export_job', { jobId });
}

export function clearCompletedExportJobs(): Promise<void> {
  return invoke('clear_completed_export_jobs');
}
