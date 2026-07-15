import { forwardRef, useCallback, useDeferredValue, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  checkSidecarMetadata,
  createStack,
  deleteAssets,
  deleteStack,
  getFolderAssets,
  getFolderPaths,
  getStack,
  launchEditor,
  listStacks,
  setStackPick,
  updateAssetMetadata,
  type AssetMetadataPatch,
  type AssetStackInfo,
  type AssetSummary,
  type EditJob,
  type UnsyncedMetadata,
} from '../lib/api';
import { buildFolderTree, collectAssetPaths, findFolderNode, type FolderNode } from '../lib/folderTree';
import Viewer from '../components/Viewer';
import AssetTile, { type ClickMods } from '../components/AssetTile';
import SelectionBar from '../components/SelectionBar';
import StackBand from '../components/StackBand';
import ContextMenu, { type ContextMenuItem } from '../components/ContextMenu';
import SmartStackDialog from '../components/SmartStackDialog';
import MetadataPanel from '../components/MetadataPanel';
import ConfirmDialog from '../components/ConfirmDialog';
import InlineWarningBanner from '../components/InlineWarningBanner';
import { isTypingTarget, matchesShortcut, useShortcuts, type ShortcutId } from '../lib/shortcuts';
import { isRawAsset, matchesFilters, type Filters } from '../lib/filters';
import { isHiddenStackChild } from '../lib/stacks';
import type { SmartStackGroup } from '../lib/smartStack';
import { useRawOverrides } from '../lib/rawOverrides';
import { useApplications } from '../lib/applications';
import { pendingStyle } from '../lib/pending';
import { useEditQueue } from '../lib/editQueue';
import { useEditJobReconciliation } from '../lib/useEditJobReconciliation';
import { useBucketMemo } from '../lib/bucketMemo';

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

const THUMB_SIZE = 168;
const ROW_HEIGHT_GUESS = Math.round((THUMB_SIZE * 2) / 3) + 12;

