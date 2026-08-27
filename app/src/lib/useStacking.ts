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

import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { createStack, deleteStack, getStack, listStacks, setStackPick, type AssetStackInfo } from './api';
import type { SmartStackGroup } from './smartStack';

export interface UseStackingResult {
  stackByAssetId: Map<string, AssetStackInfo>;
  expandedStacks: Set<string>;
  toggleStackExpand: (stackId: string) => void;
  dissolveStack: (stackId: string) => Promise<string[]>;
  restackRemainder: (memberIds: string[]) => Promise<void>;
  createStackForSelection: (ids: string[]) => Promise<void>;
  applySmartStackGroups: (groups: SmartStackGroup[]) => Promise<void>;
  setStackPickAction: (stackId: string, assetId: string, memberIds: string[]) => Promise<void>;
  unstack: (stackId: string, memberIds: string[]) => Promise<void>;
  unstackByStackId: (stackId: string) => Promise<void>;
  unstackSelection: () => Promise<void>;
  hasStackedSelection: boolean;
  applyStackInfo: (memberIds: string[], info: AssetStackInfo) => void;
}

// Shared by every page with a stackable asset grid (Photos, Folders, Albums,
// People, Tags, Search Results) - originally duplicated near-verbatim
// between PhotosBrowser.tsx and FoldersBrowser.tsx, extracted here so a
// third+ consumer doesn't mean a third+ copy of the same ~150 lines. Each
// caller supplies its own `selected`/`setSelected` (already owned by every
// page today) rather than the hook owning selection state itself, so
// existing keyboard-nav/range-select behavior in each page is untouched.
//
// Deliberately does NOT own: overlaying `.stack` onto a page's own asset
// list/cache or filtering out hidden (non-pick) stack members - each page's
// asset storage shape differs too much (Photos' bucketed cache, Folders'
// per-path cache, Albums/People/Tags/Search's flat array) for a shared
// overlay step to make sense; callers overlay `stackByAssetId` onto their
// own asset source the same way PhotosBrowser.tsx's filteredAssetCache
// already does. Also does not own delete/trash - each page keeps its own
// thin removeAssets/trashAssets wrapper composing dissolveStack +
// restackRemainder + its own deleteAssets/local-cache-purge call.
export function useStacking(selected: Set<string>, setSelected: Dispatch<SetStateAction<Set<string>>>): UseStackingResult {
  const [stackByAssetId, setStackByAssetId] = useState<Map<string, AssetStackInfo>>(new Map());
  const [expandedStacks, setExpandedStacks] = useState<Set<string>>(new Set());

  useEffect(() => {
    listStacks()
      .then((stacks) => {
        const map = new Map<string, AssetStackInfo>();
        for (const s of stacks) {
          const info: AssetStackInfo = { id: s.id, primaryAssetId: s.primaryAssetId, assetCount: s.assets.length };
          for (const a of s.assets) map.set(a.id, info);
        }
        setStackByAssetId(map);
      })
      .catch(() => {});
  }, []);

  // Dissolves a stack server-side and purges *every* one of its members from
  // the local stackByAssetId cache - not just whichever subset the caller
  // already knows about. Also tolerates the stack already being gone
  // server-side instead of throwing.
  const dissolveStack = useCallback(
    async (stackId: string): Promise<string[]> => {
      let memberIds: string[] | null = null;
      try {
        const full = await getStack(stackId);
        memberIds = full.assets.map((a) => a.id);
      } catch {
        // Not found - already dissolved server-side under a prior mutation
        // this cache never heard about.
      }
      if (memberIds) {
        await deleteStack(stackId);
      } else {
        memberIds = [...stackByAssetId.entries()].filter(([, i]) => i.id === stackId).map(([id]) => id);
      }
      setStackByAssetId((m) => {
        const next = new Map(m);
        for (const id of memberIds!) next.delete(id);
        return next;
      });
      setExpandedStacks((s) => {
        if (!s.has(stackId)) return s;
        const next = new Set(s);
        next.delete(stackId);
        return next;
      });
      return memberIds;
    },
    [stackByAssetId],
  );

  // Re-creates a stack from whatever survives a trash operation (a page's
  // own removeAssets/trashAssets calls this after dissolveStack, once it's
  // filtered out the ids actually being trashed) - factored out here since
  // stackByAssetId's setter is otherwise private to this hook.
  const restackRemainder = useCallback(async (remaining: string[]) => {
    if (remaining.length < 2) return;
    const newStack = await createStack(remaining);
    const newInfo: AssetStackInfo = { id: newStack.id, primaryAssetId: newStack.primaryAssetId, assetCount: remaining.length };
    setStackByAssetId((m) => {
      const next = new Map(m);
      for (const id of remaining) next.set(id, newInfo);
      return next;
    });
  }, []);

  // Creates a real stack (first id = pick), dissolving+unioning any old
  // stack any of the ids already belonged to first, so hidden siblings of
  // an existing stack get carried over instead of silently dropped.
  const createStackForSelection = useCallback(
    async (ids: string[]) => {
      if (ids.length < 2) return;
      const oldStackIds = new Set(ids.map((id) => stackByAssetId.get(id)?.id).filter((id): id is string => !!id));
      const allIds = new Set(ids);
      for (const oldId of oldStackIds) {
        const memberIds = await dissolveStack(oldId);
        for (const id of memberIds) allIds.add(id);
      }
      const finalIds = [ids[0], ...[...allIds].filter((id) => id !== ids[0])];
      const stack = await createStack(finalIds);
      const info: AssetStackInfo = { id: stack.id, primaryAssetId: stack.primaryAssetId, assetCount: finalIds.length };
      setStackByAssetId((m) => {
        const next = new Map(m);
        for (const id of finalIds) next.set(id, info);
        return next;
      });
      setSelected(new Set());
    },
    [stackByAssetId, dissolveStack, setSelected],
  );

  // Smart Stack applies one createStack call per proposed group (pick
  // first) - sequential rather than Promise.all so a mid-batch failure
  // stops cleanly instead of an unordered pile of concurrent requests.
  const applySmartStackGroups = useCallback(
    async (groups: SmartStackGroup[]) => {
      for (const g of groups) {
        const oldStackIds = new Set(g.members.map((m) => m.stack?.id).filter((id): id is string => !!id));
        for (const oldId of oldStackIds) await dissolveStack(oldId);
        const ids = [g.pickId, ...g.members.map((m) => m.id).filter((id) => id !== g.pickId)];
        const stack = await createStack(ids);
        const info: AssetStackInfo = { id: stack.id, primaryAssetId: stack.primaryAssetId, assetCount: ids.length };
        setStackByAssetId((m) => {
          const next = new Map(m);
          for (const id of ids) next.set(id, info);
          return next;
        });
      }
      setSelected(new Set());
    },
    [dissolveStack, setSelected],
  );

  const setStackPickAction = useCallback(async (stackId: string, assetId: string, memberIds: string[]) => {
    await setStackPick(stackId, assetId);
    const info: AssetStackInfo = { id: stackId, primaryAssetId: assetId, assetCount: memberIds.length };
    setStackByAssetId((m) => {
      const next = new Map(m);
      for (const id of memberIds) next.set(id, info);
      return next;
    });
  }, []);

  const unstack = useCallback(async (stackId: string, memberIds: string[]) => {
    await deleteStack(stackId);
    setStackByAssetId((m) => {
      const next = new Map(m);
      for (const id of memberIds) next.delete(id);
      return next;
    });
    setExpandedStacks((s) => {
      if (!s.has(stackId)) return s;
      const next = new Set(s);
      next.delete(stackId);
      return next;
    });
  }, []);

  const toggleStackExpand = useCallback((stackId: string) => {
    setExpandedStacks((s) => {
      const next = new Set(s);
      if (next.has(stackId)) next.delete(stackId);
      else next.add(stackId);
      return next;
    });
  }, []);

  // Context menu / Viewer's Unstack don't already have a member list handy
  // the way StackBand does (it just fetched one) - fetch it fresh rather
  // than trust whatever happens to be in a page's own asset cache, since
  // non-primary members aren't guaranteed to be loaded there.
  const unstackByStackId = useCallback(
    async (stackId: string) => {
      const info = await getStack(stackId);
      await unstack(
        stackId,
        info.assets.map((a) => a.id),
      );
    },
    [unstack],
  );

  // Selection bar's bulk Unstack - the selection may span more than one
  // distinct stack, so this dissolves every stack touched by it, not just
  // one. Sequential, matching applySmartStackGroups's own sequencing.
  const unstackSelection = useCallback(async () => {
    const stackIds = new Set(
      [...selected].map((id) => stackByAssetId.get(id)?.id).filter((id): id is string => !!id),
    );
    for (const stackId of stackIds) {
      await unstackByStackId(stackId);
    }
    setSelected(new Set());
  }, [selected, stackByAssetId, unstackByStackId, setSelected]);

  const hasStackedSelection = useMemo(
    () => [...selected].some((id) => stackByAssetId.has(id)),
    [selected, stackByAssetId],
  );

  // Synchronous local-cache write, no API call - for callers that already
  // know a stack's post-mutation shape from elsewhere (e.g. the round-trip
  // ingest flow, which creates/updates the stack server-side itself via
  // lib/roundTrip.ts and just needs the result reflected here).
  const applyStackInfo = useCallback((memberIds: string[], info: AssetStackInfo) => {
    setStackByAssetId((m) => {
      const next = new Map(m);
      for (const id of memberIds) next.set(id, info);
      return next;
    });
  }, []);

  return {
    stackByAssetId,
    expandedStacks,
    toggleStackExpand,
    dissolveStack,
    restackRemainder,
    createStackForSelection,
    applySmartStackGroups,
    setStackPickAction,
    unstack,
    unstackByStackId,
    unstackSelection,
    hasStackedSelection,
    applyStackInfo,
  };
}
