import { forwardRef, useCallback, useDeferredValue, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { listen } from '@tauri-apps/api/event';
import {
  batchArtRoundTrip,
  checkSidecarMetadata,
  createStack,
  deleteAssets,
  deleteStack,
  getStack,
  getTimelineBuckets,
  getTimelineBucketAssets,
  launchArtRoundTrip,
  launchEditor,
  listStacks,
  pasteImageProcessing,
  setStackPick,
  updateAssetMetadata,
  type ArtJob,
  type ArtRoundTripTarget,
  type AssetMetadataPatch,
  type AssetStackInfo,
  type AssetSummary,
  type EditJob,
  type MetadataEditTarget,
  type RoundTripFileDetected,
  type TimeBucketInfo,
  type UnsyncedMetadata,
} from '../lib/api';
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
import { matchesVersionSuffix, type SmartStackGroup } from '../lib/smartStack';
import { useRawOverrides } from '../lib/rawOverrides';
import { useApplications } from '../lib/applications';
import { useClipboard } from '../lib/clipboard';
import { useSmartStackSettings } from '../lib/smartStackSettings';
import { pendingStyle } from '../lib/pending';
import { useEditQueue } from '../lib/editQueue';
import { useEditJobReconciliation } from '../lib/useEditJobReconciliation';
import { useArtQueue } from '../lib/artQueue';
import { useArtJobReconciliation } from '../lib/useArtJobReconciliation';
import { useBucketMemo } from '../lib/bucketMemo';
import { ingestRoundTripExport, type RoundTripIngestOutcome } from '../lib/roundTrip';

// Snapshots whichever AssetSummary fields a patch is about to touch, so a
// job that later fails (the sidecar write, the authoritative mechanism -
// see edit_queue.rs) can be rolled back to exactly what it was before the
// optimistic apply.
function prevValuesFor(asset: AssetSummary | undefined, patch: AssetMetadataPatch): Partial<AssetSummary> {
  const prev: Partial<AssetSummary> = {};
  if (patch.rating !== undefined) prev.rating = asset?.rating ?? null;
  if (patch.isFavorite !== undefined) prev.isFavorite = asset?.isFavorite ?? false;
  if (patch.description !== undefined) prev.description = asset?.description ?? null;
  return prev;
}

// `new Date("2026-06-01")` parses bare (time-less) date strings as UTC midnight,
// then toLocaleDateString() renders that back in the local timezone - shifting
// the displayed date back a day for any timezone behind UTC. Parsing the y/m/d
// components ourselves and building a local Date avoids that shift entirely.
function parseCalendarDate(dateStr: string): Date {
  const [y, m, d] = dateStr.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
}

const COLUMNS_GUESS = 6;
const MONTH_HEADER_HEIGHT = 34;
const DAY_HEADER_HEIGHT = 26;
const DEFAULT_THUMB_SIZE = 168;

export interface PhotosBrowserHandle {
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
}

const PhotosBrowser = forwardRef<PhotosBrowserHandle, {
  onTotalCount?: (n: number) => void;
  metaOpen: boolean;
  onCloseMetadata: () => void;
  filters: Filters;
  onOpenApplicationsPreferences?: () => void;
  // Whether the Photos tab is the one currently showing - stays mounted
  // (rather than unmounted) while another tab is active so its assetCache
  // survives switching away and back instead of refetching the whole
  // timeline every time, but its global keydown shortcuts still need to be
  // suppressed while hidden or they'd fire on top of whatever tab actually
  // has focus. Defaults true so FoldersBrowser (no such prop) keeps working
  // unaffected - only PhotosBrowser and FoldersBrowser pass this explicitly.
  active?: boolean;
}>(function PhotosBrowser({ onTotalCount, metaOpen, onCloseMetadata, filters, onOpenApplicationsPreferences, active = true }, ref) {
  const [buckets, setBuckets] = useState<TimeBucketInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Set only when update_asset_metadata itself rejects synchronously (read-
  // only mode, over the batch cap) - i.e. before anything was enqueued. An
  // async job failure discovered later (the sidecar write failed) surfaces
  // via the shared ActivityPanel/EditQueueIndicator instead, not this banner.
  const [enqueueError, setEnqueueError] = useState<string | null>(null);
  // Fetched asset data is cached permanently per bucket (cheap - just ids/dates,
  // not images) so scrolling back to an already-visited month is instant. Only
  // the DOM (thumbnail <img> elements) is virtualized/torn down when scrolled
  // out of view - that's what actually bounds memory/DOM size for a huge library.
  const [assetCache, setAssetCache] = useState<Record<string, AssetSummary[]>>({});
  const inFlight = useRef<Set<string>>(new Set());
  const containerRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const lastClickedId = useRef<string | null>(null);
  const [thumbSize, setThumbSize] = useState(DEFAULT_THUMB_SIZE);
  const [totalCount, setTotalCount] = useState(0);
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
  // Asset id -> rating/description found in that asset's local sidecar or
  // embedded file, for whichever field(s) differ from what Immich currently
  // has - a plain gap (Immich has nothing) or a stale value (Immich has
  // something, but the sidecar changed since); see check_sidecar_metadata in
  // commands.rs. Populated passively as buckets load; the actual write into
  // Immich only happens when the user explicitly triggers a sync (never
  // automatic).
  const [unsyncedMetadata, setUnsyncedMetadata] = useState<Map<string, UnsyncedMetadata>>(new Map());
  // Asset ids known to currently have an ART/RawTherapee processing sidecar
  // on disk - piggybacked off the same checkSidecarMetadata scan as
  // unsyncedMetadata above, but independent of it (see MetadataSyncResult's
  // own doc comment): gates whether Copy Image Processing is offered.
  const [processingSidecarAssets, setProcessingSidecarAssets] = useState<Set<string>>(new Set());
  // Non-null while the Paste Image Processing confirm dialog is open - the
  // already RAW-filtered target ids it'll paste onto.
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

  // Filters only ever hide assets from view/selection/navigation - the raw
  // assetCache (keyed the same way) stays the source of truth for edits and
  // for the loaded/not-yet-loaded check in the fetch effect below.
  //
  // Re-filtering touches every asset ever loaded into assetCache (not just
  // what's currently on screen), which in a large library can be tens of
  // thousands of items - deferring it means clicking a filter control
  // updates the panel's own UI (checked star, switch position) immediately,
  // and lets that heavier grid recompute lag a frame behind under load
  // instead of blocking the click itself.
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

  // Flat visual order (bucket order, then day order, then asset order) of every
  // currently-loaded, currently-visible asset - this is what shift-click range
  // selection and the viewer's prev/next navigation both walk. Only loaded
  // buckets contribute, which keeps this small even in a huge library.
  const flatIds = useMemo(() => {
    if (!buckets) return [];
    const ids: string[] = [];
    for (const bucket of buckets) {
      const assets = filteredAssetCache[bucket.timeBucket];
      if (!assets) continue;
      for (const [, items] of groupByDay(assets)) {
        for (const a of items) ids.push(a.id);
      }
    }
    return ids;
  }, [buckets, filteredAssetCache]);

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

  // Patches the one asset's copy that lives in whichever bucket's cached
  // array it's in - assetById/openAsset/selectedAssets all derive from
  // assetCache, so this is the single place a successful edit needs to land
  // to show up consistently in the grid, viewer, and metadata panel at once.
  const patchAssetLocal = useCallback((id: string, patch: Partial<AssetSummary>) => {
    setAssetCache((cache) => {
      for (const [bucketKey, assets] of Object.entries(cache)) {
        const idx = assets.findIndex((a) => a.id === id);
        if (idx !== -1) {
          const nextAssets = assets.slice();
          nextAssets[idx] = { ...nextAssets[idx], ...patch };
          return { ...cache, [bucketKey]: nextAssets };
        }
      }
      return cache;
    });
  }, []);

  // jobId -> the one asset id + pre-edit values it needs rolled back to, if
  // that job comes back Failed. Populated right after a successful enqueue;
  // drained by reconcileJob below as each tracked job settles.
  const rollbackById = useRef<Map<number, { id: string; prevValues: Partial<AssetSummary> }>>(new Map());
  const { jobs: editJobs } = useEditQueue();

  // Fires once per tracked job the moment it settles (done/failed), however
  // many polls that takes - see useEditJobReconciliation. A `failed` job
  // rolls its optimistic patch back and surfaces the reason; a `done` job
  // (its immichWarning, if any, is visible only in the ActivityPanel) just
  // drops its own rollback bookkeeping.
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

  // Optimistic: applies the patch to local state immediately, then enqueues
  // the actual XMP/Immich writes onto the backend's background EditQueue
  // (see edit_queue.rs) without waiting for them. Only a *synchronous*
  // rejection from the enqueue call itself (read-only mode, over the batch
  // cap) rolls back and surfaces here - an async job failure discovered
  // later is handled by reconcileJob instead.
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

  // Bulk sibling of commitEdit - used by the grid's rating/favorite keyboard
  // shortcuts, which (unlike the Metadata panel's mouse-driven single-asset
  // editing) apply to the whole current selection at once.
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

  // Strips deleted ids out of whichever bucket's cached array they're in,
  // out of the current selection, and closes the viewer if it was open on
  // one of them - the single place a successful delete needs to land.
  const removeAssetsLocal = useCallback((ids: string[]) => {
    const idSet = new Set(ids);
    setAssetCache((cache) => {
      let changed = false;
      const next: Record<string, AssetSummary[]> = {};
      for (const [bucketKey, assets] of Object.entries(cache)) {
        const filtered = assets.filter((a) => !idSet.has(a.id));
        if (filtered.length !== assets.length) changed = true;
        next[bucketKey] = filtered;
      }
      return changed ? next : cache;
    });
    setSelected((s) => {
      if (![...idSet].some((id) => s.has(id))) return s;
      const next = new Set(s);
      for (const id of idSet) next.delete(id);
      return next;
    });
    setTotalCount((c) => {
      const nc = Math.max(0, c - ids.length);
      onTotalCount?.(nc);
      return nc;
    });
    setOpenId((cur) => (cur && idSet.has(cur) ? null : cur));
  }, [onTotalCount]);

  // Inserts a newly-discovered asset (currently only the round-trip watcher
  // below) into whichever bucket already holds `referenceAssetId` - mirrors
  // removeAssetsLocal's shape but going the other direction. Deliberately
  // reads `assetCache` directly (not via the setAssetCache updater) to
  // locate the bucket key up front, since `buckets`' own count also needs
  // updating in lockstep and there's no single setState call that can touch
  // both. A no-op (not a fetch) if the reference asset's bucket isn't
  // currently loaded - the same edge case patchAssetLocal already accepts
  // silently - since the next real scroll-into-view will pick it up anyway.
  const addAssetLocal = useCallback(
    (asset: AssetSummary, referenceAssetId: string) => {
      let bucketKey: string | null = null;
      for (const [key, assets] of Object.entries(assetCache)) {
        if (assets.some((a) => a.id === asset.id)) return; // already present - dedupe
        if (assets.some((a) => a.id === referenceAssetId)) bucketKey = key;
      }
      if (!bucketKey) return;
      const key = bucketKey;
      setAssetCache((cache) => ({ ...cache, [key]: insertByCaptureDateDesc(cache[key] ?? [], asset) }));
      setBuckets((bs) => bs?.map((b) => (b.timeBucket === key ? { ...b, count: b.count + 1 } : b)) ?? bs);
      setTotalCount((c) => {
        const nc = c + 1;
        onTotalCount?.(nc);
        return nc;
      });
    },
    [assetCache, onTotalCount],
  );

  // Applies an ingestRoundTripExport outcome (lib/roundTrip.ts) to local
  // state - shared by the generic round trip's 'round-trip-file-detected'
  // listener below and both ART CLI round-trip variants (Viewer.tsx's
  // onRoundTripExported for Variant 1, reconcileArtJob for Variant 2).
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
    },
    [addAssetLocal],
  );

  // Watches for the round-trip file the backend detected (see round_trip.rs)
  // to actually be the editor's output for one of the candidates it's
  // pending on - matched here (not backend-side) via the same version-string
  // suffix logic the Smart Stack "Version" mode itself uses, so both places
  // stay in sync automatically whenever the user changes that setting.
  const { settings: smartStackSettings } = useSmartStackSettings();
  useEffect(() => {
    const unlisten = listen<RoundTripFileDetected>('round-trip-file-detected', (e) => {
      const { candidates, newFileName } = e.payload;
      const match = candidates.find((c) => {
        const original = assetByIdAll.get(c.originalAssetId);
        return original && matchesVersionSuffix(newFileName, original, smartStackSettings.suffix);
      });
      if (!match) return;
      const originalAssetId = match.originalAssetId;

      (async () => {
        const original = assetByIdAll.get(originalAssetId);
        if (!original) return;

        const outcome = await ingestRoundTripExport(original, newFileName);
        if (outcome) applyRoundTripOutcome(outcome);
      })();
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [assetByIdAll, smartStackSettings.suffix, applyRoundTripOutcome]);

  // Grid deletes always move to trash (permanent=false) - "Delete Forever"
  // only exists from within the Trash view.
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
  // Looked up via assetByIdAll (not assetById/flatIds) for two reasons: (1)
  // setting a new stack pick updates stackByAssetId and openId together, and
  // if flatIds hasn't recomputed yet on the render in between, an assetById
  // lookup would miss and briefly close the viewer instead of just following
  // the pick; (2) opening a non-pick stack member directly (StackBand's
  // double-click/hover-open) targets a hidden child that assetById excludes
  // entirely, not just momentarily - hasPrev/hasNext below degrade
  // gracefully off the same openIndex when it doesn't resolve, which is
  // harmless (no "next in the grid" is meaningfully defined for a hidden
  // child anyway).
  const openAsset = openId ? assetByIdAll.get(openId) ?? null : null;

  const stripAssets = useMemo(
    () => flatIds.map((id) => assetById.get(id)).filter((a): a is AssetSummary => !!a),
    [flatIds, assetById],
  );

  // Click order (Sets preserve insertion order), not visual order - "first
  // selected" is somewhat arbitrary either way, and this avoids an O(flatIds)
  // scan on every selection change for what's just a display convenience.
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

  // Launch-only, single-asset - mirrors Viewer.tsx's handleLaunch exactly
  // (same redirect-to-Preferences-when-unconfigured behavior and ART CLI
  // round-trip branch), just sourced from the selection bar's one selected
  // asset instead of the open asset.
  const { applications, artRoundTripEnabled } = useApplications();
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
        const exportFileName = await launchArtRoundTrip(asset.originalPath, asset.fileName, asset.fileExtension, choice);
        const outcome = await ingestRoundTripExport(asset, exportFileName);
        if (outcome) applyRoundTripOutcome(outcome);
        return;
      }
      await launchEditor(asset.originalPath, choice, asset.id, asset.fileName);
    },
    [selectedAssets, applications, artRoundTripEnabled, onOpenApplicationsPreferences, applyRoundTripOutcome],
  );

  // Writes each id's sidecar/embedded-discovered rating and/or description
  // into Immich - one commitEdit per asset (descriptions are per-asset-
  // unique text, so unlike a plain rating there's no meaningful way to group
  // several ids into a single call), reusing the existing bulk-edit path's
  // read-only/max-writes-per-batch gate unchanged.
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

  const handlePasteMetadata = useCallback(
    (ids: string[]) => {
      if (!copiedMetadata || ids.length === 0) return;
      commitEditMany(ids, copiedMetadata).catch(() => {});
    },
    [copiedMetadata, commitEditMany],
  );

  // RAW-only - a non-RAW target has no processing-sidecar concept at all, so
  // filtering here (rather than leaving it to the backend) also means the
  // confirm dialog's "N photo(s)" count already reflects what's really about
  // to be pasted onto.
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

  const confirmPasteImageProcessing = useCallback(async () => {
    if (!copiedProcessingSource || !pasteProcessingTargets) return;
    const targets: MetadataEditTarget[] = pasteProcessingTargets.map((id) => ({
      id,
      originalPath: assetByIdAll.get(id)?.originalPath ?? null,
    }));
    await pasteImageProcessing(copiedProcessingSource.originalPath, targets);
  }, [copiedProcessingSource, pasteProcessingTargets, assetByIdAll]);

  // Batch RAW Roundtrip (ART CLI round trip Variant 2) - fully headless,
  // background-queued export of 2+ RAW assets at once. Only reachable when
  // artRoundTripEnabled (see PreferencesApplications.tsx). RAW-filtered here
  // (not left to the backend) for the same reason requestPasteImageProcessing
  // is: the confirm dialog's count should reflect what's really about to be
  // exported.
  const { jobs: artJobs } = useArtQueue();
  const [batchArtTargets, setBatchArtTargets] = useState<string[] | null>(null);
  const requestBatchArtRoundTrip = useCallback(
    (ids: string[]) => {
      const rawIds = ids.filter((id) => {
        const a = assetByIdAll.get(id);
        return !!a && isRawAsset(a);
      });
      if (rawIds.length < 2) return;
      setBatchArtTargets(rawIds);
    },
    [assetByIdAll],
  );

  // Fires once per queued job as it settles - a `done` job ingests its
  // deterministic export (same tail as Variant 1/the generic round trip,
  // via ingestRoundTripExport) incrementally rather than waiting for the
  // whole batch to finish; a `failed` job surfaces its error in the same
  // banner a synchronous enqueue rejection would.
  const reconcileArtJob = useCallback(
    (job: ArtJob) => {
      if (job.status === 'failed') {
        setEnqueueError(job.error ?? "Couldn't complete a Batch RAW Roundtrip export.");
        return;
      }
      if (!job.exportFileName) return;
      const original = assetByIdAll.get(job.assetId);
      if (!original) return;
      ingestRoundTripExport(original, job.exportFileName).then((outcome) => {
        if (outcome) applyRoundTripOutcome(outcome);
      });
    },
    [assetByIdAll, applyRoundTripOutcome],
  );
  const { trackJobs: trackArtJobs } = useArtJobReconciliation(artJobs, reconcileArtJob);

  const confirmBatchArtRoundTrip = useCallback(async () => {
    if (!batchArtTargets) return;
    const targets: ArtRoundTripTarget[] = batchArtTargets.map((id) => {
      const a = assetByIdAll.get(id)!;
      return { id, originalPath: a.originalPath, fileName: a.fileName, fileExtension: a.fileExtension };
    });
    const jobIds = await batchArtRoundTrip(targets);
    trackArtJobs(jobIds);
    setSelected(new Set());
  }, [batchArtTargets, assetByIdAll, trackArtJobs]);

  const navigateOpen = (dir: 1 | -1) => {
    const ni = openIndex + dir;
    if (ni < 0 || ni >= flatIds.length) return;
    setOpenId(flatIds[ni]);
  };

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
      if (rawTargetIds.length >= 2) {
        items.push({
          label: `Batch RAW Roundtrip (${rawTargetIds.length})`,
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
    handleCopyImageProcessing,
    requestPasteImageProcessing,
    handleCopyMetadata,
    handlePasteMetadata,
    artRoundTripEnabled,
    requestBatchArtRoundTrip,
  ]);

  useEffect(() => {
    getTimelineBuckets()
      .then((b) => {
        setBuckets(b);
        const total = b.reduce((sum, x) => sum + x.count, 0);
        setTotalCount(total);
        onTotalCount?.(total);
      })
      .catch((e) => setError(String(e)));
    // Deliberately runs once on mount only - onTotalCount's identity changing
    // on re-renders shouldn't refetch the whole timeline.
  }, []);

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
      // Scoped to every currently-loaded unsynced asset, not just the
      // selection - matches the Edit menu's other "act on everything
      // relevant" items rather than requiring a selection first.
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
      handleCopyMetadata,
      handlePasteMetadata,
    ],
  );

  // Open opens the last-clicked photo (a keyboard path to the viewer that
  // doesn't depend on double-click/double-tap gesture detection working at
  // all), Select All selects everything currently loaded, Deselect clears the
  // selection, Delete opens a confirm dialog for the current selection,
  // favorite/rating apply to the whole selection at once (matching the
  // design prototype's rateTarget/favTarget) - all skipped while the
  // viewer's already open so they don't fight with Viewer's own keydown
  // handling, and while typing in a text field.
  useEffect(() => {
    // Also skipped while inactive (kept mounted but hidden behind another
    // tab) - otherwise these would fire on top of whichever tab actually has
    // focus, e.g. Ctrl+A on Folders silently also selecting everything in a
    // backgrounded Photos tab, or "open" popping Photos' viewer up over the
    // Folders grid.
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

  // Plain click: select only this one, clearing everything else (standard
  // file-manager semantics). Also used as the checkbox's own click target,
  // so it always sets the anchor for a subsequent shift-click range.
  const selectExclusive = useCallback((id: string) => {
    setSelected(new Set([id]));
    lastClickedId.current = id;
  }, []);

  // Ctrl/Cmd+click: toggle just this one item, leaving the rest of the
  // selection alone. Also what the per-thumbnail checkbox always does,
  // regardless of modifiers - it's a dedicated toggle affordance.
  const toggleOne = useCallback((id: string) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    lastClickedId.current = id;
  }, []);

  // Shift+click: replace the selection with exactly the contiguous range from
  // the last plain/ctrl-click anchor to this item - not merged with whatever
  // was selected before. The anchor deliberately doesn't move, so repeated
  // shift-clicks keep adjusting the range from the same starting point.
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

  // Stable across renders (only changes when flatIds does) so Thumb's
  // React.memo can actually bail out on unrelated re-renders instead of
  // re-rendering every visible thumbnail on every single selection click.
  const handleThumbClick = useCallback(
    (id: string, mods: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => {
      if (mods.shiftKey) selectRange(id);
      else if (mods.ctrlKey || mods.metaKey) toggleOne(id);
      else selectExclusive(id);
    },
    [selectRange, toggleOne, selectExclusive],
  );

  const rowHeightGuess = Math.round((thumbSize * 2) / 3) + 12;

  const virtualizer = useVirtualizer({
    count: buckets?.length ?? 0,
    getScrollElement: () => containerRef.current,
    estimateSize: (index) => {
      const b = buckets![index];
      const rows = Math.ceil(b.count / COLUMNS_GUESS);
      const dayHeadersGuess = Math.min(b.count, 28);
      return MONTH_HEADER_HEIGHT + dayHeadersGuess * DAY_HEADER_HEIGHT + rows * rowHeightGuess;
    },
    overscan: 3,
  });

  useEffect(() => {
    if (!buckets) return;
    for (const item of virtualizer.getVirtualItems()) {
      const bucket = buckets[item.index];
      if (assetCache[bucket.timeBucket] || inFlight.current.has(bucket.timeBucket)) continue;
      inFlight.current.add(bucket.timeBucket);
      getTimelineBucketAssets(bucket.timeBucket)
        .then((assets) => {
          setAssetCache((c) => ({ ...c, [bucket.timeBucket]: assets }));
          // Passive, best-effort check - silently does nothing if no local
          // path mapping is configured (Preferences → Library → Originals
          // on Disk) or this bucket's assets don't resolve to one.
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
              // A result can carry `hasProcessingSidecar: true` with both
              // rating/description null (metadata already in sync, but a
              // processing sidecar still exists) - only results with an
              // actual metadata gap belong in unsyncedMetadata, or every
              // asset with just a processing sidecar would wrongly show the
              // "Sync Metadata from Sidecar" badge too.
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
        .catch(() => setAssetCache((c) => ({ ...c, [bucket.timeBucket]: [] })))
        .finally(() => inFlight.current.delete(bucket.timeBucket));
    }
  });

  if (error) {
    return (
      <div style={{ padding: 24, color: 'var(--text-dim)' }}>
        Couldn't load the library — {error}. Check Preferences → Library.
      </div>
    );
  }

  if (!buckets) {
    return <div style={{ padding: 24, color: 'var(--text-dim)' }}>Loading timeline…</div>;
  }

  if (buckets.length === 0) {
    return <div style={{ padding: 24, color: 'var(--text-dim)' }}>No assets found.</div>;
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
        />
      )}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <div ref={containerRef} style={{ flex: 1, overflow: 'auto', minHeight: 0, padding: '0 24px', ...pendingStyle(isFiltering) }}>
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
            {virtualizer.getVirtualItems().map((item) => {
              const bucket = buckets[item.index];
              return (
                <div
                  key={bucket.timeBucket}
                  ref={virtualizer.measureElement}
                  data-index={item.index}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${item.start}px)`,
                    paddingTop: 16,
                  }}
                >
                  <BucketContent
                    bucket={bucket}
                    assets={filteredAssetCache[bucket.timeBucket]}
                    selected={selected}
                    onToggleSelect={handleThumbClick}
                    onToggleOne={toggleOne}
                    onOpen={setOpenId}
                    onContextMenu={(assetId, x, y) => setContextMenu({ assetId, x, y })}
                    thumbSize={thumbSize}
                    expandedStacks={expandedStacks}
                    onToggleStackExpand={toggleStackExpand}
                    onUnstack={unstack}
                    onSetPick={setStackPickAction}
                    onRate={(id, rating) => commitEdit(id, { rating })}
                    resolveAsset={(id) => assetByIdAll.get(id)}
                  />
                </div>
              );
            })}
          </div>
        </div>
        {metaOpen && <MetadataPanel selected={selectedAssets} onClose={onCloseMetadata} onEdit={commitEdit} />}
      </div>
      <StatusBar
        totalCount={totalCount}
        selectedCount={selected.size}
        thumbSize={thumbSize}
        onThumbSize={setThumbSize}
      />
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
                  // Picking a non-primary member hides the previously-open primary
                  // from flatIds/assetById (see isHiddenStackChild) - without this,
                  // openAsset would resolve to null on the next render and the
                  // viewer would fall back to the grid instead of following the
                  // pick. Chaining straight off the same await (no extra tick)
                  // keeps both state updates in one React batch.
                  setOpenId(assetId);
                }
              : undefined
          }
          onOpenApplicationsPreferences={onOpenApplicationsPreferences}
          onRoundTripExported={(_original, outcome) => applyRoundTripOutcome(outcome)}
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
          title="Batch RAW Roundtrip?"
          message={`Export ${batchArtTargets.length} RAW photos through ART-cli in the background, applying each one's own sidecar (if any) over your ART default profile?`}
          confirmLabel="Roundtrip"
          danger={false}
          onConfirm={confirmBatchArtRoundTrip}
          onClose={() => setBatchArtTargets(null)}
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

export default PhotosBrowser;

function StatusBar({
  totalCount,
  selectedCount,
  thumbSize,
  onThumbSize,
}: {
  totalCount: number;
  selectedCount: number;
  thumbSize: number;
  onThumbSize: (n: number) => void;
}) {
  return (
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
      <span>{totalCount} assets</span>
      {selectedCount > 0 && <span>· {selectedCount} selected</span>}
      <div style={{ flex: 1 }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, height: 20, padding: '0 8px', borderRadius: 6 }}>
        <div style={{ position: 'relative', width: 12, height: 12, flexShrink: 0 }}>
          <div style={{ position: 'absolute', inset: 0, border: '1.5px solid currentColor', borderRadius: '50%' }} />
          <div style={{ position: 'absolute', left: 5.3, top: 2.5, width: 1.4, height: 4, background: 'currentColor', borderRadius: 1 }} />
          <div
            style={{
              position: 'absolute',
              left: 5.7,
              top: 5.4,
              width: 3.3,
              height: 1.4,
              background: 'currentColor',
              borderRadius: 1,
              transformOrigin: 'left center',
              transform: 'rotate(28deg)',
            }}
          />
        </div>
        Activity
      </div>
      <div style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.12)' }} />
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
          onChange={(e) => onThumbSize(Number(e.target.value))}
          style={{ width: 104 }}
        />
      </div>
    </div>
  );
}

function placeLabel(a: AssetSummary): string | null {
  return a.city || a.country || null;
}

// Assets within a bucket arrive newest-first (Immich's own timeline
// endpoints already return them that way, matching the month/day headers'
// own newest-first order) - groupByDay below does no sorting of its own, it
// just buckets by day in whatever order the array is already in. A locally
// inserted asset (addAssetLocal, from the round-trip watcher) has to land in
// the position that order implies, not just get prepended, or it visually
// sticks at the top of its capture day until the next full refetch re-sorts
// it from scratch.
function insertByCaptureDateDesc(assets: AssetSummary[], asset: AssetSummary): AssetSummary[] {
  const idx = assets.findIndex((a) => a.fileCreatedAt < asset.fileCreatedAt);
  if (idx === -1) return [...assets, asset];
  return [...assets.slice(0, idx), asset, ...assets.slice(idx)];
}

function groupByDay(assets: AssetSummary[]): Map<string, AssetSummary[]> {
  const groups = new Map<string, AssetSummary[]>();
  for (const a of assets) {
    const day = a.fileCreatedAt.slice(0, 10);
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day)!.push(a);
  }
  return groups;
}

function BucketContent({
  bucket,
  assets,
  selected,
  onToggleSelect,
  onToggleOne,
  onOpen,
  onContextMenu,
  thumbSize,
  expandedStacks,
  onToggleStackExpand,
  onUnstack,
  onSetPick,
  onRate,
  resolveAsset,
}: {
  bucket: TimeBucketInfo;
  assets?: AssetSummary[];
  selected: Set<string>;
  onToggleSelect: (id: string, mods: ClickMods) => void;
  onToggleOne: (id: string) => void;
  onOpen: (id: string) => void;
  onContextMenu: (id: string, x: number, y: number) => void;
  thumbSize: number;
  expandedStacks: Set<string>;
  onToggleStackExpand: (stackId: string) => void;
  onUnstack: (stackId: string, memberIds: string[]) => Promise<void>;
  onSetPick: (stackId: string, assetId: string, memberIds: string[]) => Promise<void>;
  onRate: (assetId: string, rating: number) => Promise<void>;
  resolveAsset: (id: string) => AssetSummary | undefined;
}) {
  const monthLabel = parseCalendarDate(bucket.timeBucket).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
  });

  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-dim)', margin: '0 0 10px' }}>
        {monthLabel} <span style={{ color: 'var(--text-dimmer)', fontWeight: 400 }}>· {bucket.count}</span>
      </div>
      {assets ? (
        <DayGroups
          assets={assets}
          selected={selected}
          onToggleSelect={onToggleSelect}
          onToggleOne={onToggleOne}
          onOpen={onOpen}
          onContextMenu={onContextMenu}
          thumbSize={thumbSize}
          expandedStacks={expandedStacks}
          onToggleStackExpand={onToggleStackExpand}
          onUnstack={onUnstack}
          onSetPick={onSetPick}
          onRate={onRate}
          resolveAsset={resolveAsset}
        />
      ) : (
        <div style={{ color: 'var(--text-dimmer)', fontSize: 12.5 }}>Loading…</div>
      )}
    </div>
  );
}