export interface FoldersBrowserHandle {
  selectAll: () => void;
  deselectAll: () => void;
  stackSelected: () => void;
  openSmartStack: () => void;
  toggleRawOverrideForSelection: () => void;
  syncAllUnsyncedMetadata: () => void;
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
  const lastClickedId = useRef<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [confirmDeleteSelection, setConfirmDeleteSelection] = useState(false);
  const [expandedStacks, setExpandedStacks] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; assetId: string } | null>(null);
  const [smartStackOpen, setSmartStackOpen] = useState(false);
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
  const { shortcuts, capturing } = useShortcuts();
  const { overrideIds, setOverride } = useRawOverrides();

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
    [deferredFilters, stackByAssetId, overrideIds, unsyncedMetadata],
    (assets) =>
      assets
        .map((a) => ({
          ...a,
          stack: stackByAssetId.get(a.id) ?? null,
          isRawOverride: overrideIds.has(a.id),
          unsyncedMetadata: unsyncedMetadata.get(a.id),
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
    [stackByAssetId, overrideIds, unsyncedMetadata],
    (assets) =>
      assets.map((a) => ({
        ...a,
        stack: stackByAssetId.get(a.id) ?? null,
        isRawOverride: overrideIds.has(a.id),
        unsyncedMetadata: unsyncedMetadata.get(a.id),
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

  // See PhotosBrowser.tsx's identical setup for the full explanation.
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

  const removeAssets = useCallback(
    async (ids: string[]) => {
      await deleteAssets(ids, false);
      removeAssetsLocal(ids);
    },
    [removeAssetsLocal],
  );

  // Creates a real stack (first id = pick, matching the prototype's
  // "first selected" default), then updates the local stackByAssetId map so
  // the non-primary members immediately hide from the grid without needing
  // to refetch anything.
  const createStackForSelection = useCallback(async (ids: string[]) => {
    if (ids.length < 2) return;
    const stack = await createStack(ids);
    const info: AssetStackInfo = { id: stack.id, primaryAssetId: stack.primaryAssetId, assetCount: ids.length };
    setStackByAssetId((m) => {
      const next = new Map(m);
      for (const id of ids) next.set(id, info);
      return next;
    });
    setSelected(new Set());
  }, []);

  // Smart Stack applies one createStack call per proposed group (pick first,
  // same "first id = primary" convention createStackForSelection already
  // uses) - sequential rather than Promise.all so a mid-batch failure stops
  // cleanly and the dialog can report which point it got to via the thrown
  // error, instead of an unordered pile of concurrent server requests.
  const applySmartStackGroups = useCallback(async (groups: SmartStackGroup[]) => {
    for (const g of groups) {
      // A group can include members merged in from an already-existing stack
      // (SmartStackDialog's mergeExistingStacks) rather than skipping them -
      // dissolve any such old stack(s) first so their members are free to
      // join the new, unified one.
      const oldStackIds = new Set(g.members.map((m) => m.stack?.id).filter((id): id is string => !!id));
      for (const oldId of oldStackIds) {
        await deleteStack(oldId);
        setExpandedStacks((s) => {
          if (!s.has(oldId)) return s;
          const next = new Set(s);
          next.delete(oldId);
          return next;
        });
      }
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
  }, []);

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

  // See PhotosBrowser.tsx's identical callback for the full explanation -
  // launch-only, single-asset, redirects to Preferences when unconfigured.
  const { applications } = useApplications();
  const launchEditorForSelection = useCallback(
    async (role: 'rawEditor' | 'externalEditor') => {
      if (selectedAssets.length !== 1) return;
      const choice = applications[role];
      if (!choice) {
        onOpenApplicationsPreferences?.();
        return;
      }
      await launchEditor(selectedAssets[0].originalPath, choice);
    },
    [selectedAssets, applications, onOpenApplicationsPreferences],
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

  // Right-click menu is deliberately minimal: only primaries/unstacked
  // assets are ever visible in the main grid to right-click on (band
  // members already have their own Unstack button and pick-star), so
  // "Set as Stack Pick" never applies here - only bulk Stack and Unstack.
  const contextMenuItems: ContextMenuItem[] = useMemo(() => {
    if (!contextMenu) return [];
    const asset = assetById.get(contextMenu.assetId);
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
    if (asset && unsyncedMetadata.has(asset.id)) {
      items.push({
        label: 'Sync Metadata from Sidecar',
        onClick: () => syncMetadata([asset.id]).catch(() => {}),
      });
    }
    return items;
  }, [contextMenu, assetById, selected, createStackForSelection, unstackByStackId, unsyncedMetadata, syncMetadata]);

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
    }),
    [selectAll, deselectAll, createStackForSelection, selected, toggleRawOverrideForSelection, syncMetadata, unsyncedMetadata],
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
  }, [openId, active, selectAll, deselectAll, selected, shortcuts, capturing, commitEditMany, createStackForSelection, toggleFavoriteForSelection]);

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
  const virtualizer = useVirtualizer({
    count: activeBucketKeys.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => ROW_HEIGHT_GUESS * 4,
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
              setUnsyncedMetadata((m) => {
                const next = new Map(m);
                for (const r of results) {
                  next.set(r.assetId, {
                    rating: r.rating ?? undefined,
                    description: r.description ?? undefined,
                  });
                }
                return next;
              });
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
          onOpenInRawEditor={() => launchEditorForSelection('rawEditor').catch(() => {})}
          onOpenInExternalEditor={() => launchEditorForSelection('externalEditor').catch(() => {})}
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
                          gridTemplateColumns: `repeat(auto-fill, minmax(${THUMB_SIZE}px, 1fr))`,
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
        />
      )}
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
      {smartStackOpen && (
        <SmartStackDialog
          candidateAssets={selectedAssets}
          onApply={applySmartStackGroups}
          onClose={() => setSmartStackOpen(false)}
        />
      )}
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
