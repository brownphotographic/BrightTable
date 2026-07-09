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

export interface AppConfig {
  library: LibraryConfig;
  settingsFolder: string | null;
  shortcuts: Record<string, string>;
  smartStack: SmartStackSettings;
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
}

export interface StackInfo {
  id: string;
  primaryAssetId: string;
  assets: AssetSummary[];
}

export interface AssetMetadataPatch {
  rating?: number;
  isFavorite?: boolean;
  description?: string;
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

export function updateAssetMetadata(ids: string[], patch: AssetMetadataPatch): Promise<void> {
  return invoke('update_asset_metadata', {
    ids,
    rating: patch.rating ?? null,
    isFavorite: patch.isFavorite ?? null,
    description: patch.description ?? null,
  });
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

// Grid cells render at ~160px - "thumbnail" (~30KB) is the right size for that.
// "preview" (~1MB, full viewer resolution) is reserved for a future detail view.
export function thumbnailSrc(assetId: string, size: 'thumbnail' | 'preview' = 'thumbnail'): string {
  return `immich-thumb://thumbnail/${assetId}?size=${size}`;
}
