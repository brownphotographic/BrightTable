import { forwardRef, useCallback, useDeferredValue, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  batchArtRoundTrip,
  checkSidecarMetadata,
  createStack,
  deleteAssets,
  deleteStack,
  getFolderAssets,
  getFolderPaths,
  getStack,
  launchArtRoundTrip,
  launchEditor,
  listStacks,
  pasteImageProcessing,
  revealInFileManager,
  setStackPick,
  updateAssetMetadata,
  type ArtJob,
  type ArtRoundTripTarget,
  type AssetMetadataPatch,
  type AssetStackInfo,
  type AssetSummary,
  type EditJob,
  type MetadataEditTarget,
  type ProcessingJob,
  type UnsyncedMetadata,
} from '../lib/api';
import { buildFolderTree, collectAssetPaths, findFolderNode, type FolderNode } from '../lib/folderTree';
import Viewer from '../components/Viewer';
import AssetTile, { type ClickMods } from '../components/AssetTile';
import SelectionBar from '../components/SelectionBar';
import AddToAlbumDialog from '../components/AddToAlbumDialog';
import StackBand from '../components/StackBand';
import ContextMenu, { type ContextMenuItem } from '../components/ContextMenu';
import SmartStackDialog from '../components/SmartStackDialog';
import ExportToFolderDialog from '../components/ExportToFolderDialog';
import PrintDialog from '../components/PrintDialog';
import ExportToFlickrDialog from '../components/ExportToFlickrDialog';
import MetadataPanel from '../components/MetadataPanel';
import ConfirmDialog from '../components/ConfirmDialog';
import NoSidecarDialog from '../components/NoSidecarDialog';
import InlineWarningBanner from '../components/InlineWarningBanner';
import { isTypingTarget, matchesShortcut, useShortcuts, type ShortcutId } from '../lib/shortcuts';
import { isRawAsset, matchesFilters, type Filters } from '../lib/filters';
import { isHiddenStackChild } from '../lib/stacks';
import type { SmartStackGroup } from '../lib/smartStack';
import { useRawOverrides } from '../lib/rawOverrides';
import { useApplications } from '../lib/applications';
import { useClipboard } from '../lib/clipboard';
import { pendingStyle } from '../lib/pending';
import { useEditQueue } from '../lib/editQueue';
import { useEditJobReconciliation } from '../lib/useEditJobReconciliation';
import { useArtQueue } from '../lib/artQueue';
import { useArtJobReconciliation } from '../lib/useArtJobReconciliation';
import { useProcessingQueue } from '../lib/processingQueue';
import { useProcessingJobReconciliation } from '../lib/useProcessingJobReconciliation';
import { useBucketMemo } from '../lib/bucketMemo';
import { ingestRoundTripExport, subscribeLateRoundTripOutcome, type RoundTripIngestOutcome } from '../lib/roundTrip';
import { useNoSidecarChoice } from '../lib/useNoSidecarChoice';

// See PhotosBrowser.tsx's identical helper for the full explanation -
// snapshots whichever AssetSummary fields a patch is about to touch, so a
// job that later fails can be rolled back to exactly what it was before.
function prevValuesFor(asset: AssetSummary | undefined, patch: AssetMetadataPatch): Partial<AssetSummary> {
  const prev: Partial<AssetSummary> = {};
  if (patch.rating !== undefined) prev.rating = asset?.rating ?? null;
  if (patch.isFavorite !== undefined) prev.isFavorite = asset?.isFavorite ?? false;
  if (patch.description !== undefined) prev.description = asset?.description ?? null;
  return prev;
}

const DEFAULT_THUMB_SIZE = 168;

export interface FoldersBrowserHandle {
  selectAll: () => void;
  deselectAll: () => void;
  stackSelected: () => void;
  openSmartStack: () => void;
  toggleRawOverrideForSelection: () => void;
  syncAllUnsyncedMetadata: () => void;
  copyImageProcessing: () => void;
  pasteImageProcessing: () => void;
  copyMetadata: () => void;
  pasteMetadata: () => void;
  openPrint: () => void;
}

