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
  maxDeletePerSession: number;
}

export interface AppConfig {
  library: LibraryConfig;
  settingsFolder: string | null;
}

export interface ConnectionStatus {
  ok: boolean;
  resolvedUrl: string;
  via: string;
  serverVersion: string;
  userEmail: string;
}

export interface TimeBucketInfo {
  timeBucket: string;
  count: number;
}

export interface AssetSummary {
  id: string;
  fileCreatedAt: string;
  isFavorite: boolean;
  type: 'IMAGE' | 'VIDEO';
  thumbHash: string | null;
}

export function getConfig(): Promise<AppConfig> {
  return invoke('get_config');
}

export function saveLibraryConfig(cfg: LibraryConfig): Promise<AppConfig> {
  return invoke('save_library_config', { cfg });
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

export function deleteAssets(ids: string[]): Promise<void> {
  return invoke('delete_assets', { ids });
}

// Grid cells render at ~160px - "thumbnail" (~30KB) is the right size for that.
// "preview" (~1MB, full viewer resolution) is reserved for a future detail view.
export function thumbnailSrc(assetId: string, size: 'thumbnail' | 'preview' = 'thumbnail'): string {
  return `immich-thumb://thumbnail/${assetId}?size=${size}`;
}