function DayGroups({
  assets,
  selected,
  onToggleSelect,
  onToggleOne,
  onOpen,
  onContextMenu,
  thumbSize,
  expandedStacks,
  onToggleStackExpand,
  onUnstack,
  onSetPick,
  onRate,
  resolveAsset,
}: {
  assets: AssetSummary[];
  selected: Set<string>;
  onToggleSelect: (id: string, mods: ClickMods) => void;
  onToggleOne: (id: string) => void;
  onOpen: (id: string) => void;
  onContextMenu: (id: string, x: number, y: number) => void;
  thumbSize: number;
  expandedStacks: Set<string>;
  onToggleStackExpand: (stackId: string) => void;
  onUnstack: (stackId: string, memberIds: string[]) => Promise<void>;
  onSetPick: (stackId: string, assetId: string, memberIds: string[]) => Promise<void>;
  onRate: (assetId: string, rating: number) => Promise<void>;
  resolveAsset: (id: string) => AssetSummary | undefined;
}) {
  const groups = groupByDay(assets);
  return (
    <>
      {[...groups.entries()].map(([day, items]) => {
        const place = placeLabel(items[0]);
        const dateObj = parseCalendarDate(day);
        const dayLabel = `${dateObj.toLocaleDateString(undefined, { weekday: 'long' })} · ${dateObj.toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}`;
        return (
          <div key={day} style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '2px 2px 10px' }}>
              <span style={{ fontSize: 13.5, fontWeight: 700 }}>{dayLabel}</span>
              <span style={{ fontSize: 12, color: 'var(--text-dimmer)' }}>
                {place ? `${place} · ` : ''}
                {items.length}
              </span>
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: `repeat(auto-fill, minmax(${thumbSize}px, 1fr))`,
                gap: 12,
              }}
            >
              {items.map((a) => {
                if (a.stack && a.stack.primaryAssetId === a.id && expandedStacks.has(a.stack.id)) {
                  const stackId = a.stack.id;
                  return (
                    <StackBand
                      key={a.id}
                      stackId={stackId}
                      selected={selected}
                      onSelectMember={(id) => onToggleSelect(id, { shiftKey: false, ctrlKey: false, metaKey: false })}
                      onOpen={onOpen}
                      onCollapse={() => onToggleStackExpand(stackId)}
                      onUnstack={(memberIds) => onUnstack(stackId, memberIds)}
                      onSetPick={(assetId, memberIds) => onSetPick(stackId, assetId, memberIds)}
                      onRate={onRate}
                      onContextMenu={onContextMenu}
                      resolveAsset={resolveAsset}
                    />
                  );
                }
                return (
                  <AssetTile
                    key={a.id}
                    asset={a}
                    selected={selected.has(a.id)}
                    onToggleSelect={onToggleSelect}
                    onToggleOne={onToggleOne}
                    onOpen={onOpen}
                    onContextMenu={onContextMenu}
                    onToggleStackExpand={onToggleStackExpand}
                    onRate={onRate}
                  />
                );
              })}
            </div>
          </div>
        );
      })}
    </>
  );
}

