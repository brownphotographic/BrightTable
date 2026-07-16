import { getFolderAssets, type AssetSummary } from './api';

// Immich only learns about a round-trip output file once scan_immich_library
// has kicked its own async library-scan job and that job has actually run -
// there's no push notification for "a specific file finished indexing", so
// this just retries the existing get_folder_assets call (already used by the
// Folders view) until the exact filename shows up or the budget runs out.
// ~22s total, matching the generosity of this app's other background-job
// polling (editQueue.tsx/importQueue.tsx poll every 1s indefinitely instead,
// but those have a visible "still working" UI - this one is silent, so it
// shouldn't wait indefinitely for a file that, for whatever reason, Immich
// never picks up).
const DEFAULT_ATTEMPTS = 15;
const DEFAULT_INTERVAL_MS = 1500;

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
