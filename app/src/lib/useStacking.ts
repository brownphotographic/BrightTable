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

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { enqueueStackCreate, enqueueStackDissolve, listStacks, setStackPick, type AssetStackInfo } from './api';
import { waitForStackJobs } from './stackQueue';
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
  // Dissolves stackIds, then re-creates a stack from whatever survives after
  // excluding excludeIds (e.g. the ids about to be trashed) - one dissolve
  // wave followed by one create wave, replacing what used to be a per-page
  // inline sequential loop in every removeAssets/trashAssets.
  dissolveAndRestackMany: (stackIds: string[], excludeIds: Set<string>) => Promise<void>;
  hasStackedSelection: boolean;
  applyStackInfo: (memberIds: string[], info: AssetStackInfo) => void;
  // True while any dissolve/create batch enqueued by this hook is still in
  // flight - drives SelectionBar's Stack/Smart Stack/Unstack buttons'
  // disabled/"Working…" state, same pattern as rawEditorBusy.
  busy: boolean;
}

interface DissolveOutcome {
  // The freed member ids - always populated on success (including the
  // "stack already gone server-side" tolerance case, via a fallback to
  // this hook's own cache), empty only when the dissolve genuinely failed.
  memberIds: string[];
  error: string | null;
}

interface CreateOutcome {
  stackId: string | null;
  primaryAssetId: string | null;
  assetIds: string[];
  error: string | null;
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
// thin removeAssets/trashAssets wrapper composing dissolveAndRestackMany +
// its own deleteAssets/local-cache-purge call.
//
// Every multi-stack operation (bulk Unstack, Smart Stack apply, manual
// multi-select Stack, dissolve-before-trash) is built on two low-level
// batch primitives, `dissolveMany`/`createMany` below, which enqueue a
// whole wave of independent Dissolve/Create jobs onto the background
// `stack_queue` (src-tauri/src/stack_queue.rs) in one call and await the
// wave settling via `waitForStackJobs` - the Rust-side worker runs them
// concurrently instead of a frontend loop forcing one-at-a-time execution.
// See the plan's "Design decisions" for why this is two job kinds and
// "waves" rather than one job kind per current function.
export function useStacking(selected: Set<string>, setSelected: Dispatch<SetStateAction<Set<string>>>): UseStackingResult {
  const [stackByAssetId, setStackByAssetId] = useState<Map<string, AssetStackInfo>>(new Map());
  const [expandedStacks, setExpandedStacks] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const busyCount = useRef(0);

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

  // Wraps every dissolveMany/createMany call so `busy` is true for the
  // whole time any batch (of any size) is in flight - a counter, not a
  // plain boolean, since createStackForSelection/applySmartStackGroups/etc.
  // can have a dissolve wave and a create wave overlap in flight-adjacent
  // calls; the last one to finish is the one that should clear `busy`.
  const withBusy = useCallback(async <T,>(fn: () => Promise<T>): Promise<T> => {
    busyCount.current += 1;
    setBusy(true);
    try {
      return await fn();
    } finally {
      busyCount.current -= 1;
      if (busyCount.current === 0) setBusy(false);
    }
  }, []);

  // Enqueues one Dissolve job per stack id, waits for the whole wave, and
  // purges stackByAssetId/expandedStacks for every freed member - a stack
  // whose job genuinely failed (e.g. over max_writes_per_batch) is left
  // untouched in the cache, since it's still stacked server-side; only a
  // job that succeeded (with or without a resultMemberIds - see
  // stack_queue.rs's "already gone" tolerance) is purged.
  const dissolveMany = useCallback(
    (stackIds: string[]): Promise<Map<string, DissolveOutcome>> =>
      withBusy(async () => {
        const outcomes = new Map<string, DissolveOutcome>();
        if (stackIds.length === 0) return outcomes;
        const jobIds = await enqueueStackDissolve(stackIds);
        const jobs = await waitForStackJobs(jobIds);
        const freedIds = new Set<string>();
        const dissolvedStackIds: string[] = [];
        for (let i = 0; i < stackIds.length; i++) {
          const stackId = stackIds[i];
          const job = jobs[i];
          if (job.status === 'failed') {
            outcomes.set(stackId, { memberIds: [], error: job.error ?? 'Unstack failed' });
            continue;
          }
          const memberIds =
            job.resultMemberIds ?? [...stackByAssetId.entries()].filter(([, info]) => info.id === stackId).map(([id]) => id);
          outcomes.set(stackId, { memberIds, error: null });
          for (const id of memberIds) freedIds.add(id);
          dissolvedStackIds.push(stackId);
        }
        if (freedIds.size > 0) {
          setStackByAssetId((m) => {
            const next = new Map(m);
            for (const id of freedIds) next.delete(id);
            return next;
          });
        }
        if (dissolvedStackIds.length > 0) {
          setExpandedStacks((s) => {
            let changed = false;
            const next = new Set(s);
            for (const stackId of dissolvedStackIds) if (next.delete(stackId)) changed = true;
            return changed ? next : s;
          });
        }
        return outcomes;
      }),
    [withBusy, stackByAssetId],
  );

  // Enqueues one Create job per requested id list (first id of each =
  // pick), waits for the whole wave, and writes each successful result
  // into stackByAssetId.
  const createMany = useCallback(
    (requests: string[][]): Promise<CreateOutcome[]> =>
      withBusy(async () => {
        if (requests.length === 0) return [];
        const jobIds = await enqueueStackCreate(requests);
        const jobs = await waitForStackJobs(jobIds);
        const outcomes: CreateOutcome[] = requests.map((assetIds, i) => {
          const job = jobs[i];
          if (job.status === 'failed' || !job.resultStackId || !job.resultPrimaryAssetId) {
            return { stackId: null, primaryAssetId: null, assetIds, error: job.error ?? 'Stack creation failed' };
          }
          return { stackId: job.resultStackId, primaryAssetId: job.resultPrimaryAssetId, assetIds, error: null };
        });
        setStackByAssetId((m) => {
          const next = new Map(m);
          for (const outcome of outcomes) {
            if (!outcome.stackId || !outcome.primaryAssetId) continue;
            const info: AssetStackInfo = { id: outcome.stackId, primaryAssetId: outcome.primaryAssetId, assetCount: outcome.assetIds.length };
            for (const id of outcome.assetIds) next.set(id, info);
          }
          return next;
        });
        return outcomes;
      }),
    [withBusy],
  );

  // Dissolves a single stack, returning its freed member ids - throws if
  // the dissolve genuinely failed (as opposed to the "already gone"
  // tolerance case, which resolves normally with whatever this cache still
  // had recorded).
  const dissolveStack = useCallback(
    async (stackId: string): Promise<string[]> => {
      const outcomes = await dissolveMany([stackId]);
      const outcome = outcomes.get(stackId);
      if (outcome?.error) throw new Error(outcome.error);
      return outcome?.memberIds ?? [];
    },
    [dissolveMany],
  );

  // Re-creates a stack from whatever survives a trash operation - factored
  // out here since stackByAssetId's setter is otherwise private to this
  // hook.
  const restackRemainder = useCallback(
    async (remaining: string[]) => {
      if (remaining.length < 2) return;
      const [outcome] = await createMany([remaining]);
      if (outcome.error) throw new Error(outcome.error);
    },
    [createMany],
  );

  // Creates a real stack (first id = pick), dissolving+unioning any old
  // stack any of the ids already belonged to first (one batched dissolve
  // wave, not a sequential loop), so hidden siblings of an existing stack
  // get carried over instead of silently dropped.
  const createStackForSelection = useCallback(
    async (ids: string[]) => {
      if (ids.length < 2) return;
      const oldStackIds = [...new Set(ids.map((id) => stackByAssetId.get(id)?.id).filter((id): id is string => !!id))];
      const allIds = new Set(ids);
      if (oldStackIds.length > 0) {
        const outcomes = await dissolveMany(oldStackIds);
        for (const outcome of outcomes.values()) {
          for (const id of outcome.memberIds) allIds.add(id);
        }
      }
      const finalIds = [ids[0], ...[...allIds].filter((id) => id !== ids[0])];
      const [outcome] = await createMany([finalIds]);
      setSelected(new Set());
      if (outcome.error) throw new Error(outcome.error);
    },
    [stackByAssetId, dissolveMany, createMany, setSelected],
  );

  // Smart Stack applies every group's old-stack dissolves as one wave,
  // then every group's create as one wave - two parallel batches instead
  // of N sequential dissolve+create round trips.
  const applySmartStackGroups = useCallback(
    async (groups: SmartStackGroup[]) => {
      if (groups.length === 0) return;
      const allOldStackIds = [
        ...new Set(groups.flatMap((g) => g.members.map((m) => m.stack?.id).filter((id): id is string => !!id))),
      ];
      if (allOldStackIds.length > 0) {
        await dissolveMany(allOldStackIds);
      }
      const requests = groups.map((g) => [g.pickId, ...g.members.map((m) => m.id).filter((id) => id !== g.pickId)]);
      const outcomes = await createMany(requests);
      setSelected(new Set());
      const failed = outcomes.filter((o) => o.error);
      if (failed.length > 0) {
        const detail = failed[0].error;
        throw new Error(
          failed.length === outcomes.length
            ? `Failed to create ${failed.length} stack${failed.length === 1 ? '' : 's'}: ${detail}`
            : `${failed.length} of ${outcomes.length} stacks failed to create: ${detail}`,
        );
      }
    },
    [dissolveMany, createMany, setSelected],
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

  // `memberIds` is accepted for backward-compat with existing callers
  // (StackBand already has its own fresh member list) but no longer used -
  // dissolveMany re-derives the current membership itself via the queue
  // job, so this is now just a single-stack call to it.
  const unstack = useCallback(
    async (stackId: string, _memberIds: string[]) => {
      const outcomes = await dissolveMany([stackId]);
      const outcome = outcomes.get(stackId);
      if (outcome?.error) throw new Error(outcome.error);
    },
    [dissolveMany],
  );

  const toggleStackExpand = useCallback((stackId: string) => {
    setExpandedStacks((s) => {
      const next = new Set(s);
      if (next.has(stackId)) next.delete(stackId);
      else next.add(stackId);
      return next;
    });
  }, []);

  // Context menu / Viewer's Unstack don't already have a member list handy
  // the way StackBand does - dissolveMany fetches the current membership
  // itself, so this is just a thin single-stack wrapper.
  const unstackByStackId = useCallback((stackId: string) => unstack(stackId, []), [unstack]);

  // Selection bar's bulk Unstack - the selection may span more than one
  // distinct stack; every distinct stack is dissolved in one batched wave
  // instead of one at a time.
  const unstackSelection = useCallback(async () => {
    const stackIds = [...new Set([...selected].map((id) => stackByAssetId.get(id)?.id).filter((id): id is string => !!id))];
    if (stackIds.length === 0) {
      setSelected(new Set());
      return;
    }
    const outcomes = await dissolveMany(stackIds);
    setSelected(new Set());
    const failed = [...outcomes.values()].filter((o) => o.error);
    if (failed.length > 0) {
      const detail = failed[0].error;
      throw new Error(
        failed.length === outcomes.size ? `Failed to unstack: ${detail}` : `${failed.length} of ${outcomes.size} stacks failed to unstack: ${detail}`,
      );
    }
  }, [selected, stackByAssetId, dissolveMany, setSelected]);

  // One dissolve wave for stackIds, then re-creates whatever survives once
  // excludeIds (the ids about to be trashed) are filtered out of each
  // stack's freed members - replaces the per-page inline
  // "for (stackId of stackIdsTouched) { dissolve; restack; }" loop every
  // removeAssets/trashAssets used to have. Throws on any failure (dissolve
  // or create) so a page's own removeAssets/trashAssets doesn't proceed to
  // actually delete assets if the stack cleanup step didn't fully succeed -
  // same fail-safe property the old sequential loop had.
  const dissolveAndRestackMany = useCallback(
    async (stackIds: string[], excludeIds: Set<string>) => {
      const ids = [...new Set(stackIds)];
      if (ids.length === 0) return;
      const dissolveOutcomes = await dissolveMany(ids);
      const dissolveFailed = [...dissolveOutcomes.values()].filter((o) => o.error);
      const requests: string[][] = [];
      for (const outcome of dissolveOutcomes.values()) {
        const remaining = outcome.memberIds.filter((id) => !excludeIds.has(id));
        if (remaining.length >= 2) requests.push(remaining);
      }
      const createOutcomes = requests.length > 0 ? await createMany(requests) : [];
      const createFailed = createOutcomes.filter((o) => o.error);
      if (dissolveFailed.length > 0 || createFailed.length > 0) {
        throw new Error(dissolveFailed[0]?.error ?? createFailed[0]?.error ?? 'Failed to update stacks before trashing');
      }
    },
    [dissolveMany, createMany],
  );

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
    dissolveAndRestackMany,
    hasStackedSelection,
    applyStackInfo,
    busy,
  };
}
