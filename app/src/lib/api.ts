import { invoke } from '@tauri-apps/api/core';

export type ConnMode = 'lan' | 'tailscale' | 'auto';
export type ShareType = 'nfs' | 'smb';

export interface LibraryConfig {
  connMode: ConnMode;
  lanUrl: string;
  tailscaleUrl: string;
  apiKey: string;
  shareType: ShareType;
  localRoot: string;
  immichRoot: string;
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
  // Client-only annotation, overlaid from RawOverridesProvider wherever an
  // AssetSummary is displayed (see lib/rawOverrides.tsx) - Immich itself has
  // no concept of this, so it's absent (not just false) on any AssetSummary
  // straight off the wire (e.g. a fresh getStack() result) until re-mapped.
  isRawOverride?: boolean;
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

// Grid cells render at ~160px - "thumbnail" (~30KB) is the right size for that.
// "preview" (~1MB, full viewer resolution) is reserved for a future detail view.
export function thumbnailSrc(assetId: string, size: 'thumbnail' | 'preview' = 'thumbnail'): string {
  return `immich-thumb://thumbnail/${assetId}?size=${size}`;
}
