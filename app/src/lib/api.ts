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
  // value is the single signal that switches "Open in RAW Editor"/the new
  // "Batch RAW Roundtrip" action over to the ART CLI round trip - see
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

export interface AppConfig {
  library: LibraryConfig;
  settingsFolder: string | null;
  shortcuts: Record<string, string>;
  smartStack: SmartStackSettings;
  applications: ApplicationsConfig;
  import: ImportSettings;
  rawOverrides: string[];
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
// artRoundTripEnabled) - the generic (non-ART) "Open in RAW Editor" flow
// keeps calling launchEditor unchanged.
export function launchArtRoundTrip(
  originalPath: string | null,
  fileName: string,
  fileExtension: string,
  rawEditor: AppChoice,
): Promise<string> {
  return invoke('launch_art_round_trip', { originalPath, fileName, fileExtension, rawEditor });
}

// One Batch RAW Roundtrip target - mirrors MetadataEditTarget plus the
// fileName/fileExtension the backend's export-naming logic needs.
export interface ArtRoundTripTarget {
  id: string;
  originalPath: string | null;
  fileName: string;
  fileExtension: string;
}

// Enqueues Variant 2 (Batch RAW Roundtrip) onto the backend's background
// ArtQueue and returns immediately with the assigned job ids - same
// "enqueue and let the frontend poll" shape as startImport/
// pasteImageProcessing.
export function batchArtRoundTrip(targets: ArtRoundTripTarget[]): Promise<number[]> {
  return invoke('batch_art_round_trip', { targets });
}

export type ArtJobStatus = 'pending' | 'running' | 'done' | 'failed';

// Mirrors art_queue.rs's ArtJob - one row of Batch RAW Roundtrip's advisory
// activity panel.
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