// Backed by Immich's real server-side folder structure (GET
// /view/folder/unique-paths + /view/folder?path=), not capture date - the
// tree mirrors the actual filesystem layout Immich itself shows in its own
// Folders view, letting you drill into a real folder (or a whole subtree, or
// everything) as a flat grid instead of the Photos view's continuously-
// scrolling day-grouped timeline.
const FoldersBrowser = forwardRef<FoldersBrowserHandle, {
  metaOpen: boolean;
  onCloseMetadata: () => void;
  filters: Filters;
  onOpenApplicationsPreferences?: () => void;
  // See PhotosBrowser.tsx's identical prop - whether the Folders tab is the
  // one currently showing. Stays mounted while another tab is active so its
  // assetCache/folder tree survive switching away and back, but its global
  // keydown shortcuts need suppressing while hidden.
  active?: boolean;
}>(function FoldersBrowser({ metaOpen, onCloseMetadata, filters, onOpenApplicationsPreferences, active = true }, ref) {
  const [folderPaths, setFolderPaths] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // See PhotosBrowser.tsx's identical state - set only when
  // update_asset_metadata itself rejects synchronously (read-only mode,
  // over the batch cap), before anything was enqueued.
  const [enqueueError, setEnqueueError] = useState<string | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Record<string, boolean>>({});
  const [selectedNode, setSelectedNode] = useState<string>('all');
  // Keyed by time_bucket, same cache shape as PhotosBrowser - shared nowhere
  // (each tab keeps its own copy), but cheap enough (ids/dates, not images)
  // that refetching per tab visit is a non-issue.
  const [assetCache, setAssetCache] = useState<Record<string, AssetSummary[]>>({});
  const inFlight = useRef<Set<string>>(new Set());
  const containerRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [thumbSize, setThumbSize] = useState(DEFAULT_THUMB_SIZE);
  const lastClickedId = useRef<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [confirmDeleteSelection, setConfirmDeleteSelection] = useState(false);
  const [expandedStacks, setExpandedStacks] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; assetId: string } | null>(null);
  const [smartStackOpen, setSmartStackOpen] = useState(false);
  const [exportFolderAssets, setExportFolderAssets] = useState<AssetSummary[] | null>(null);
  const [printAsset, setPrintAsset] = useState<AssetSummary | null>(null);
  const [exportFlickrAssets, setExportFlickrAssets] = useState<AssetSummary[] | null>(null);
  const [addToAlbumTargets, setAddToAlbumTargets] = useState<string[] | null>(null);
  // This server version doesn't populate `stack` on /search/metadata or
  // /timeline/bucket at all (confirmed live - it's a newer-server-only
  // optimization), so stack membership is cross-referenced here from a
  // separate one-time GET /stacks fetch instead of trusted off individual
  // asset records. Kept independent of assetCache/patchAssetLocal - see the
  // filteredAssetCache overlay below.
  const [stackByAssetId, setStackByAssetId] = useState<Map<string, AssetStackInfo>>(new Map());
  // See PhotosBrowser.tsx's identical state for the full explanation - holds
  // whichever field(s) differ from what Immich currently has: a plain gap
  // (Immich has nothing) or a stale value (Immich has something, but the
  // sidecar changed since).
  const [unsyncedMetadata, setUnsyncedMetadata] = useState<Map<string, UnsyncedMetadata>>(new Map());
  // See PhotosBrowser.tsx's identical state for the full explanation.
  const [processingSidecarAssets, setProcessingSidecarAssets] = useState<Set<string>>(new Set());
  const [pasteProcessingTargets, setPasteProcessingTargets] = useState<string[] | null>(null);
  const { shortcuts, capturing } = useShortcuts();
  const { overrideIds, setOverride } = useRawOverrides();
  const { copiedProcessingSource, setCopiedProcessingSource, copiedMetadata, setCopiedMetadata } = useClipboard();

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

  useEffect(() => {
    getFolderPaths()
      .then((paths) => {
        setFolderPaths(paths);
        const tree = buildFolderTree(paths);
        if (tree.children.length === 1) setExpandedPaths({ [tree.children[0].path]: true });
      })
      .catch((e) => setError(String(e)));
  }, []);

  const tree = useMemo(() => buildFolderTree(folderPaths ?? []), [folderPaths]);

  // Which real folder paths feed the currently selected tree node - "all" is
  // every asset-holding folder in the whole tree, otherwise every
  // asset-holding folder at or under the selected node (a container folder
  // recurses over its subfolders; a leaf folder is just itself).
  const activeBucketKeys = useMemo(() => {
    if (selectedNode === 'all') return collectAssetPaths(tree);
    const node = findFolderNode(tree, selectedNode);
    return node ? collectAssetPaths(node) : [];
  }, [tree, selectedNode]);

  // Filters only ever hide assets from view/selection/navigation - the raw
  // assetCache (keyed the same way) stays the source of truth for edits and
  // for the loaded/not-yet-loaded check in the fetch effect below.
  //
  // Deferred for the same reason as PhotosBrowser: re-filtering touches every
  // asset ever loaded into assetCache, not just what's on screen, so this
  // lags a frame behind under load instead of making filter clicks feel slow.
  const deferredFilters = useDeferredValue(filters);
  // Reference inequality is the standard signal that a deferred value hasn't
  // caught up yet - `filters` gets a new object on every change, so this is
  // true for exactly the frames where the grid below is showing stale data.
  const isFiltering = filters !== deferredFilters;
  const filteredAssetCache = useBucketMemo(
    assetCache,
    [deferredFilters, stackByAssetId, overrideIds, unsyncedMetadata, processingSidecarAssets],
    (assets) =>
      assets
        .map((a) => ({
          ...a,
          stack: stackByAssetId.get(a.id) ?? null,
          isRawOverride: overrideIds.has(a.id),
          unsyncedMetadata: unsyncedMetadata.get(a.id),
          hasProcessingSidecar: processingSidecarAssets.has(a.id),
        }))
        .filter((a) => !isHiddenStackChild(a) && matchesFilters(a, deferredFilters)),
  );

  // Flat visual order of every currently-loaded, currently-visible asset
  // under the selected node - drives shift-click range selection and the
  // viewer's prev/next.
  const flatIds = useMemo(() => {
    const ids: string[] = [];
    for (const key of activeBucketKeys) {
      const assets = filteredAssetCache[key];
      if (!assets) continue;
      for (const a of assets) ids.push(a.id);
    }
    return ids;
  }, [activeBucketKeys, filteredAssetCache]);

  const assetById = useMemo(() => {
    const map = new Map<string, AssetSummary>();
    for (const assets of Object.values(filteredAssetCache)) {
      for (const a of assets) map.set(a.id, a);
    }
    return map;
  }, [filteredAssetCache]);

  // Same overlay as filteredAssetCache but without the isHiddenStackChild/
  // matchesFilters trims - needed to resolve a specific known id (opening a
  // non-pick stack member from StackBand, or selecting one to rate it) that
  // isHiddenStackChild deliberately keeps out of the flat grid/assetById.
  const overlaidAssetCache = useBucketMemo(
    assetCache,
    [stackByAssetId, overrideIds, unsyncedMetadata, processingSidecarAssets],
    (assets) =>
      assets.map((a) => ({
        ...a,
        stack: stackByAssetId.get(a.id) ?? null,
        isRawOverride: overrideIds.has(a.id),
        unsyncedMetadata: unsyncedMetadata.get(a.id),
        hasProcessingSidecar: processingSidecarAssets.has(a.id),
      })),
  );
  const assetByIdAll = useMemo(() => {
    const map = new Map<string, AssetSummary>();
    for (const assets of Object.values(overlaidAssetCache)) {
      for (const a of assets) map.set(a.id, a);
    }
    return map;
  }, [overlaidAssetCache]);

  const patchAssetLocal = useCallback((id: string, patch: Partial<AssetSummary>) => {
    setAssetCache((cache) => {
      for (const [key, assets] of Object.entries(cache)) {
        const idx = assets.findIndex((a) => a.id === id);
        if (idx !== -1) {
          const next = assets.slice();
          next[idx] = { ...next[idx], ...patch };
          return { ...cache, [key]: next };
        }
      }
      return cache;
    });
  }, []);

  // FoldersBrowser-local equivalent of PhotosBrowser.tsx's addAssetLocal,
  // added for ART CLI round-trip parity (decision 6 in the feature plan) -
  // FoldersBrowser otherwise has no auto-ingest at all, even for the
  // existing generic round trip. Inserts into whichever folder-keyed
  // assetCache entry already holds `referenceAssetId` - no bucket-count/
  // totalCount bookkeeping to keep in lockstep here (unlike PhotosBrowser,
  // this view has no separate counts state; flatIds/the status bar derive
  // their counts straight from assetCache), and no capture-date ordering to
  // preserve either (this grid doesn't day-group/sort within a folder the
  // way PhotosBrowser's timeline does).
  const addAssetLocal = useCallback(
    (asset: AssetSummary, referenceAssetId: string) => {
      let key: string | null = null;
      for (const [k, assets] of Object.entries(assetCache)) {
        if (assets.some((a) => a.id === asset.id)) return; // already present - dedupe
        if (assets.some((a) => a.id === referenceAssetId)) key = k;
      }
      if (!key) return;
      const foundKey = key;
      setAssetCache((cache) => ({ ...cache, [foundKey]: [...(cache[foundKey] ?? []), asset] }));
    },
    [assetCache],
  );

  // See PhotosBrowser.tsx's identical setup for the full explanation. Moved
  // above applyRoundTripOutcome (below) since that now needs trackJobs -
  // useCallback's dependency array evaluates eagerly, so referencing
  // trackJobs there before this const's own declaration would throw.
  const rollbackById = useRef<Map<number, { id: string; prevValues: Partial<AssetSummary> }>>(new Map());
  const { jobs: editJobs } = useEditQueue();

  const reconcileJob = useCallback(
    (job: EditJob) => {
      const entry = rollbackById.current.get(job.jobId);
      if (!entry) return;
      rollbackById.current.delete(job.jobId);
      if (job.status === 'failed') {
        patchAssetLocal(entry.id, entry.prevValues);
        setEnqueueError(job.error ?? "Couldn't save an edit — it's been reverted.");
      }
    },
    [patchAssetLocal],
  );
  const { trackJobs } = useEditJobReconciliation(editJobs, reconcileJob);

  // Applies an ingestRoundTripExport outcome (lib/roundTrip.ts) to local
  // state - see PhotosBrowser.tsx's identical helper (including the
  // checkSidecarMetadata re-check below - same "Copy Image Processing stayed
  // hidden after a mid-session Tweak/Headless Roundtrip" fix). Uses
  // outcome.original rather than assetByIdAll.get(outcome.originalAssetId) -
  // see roundTrip.ts's RoundTripIngestOutcome for why that lookup isn't
  // reliable here.
  const applyRoundTripOutcome = useCallback(
    (outcome: RoundTripIngestOutcome) => {
      addAssetLocal(outcome.asset, outcome.originalAssetId);
      if (outcome.stack) {
        const { memberIds, info } = outcome.stack;
        setStackByAssetId((m) => {
          const next = new Map(m);
          for (const id of memberIds) next.set(id, info);
          return next;
        });
      }
      // Tracks the rating/favorite/description copy roundTrip.ts's
      // finishIngest already enqueued onto the EditQueue - see
      // PhotosBrowser.tsx's identical registration for the full explanation.
      for (const jobId of outcome.metadataJobIds) {
        rollbackById.current.set(jobId, { id: outcome.asset.id, prevValues: outcome.metadataPrevValues });
      }
      trackJobs(outcome.metadataJobIds);
      const original = outcome.original;
      if (original.originalPath) {
        checkSidecarMetadata([
          {
            assetId: original.id,
            originalPath: original.originalPath,
            currentRating: original.rating,
            currentDescription: original.description,
          },
        ])
          .then(([result]) => {
            if (!result) return;
            if (result.rating !== null || result.description !== null) {
              setUnsyncedMetadata((m) => {
                const next = new Map(m);
                next.set(result.assetId, { rating: result.rating ?? undefined, description: result.description ?? undefined });
                return next;
              });
            }
            if (result.hasProcessingSidecar) {
              setProcessingSidecarAssets((s) => new Set(s).add(result.assetId));
            }
          })
          .catch(() => {});
      }
    },
    [addAssetLocal, trackJobs],
  );

  // Applies a round-trip outcome that only finished after its own foreground
  // poll budget already gave up - see PhotosBrowser.tsx's identical
  // subscription and roundTrip.ts's retryIngestInBackground for the full
  // explanation.
  useEffect(() => subscribeLateRoundTripOutcome(applyRoundTripOutcome), [applyRoundTripOutcome]);

  // Optimistic - see PhotosBrowser.tsx's identical commitEdit for the full
  // explanation.
  const commitEdit = useCallback(
    async (id: string, patch: AssetMetadataPatch) => {
      const originalPath = assetByIdAll.get(id)?.originalPath ?? null;
      const prevValues = prevValuesFor(assetByIdAll.get(id), patch);
      patchAssetLocal(id, patch);
      try {
        const jobIds = await updateAssetMetadata([{ id, originalPath }], patch);
        for (const jobId of jobIds) rollbackById.current.set(jobId, { id, prevValues });
        trackJobs(jobIds);
      } catch (e) {
        patchAssetLocal(id, prevValues);
        setEnqueueError(String(e));
      }
    },
    [patchAssetLocal, assetByIdAll, trackJobs],
  );

  const commitEditMany = useCallback(
    async (ids: string[], patch: AssetMetadataPatch) => {
      const targets = ids.map((id) => ({ id, originalPath: assetByIdAll.get(id)?.originalPath ?? null }));
      const prevByAsset = new Map(ids.map((id) => [id, prevValuesFor(assetByIdAll.get(id), patch)]));
      for (const id of ids) patchAssetLocal(id, patch);
      try {
        const jobIds = await updateAssetMetadata(targets, patch);
        jobIds.forEach((jobId, i) => {
          const id = ids[i];
          rollbackById.current.set(jobId, { id, prevValues: prevByAsset.get(id)! });
        });
        trackJobs(jobIds);
      } catch (e) {
        for (const id of ids) patchAssetLocal(id, prevByAsset.get(id)!);
        setEnqueueError(String(e));
      }
    },
    [patchAssetLocal, assetByIdAll, trackJobs],
  );

  const removeAssetsLocal = useCallback((ids: string[]) => {
    const idSet = new Set(ids);
    setAssetCache((cache) => {
      let changed = false;
      const next: Record<string, AssetSummary[]> = {};
      for (const [key, assets] of Object.entries(cache)) {
        const filtered = assets.filter((a) => !idSet.has(a.id));
        if (filtered.length !== assets.length) changed = true;
        next[key] = filtered;
      }
      return changed ? next : cache;
    });
    setSelected((s) => {
      if (![...idSet].some((id) => s.has(id))) return s;
      const next = new Set(s);
      for (const id of idSet) next.delete(id);
      return next;
    });
    setOpenId((cur) => (cur && idSet.has(cur) ? null : cur));
  }, []);

  // Dissolves a stack server-side and purges *every* one of its members from
  // the local stackByAssetId cache - not just whichever subset the caller
  // already knows about. Callers that only re-add a subset of those members
  // to a new stack (a partial merge, or a delete that drops one member) need
  // every other member's stale entry cleared too, or a later action on one of
  // them tries to operate on a stack id Immich has already forgotten about.
  // Also tolerates the stack already being gone server-side (e.g. an earlier
  // merge left another member's cache entry stale) instead of throwing -
  // there's nothing to dissolve, so it just clears whatever's cached for it.
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

  // Immich trashes a stack as one atomic unit, so trashing an id that's still
  // part of a stack would take its siblings down too - pull each affected
  // stack apart first and re-stack whatever's left over, so only the
  // requested id(s) actually go.
  const removeAssets = useCallback(
    async (ids: string[]) => {
      const idSet = new Set(ids);
      const stackIdsTouched = new Set<string>();
      for (const id of ids) {
        const info = stackByAssetId.get(id);
        if (info) stackIdsTouched.add(info.id);
      }
      for (const stackId of stackIdsTouched) {
        const memberIds = await dissolveStack(stackId);
        const remaining = memberIds.filter((id) => !idSet.has(id));
        if (remaining.length >= 2) {
          const newStack = await createStack(remaining);
          const newInfo: AssetStackInfo = {
            id: newStack.id,
            primaryAssetId: newStack.primaryAssetId,
            assetCount: remaining.length,
          };
          setStackByAssetId((m) => {
            const next = new Map(m);
            for (const id of remaining) next.set(id, newInfo);
            return next;
          });
        }
      }
      await deleteAssets(ids, false);
      removeAssetsLocal(ids);
    },
    [removeAssetsLocal, stackByAssetId, dissolveStack],
  );

  // Creates a real stack (first id = pick, matching the prototype's
  // "first selected" default), then updates the local stackByAssetId map so
  // the non-primary members immediately hide from the grid without needing
  // to refetch anything. Any id already belonging to a different stack (e.g.
  // merging two existing stacks' picks together, or adding new assets to a
  // stack whose non-primary members are hidden/unselected in the grid) has
  // its old stack dissolved first - dissolveStack's returned member list is
  // unioned into the new stack's ids so those hidden siblings get carried
  // over instead of silently dropped, and so they don't keep a stale
  // reference to a stack that's about to disappear.
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
    [stackByAssetId, dissolveStack],
  );

  // Smart Stack applies one createStack call per proposed group (pick first,
  // same "first id = primary" convention createStackForSelection already
  // uses) - sequential rather than Promise.all so a mid-batch failure stops
  // cleanly and the dialog can report which point it got to via the thrown
  // error, instead of an unordered pile of concurrent server requests.
  const applySmartStackGroups = useCallback(
    async (groups: SmartStackGroup[]) => {
      for (const g of groups) {
        // A group can include members merged in from an already-existing stack
        // (SmartStackDialog's mergeExistingStacks) rather than skipping them -
        // dissolve any such old stack(s) first so their members are free to
        // join the new, unified one.
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
    [dissolveStack],
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

  const unstack = useCallback(
    async (stackId: string, memberIds: string[]) => {
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
    },
    [],
  );

  const toggleStackExpand = useCallback((stackId: string) => {
    setExpandedStacks((s) => {
      const next = new Set(s);
      if (next.has(stackId)) next.delete(stackId);
      else next.add(stackId);
      return next;
    });
  }, []);

  // Context menu / Viewer's Unstack button don't already have a member list
  // handy the way StackBand does (it just fetched one) - fetch it fresh
  // rather than trust whatever happens to be in assetCache, since non-primary
  // members aren't guaranteed to be loaded there.
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

  const openIndex = openId ? flatIds.indexOf(openId) : -1;
  // See PhotosBrowser.tsx's identical lookup for why this uses assetByIdAll
  // instead of assetById/flatIds.
  const openAsset = openId ? assetByIdAll.get(openId) ?? null : null;

  const stripAssets = useMemo(
    () => flatIds.map((id) => assetById.get(id)).filter((a): a is AssetSummary => !!a),
    [flatIds, assetById],
  );

  // assetByIdAll (not assetById) so selecting a non-pick stack member from
  // StackBand still resolves here - otherwise the Metadata panel would show
  // nothing for it and rating/favorite couldn't be set.
  const selectedAssets = useMemo(
    () => [...selected].map((id) => assetByIdAll.get(id)).filter((a): a is AssetSummary => !!a),
    [selected, assetByIdAll],
  );

  const allSelectedFavorited = selectedAssets.length > 0 && selectedAssets.every((a) => a.isFavorite);

  // Shared by the favorite keyboard shortcut and the selection bar's
  // Favorite button - "all vs not all" matches the metadata panel's toggle
  // convention (any non-favorited member in the selection means the next
  // click favorites everything, rather than only clearing).
  const toggleFavoriteForSelection = useCallback(() => {
    if (selected.size === 0) return;
    commitEditMany([...selected], { isFavorite: !allSelectedFavorited }).catch(() => {});
  }, [selected, allSelectedFavorited, commitEditMany]);

  // Shared by every ART CLI round trip job (Variant 1's single "Tweak RAW
  // Roundtrip" and Variant 2's Headless RAW Roundtrip batch) - a `done` job
  // ingests its deterministic export (via ingestRoundTripExport)
  // incrementally rather than waiting for a whole batch to finish; a
  // `failed` job surfaces its error in the same banner a synchronous
  // rejection would. Declared before launchEditorForSelection since Variant
  // 1's own launch now just kicks the export off in the background
  // (launch_art_round_trip returns as soon as it's running, not once it's
  // done - see its own doc comment) and relies on this same reconciliation
  // to pick up the result, instead of awaiting the export inline.
  const { jobs: artJobs } = useArtQueue();
  const reconcileArtJob = useCallback(
    (job: ArtJob) => {
      if (job.status === 'failed') {
        setEnqueueError(job.error ?? "Couldn't complete a RAW Roundtrip export.");
        return;
      }
      if (!job.exportFileName) return;
      const original = assetByIdAll.get(job.assetId);
      if (!original) return;
      const exportFileName = job.exportFileName;
      ingestRoundTripExport(original, exportFileName).then((outcome) => {
        if (outcome) {
          applyRoundTripOutcome(outcome);
        } else {
          // The export itself succeeded (ART-cli already wrote the file) -
          // this only means Immich hasn't indexed it yet within the polling
          // budget, not that the export actually failed.
          setEnqueueError(
            `Exported "${exportFileName}", but it hasn't shown up in Immich yet — ImmAture will keep checking in the background and stack it automatically once it does.`,
          );
        }
      });
    },
    [assetByIdAll, applyRoundTripOutcome],
  );
  const { trackJobs: trackArtJobs } = useArtJobReconciliation(artJobs, reconcileArtJob);

  // See PhotosBrowser.tsx's identical callback for the full explanation -
  // launch-only, single-asset, redirects to Preferences when unconfigured,
  // branches to the ART CLI round trip when artRoundTripEnabled.
  const { applications, artRoundTripEnabled } = useApplications();
  // True while ART itself is open for the selection bar's single selected
  // asset (and briefly after, while the export path/sidecar are resolved) -
  // see SelectionBar.tsx's rawEditorBusy prop. Cleared as soon as the
  // ART-cli export is handed off to the background, not once that export
  // finishes - trackArtJobs above (not this flag) is what the actual
  // conversion's completion drives.
  const [artLaunchBusy, setArtLaunchBusy] = useState(false);
  const { resolve: resolveArtRoundTripOutcome, dialog: noSidecarDialog } = useNoSidecarChoice();
  const launchEditorForSelection = useCallback(
    async (role: 'rawEditor' | 'externalEditor') => {
      if (selectedAssets.length !== 1) return;
      const choice = applications[role];
      if (!choice) {
        onOpenApplicationsPreferences?.();
        return;
      }
      const asset = selectedAssets[0];
      if (role === 'rawEditor' && artRoundTripEnabled) {
        setArtLaunchBusy(true);
        try {
          const rtOutcome = await launchArtRoundTrip(asset.id, asset.originalPath, asset.fileName, asset.fileExtension, choice);
          const jobId = await resolveArtRoundTripOutcome(rtOutcome);
          trackArtJobs([jobId]);
        } finally {
          setArtLaunchBusy(false);
        }
        return;
      }
      await launchEditor(asset.originalPath, choice);
    },
    [selectedAssets, applications, artRoundTripEnabled, onOpenApplicationsPreferences, resolveArtRoundTripOutcome, trackArtJobs],
  );

  // See PhotosBrowser.tsx's identical callback for the full explanation -
  // one commitEdit per asset (descriptions are per-asset-unique, so unlike a
  // plain rating there's no meaningful grouping), reusing the existing
  // bulk-edit path's read-only/max-writes-per-batch gate unchanged.
  const syncMetadata = useCallback(
    async (ids: string[]) => {
      for (const id of ids) {
        const gap = unsyncedMetadata.get(id);
        if (!gap) continue;
        const patch: AssetMetadataPatch = {};
        if (gap.rating !== undefined) patch.rating = gap.rating;
        if (gap.description !== undefined) patch.description = gap.description;
        await commitEdit(id, patch);
      }
      setUnsyncedMetadata((m) => {
        const next = new Map(m);
        for (const id of ids) next.delete(id);
        return next;
      });
    },
    [unsyncedMetadata, commitEdit],
  );

  // See PhotosBrowser.tsx's identical callbacks for the full explanation.
  const handleCopyImageProcessing = useCallback(
    (asset: AssetSummary) => {
      if (!asset.originalPath || !asset.hasProcessingSidecar) return;
      setCopiedProcessingSource({ assetId: asset.id, originalPath: asset.originalPath, fileName: asset.fileName });
    },
    [setCopiedProcessingSource],
  );

  const handleCopyMetadata = useCallback(
    (asset: AssetSummary) => {
      setCopiedMetadata({ rating: asset.rating ?? undefined, isFavorite: asset.isFavorite, description: asset.description ?? undefined });
    },
    [setCopiedMetadata],
  );

  const handleShowInFileManager = useCallback((asset: AssetSummary) => {
    if (!asset.originalPath) return;
    revealInFileManager(asset.originalPath).catch((e) => setEnqueueError(String(e)));
  }, []);

  const handlePasteMetadata = useCallback(
    (ids: string[]) => {
      if (!copiedMetadata || ids.length === 0) return;
      commitEditMany(ids, copiedMetadata).catch(() => {});
    },
    [copiedMetadata, commitEditMany],
  );

  const requestPasteImageProcessing = useCallback(
    (ids: string[]) => {
      if (!copiedProcessingSource) return;
      const rawIds = ids.filter((id) => {
        const a = assetByIdAll.get(id);
        return !!a && isRawAsset(a);
      });
      if (rawIds.length === 0) return;
      setPasteProcessingTargets(rawIds);
    },
    [copiedProcessingSource, assetByIdAll],
  );

  const { jobs: processingJobs, refresh: refreshProcessingQueue } = useProcessingQueue();

  // See PhotosBrowser.tsx's identical callback for the full explanation -
  // a `done` Paste Image Processing job really did write a fresh
  // `.arp`/`.pp3` to disk, so mark the target as having a sidecar locally
  // too rather than leaving hasProcessingSidecar stale until the next full
  // folder reload.
  const reconcileProcessingJob = useCallback((job: ProcessingJob) => {
    if (job.status === 'failed') {
      setEnqueueError(job.error ?? "Couldn't paste image processing onto a photo.");
      return;
    }
    setProcessingSidecarAssets((s) => (s.has(job.targetAssetId) ? s : new Set(s).add(job.targetAssetId)));
  }, []);
  const { trackJobs: trackProcessingJobs } = useProcessingJobReconciliation(processingJobs, reconcileProcessingJob);

  const confirmPasteImageProcessing = useCallback(async () => {
    if (!copiedProcessingSource || !pasteProcessingTargets) return;
    const targets: MetadataEditTarget[] = pasteProcessingTargets.map((id) => ({
      id,
      originalPath: assetByIdAll.get(id)?.originalPath ?? null,
    }));
    const jobIds = await pasteImageProcessing(copiedProcessingSource.originalPath, targets);
    trackProcessingJobs(jobIds);
    // See processingQueue.tsx's doc comment on `refresh` - without this, a
    // fast batch paste can complete entirely between two scheduled polls,
    // leaving the TitleBar pill never shown at all.
    refreshProcessingQueue();
  }, [copiedProcessingSource, pasteProcessingTargets, assetByIdAll, trackProcessingJobs, refreshProcessingQueue]);

  // Headless RAW Roundtrip (ART CLI round trip Variant 2) - see
  // PhotosBrowser.tsx's identical setup for the full explanation.
  // artJobs/reconcileArtJob/trackArtJobs (shared with Variant 1's own launch
  // above) are declared earlier, before launchEditorForSelection.
  const [batchArtTargets, setBatchArtTargets] = useState<string[] | null>(null);
  const requestBatchArtRoundTrip = useCallback(
    (ids: string[]) => {
      const rawIds = ids.filter((id) => {
        const a = assetByIdAll.get(id);
        return !!a && isRawAsset(a);
      });
      if (rawIds.length < 1) return;
      setBatchArtTargets(rawIds);
    },
    [assetByIdAll],
  );

  const runBatchArtRoundTrip = useCallback(
    async (ids: string[]) => {
      const targets: ArtRoundTripTarget[] = ids.map((id) => {
        const a = assetByIdAll.get(id)!;
        return { id, originalPath: a.originalPath, fileName: a.fileName, fileExtension: a.fileExtension };
      });
      const jobIds = await batchArtRoundTrip(targets);
      trackArtJobs(jobIds);
      setSelected(new Set());
    },
    [assetByIdAll, trackArtJobs],
  );

  // See PhotosBrowser.tsx's identical callback for the full explanation - some
  // selected RAW photos may have no saved ART edits at all, so this surfaces
  // an explicit choice (export everyone vs. exclude just the affected ones)
  // once the outer "Headless RAW Roundtrip?" confirm is accepted, rather than
  // silently exporting the affected ones with ART's default profile.
  const [noSidecarBatch, setNoSidecarBatch] = useState<{ allIds: string[]; withoutSidecarCount: number } | null>(null);

  const confirmBatchArtRoundTrip = useCallback(async () => {
    if (!batchArtTargets) return;
    const targets = batchArtTargets;
    // See PhotosBrowser.tsx's identical callback - closes the dialog
    // immediately (same "close first, await after" trick the no-sidecar
    // follow-up dialog below already uses) instead of blocking it on a
    // decision. The no-sidecar warning below is decided from the cached
    // `hasProcessingSidecar` flag only, not a live checkSidecarMetadata
    // round trip - that used to sit in front of the enqueue call below,
    // and on a slow NFS mount left nothing visible on screen (dialog
    // already closed, pill not up yet) for up to two minutes. The cache is
    // kept fresh enough for this one judgment call by the context-menu-open
    // live recheck effect below; a stale read here can't cause data loss
    // since batch_art_round_trip itself still re-checks each target's
    // sidecar on disk before deciding whether to apply the default profile.
    // Errors are caught explicitly and routed to the standing enqueueError
    // banner since the dialog is already unmounted by the time any of this
    // can fail.
    setBatchArtTargets(null);
    const withoutSidecarCount = targets.filter((id) => !assetByIdAll.get(id)?.hasProcessingSidecar).length;
    if (withoutSidecarCount > 0) {
      setNoSidecarBatch({ allIds: targets, withoutSidecarCount });
      return;
    }
    try {
      await runBatchArtRoundTrip(targets);
    } catch (e) {
      setEnqueueError(String(e));
    }
  }, [batchArtTargets, assetByIdAll, runBatchArtRoundTrip]);

  // Stack/Unstack/Smart-Stack stay minimal here (band members already have
  // their own Unstack button and pick-star, so "Set as Stack Pick" never
  // applies) - but Copy/Paste Image Processing/Metadata are real per-member
  // actions with no other in-band entry point, so `StackBand` now forwards
  // right-clicks here too (see its own doc comment). Resolved via
  // `assetByIdAll`, not the filtered `assetById`, specifically so a
  // right-clicked *non-pick* member (excluded from the filtered map by
  // `isHiddenStackChild`) still resolves instead of silently rendering an
  // empty menu - same fix `Viewer.tsx`'s peek architecture already needed
  // for the identical structural reason (§7.16).
  const contextMenuItems: ContextMenuItem[] = useMemo(() => {
    if (!contextMenu) return [];
    const asset = assetByIdAll.get(contextMenu.assetId);
    const items: ContextMenuItem[] = [];
    if (selected.size >= 2) {
      items.push({
        label: `Stack ${selected.size} Photos`,
        onClick: () => createStackForSelection([...selected]).catch(() => {}),
      });
      items.push({
        label: `Smart Stack ${selected.size} Photos`,
        onClick: () => setSmartStackOpen(true),
      });
    }
    if (asset?.stack) {
      items.push({
        label: 'Unstack',
        onClick: () => unstackByStackId(asset.stack!.id).catch(() => {}),
      });
    }
    if (asset?.originalPath) {
      items.push({ label: 'Show in File Manager', onClick: () => handleShowInFileManager(asset) });
    }
    // Print is single-asset only in v1 - omitted (not just disabled) when
    // multiple are selected or the target is RAW, matching the Viewer
    // toolbar button's identical gating.
    if (asset && selected.size <= 1 && !isRawAsset(asset)) {
      items.push({ label: 'Print…', onClick: () => setPrintAsset(asset) });
    }
    if (asset && unsyncedMetadata.has(asset.id)) {
      items.push({
        label: 'Sync Metadata from Sidecar',
        onClick: () => syncMetadata([asset.id]).catch(() => {}),
      });
    }
    if (asset) {
      if (isRawAsset(asset) && asset.hasProcessingSidecar) {
        items.push({ label: 'Copy Image Processing', onClick: () => handleCopyImageProcessing(asset) });
      }
    }
    // Paste targets the whole current selection when 2+ are selected -
    // matching "Stack N Photos" above, which already does this regardless of
    // which specific tile was right-clicked - rather than always the single
    // right-clicked tile. Found live: a user with a multi-selection active
    // got a "Paste onto 1 photo?" confirm no matter how many were selected.
    const pasteTargetIds = selected.size >= 2 ? [...selected] : asset ? [asset.id] : [];
    const pasteTargetsIncludeRaw = pasteTargetIds.some((id) => {
      const a = assetByIdAll.get(id);
      return !!a && isRawAsset(a);
    });
    if (copiedProcessingSource && pasteTargetsIncludeRaw) {
      items.push({
        label: pasteTargetIds.length > 1 ? `Paste Image Processing to ${pasteTargetIds.length} Photos` : 'Paste Image Processing',
        onClick: () => requestPasteImageProcessing(pasteTargetIds),
      });
    }
    if (artRoundTripEnabled) {
      const rawTargetIds = pasteTargetIds.filter((id) => {
        const a = assetByIdAll.get(id);
        return !!a && isRawAsset(a);
      });
      if (rawTargetIds.length >= 1) {
        items.push({
          label: `Headless RAW Roundtrip (${rawTargetIds.length})`,
          onClick: () => requestBatchArtRoundTrip(rawTargetIds),
        });
      }
    }
    if (asset) {
      items.push({ label: 'Copy Metadata', onClick: () => handleCopyMetadata(asset) });
    }
    if (copiedMetadata && pasteTargetIds.length > 0) {
      items.push({
        label: pasteTargetIds.length > 1 ? `Paste Metadata to ${pasteTargetIds.length} Photos` : 'Paste Metadata',
        onClick: () => handlePasteMetadata(pasteTargetIds),
      });
    }
    if (pasteTargetIds.length > 0) {
      items.push({
        label: pasteTargetIds.length > 1 ? `Add ${pasteTargetIds.length} Photos to Album…` : 'Add to Album…',
        onClick: () => setAddToAlbumTargets(pasteTargetIds),
      });
      const exportAssets = pasteTargetIds.map((id) => assetByIdAll.get(id)).filter((a): a is AssetSummary => !!a);
      items.push({ label: 'Export to Folder…', onClick: () => setExportFolderAssets(exportAssets) });
      items.push({ label: 'Share to Flickr…', onClick: () => setExportFlickrAssets(exportAssets) });
    }
    return items;
  }, [
    contextMenu,
    assetByIdAll,
    selected,
    createStackForSelection,
    unstackByStackId,
    unsyncedMetadata,
    syncMetadata,
    copiedProcessingSource,
    copiedMetadata,
    handleShowInFileManager,
    handleCopyImageProcessing,
    requestPasteImageProcessing,
    handleCopyMetadata,
    handlePasteMetadata,
    artRoundTripEnabled,
    requestBatchArtRoundTrip,
  ]);

  // See PhotosBrowser.tsx's identical effect for the full explanation -
  // right-clicking a RAW asset that doesn't currently show Copy Image
  // Processing live-rechecks disk once, covering sidecars created outside
  // this view's own tracked flows (an external ART/RawTherapee run, or a
  // paste that happened in the Photos view, which keeps its own separate
  // processingSidecarAssets cache).
  useEffect(() => {
    if (!contextMenu) return;
    const asset = assetByIdAll.get(contextMenu.assetId);
    if (!asset || !asset.originalPath || asset.hasProcessingSidecar || !isRawAsset(asset)) return;
    let cancelled = false;
    checkSidecarMetadata([
      { assetId: asset.id, originalPath: asset.originalPath, currentRating: asset.rating, currentDescription: asset.description },
    ])
      .then((results) => {
        if (cancelled) return;
        if (results.some((r) => r.hasProcessingSidecar)) {
          setProcessingSidecarAssets((s) => (s.has(asset.id) ? s : new Set(s).add(asset.id)));
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [contextMenu, assetByIdAll]);

  const navigateOpen = (dir: 1 | -1) => {
    const ni = openIndex + dir;
    if (ni < 0 || ni >= flatIds.length) return;
    setOpenId(flatIds[ni]);
  };

  const selectAll = useCallback(() => setSelected(new Set(flatIds)), [flatIds]);
  const deselectAll = useCallback(() => setSelected(new Set()), []);

  // Scoped to whichever selected assets are actually .tif/.tiff (the only
  // extension this override is meaningful for) - toggles them all to match
  // whatever the majority state isn't, mirroring the favorite-toggle
  // shortcut's "all vs not all" convention. A no-op if none of the current
  // selection is a TIFF.
  const toggleRawOverrideForSelection = useCallback(() => {
    const tifIds = [...selected].filter((id) => {
      const ext = assetById.get(id)?.fileExtension;
      return ext === 'TIF' || ext === 'TIFF';
    });
    if (!tifIds.length) return;
    const allMarked = tifIds.every((id) => overrideIds.has(id));
    setOverride(tifIds, !allMarked);
  }, [selected, assetById, overrideIds, setOverride]);

  useImperativeHandle(
    ref,
    () => ({
      selectAll,
      deselectAll,
      stackSelected: () => {
        createStackForSelection([...selected]).catch(() => {});
      },
      openSmartStack: () => setSmartStackOpen(true),
      toggleRawOverrideForSelection,
      syncAllUnsyncedMetadata: () => {
        syncMetadata([...unsyncedMetadata.keys()]).catch(() => {});
      },
      copyImageProcessing: () => {
        if (selectedAssets.length === 1) handleCopyImageProcessing(selectedAssets[0]);
      },
      pasteImageProcessing: () => {
        requestPasteImageProcessing([...selected]);
      },
      copyMetadata: () => {
        if (selectedAssets.length === 1) handleCopyMetadata(selectedAssets[0]);
      },
      pasteMetadata: () => {
        handlePasteMetadata([...selected]);
      },
      // Single-asset resolution, matching PhotosBrowser's identical
      // openPrint - the lone selected asset, else the open Viewer asset,
      // else the first currently-visible one. A RAW-resolved target is a
      // silent no-op (defense in depth; the real gates are the menu item/
      // Viewer button/context menu).
      openPrint: () => {
        const target =
          selectedAssets.length === 1
            ? selectedAssets[0]
            : openId
              ? (assetByIdAll.get(openId) ?? null)
              : (assetByIdAll.get(flatIds[0]) ?? null);
        if (target && !isRawAsset(target)) setPrintAsset(target);
      },
    }),
    [
      selectAll,
      deselectAll,
      createStackForSelection,
      selected,
      toggleRawOverrideForSelection,
      syncMetadata,
      unsyncedMetadata,
      selectedAssets,
      handleCopyImageProcessing,
      requestPasteImageProcessing,
      openId,
      assetByIdAll,
      flatIds,
      handleCopyMetadata,
      handlePasteMetadata,
    ],
  );

  // Switching tree nodes starts from a fresh scroll position and selection -
  // otherwise a selection made in one month could look like it silently
  // carried over into an unrelated one.
  useEffect(() => {
    setSelected(new Set());
    containerRef.current?.scrollTo(0, 0);
  }, [selectedNode]);

  useEffect(() => {
    // See PhotosBrowser.tsx's identical guard - also skipped while inactive
    // (mounted but hidden behind the Photos tab) so these don't fire on top
    // of whatever tab actually has focus.
    if (openId || !active) return;
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e) || capturing) return;
      if (matchesShortcut(e, shortcuts.open) && lastClickedId.current) {
        e.preventDefault();
        setOpenId(lastClickedId.current);
      } else if (matchesShortcut(e, shortcuts.selectAll)) {
        e.preventDefault();
        selectAll();
      } else if (matchesShortcut(e, shortcuts.deselect)) {
        deselectAll();
      } else if (matchesShortcut(e, shortcuts.delete) && selected.size > 0) {
        e.preventDefault();
        setConfirmDeleteSelection(true);
      } else if (matchesShortcut(e, shortcuts.favorite) && selected.size > 0) {
        e.preventDefault();
        toggleFavoriteForSelection();
      } else if (matchesShortcut(e, shortcuts.stack) && selected.size >= 2) {
        e.preventDefault();
        createStackForSelection([...selected]).catch(() => {});
      } else if (matchesShortcut(e, shortcuts.copyMetadata) && selectedAssets.length === 1) {
        e.preventDefault();
        handleCopyMetadata(selectedAssets[0]);
      } else if (matchesShortcut(e, shortcuts.pasteMetadata) && selected.size > 0 && copiedMetadata) {
        e.preventDefault();
        handlePasteMetadata([...selected]);
      } else if (matchesShortcut(e, shortcuts.copyImageProcessing) && selectedAssets.length === 1) {
        e.preventDefault();
        handleCopyImageProcessing(selectedAssets[0]);
      } else if (matchesShortcut(e, shortcuts.pasteImageProcessing) && selected.size > 0 && copiedProcessingSource) {
        e.preventDefault();
        requestPasteImageProcessing([...selected]);
      } else if (selected.size > 0) {
        const ratingByShortcut: [ShortcutId, number][] = [
          ['rate0', 0],
          ['rate1', 1],
          ['rate2', 2],
          ['rate3', 3],
          ['rate4', 4],
          ['rate5', 5],
          ['reject', -1],
        ];
        for (const [id, rating] of ratingByShortcut) {
          if (matchesShortcut(e, shortcuts[id])) {
            e.preventDefault();
            commitEditMany([...selected], { rating }).catch(() => {});
            break;
          }
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    openId,
    active,
    selectAll,
    deselectAll,
    selected,
    shortcuts,
    capturing,
    commitEditMany,
    createStackForSelection,
    toggleFavoriteForSelection,
    selectedAssets,
    handleCopyMetadata,
    handlePasteMetadata,
    handleCopyImageProcessing,
    requestPasteImageProcessing,
    copiedMetadata,
    copiedProcessingSource,
  ]);

  const selectExclusive = useCallback((id: string) => {
    setSelected(new Set([id]));
    lastClickedId.current = id;
  }, []);

  const toggleOne = useCallback((id: string) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    lastClickedId.current = id;
  }, []);

  const selectRange = useCallback(
    (id: string) => {
      const anchor = lastClickedId.current;
      const lo = anchor ? flatIds.indexOf(anchor) : -1;
      const hi = flatIds.indexOf(id);
      if (lo === -1 || hi === -1) {
        setSelected(new Set([id]));
        return;
      }
      const [start, end] = lo < hi ? [lo, hi] : [hi, lo];
      setSelected(new Set(flatIds.slice(start, end + 1)));
    },
    [flatIds],
  );

  const handleThumbClick = useCallback(
    (id: string, mods: ClickMods) => {
      if (mods.shiftKey) selectRange(id);
      else if (mods.ctrlKey || mods.metaKey) toggleOne(id);
      else selectExclusive(id);
    },
    [selectRange, toggleOne, selectExclusive],
  );

  // Unlike the timeline's month buckets, real folders' sizes aren't known
  // upfront (Immich's folder API has no per-folder count) - a fixed guess is
  // corrected once each section actually renders via virtualizer.measure().
  const rowHeightGuess = Math.round((thumbSize * 2) / 3) + 12;
  const virtualizer = useVirtualizer({
    count: activeBucketKeys.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => rowHeightGuess * 4,
    overscan: 3,
  });

  useEffect(() => {
    virtualizer.measure();
    // Re-measure whenever the selected node changes the set of bucket keys
    // being windowed - otherwise stale row-height estimates from the
    // previous node's bucket sizes can linger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBucketKeys]);

  useEffect(() => {
    for (const item of virtualizer.getVirtualItems()) {
      const key = activeBucketKeys[item.index];
      if (!key || assetCache[key] || inFlight.current.has(key)) continue;
      inFlight.current.add(key);
      getFolderAssets(key)
        .then((assets) => {
          setAssetCache((c) => ({ ...c, [key]: assets }));
          checkSidecarMetadata(
            assets.map((a) => ({
              assetId: a.id,
              originalPath: a.originalPath,
              currentRating: a.rating,
              currentDescription: a.description,
            })),
          )
            .then((results) => {
              if (!results.length) return;
              // See PhotosBrowser.tsx's identical guard - a result can carry
              // hasProcessingSidecar: true with no metadata gap at all.
              const metaResults = results.filter((r) => r.rating !== null || r.description !== null);
              if (metaResults.length) {
                setUnsyncedMetadata((m) => {
                  const next = new Map(m);
                  for (const r of metaResults) {
                    next.set(r.assetId, {
                      rating: r.rating ?? undefined,
                      description: r.description ?? undefined,
                    });
                  }
                  return next;
                });
              }
              const withSidecar = results.filter((r) => r.hasProcessingSidecar).map((r) => r.assetId);
              if (withSidecar.length) {
                setProcessingSidecarAssets((s) => {
                  const next = new Set(s);
                  for (const id of withSidecar) next.add(id);
                  return next;
                });
              }
            })
            .catch(() => {});
        })
        .catch(() => setAssetCache((c) => ({ ...c, [key]: [] })))
        .finally(() => inFlight.current.delete(key));
    }
  });

  if (error) {
    return (
      <div style={{ padding: 24, color: 'var(--text-dim)' }}>
        Couldn't load the library — {error}. Check Preferences → Library.
      </div>
    );
  }

  if (!folderPaths) {
    return <div style={{ padding: 24, color: 'var(--text-dim)' }}>Loading folders…</div>;
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {enqueueError && <InlineWarningBanner message={enqueueError} onDismiss={() => setEnqueueError(null)} />}
      {selected.size > 0 && (
        <SelectionBar
          count={selected.size}
          onCancel={deselectAll}
          onStack={() => createStackForSelection([...selected]).catch(() => {})}
          onSmartStack={() => setSmartStackOpen(true)}
          onFavorite={toggleFavoriteForSelection}
          allFavorited={allSelectedFavorited}
          onRate={(rating) => commitEditMany([...selected], { rating }).catch(() => {})}
          unsyncedCount={[...selected].filter((id) => unsyncedMetadata.has(id)).length}
          onSyncMetadata={() => syncMetadata([...selected].filter((id) => unsyncedMetadata.has(id))).catch(() => {})}
          onDelete={() => setConfirmDeleteSelection(true)}
          canOpenInRawEditor={selectedAssets.length === 1 && isRawAsset(selectedAssets[0])}
          onOpenInRawEditor={() => launchEditorForSelection('rawEditor').catch((e) => setEnqueueError(String(e)))}
          onOpenInExternalEditor={() => launchEditorForSelection('externalEditor').catch((e) => setEnqueueError(String(e)))}
          rawEditorBusy={artLaunchBusy}
          canPasteImageProcessing={
            !!copiedProcessingSource &&
            [...selected].some((id) => {
              const a = assetByIdAll.get(id);
              return !!a && isRawAsset(a);
            })
          }
          onPasteImageProcessing={() => requestPasteImageProcessing([...selected])}
          canPasteMetadata={!!copiedMetadata}
          onPasteMetadata={() => handlePasteMetadata([...selected])}
          rawSelectedCount={
            artRoundTripEnabled
              ? [...selected].filter((id) => {
                  const a = assetByIdAll.get(id);
                  return !!a && isRawAsset(a);
                }).length
              : undefined
          }
          onBatchArtRoundTrip={artRoundTripEnabled ? () => requestBatchArtRoundTrip([...selected]) : undefined}
          onAddToAlbum={() => setAddToAlbumTargets([...selected])}
        />
      )}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <div style={{ width: 208, flexShrink: 0, borderRight: '1px solid rgba(0,0,0,0.35)', padding: '10px 8px', overflow: 'auto' }}>
          <TreeRow
            label="All Originals"
            depth={0}
            selected={selectedNode === 'all'}
            hasChildren={false}
            onSelect={() => setSelectedNode('all')}
          />
          {tree.children.map((node) => (
            <FolderTreeRows
              key={node.path}
              node={node}
              depth={0}
              selectedNode={selectedNode}
              expandedPaths={expandedPaths}
              onSelect={setSelectedNode}
              onToggle={(path) => setExpandedPaths((e) => ({ ...e, [path]: !e[path] }))}
            />
          ))}
        </div>

        <div ref={containerRef} style={{ flex: 1, overflow: 'auto', minHeight: 0, padding: 16, ...pendingStyle(isFiltering) }}>
          {activeBucketKeys.length === 0 ? (
            <div style={{ color: 'var(--text-dimmer)', fontSize: 12.5 }}>No assets in this folder.</div>
          ) : (
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
              {virtualizer.getVirtualItems().map((item) => {
                const key = activeBucketKeys[item.index];
                const assets = filteredAssetCache[key];
                return (
                  <div
                    key={key}
                    ref={virtualizer.measureElement}
                    data-index={item.index}
                    style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${item.start}px)` }}
                  >
                    {assets ? (
                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: `repeat(auto-fill, minmax(${thumbSize}px, 1fr))`,
                          gap: 12,
                          paddingBottom: 12,
                        }}
                      >
                        {assets.map((a) => {
                          if (a.stack && a.stack.primaryAssetId === a.id && expandedStacks.has(a.stack.id)) {
                            const stackId = a.stack.id;
                            return (
                              <StackBand
                                key={a.id}
                                stackId={stackId}
                                selected={selected}
                                onSelectMember={(id) => handleThumbClick(id, { shiftKey: false, ctrlKey: false, metaKey: false })}
                                onOpen={setOpenId}
                                onCollapse={() => toggleStackExpand(stackId)}
                                onUnstack={(memberIds) => unstack(stackId, memberIds)}
                                onSetPick={(assetId, memberIds) => setStackPickAction(stackId, assetId, memberIds)}
                                onRate={(id, rating) => commitEdit(id, { rating })}
                                onContextMenu={(assetId, x, y) => setContextMenu({ assetId, x, y })}
                                resolveAsset={(id) => assetByIdAll.get(id)}
                              />
                            );
                          }
                          return (
                            <AssetTile
                              key={a.id}
                              asset={a}
                              selected={selected.has(a.id)}
                              onToggleSelect={handleThumbClick}
                              onToggleOne={toggleOne}
                              onOpen={setOpenId}
                              onContextMenu={(assetId, x, y) => setContextMenu({ assetId, x, y })}
                              onToggleStackExpand={toggleStackExpand}
                              onRate={(id, rating) => commitEdit(id, { rating })}
                            />
                          );
                        })}
                      </div>
                    ) : (
                      <div style={{ color: 'var(--text-dimmer)', fontSize: 12.5, padding: '8px 2px' }}>Loading…</div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        {metaOpen && <MetadataPanel selected={selectedAssets} onClose={onCloseMetadata} onEdit={commitEdit} />}
      </div>

      <div
        style={{
          height: 30,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 13,
          padding: '0 12px',
          background: '#2b2b2b',
          borderTop: '1px solid rgba(0,0,0,0.4)',
          fontSize: 11.5,
          color: 'rgba(255,255,255,0.5)',
        }}
      >
        <span>{flatIds.length} assets</span>
        {selected.size > 0 && <span>· {selected.size} selected</span>}
        <div style={{ flex: 1 }} />
        {/* Mirrors PhotosBrowser.tsx's StatusBar thumbnail slider. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'rgba(255,255,255,0.55)' }}>
          <span style={{ fontSize: 11.5 }}>Thumbnails</span>
          <div style={{ position: 'relative', width: 12, height: 12, flexShrink: 0 }}>
            <div style={{ position: 'absolute', left: 0, top: 0, width: 8, height: 8, border: '1.5px solid currentColor', borderRadius: '50%' }} />
            <div
              style={{
                position: 'absolute',
                left: 6.6,
                top: 6.6,
                width: 4,
                height: 1.5,
                background: 'currentColor',
                borderRadius: 1,
                transformOrigin: 'left center',
                transform: 'rotate(45deg)',
              }}
            />
          </div>
          <input
            type="range"
            min={100}
            max={320}
            step={4}
            value={thumbSize}
            onChange={(e) => setThumbSize(Number(e.target.value))}
            style={{ width: 104 }}
          />
        </div>
      </div>

      {openAsset && (
        <Viewer
          asset={openAsset}
          hasPrev={openIndex > 0}
          hasNext={openIndex !== -1 && openIndex < flatIds.length - 1}
          onClose={() => setOpenId(null)}
          onPrev={() => navigateOpen(-1)}
          onNext={() => navigateOpen(1)}
          stripAssets={stripAssets}
          onSelect={setOpenId}
          onEdit={commitEdit}
          onDelete={(id) => removeAssets([id])}
          onUnstack={openAsset.stack ? () => unstackByStackId(openAsset.stack!.id) : undefined}
          onSetStackPick={
            openAsset.stack
              ? async (assetId, memberIds) => {
                  await setStackPickAction(openAsset.stack!.id, assetId, memberIds);
                  // See PhotosBrowser.tsx's identical handler for why setOpenId
                  // is chained straight off this await.
                  setOpenId(assetId);
                }
              : undefined
          }
          onOpenApplicationsPreferences={onOpenApplicationsPreferences}
          onArtRoundTripQueued={(jobId) => trackArtJobs([jobId])}
          onProcessingSidecarCreated={(id) => setProcessingSidecarAssets((s) => (s.has(id) ? s : new Set(s).add(id)))}
          onPrint={setPrintAsset}
        />
      )}
      {printAsset && <PrintDialog asset={printAsset} onClose={() => setPrintAsset(null)} />}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenuItems}
          onClose={() => setContextMenu(null)}
        />
      )}
      {confirmDeleteSelection && (
        <ConfirmDialog
          title="Move to trash?"
          message={`This moves ${selected.size} photo${selected.size === 1 ? '' : 's'} to Immich's trash. You can restore them from Trash later, or they'll be deleted permanently after your server's trash retention period.`}
          confirmLabel="Move to Trash"
          onConfirm={() => removeAssets([...selected])}
          onClose={() => setConfirmDeleteSelection(false)}
        />
      )}
      {pasteProcessingTargets && (
        <ConfirmDialog
          title="Paste image processing?"
          message={`Paste image processing onto ${pasteProcessingTargets.length} photo${pasteProcessingTargets.length === 1 ? '' : 's'}? This replaces any existing RawTherapee/ART edits on each one.`}
          confirmLabel="Paste"
          onConfirm={confirmPasteImageProcessing}
          onClose={() => setPasteProcessingTargets(null)}
        />
      )}
      {batchArtTargets && (
        <ConfirmDialog
          title="Headless RAW Roundtrip?"
          message={`Export ${batchArtTargets.length} RAW photo${batchArtTargets.length === 1 ? '' : 's'} through ART-cli in the background, applying each one's own sidecar (if any) over your ART default profile?`}
          confirmLabel="Roundtrip"
          danger={false}
          onConfirm={confirmBatchArtRoundTrip}
          onClose={() => setBatchArtTargets(null)}
        />
      )}
      {noSidecarBatch && (
        <NoSidecarDialog
          title="Some Photos Have No Saved Edits"
          message={`${noSidecarBatch.withoutSidecarCount} of ${noSidecarBatch.allIds.length} selected photos have no saved ART edits. Export ${
            noSidecarBatch.withoutSidecarCount === 1 ? 'it' : 'them'
          } anyway using ART's default processing profile, or exclude ${noSidecarBatch.withoutSidecarCount === 1 ? 'it' : 'them'} from this batch?`}
          primaryLabel="Export with Default Processing"
          secondaryLabel="Exclude Affected"
          onPrimary={async () => {
            const { allIds } = noSidecarBatch;
            setNoSidecarBatch(null);
            await runBatchArtRoundTrip(allIds);
          }}
          onSecondary={async () => {
            const remaining = noSidecarBatch.allIds.filter((id) => assetByIdAll.get(id)?.hasProcessingSidecar);
            setNoSidecarBatch(null);
            if (remaining.length > 0) await runBatchArtRoundTrip(remaining);
          }}
        />
      )}
      {noSidecarDialog}
      {smartStackOpen && (
        <SmartStackDialog
          candidateAssets={selectedAssets}
          onApply={applySmartStackGroups}
          onClose={() => setSmartStackOpen(false)}
        />
      )}
      {exportFolderAssets && (
        <ExportToFolderDialog assets={exportFolderAssets} onClose={() => setExportFolderAssets(null)} onExported={() => {}} />
      )}
      {exportFlickrAssets && (
        <ExportToFlickrDialog assets={exportFlickrAssets} onClose={() => setExportFlickrAssets(null)} onExported={() => {}} />
      )}
      {addToAlbumTargets && <AddToAlbumDialog assetIds={addToAlbumTargets} onClose={() => setAddToAlbumTargets(null)} />}
    </div>
  );
});

export default FoldersBrowser;

function TreeRow({
  label,
  depth,
  selected,
  hasChildren,
  expanded,
  onSelect,
  onToggle,
}: {
  label: string;
  depth: number;
  selected: boolean;
  hasChildren: boolean;
  expanded?: boolean;
  onSelect: () => void;
  onToggle?: () => void;
}) {
  return (
    <div
      onClick={onSelect}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        height: 32,
        padding: `0 9px 0 ${9 + depth * 15}px`,
        borderRadius: 8,
        cursor: 'default',
        color: selected ? '#fff' : 'rgba(255,255,255,0.9)',
        background: selected ? 'rgba(53,132,228,0.32)' : 'transparent',
      }}
    >
      <div
        onClick={(e) => {
          e.stopPropagation();
          onToggle?.();
        }}
        style={{ width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginLeft: -2 }}
      >
        <div
          style={{
            width: 6,
            height: 6,
            borderRight: '1.7px solid currentColor',
            borderBottom: '1.7px solid currentColor',
            transform: `rotate(${expanded ? 45 : -45}deg)`,
            opacity: hasChildren ? 0.7 : 0,
            color: 'rgba(255,255,255,0.7)',
          }}
        />
      </div>
      <div style={{ width: 15, height: 12, borderRadius: 2.5, background: 'rgba(255,255,255,0.18)', flexShrink: 0 }} />
      <span style={{ flex: 1, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
    </div>
  );
}

// Real folder trees are arbitrary depth (e.g. this library has plain
// YYYY folders for older years but YYYY/MM subfolders from a certain year
// onward) - recurses rather than assuming a fixed Year > Month shape.
function FolderTreeRows({
  node,
  depth,
  selectedNode,
  expandedPaths,
  onSelect,
  onToggle,
}: {
  node: FolderNode;
  depth: number;
  selectedNode: string;
  expandedPaths: Record<string, boolean>;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
}) {
  const hasChildren = node.children.length > 0;
  const expanded = !!expandedPaths[node.path];
  return (
    <div>
      <TreeRow
        label={node.name}
        depth={depth}
        selected={selectedNode === node.path}
        hasChildren={hasChildren}
        expanded={expanded}
        onSelect={() => onSelect(node.path)}
        onToggle={hasChildren ? () => onToggle(node.path) : undefined}
      />
      {expanded &&
        node.children.map((child) => (
          <FolderTreeRows
            key={child.path}
            node={child}
            depth={depth + 1}
            selectedNode={selectedNode}
            expandedPaths={expandedPaths}
            onSelect={onSelect}
            onToggle={onToggle}
          />
        ))}
    </div>
  );
}
