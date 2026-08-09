import { useEffect, useReducer } from 'react';
import { evictThumbCacheForAsset } from './api';

// Bumped for one asset id whenever a local edit changes its actual pixel/
// orientation data in place (currently just Viewer.tsx's rotate action, via
// refreshAssetImage below) - consumed by thumbnailSrc() as a cache-busting
// query param so the webview's own HTTP cache doesn't keep serving pre-edit
// bytes for the same URL (see thumbnailSrc's doc comment in lib/api.ts).
// Purely in-memory/session-scoped - a fresh launch has nothing to bust,
// which is fine since BrightTable's own on-disk thumb_cache is evicted
// server-side by the same action (see evictThumbCacheForAsset), so a cold
// cache miss re-fetches fresh bytes regardless.
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

// Which asset ids have a rotate queued server-side (Immich's own
// regenerate-thumbnail job - see commands::regenerate_asset_thumbnail) whose
// completion BrightTable has no way to observe. Drives the "Refresh from
// server" affordance on the Viewer's main preview and on AssetThumbImage
// (grid/filmstrip) - see their doc comments for why a manual, repeatable
// refresh replaced the old auto cache-bust-on-rotate + fixed timer, which
// raced the immediate refetch against the still-in-flight regen job and
// could permanently cache the pre-rotation bytes under the new version URL.
const rotatePending = new Set<string>();

export function markRotatePending(assetId: string) {
  rotatePending.add(assetId);
  listeners.forEach((l) => l());
}

// Reactive read, same coarse "any bump re-renders every subscriber"
// tradeoff as useImageVersion above.
export function useRotatePending(assetId: string): boolean {
  const [, forceRender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const listener = () => forceRender();
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return rotatePending.has(assetId);
}

// The actual "Refresh from server" action: pulls fresh bytes by bumping the
// cache-busting version (see thumbnailSrc) and evicting BrightTable's own
// on-disk thumb_cache entry, then clears the pending flag. User-triggered
// only, and safe to click more than once - if Immich's regen job hasn't
// landed yet the refetched bytes will still look pre-rotation, and the user
// can just click again once it has, rather than the old fixed-timer guess
// silently revealing stale bytes with no way to retry.
export function refreshAssetImage(assetId: string) {
  rotatePending.delete(assetId);
  bumpImageVersion(assetId);
  evictThumbCacheForAsset(assetId).catch(() => {});
}
