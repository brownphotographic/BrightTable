/*
 * BrightTable // Copyright (C) 2026 Rob Brown
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import { useEffect, useReducer } from 'react';

// Same shape/rationale as lib/imageVersion.ts's bumpImageVersion/
// useImageVersion - MetadataRows.tsx's tag pills come from a dedicated
// GET /assets/{id} fetch (see its own doc comment for why: Immich never
// joins the tags relation on listing endpoints), decoupled from the
// AssetSummary object every other edit (rating/favorite/description)
// mutates in place. Without this, assigning/removing a tag via
// AddToTagDialog or TagsBrowser's "Remove from Tag" - both of which live
// outside MetadataRows entirely - left any currently-open metadata panel
// showing stale tags until the asset was re-selected or the app reloaded.
// Bump for an asset id after any tag<->asset link changes; every open
// MetadataRows instance for that asset re-fetches.
const versions = new Map<string, number>();
const listeners = new Set<() => void>();

export function bumpTagsVersion(assetId: string) {
  versions.set(assetId, (versions.get(assetId) ?? 0) + 1);
  listeners.forEach((l) => l());
}

export function getTagsVersion(assetId: string): number {
  return versions.get(assetId) ?? 0;
}

// Reactive read, same coarse "any bump re-renders every subscriber"
// tradeoff as useImageVersion - tag assignment is a rare, user-initiated
// action, not a hot path worth a per-id subscription.
export function useTagsVersion(assetId: string): number {
  const [, forceRender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const listener = () => forceRender();
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return getTagsVersion(assetId);
}
