import { useEffect, useReducer } from 'react';

// Bumped for one asset id whenever a local edit changes its actual pixel/
// orientation data in place (currently just Viewer.tsx's rotate action) -
// consumed by thumbnailSrc() as a cache-busting query param so the webview's
// own HTTP cache doesn't keep serving pre-edit bytes for the same URL (see
// thumbnailSrc's doc comment in lib/api.ts). Purely in-memory/session-scoped
// - a fresh launch has nothing to bust, which is fine since ImmAture's own
// on-disk thumb_cache is evicted server-side by the same action (see
// evictThumbCacheForAsset), so a cold cache miss re-fetches fresh bytes
// regardless.
const versions = new Map<string, number>();
const listeners = new Set<() => void>();

export function bumpImageVersion(assetId: string) {
  versions.set(assetId, (versions.get(assetId) ?? 0) + 1);
  listeners.forEach((l) => l());
}

export function getImageVersion(assetId: string): number {
  return versions.get(assetId) ?? 0;
}

// Reactive read - re-renders the calling component whenever *any* asset's
// version bumps (not just this one), same coarse-invalidation tradeoff
// useShortcuts/useApplications make: rotates are rare, user-initiated
// actions, not a hot path worth a per-id subscription.
export function useImageVersion(assetId: string): number {
  const [, forceRender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const listener = () => forceRender();
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return getImageVersion(assetId);
}
