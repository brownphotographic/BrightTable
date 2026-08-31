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

import { forwardRef, memo, useCallback, useDeferredValue, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { listen } from '@tauri-apps/api/event';
import { retryOnVaultReady } from '../lib/vaultReadyRetry';
import {
  batchRawCliRoundTrip,
  deleteAssets,
  getTimelineBuckets,
  getTimelineBucketAssets,
  launchRawCliRoundTrip,
  launchEditor,
  RAW_CONVERTER_LABEL,
  updateAssetMetadata,
  type ArtJob,
  type ArtRoundTripTarget,
  type AssetMetadataPatch,
  type AssetSummary,
  type EditJob,
  type RoundTripFileDetected,
  type TimeBucketInfo,
} from '../lib/api';
import { useStacking } from '../lib/useStacking';
import Viewer, { type ViewerHandle } from '../components/Viewer';
import AssetTile, { type ClickMods } from '../components/AssetTile';
import SelectionBar from '../components/SelectionBar';
import AddToAlbumDialog from '../components/AddToAlbumDialog';
import AddToTagDialog from '../components/AddToTagDialog';
import { TAG_ASSIGN_DISABLED_REASON } from '../lib/featureFlags';
import StackBand from '../components/StackBand';
import ContextMenu, { DIVIDER, type ContextMenuEntry } from '../components/ContextMenu';
import SmartStackDialog from '../components/SmartStackDialog';
import ExportToFolderDialog from '../components/ExportToFolderDialog';
import PrintDialog from '../components/PrintDialog';
import ExportToFlickrDialog from '../components/ExportToFlickrDialog';
import MetadataPanel from '../components/MetadataPanel';
import GridLoupePane from '../components/GridLoupePane';
import TimelineRail from '../components/TimelineRail';
import ConfirmDialog from '../components/ConfirmDialog';
import NoSidecarDialog from '../components/NoSidecarDialog';
import InlineWarningBanner from '../components/InlineWarningBanner';
import { isTypingTarget, matchesShortcut, useShortcuts, type ShortcutId } from '../lib/shortcuts';
import { isRawAsset, isRoundTripEligible, isVideoAsset, matchesFilters, type Filters } from '../lib/filters';
import { resolveVisibleStackAssets } from '../lib/stacks';
import { matchesVersionSuffix } from '../lib/smartStack';
import { useRawOverrides } from '../lib/rawOverrides';
import { useApplications } from '../lib/applications';
import { copyImageProcessingEntry, useAssetActions } from '../lib/useAssetActions';
import { type MenuAction } from '../lib/actionMenu';
import { useSmartStackSettings } from '../lib/smartStackSettings';
import { pendingStyle } from '../lib/pending';
import { useEditQueue } from '../lib/editQueue';
import { useEditJobReconciliation } from '../lib/useEditJobReconciliation';
import { useArtQueue } from '../lib/artQueue';
import { useArtJobReconciliation } from '../lib/useArtJobReconciliation';
import { useBucketMemo } from '../lib/bucketMemo';
import { ingestRoundTripExport, subscribeLateRoundTripOutcome, type RoundTripIngestOutcome } from '../lib/roundTrip';
import { useNoSidecarChoice } from '../lib/useNoSidecarChoice';

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

const MONTH_TOP_PADDING = 16;
const MONTH_HEADER_HEIGHT = 22;
const DAY_HEADER_HEIGHT = 36;
const GRID_GAP = 12;
const STACK_BAND_HEIGHT_GUESS = 210;

// A flat, virtualizable description of everything the grid renders - one
// entry per *row* (a month header, a day header, one row of asset tiles, or
// an expanded stack's band), rather than one entry per month the way the
// virtualizer used to work. That's the whole point: the old bucket-level
// virtualizer mounted every asset in a visible month at once (a busy month
// can hold thousands), which is what made Immich's own timeline (which
// virtualizes at the row level, like this) feel so much snappier in
// comparison. `bucketIndex` lets the fetch-on-scroll effect and
// TimelineRail's bucket-index math both find their way back to which month
// a given row belongs to.
type PhotoRow =
  | { kind: 'loading'; bucketIndex: number; height: number }
  | { kind: 'month'; bucketIndex: number; height: number }
  | { kind: 'day'; bucketIndex: number; day: string; dayLabel: string; place: string | null; count: number; height: number }
  | { kind: 'assets'; bucketIndex: number; day: string; items: AssetSummary[]; height: number }
  | { kind: 'stackband'; bucketIndex: number; day: string; stackId: string; assetId: string; height: number };

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
  openPrint: () => void;
  rotateLeft: () => void;
  rotateRight: () => void;
  openExportToFolder: () => void;
  openExportToFlickr: () => void;
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
  // Grid thumbnail size - controlled from MenuBar's slider (App.tsx owns
  // the state) since it moved out of this view's own bottom status bar.
  thumbSize: number;
  // Grid loupe mode - App.tsx owns the boolean (shared with the MenuBar
  // button/shortcut and with hiding the sidebar/metadata panel), this view
  // just reacts to it: browse-only grid + hover-preview split pane.
  loupeOn: boolean;
  onToggleLoupe: () => void;
  // Loupe circle size - set in Preferences → Configuration → Window
  // ("Thumbnail Loupe Size"). Only meaningful while loupeOn.
  loupeLarge: boolean;
}>(function PhotosBrowser({ onTotalCount, metaOpen, onCloseMetadata, filters, onOpenApplicationsPreferences, active = true, thumbSize, loupeOn, onToggleLoupe, loupeLarge }, ref) {
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
  // Content-box width of the scroll container (i.e. already excludes its own
  // horizontal padding) - used to compute exactly how many columns the grid
  // holds and how wide/tall each tile is, so row heights are known up front
  // instead of guessed and corrected after the fact. Read via ResizeObserver
  // rather than a plain window-resize listener so it also tracks the
  // Metadata panel opening/closing (which resizes this container without
  // resizing the window).
  const [contentWidth, setContentWidth] = useState(0);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setContentWidth(entries[0].contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
    // Deliberately keyed on `buckets`/`error` (not `[]`) - the scroll
    // container this observes only exists in the DOM once the timeline has
    // actually loaded (see the early `if (!buckets) return <Loading.../>`
    // below), so a mount-only effect would find `containerRef.current` still
    // null the one time it runs and would never get another chance to
    // attach. Found live: with `[]`, contentWidth stayed stuck at 0 forever,
    // which pinned the grid at a single full-width column and made the
    // thumbnail-size slider look like it did nothing.
  }, [buckets, error]);
  // Lets rotateLeft/rotateRight (Edit menu) reach the currently-open Viewer
  // - null whenever nothing's open, since <Viewer> below is only mounted at
  // all when openAsset exists.
  const viewerRef = useRef<ViewerHandle>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Which tile the cursor is currently over while loupeOn - drives
  // GridLoupePane's preview. Cleared whenever loupe mode turns off so a
  // stale preview doesn't linger for next time it's turned on.
  const [hoveredAssetId, setHoveredAssetId] = useState<string | null>(null);
  useEffect(() => {
    if (!loupeOn) setHoveredAssetId(null);
  }, [loupeOn]);
  // Mirrors hoveredAssetId but is never cleared - only ever overwritten by
  // the next hover - so the centering effect below still knows which tile
  // to re-center on at the instant loupeOn flips off, even though the
  // reset effect above (same render, runs after this ref is already set)
  // is about to null out the display state itself.
  const lastHoveredAssetId = useRef<string | null>(null);
  const handleHoverAsset = useCallback((id: string | null) => {
    if (id) lastHoveredAssetId.current = id;
    setHoveredAssetId(id);
  }, []);
  // Which asset to re-center on next time `rows` actually reflects the
  // post-toggle column count - see the layout effect after `rows`/
  // `virtualizer` below. Captured with its own layout effect (not folded
  // into the one above) so it's set *before* the ResizeObserver driving
  // contentWidth can possibly fire, rather than racing it.
  const pendingCenterAssetId = useRef<string | null>(null);
  useLayoutEffect(() => {
    pendingCenterAssetId.current = lastHoveredAssetId.current;
  }, [loupeOn]);
  const lastClickedId = useRef<string | null>(null);
  const [, setTotalCount] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const [confirmDeleteSelection, setConfirmDeleteSelection] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; assetId: string } | null>(null);
  const [smartStackOpen, setSmartStackOpen] = useState(false);
  const [exportFolderAssets, setExportFolderAssets] = useState<AssetSummary[] | null>(null);
  const [printAsset, setPrintAsset] = useState<AssetSummary | null>(null);
  const [exportFlickrAssets, setExportFlickrAssets] = useState<AssetSummary[] | null>(null);
  const [addToAlbumTargets, setAddToAlbumTargets] = useState<string[] | null>(null);
  const [addToTagTargets, setAddToTagTargets] = useState<string[] | null>(null);
  // Copy/Paste Image Processing/Metadata, Sync Metadata from Sidecar, Show in
  // File Manager, and batch Rotate - shared with every other photo-grid page
  // via useAssetActions.ts (see its own doc comment for why assetByIdAll/
  // commitEdit/commitEditMany are passed at call time below rather than to
  // the hook itself). unsyncedMetadata/processingSidecarAssets destructured
  // under their original names since filteredAssetCache/overlaidAssetCache
  // below already reference them that way.
  const {
    unsyncedMetadata,
    processingSidecarAssets,
    scannedForProcessingSidecar,
    scanUnsyncedMetadata,
    markProcessingSidecar,
    copiedProcessingSource,
    copiedMetadata,
    handleCopyImageProcessing,
    handleCopyMetadata,
    handlePasteMetadata,
    requestPasteImageProcessing,
    pasteProcessingTargets,
    cancelPasteImageProcessing,
    confirmPasteImageProcessing,
    handleShowInFileManager,
    syncMetadata,
    rotateSelection,
    rotatingIds,
  } = useAssetActions({ onError: setEnqueueError });
  const { shortcuts, capturing } = useShortcuts();
  const { overrideIds, setOverride } = useRawOverrides();
  // This server version doesn't populate `stack` on /search/metadata or
  // /timeline/bucket at all (confirmed live - it's a newer-server-only
  // optimization), so stack membership is cross-referenced from a separate
  // one-time GET /stacks fetch instead of trusted off individual asset
  // records - see useStacking. Kept independent of assetCache/
  // patchAssetLocal - see the filteredAssetCache overlay below.
  const {
    stackByAssetId,
    expandedStacks,
    toggleStackExpand,
    dissolveAndRestackMany,
    createStackForSelection,
    applySmartStackGroups,
    setStackPickAction,
    unstack,
    unstackByStackId,
    unstackSelection,
    hasStackedSelection,
    applyStackInfo,
    busy: stackBusy,
  } = useStacking(selected, setSelected);

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
      resolveVisibleStackAssets(
        assets.map((a) => ({
          ...a,
          stack: stackByAssetId.get(a.id) ?? null,
          isRawOverride: overrideIds.has(a.id),
          unsyncedMetadata: unsyncedMetadata.get(a.id),
          hasProcessingSidecar: processingSidecarAssets.has(a.id),
        })),
      ).filter((a) => matchesFilters(a, deferredFilters)),
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

  // Same overlay as filteredAssetCache but without the
  // resolveVisibleStackAssets/matchesFilters trims - needed to resolve a
  // specific known id (opening a non-pick stack member from StackBand, or
  // selecting one to rate it) that resolveVisibleStackAssets deliberately
  // keeps out of the flat grid/assetById.
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
  // listener below and reconcileArtJob (both ART CLI round-trip variants
  // funnel through the same ArtQueue job reconciliation now).
  const applyRoundTripOutcome = useCallback(
    (outcome: RoundTripIngestOutcome) => {
      addAssetLocal(outcome.asset, outcome.originalAssetId);
      if (outcome.stack) {
        const { memberIds, info } = outcome.stack;
        applyStackInfo(memberIds, info);
      }
      // Tracks the rating/favorite/description copy roundTrip.ts's
      // finishIngest already enqueued onto the EditQueue - without this, a
      // real write failure (racing the freshly-created asset, batch
      // contention, ...) was previously invisible: the enqueue call itself
      // almost always succeeds, so nothing ever caught the actual failure.
      // Reuses the exact same rollbackById/reconcileJob machinery a normal
      // in-place edit does.
      for (const jobId of outcome.metadataJobIds) {
        rollbackById.current.set(jobId, { id: outcome.asset.id, prevValues: outcome.metadataPrevValues });
      }
      trackJobs(outcome.metadataJobIds);
      // Every round trip (Tweak or Headless) writes ART's own `.arp`
      // develop-settings sidecar back next to the *original* RAW - but
      // processingSidecarAssets is otherwise only ever populated once, the
      // first time each bucket loads (see the bucket-fetch effect below), so
      // an asset edited mid-session (long after its bucket already loaded)
      // never got its own "Copy Image Processing" gate flipped on. Found
      // live: a Tweak RAW Roundtrip produced a real 12KB `.arp` on disk, but
      // "Copy Image Processing" stayed hidden for that asset for the rest of
      // the session. Re-runs the same one-asset check the bucket effect
      // does, rather than waiting on a full Refresh Timeline. Uses
      // outcome.original (the caller's own snapshot) rather than
      // assetByIdAll.get(outcome.originalAssetId) - that lookup silently
      // no-ops whenever the original's bucket isn't loaded here, which is
      // routine for the late/background outcome path (see roundTrip.ts).
      const original = outcome.original;
      scanUnsyncedMetadata([original]);
    },
    [addAssetLocal, trackJobs, applyStackInfo, scanUnsyncedMetadata],
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

  // Applies a round-trip outcome that only finished after its own foreground
  // poll budget already gave up (see roundTrip.ts's retryIngestInBackground) -
  // without this, an export whose Immich indexing was slow enough to miss
  // the initial ~2-minute window would get correctly stacked server-side by
  // the background retry, but this page would never learn about it and the
  // asset would only show up (still unstacked-looking, until the next full
  // reload) via a manual Refresh Timeline.
  useEffect(() => subscribeLateRoundTripOutcome(applyRoundTripOutcome), [applyRoundTripOutcome]);

  // Grid deletes always move to trash (permanent=false) - "Delete Forever"
  // only exists from within the Trash view. Immich trashes a stack as one
  // atomic unit, so trashing an id that's still part of a stack would take
  // its siblings down too - pull each affected stack apart first and
  // re-stack whatever's left over, so only the requested id(s) actually go.
  const removeAssets = useCallback(
    async (ids: string[]) => {
      const idSet = new Set(ids);
      const stackIdsTouched = new Set<string>();
      for (const id of ids) {
        const info = stackByAssetId.get(id);
        if (info) stackIdsTouched.add(info.id);
      }
      await dissolveAndRestackMany([...stackIdsTouched], idSet);
      await deleteAssets(ids, false);
      removeAssetsLocal(ids);
    },
    [removeAssetsLocal, stackByAssetId, dissolveAndRestackMany],
  );

  // Stabilized (rather than inline arrow functions in the render below) so
  // the memoized row components (see PhotoRow type/render further down) can
  // actually bail out of re-rendering on scroll - a plain per-render arrow
  // function would defeat that memoization for every visible row.
  const handleRowContextMenu = useCallback((assetId: string, x: number, y: number) => setContextMenu({ assetId, x, y }), []);
  const handleRowRate = useCallback((id: string, rating: number) => commitEdit(id, { rating }), [commitEdit]);
  const resolveAsset = useCallback((id: string) => assetByIdAll.get(id), [assetByIdAll]);

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

  // Shared by every ART CLI round trip job (Variant 1's single "Tweak RAW
  // Roundtrip" and Variant 2's Headless RAW Roundtrip batch) - a `done` job
  // ingests its deterministic export (via ingestRoundTripExport)
  // incrementally rather than waiting for a whole batch to finish; a
  // `failed` job surfaces its error in the same banner a synchronous
  // rejection would. Declared before launchEditorForSelection since Variant
  // 1's own launch now just kicks the export off in the background
  // (launch_raw_cli_round_trip returns as soon as it's running, not once it's
  // done - see its own doc comment) and relies on this same reconciliation
  // to pick up the result, instead of awaiting the export inline.
  const { jobs: artJobs } = useArtQueue();
  const reconcileArtJob = useCallback(
    (job: ArtJob) => {
      if (job.status === 'failed') {
        setEnqueueError(job.error ?? "Couldn't complete a Roundtrip export.");
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
            `Exported "${exportFileName}", but it hasn't shown up in Immich yet — BrightTable will keep checking in the background and stack it automatically once it does.`,
          );
        }
      });
    },
    [assetByIdAll, applyRoundTripOutcome],
  );
  const { trackJobs: trackArtJobs } = useArtJobReconciliation(artJobs, reconcileArtJob);

  // Launch-only, single-asset - mirrors Viewer.tsx's handleLaunch exactly
  // (same redirect-to-Preferences-when-unconfigured behavior and ART CLI
  // round-trip branch), just sourced from the selection bar's one selected
  // asset instead of the open asset.
  const { applications, activeRawEditorApp, rawRoundTripEnabled } = useApplications();
  // True while ART itself is open for the selection bar's single selected
  // asset (and briefly after, while the export path/sidecar are resolved) -
  // see SelectionBar.tsx's rawEditorBusy prop. Cleared as soon as the
  // ART-cli export is handed off to the background (or immediately on the
  // generic editor / noSidecar-cancel paths), not once that export finishes -
  // trackArtJobs above (not this flag) is what the actual conversion's
  // completion drives.
  const [artLaunchBusy, setArtLaunchBusy] = useState(false);
  const { resolve: resolveArtRoundTripOutcome, dialog: noSidecarDialog } = useNoSidecarChoice();
  const launchEditorForSelection = useCallback(
    async (role: 'rawEditor' | 'externalEditor') => {
      if (selectedAssets.length !== 1) return;
      const choice = role === 'rawEditor' ? activeRawEditorApp : applications.externalEditor;
      if (!choice) {
        onOpenApplicationsPreferences?.();
        return;
      }
      const asset = selectedAssets[0];
      if (role === 'rawEditor' && rawRoundTripEnabled) {
        setArtLaunchBusy(true);
        try {
          const rtOutcome = await launchRawCliRoundTrip(asset.id, asset.originalPath, asset.fileName, asset.fileExtension, choice);
          const jobId = await resolveArtRoundTripOutcome(rtOutcome);
          trackArtJobs([jobId]);
        } finally {
          setArtLaunchBusy(false);
        }
        return;
      }
      await launchEditor(asset.originalPath, choice, asset.id, asset.fileName);
    },
    [selectedAssets, applications, activeRawEditorApp, rawRoundTripEnabled, onOpenApplicationsPreferences, resolveArtRoundTripOutcome, trackArtJobs],
  );

  // Headless RAW Roundtrip (ART CLI round trip Variant 2) - fully headless,
  // background-queued export of one or more RAW assets at once. Only
  // reachable when rawRoundTripEnabled (see PreferencesApplications.tsx).
  // RAW-filtered here (not left to the backend) for the same reason
  // requestPasteImageProcessing is: the confirm dialog's count should
  // reflect what's really about to be exported. artJobs/reconcileArtJob/
  // trackArtJobs (shared with Variant 1's own launch above) are declared
  // earlier, before launchEditorForSelection.
  const [batchArtTargets, setBatchArtTargets] = useState<string[] | null>(null);
  const requestBatchArtRoundTrip = useCallback(
    (ids: string[]) => {
      const rawIds = ids.filter((id) => {
        const a = assetByIdAll.get(id);
        return !!a && isRoundTripEligible(a);
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
      const jobIds = await batchRawCliRoundTrip(targets);
      trackArtJobs(jobIds);
      setSelected(new Set());
    },
    [assetByIdAll, trackArtJobs],
  );

  // Some selected RAW photos may have no saved ART edits at all (no
  // `.arp`/`.pp3` next to the RAW) - rather than silently exporting those
  // with ART's default profile the way batch_raw_cli_round_trip's `-d -S` already
  // would, this surfaces the choice explicitly once the outer "Headless RAW
  // Roundtrip?" confirm above is accepted: export everyone (default profile
  // for the affected ones) or exclude just the affected ones from this batch.
  // Skipped entirely (falls straight through to runBatchArtRoundTrip) when
  // every target already has a sidecar.
  const [noSidecarBatch, setNoSidecarBatch] = useState<{ allIds: string[]; withoutSidecarCount: number } | null>(null);

  const confirmBatchArtRoundTrip = useCallback(async () => {
    if (!batchArtTargets) return;
    const targets = batchArtTargets;
    // Closes the "Headless RAW Roundtrip?" dialog immediately instead of
    // keeping it open (Cancel disabled) while deciding what to do - see
    // runBatchArtRoundTrip below for why that decision is now cache-only
    // rather than a live disk round trip. Same "close first, await after"
    // trick the no-sidecar follow-up dialog below already uses. Errors are
    // caught explicitly and routed to the standing enqueueError banner
    // instead of left to reject back through ConfirmDialog's own
    // handleConfirm, since that dialog is already unmounted by the time any
    // of this can fail.
    setBatchArtTargets(null);
    // Decides the no-sidecar warning from the cached `hasProcessingSidecar`
    // flag only - this used to `await checkSidecarMetadata(...)` for a live
    // disk recheck first (to catch a sidecar created out-of-band, e.g. via
    // Tweak Roundtrip or in the Folders view's own separate cache), but that
    // added a full extra network round trip - individually timeout-bounded
    // at 120s - in front of the actual enqueue below. Confirmed live: on a
    // slow NFS mount this left nothing visible on screen (dialog already
    // closed, pill not up yet) for up to two minutes, reading as "the
    // roundtrip button doesn't do anything". The cache is kept fresh enough
    // for this one warning-dialog judgment call by the context-menu-open
    // live recheck effect below and by reconcileArtJob/reconcileProcessingJob
    // updating it the moment a real sidecar is written - and even a stale
    // "no sidecar" read here can't cause data loss, since batch_raw_cli_round_trip
    // itself still re-checks each target's sidecar on disk before deciding
    // whether to apply the default profile.
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
  // `resolveVisibleStackAssets`) still resolves instead of silently rendering an
  // empty menu - same fix `Viewer.tsx`'s peek architecture already needed
  // for the identical structural reason (§7.16).
  // Ordered into logical groups - Organize / Stacking / Edit / Copy-Paste /
  // Utility / Destructive - matching SelectionBar's own group order
  // (primary/stack/edit/copyPaste/more/destructive) so the two surfaces
  // agree on where a given action "lives", with DIVIDER between groups
  // (ContextMenu.tsx collapses one away if the group on either side of it
  // ended up empty). Previously this grew in whatever order features were
  // added over time, which read as arbitrary.
  const contextMenuItems: ContextMenuEntry[] = useMemo(() => {
    if (!contextMenu) return [];
    const asset = assetByIdAll.get(contextMenu.assetId);
    // Paste/Add/Export/Trash all target the whole current selection when 2+
    // are selected - matching "Stack N Photos", which already does this
    // regardless of which specific tile was right-clicked - rather than
    // always just the single right-clicked tile. Found live: a user with a
    // multi-selection active got a "Paste onto 1 photo?" confirm no matter
    // how many were selected.
    const pasteTargetIds = selected.size >= 2 ? [...selected] : asset ? [asset.id] : [];
    const pasteTargetsIncludeRaw = pasteTargetIds.some((id) => {
      const a = assetByIdAll.get(id);
      return !!a && isRawAsset(a);
    });
    const items: ContextMenuEntry[] = [];

    // Organize
    if (pasteTargetIds.length > 0) {
      items.push({
        label: pasteTargetIds.length > 1 ? `Add ${pasteTargetIds.length} Photos to Album…` : 'Add to Album…',
        onClick: () => setAddToAlbumTargets(pasteTargetIds),
      });
      items.push({
        label: (pasteTargetIds.length > 1 ? `Add ${pasteTargetIds.length} Photos to Tag…` : 'Add to Tag…') + (TAG_ASSIGN_DISABLED_REASON ? ' (disabled)' : ''),
        onClick: () => setAddToTagTargets(pasteTargetIds),
        disabled: !!TAG_ASSIGN_DISABLED_REASON,
      });
    }
    items.push(DIVIDER);

    // Stacking
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
    items.push(DIVIDER);

    // Edit - Rotate mirrors Viewer.tsx's single-open-asset gating (non-video,
    // has a resolvable local path), using rotateSelection so this menu and
    // SelectionBar's Edit ▾ share the same batch-capable implementation.
    if (asset && selected.size <= 1 && asset.originalPath && !isVideoAsset(asset)) {
      items.push({ label: 'Rotate Left', onClick: () => rotateSelection([asset.id], false, assetByIdAll).catch(() => {}) });
      items.push({ label: 'Rotate Right', onClick: () => rotateSelection([asset.id], true, assetByIdAll).catch(() => {}) });
    }
    if (rawRoundTripEnabled) {
      const rawTargetIds = pasteTargetIds.filter((id) => {
        const a = assetByIdAll.get(id);
        return !!a && isRoundTripEligible(a);
      });
      if (rawTargetIds.length >= 1) {
        items.push({
          label: `Headless Roundtrip (${rawTargetIds.length})`,
          onClick: () => requestBatchArtRoundTrip(rawTargetIds),
        });
      }
    }
    items.push(DIVIDER);

    // Copy/Paste
    if (asset) {
      const copyEntry = copyImageProcessingEntry(asset, scannedForProcessingSidecar, handleCopyImageProcessing);
      if (copyEntry) items.push(copyEntry);
    }
    if (copiedProcessingSource && pasteTargetsIncludeRaw) {
      items.push({
        label: pasteTargetIds.length > 1 ? `Paste Image Processing to ${pasteTargetIds.length} Photos` : 'Paste Image Processing',
        onClick: () => requestPasteImageProcessing(pasteTargetIds, assetByIdAll),
      });
    }
    if (asset) {
      items.push({ label: 'Copy Metadata', onClick: () => handleCopyMetadata(asset) });
    }
    if (copiedMetadata && pasteTargetIds.length > 0) {
      items.push({
        label: pasteTargetIds.length > 1 ? `Paste Metadata to ${pasteTargetIds.length} Photos` : 'Paste Metadata',
        onClick: () => handlePasteMetadata(pasteTargetIds, commitEditMany),
      });
    }
    items.push(DIVIDER);

    // Utility
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
        onClick: () => syncMetadata([asset.id], commitEdit).catch(() => {}),
      });
    }
    if (pasteTargetIds.length > 0) {
      const exportAssets = pasteTargetIds.map((id) => assetByIdAll.get(id)).filter((a): a is AssetSummary => !!a);
      items.push({ label: 'Export to Folder…', onClick: () => setExportFolderAssets(exportAssets) });
      items.push({ label: 'Share to Flickr…', onClick: () => setExportFlickrAssets(exportAssets) });
    }
    items.push(DIVIDER);

    // Destructive
    if (pasteTargetIds.length > 0) {
      // Previously absent from this menu (present everywhere else - the
      // SelectionBar, the Viewer header, and every other page's own context
      // menu) - a real gap, not a deliberate omission.
      items.push({
        label: pasteTargetIds.length > 1 ? `Move ${pasteTargetIds.length} Photos to Trash` : 'Move to Trash',
        onClick: () => removeAssets(pasteTargetIds).catch(() => {}),
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
    scannedForProcessingSidecar,
    syncMetadata,
    commitEdit,
    commitEditMany,
    copiedProcessingSource,
    copiedMetadata,
    handleShowInFileManager,
    handleCopyImageProcessing,
    requestPasteImageProcessing,
    handleCopyMetadata,
    handlePasteMetadata,
    rotateSelection,
    removeAssets,
    rawRoundTripEnabled,
    requestBatchArtRoundTrip,
  ]);

  // Right-clicking a RAW asset that doesn't currently show Copy Image
  // Processing - or plain-selecting exactly one, which is SelectionBar's own
  // trigger for the same button - live-rechecks disk once, the same
  // checkSidecarMetadata call confirmBatchArtRoundTrip below uses.
  // hasProcessingSidecar is otherwise only refreshed on bucket load, a
  // completed round trip, or a completed Paste Image Processing job (see
  // reconcileProcessingJob above) - a sidecar created any other way (an
  // external ART/RawTherapee run, or a paste that happened in the Folders
  // view) would otherwise hide Copy Image Processing - on both the context
  // menu AND the SelectionBar - until the next full reload. Found live: the
  // context-menu recheck alone left Copy Image Processing correctly visible
  // on right-click but still missing from SelectionBar for that exact same
  // single selection, since SelectionBar has no right-click to trigger off.
  useEffect(() => {
    const candidateId = contextMenu?.assetId ?? (selected.size === 1 ? [...selected][0] : null);
    if (!candidateId) return;
    const asset = assetByIdAll.get(candidateId);
    if (!asset || !asset.originalPath || asset.hasProcessingSidecar || !isRawAsset(asset)) return;
    scanUnsyncedMetadata([asset], true);
  }, [contextMenu, selected, assetByIdAll, scanUnsyncedMetadata]);

  // See `vaultReadyRetry.ts` - the credential vault can still be opening in
  // the background when this first fires, so it retries until the fetch
  // actually succeeds instead of leaving a permanent "Couldn't load the
  // library" screen up.
  useEffect(() => {
    let cancelled = false;
    function load() {
      getTimelineBuckets()
        .then((b) => {
          if (cancelled) return;
          setBuckets(b);
          const total = b.reduce((sum, x) => sum + x.count, 0);
          setTotalCount(total);
          onTotalCount?.(total);
          setError(null);
        })
        .catch((e) => {
          if (!cancelled) setError(String(e));
        });
    }
    load();
    const cleanup = retryOnVaultReady(load);
    return () => {
      cancelled = true;
      cleanup();
    };
    // Deliberately runs once on mount only - onTotalCount's identity changing
    // on re-renders shouldn't refetch the whole timeline.
  }, []);

  const selectAll = useCallback(() => setSelected(new Set(flatIds)), [flatIds]);
  const deselectAll = useCallback(() => setSelected(new Set()), []);

  // Loupe mode is browse-only - nothing should still show as selected (and
  // SelectionBar shouldn't pop up) once it's on.
  useEffect(() => {
    if (loupeOn) deselectAll();
  }, [loupeOn, deselectAll]);

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
        syncMetadata([...unsyncedMetadata.keys()], commitEdit).catch(() => {});
      },
      copyImageProcessing: () => {
        if (selectedAssets.length === 1) handleCopyImageProcessing(selectedAssets[0]);
      },
      pasteImageProcessing: () => {
        requestPasteImageProcessing([...selected], assetByIdAll);
      },
      copyMetadata: () => {
        if (selectedAssets.length === 1) handleCopyMetadata(selectedAssets[0]);
      },
      pasteMetadata: () => {
        handlePasteMetadata([...selected], commitEditMany);
      },
      // Single-asset resolution, matching the design mockup's own
      // printTargetAsset(): the lone selected asset, else the open Viewer
      // asset, else the first currently-visible one. A RAW-resolved target
      // is a silent no-op (there's no toast system to explain why) - the
      // menu item/Viewer button/context menu are the actual gates in the
      // common case; this is just the same defense-in-depth backing them.
      openPrint: () => {
        const target =
          selectedAssets.length === 1
            ? selectedAssets[0]
            : openId
              ? (assetByIdAll.get(openId) ?? null)
              : (assetByIdAll.get(flatIds[0]) ?? null);
        if (target && !isRawAsset(target)) setPrintAsset(target);
      },
      // Unlike the other Edit-menu items above, rotate has no grid-level
      // implementation of its own to fall back to - it only ever acts on
      // whichever photo is actually open in the Viewer (rotating a *selected
      // but unopened* tile isn't something the toolbar buttons this mirrors
      // support either), so this is a silent no-op whenever the Viewer isn't
      // currently mounted.
      rotateLeft: () => viewerRef.current?.rotate(false),
      rotateRight: () => viewerRef.current?.rotate(true),
      // Matches openPrint's fallback shape: the current selection, else the
      // asset open in the Viewer, else nothing (silent no-op - there's no
      // selection to disable the File-menu item on).
      openExportToFolder: () => {
        const openAsset = openId ? assetByIdAll.get(openId) : undefined;
        const target = selectedAssets.length > 0 ? selectedAssets : openAsset ? [openAsset] : [];
        if (target.length > 0) setExportFolderAssets(target);
      },
      openExportToFlickr: () => {
        const openAsset = openId ? assetByIdAll.get(openId) : undefined;
        const target = selectedAssets.length > 0 ? selectedAssets : openAsset ? [openAsset] : [];
        if (target.length > 0) setExportFlickrAssets(target);
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
      commitEdit,
      commitEditMany,
      openId,
      assetByIdAll,
      flatIds,
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
      if (matchesShortcut(e, shortcuts.loupe)) {
        e.preventDefault();
        onToggleLoupe();
      } else if (matchesShortcut(e, shortcuts.open) && lastClickedId.current) {
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
      } else if (matchesShortcut(e, shortcuts.favorite) && loupeOn && hoveredAssetId) {
        e.preventDefault();
        const hovered = assetByIdAll.get(hoveredAssetId);
        commitEdit(hoveredAssetId, { isFavorite: !hovered?.isFavorite }).catch(() => {});
      } else if (matchesShortcut(e, shortcuts.stack) && selected.size >= 2) {
        e.preventDefault();
        createStackForSelection([...selected]).catch(() => {});
      } else if (matchesShortcut(e, shortcuts.copyMetadata) && selectedAssets.length === 1) {
        e.preventDefault();
        handleCopyMetadata(selectedAssets[0]);
      } else if (matchesShortcut(e, shortcuts.pasteMetadata) && selected.size > 0 && copiedMetadata) {
        e.preventDefault();
        handlePasteMetadata([...selected], commitEditMany);
      } else if (matchesShortcut(e, shortcuts.copyImageProcessing) && selectedAssets.length === 1) {
        e.preventDefault();
        handleCopyImageProcessing(selectedAssets[0]);
      } else if (matchesShortcut(e, shortcuts.copyImageProcessing) && loupeOn && hoveredAssetId) {
        e.preventDefault();
        const hovered = assetByIdAll.get(hoveredAssetId);
        if (hovered) handleCopyImageProcessing(hovered);
      } else if (matchesShortcut(e, shortcuts.pasteImageProcessing) && selected.size > 0 && copiedProcessingSource) {
        e.preventDefault();
        requestPasteImageProcessing([...selected], assetByIdAll);
      } else if (matchesShortcut(e, shortcuts.pasteImageProcessing) && loupeOn && hoveredAssetId && copiedProcessingSource) {
        e.preventDefault();
        requestPasteImageProcessing([hoveredAssetId], assetByIdAll);
      } else if (matchesShortcut(e, shortcuts.addToTag) && selected.size > 0 && !TAG_ASSIGN_DISABLED_REASON) {
        e.preventDefault();
        setAddToTagTargets([...selected]);
      } else if (selected.size > 0 || (loupeOn && hoveredAssetId)) {
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
            if (loupeOn && hoveredAssetId) {
              commitEdit(hoveredAssetId, { rating }).catch(() => {});
            } else {
              commitEditMany([...selected], { rating }).catch(() => {});
            }
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
    commitEdit,
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
    setAddToTagTargets,
    onToggleLoupe,
    loupeOn,
    hoveredAssetId,
    assetByIdAll,
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

  // Number of tiles per row, computed the same way CSS grid's own
  // `repeat(auto-fill, minmax(thumbSize, 1fr))` would (as many tracks of at
  // least thumbSize as fit, then stretched evenly) - but done here in JS
  // instead of left to the browser, since row-level virtualization needs to
  // know each row's exact tile count and height *before* it renders, not
  // find out from the DOM afterwards.
  const columns = useMemo(() => {
    if (contentWidth <= 0) return 1;
    return Math.max(1, Math.floor((contentWidth + GRID_GAP) / (thumbSize + GRID_GAP)));
  }, [contentWidth, thumbSize]);
  const tileWidth = columns > 0 ? (contentWidth - GRID_GAP * (columns - 1)) / columns : thumbSize;
  const assetRowHeight = Math.max(1, Math.round((tileWidth * 2) / 3)) + GRID_GAP;

  // Flattens every loaded bucket's day-groups into individual grid rows (see
  // the PhotoRow type above) - an expanded stack's band always starts a new
  // row and takes the whole width, exactly mirroring how CSS grid's
  // auto-placement already handled a `gridColumn: 1 / -1` item inline with
  // the old single-grid-per-day layout. A bucket whose assets haven't loaded
  // yet still contributes one 'loading' placeholder row sized off its known
  // asset count, so the fetch-on-scroll effect below still has something to
  // key off of and the scrollbar doesn't jump once it does load.
  const rows = useMemo<PhotoRow[]>(() => {
    if (!buckets) return [];
    const out: PhotoRow[] = [];
    buckets.forEach((bucket, bucketIndex) => {
      const assets = filteredAssetCache[bucket.timeBucket];
      if (!assets) {
        const dayHeadersGuess = Math.min(bucket.count, 28);
        const rowsGuess = Math.ceil(bucket.count / columns);
        const height = MONTH_TOP_PADDING + MONTH_HEADER_HEIGHT + dayHeadersGuess * DAY_HEADER_HEIGHT + rowsGuess * assetRowHeight;
        out.push({ kind: 'loading', bucketIndex, height });
        return;
      }
      out.push({ kind: 'month', bucketIndex, height: MONTH_TOP_PADDING + MONTH_HEADER_HEIGHT });
      for (const [day, items] of groupByDay(assets)) {
        const place = placeLabel(items[0]);
        const dateObj = parseCalendarDate(day);
        const dayLabel = `${dateObj.toLocaleDateString(undefined, { weekday: 'long' })} · ${dateObj.toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}`;
        out.push({ kind: 'day', bucketIndex, day, dayLabel, place, count: items.length, height: DAY_HEADER_HEIGHT });
        let currentRow: AssetSummary[] = [];
        for (const a of items) {
          const isExpandedStackPrimary = !!a.stack && a.stack.primaryAssetId === a.id && a.stack.assetCount > 1 && expandedStacks.has(a.stack.id);
          if (isExpandedStackPrimary) {
            if (currentRow.length) {
              out.push({ kind: 'assets', bucketIndex, day, items: currentRow, height: assetRowHeight });
              currentRow = [];
            }
            out.push({ kind: 'stackband', bucketIndex, day, stackId: a.stack!.id, assetId: a.id, height: STACK_BAND_HEIGHT_GUESS });
            continue;
          }
          currentRow.push(a);
          if (currentRow.length === columns) {
            out.push({ kind: 'assets', bucketIndex, day, items: currentRow, height: assetRowHeight });
            currentRow = [];
          }
        }
        if (currentRow.length) out.push({ kind: 'assets', bucketIndex, day, items: currentRow, height: assetRowHeight });
      }
    });
    return out;
  }, [buckets, filteredAssetCache, expandedStacks, columns, assetRowHeight]);

  // First row index belonging to each bucket (length buckets.length + 1, the
  // last entry being rows.length) - lets TimelineRail translate its own
  // bucket-index math (built off exact Immich asset counts, see its own doc
  // comment) into a row index this row-level virtualizer can actually scroll
  // to. Every bucket has at least one asset (Immich never returns a
  // zero-count bucket) so this is always strictly non-decreasing.
  const bucketFirstRowIndex = useMemo(() => {
    const arr = new Array<number>((buckets?.length ?? 0) + 1).fill(rows.length);
    let cursor = 0;
    for (let b = 0; b < (buckets?.length ?? 0); b++) {
      while (cursor < rows.length && rows[cursor].bucketIndex < b) cursor++;
      arr[b] = cursor;
    }
    arr[buckets?.length ?? 0] = rows.length;
    return arr;
  }, [rows, buckets]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => containerRef.current,
    estimateSize: (index) => rows[index].height,
    overscan: 12,
  });
  // Not a real options field in this tanstack-virtual version (only a
  // settable instance property - assigning it here every render is cheap
  // and idempotent). The library's own default behavior nudges scrollTop
  // by itself whenever a row's *measured* size differs even slightly from
  // estimateSize's guess (e.g. sub-pixel rounding between assetRowHeight's
  // Math.round and the browser's actual `aspect-ratio: 3/2` layout) -
  // individually tiny, but summed across the thousands of rows above the
  // viewport that all get (re-)measured right after loupeOn reshuffles
  // `rows`, it silently dragged our explicit re-centering scrollTop write
  // (see the layout effect below) off to an unrelated position a frame or
  // two later - confirmed live via console logging: our write landed
  // correctly, then jumped on its own with no other code touching
  // scrollTop in between.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false;

  // `rows` changing shape (a thumbnail-size drag changes `columns`, which
  // changes how many items land in each row, which shifts what every row
  // *index* even means) leaves the virtualizer's own per-index measurement
  // cache pointing at stale heights from the old grouping - only whichever
  // rows happen to be mounted right now would ever get remeasured on their
  // own (via the ResizeObserver measureElement attaches), so scrolled-away
  // rows would silently keep wrong cached heights, and the ones on screen
  // could lag a frame. `measure()` (same fix FoldersBrowser's own
  // virtualizer already applies when its bucket keys change) clears that
  // cache outright so every row - visible or not - is sized fresh off the
  // new `estimateSize` the moment it's actually rendered. A *layout* effect,
  // not a passive one - otherwise the browser paints one frame with rows
  // positioned off the stale cache (visibly wrong/jumping) before this runs
  // and corrects it a frame later.
  useLayoutEffect(() => {
    virtualizer.measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  // Re-centers the grid on whichever tile was hovered right as loupeOn
  // toggled (captured into pendingCenterAssetId above) once `rows` has
  // actually been rebuilt for the post-toggle column count. Computes the
  // target's offset analytically by summing `rows[i].height` up to its row
  // index, rather than reading the virtualizer's rendered `translateY`/
  // measurement cache - that cache is only guaranteed fresh *after* the
  // `measure()` layout effect above has run and forced a further
  // re-render, which hasn't happened yet at this point in the same commit,
  // so reading it here would still be one render behind (the actual cause
  // of the grid "jumping to a completely different spot" bug - not a
  // timing/frame-count problem at all, a stale-cache-read problem). Row
  // heights are exact here (assetRowHeight is derived from the same
  // formula `estimateSize` uses, and every tile has a fixed 3:2 aspect
  // ratio), so this lands on the same pixel offset the virtualizer will
  // itself settle on - no dependency on its cache or timing.
  useLayoutEffect(() => {
    const container = containerRef.current;
    const targetId = pendingCenterAssetId.current;
    if (!container || !targetId) return;
    const idx = rows.findIndex(
      (row) =>
        (row.kind === 'assets' && row.items.some((a) => a.id === targetId)) ||
        (row.kind === 'stackband' && row.assetId === targetId),
    );
    if (idx === -1) return;
    let offset = 0;
    for (let i = 0; i < idx; i++) offset += rows[i].height;
    container.scrollTop = Math.max(0, offset + rows[idx].height / 2 - container.clientHeight / 2);
    pendingCenterAssetId.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contentWidth, rows]);

  useEffect(() => {
    // Also skipped while inactive (kept mounted but hidden behind another
    // tab) - otherwise this keeps consuming checkSidecarMetadata's shared,
    // concurrency-limited permit pool (io_guard.acquire_metadata_scan_permit,
    // capped at maxConcurrentMetadataScans) for a tab nobody's looking at,
    // starving out permits for the tab actually in front of the user - found
    // live: a manual check_sidecar_metadata call from Folders never resolved
    // at all because Photos, left mounted in the background, kept queuing
    // new bucket scans indefinitely as it re-rendered.
    if (!buckets || !active) return;
    const seenBuckets = new Set<number>();
    for (const item of virtualizer.getVirtualItems()) {
      const row = rows[item.index];
      if (!row || seenBuckets.has(row.bucketIndex)) continue;
      seenBuckets.add(row.bucketIndex);
      const bucket = buckets[row.bucketIndex];
      if (assetCache[bucket.timeBucket] || inFlight.current.has(bucket.timeBucket)) continue;
      inFlight.current.add(bucket.timeBucket);
      getTimelineBucketAssets(bucket.timeBucket)
        .then((assets) => {
          setAssetCache((c) => ({ ...c, [bucket.timeBucket]: assets }));
          // Passive, best-effort check - silently does nothing if no local
          // path mapping is configured (Preferences → Library → Originals
          // on Disk) or this bucket's assets don't resolve to one.
          scanUnsyncedMetadata(assets);
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

  const canStack = selected.size >= 2;
  const canOpenInRawEditor = selectedAssets.length === 1 && isRoundTripEligible(selectedAssets[0]);
  const canPasteImageProcessing =
    !!copiedProcessingSource &&
    [...selected].some((id) => {
      const a = assetByIdAll.get(id);
      return !!a && isRawAsset(a);
    });
  const rawSelectedCount = [...selected].filter((id) => {
    const a = assetByIdAll.get(id);
    return !!a && isRoundTripEligible(a);
  }).length;
  const selectionCanRotate = [...selected].some((id) => {
    const a = assetByIdAll.get(id);
    return !!a && !!a.originalPath && !isVideoAsset(a);
  });
  const copyImageProcessingBarEntry =
    selectedAssets.length === 1 ? copyImageProcessingEntry(selectedAssets[0], scannedForProcessingSidecar, handleCopyImageProcessing) : null;
  const selectionBarActions: MenuAction[] = [
    { id: 'addToTag', group: 'organize', label: 'Add to Tag', disabled: !!TAG_ASSIGN_DISABLED_REASON, disabledReason: TAG_ASSIGN_DISABLED_REASON ?? undefined, onClick: () => setAddToTagTargets([...selected]) },
    { id: 'addToAlbum', group: 'organize', label: 'Add to Album', onClick: () => setAddToAlbumTargets([...selected]) },
    { id: 'stack', group: 'stack', label: stackBusy ? 'Working…' : `Stack ${selected.size} Photos`, disabled: !canStack || stackBusy, onClick: () => createStackForSelection([...selected]).catch(() => {}) },
    { id: 'smartStack', group: 'stack', label: stackBusy ? 'Working…' : 'Smart Stack', disabled: !canStack || stackBusy, onClick: () => setSmartStackOpen(true) },
    // Lives in the Stack ▾ dropdown (not a separate primary-slot swap with
    // Add to Tag, which is how this worked before and made it hard to find) -
    // shown whenever the selection touches a stack, disabled while busy.
    ...(hasStackedSelection
      ? [{ id: 'unstack', group: 'stack' as const, label: stackBusy ? 'Working…' : 'Unstack', disabled: stackBusy, onClick: () => unstackSelection().catch((e) => setEnqueueError(String(e))) }]
      : []),
    {
      id: 'tweakRoundtrip',
      group: 'edit',
      label: artLaunchBusy ? 'Working…' : 'Tweak Roundtrip',
      disabled: !canOpenInRawEditor || artLaunchBusy,
      disabledReason: canOpenInRawEditor ? undefined : 'Select a single RAW photo',
      onClick: () => launchEditorForSelection('rawEditor').catch((e) => setEnqueueError(String(e))),
    },
    {
      id: 'headlessRoundtrip',
      group: 'edit',
      label: 'Headless Roundtrip',
      disabled: !rawRoundTripEnabled || rawSelectedCount < 1,
      disabledReason: rawRoundTripEnabled ? 'Select a photo the active RAW converter CLI can process' : undefined,
      onClick: () => requestBatchArtRoundTrip([...selected]),
    },
    { id: 'openExtEditor', group: 'edit', label: 'Open in Ext. Editor', disabled: selectedAssets.length !== 1, disabledReason: 'Select a single photo to open it in an editor', onClick: () => launchEditorForSelection('externalEditor').catch((e) => setEnqueueError(String(e))) },
    {
      id: 'rotateLeft',
      group: 'edit',
      label: rotatingIds.size > 0 ? 'Rotating…' : 'Rotate Left',
      disabled: !selectionCanRotate || rotatingIds.size > 0,
      onClick: () => rotateSelection([...selected], false, assetByIdAll).catch(() => {}),
    },
    {
      id: 'rotateRight',
      group: 'edit',
      label: rotatingIds.size > 0 ? 'Rotating…' : 'Rotate Right',
      disabled: !selectionCanRotate || rotatingIds.size > 0,
      onClick: () => rotateSelection([...selected], true, assetByIdAll).catch(() => {}),
    },
    // Copy is inherently single-source, so these two only appear when
    // exactly one photo is selected (matching the context menu's identical
    // gating) - a multi-selection only ever gets Paste.
    ...(copyImageProcessingBarEntry ? [{ id: 'copyImageProcessing', group: 'copyPaste' as const, ...copyImageProcessingBarEntry }] : []),
    {
      id: 'pasteImageProcessing',
      group: 'copyPaste',
      label: 'Paste Image Processing',
      disabled: !canPasteImageProcessing,
      onClick: () => requestPasteImageProcessing([...selected], assetByIdAll),
    },
    ...(selectedAssets.length === 1
      ? [{ id: 'copyMetadata', group: 'copyPaste' as const, label: 'Copy Metadata', onClick: () => handleCopyMetadata(selectedAssets[0]) }]
      : []),
    { id: 'pasteMetadata', group: 'copyPaste', label: 'Paste Metadata', disabled: !copiedMetadata, onClick: () => handlePasteMetadata([...selected], commitEditMany) },
    {
      id: 'exportToFolder',
      group: 'share',
      label: 'Export to Folder…',
      onClick: () => setExportFolderAssets([...selected].map((id) => assetByIdAll.get(id)).filter((a): a is AssetSummary => !!a)),
    },
    {
      id: 'shareToFlickr',
      group: 'share',
      label: 'Share to Flickr…',
      onClick: () => setExportFlickrAssets([...selected].map((id) => assetByIdAll.get(id)).filter((a): a is AssetSummary => !!a)),
    },
    // Show in File Manager is single-target only (revealInFileManager takes
    // one path) - matching the context menu's identical single-asset-only
    // gating, same reasoning as Tweak Roundtrip/Open in Ext. Editor above.
    {
      id: 'showInFileManager',
      group: 'more',
      label: 'Show in File Manager',
      disabled: selectedAssets.length !== 1 || !selectedAssets[0].originalPath,
      disabledReason: 'Select a single photo to show it in the file manager',
      onClick: () => handleShowInFileManager(selectedAssets[0]),
    },
    ...([...selected].filter((id) => unsyncedMetadata.has(id)).length > 0
      ? [
          {
            id: 'syncMetadata',
            group: 'more' as const,
            label: 'Sync Metadata from Sidecar',
            onClick: () => syncMetadata([...selected].filter((id) => unsyncedMetadata.has(id)), commitEdit).catch(() => {}),
          },
        ]
      : []),
    { id: 'moveToTrash', group: 'destructive', label: 'Move to Trash', onClick: () => setConfirmDeleteSelection(true) },
  ];

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {enqueueError && <InlineWarningBanner message={enqueueError} onDismiss={() => setEnqueueError(null)} />}
      {selected.size > 0 && (
        <SelectionBar
          count={selected.size}
          onCancel={deselectAll}
          onFavorite={toggleFavoriteForSelection}
          allFavorited={allSelectedFavorited}
          onRate={(rating) => commitEditMany([...selected], { rating }).catch(() => {})}
          actions={selectionBarActions}
        />
      )}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <div style={{ flex: loupeOn ? '0 0 33.333%' : 1, display: 'flex', flexDirection: 'column', minHeight: 0, position: 'relative' }}>
          <div
            ref={containerRef}
            style={{
              flex: 1,
              overflow: 'auto',
              // The browser's own CSS scroll anchoring otherwise fights our
              // explicit scrollTop writes below whenever the virtualized
              // rows reshuffle (loupeOn changing column count) - it tries to
              // "keep whatever was in view in view" using its own
              // first-visible-descendant heuristic, which gets badly
              // confused by absolutely-positioned/transformed virtual rows
              // and can silently override the scrollTop we just set to a
              // effectively arbitrary one.
              overflowAnchor: 'none',
              minHeight: 0,
              padding: loupeOn ? '0 24px' : '0 76px 0 24px',
              background: 'var(--canvas)',
              ...pendingStyle(isFiltering),
            }}
          >
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
              {virtualizer.getVirtualItems().map((item) => {
                const row = rows[item.index];
                const bucket = buckets[row.bucketIndex];
                return (
                  <div
                    key={item.key}
                    ref={virtualizer.measureElement}
                    data-index={item.index}
                    style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${item.start}px)` }}
                  >
                    <PhotoRowView
                      row={row}
                      bucket={bucket}
                      columns={columns}
                      selected={selected}
                      onToggleSelect={handleThumbClick}
                      onToggleOne={toggleOne}
                      onOpen={setOpenId}
                      onContextMenu={handleRowContextMenu}
                      onToggleStackExpand={toggleStackExpand}
                      onUnstack={unstack}
                      onSetPick={setStackPickAction}
                      onRate={handleRowRate}
                      resolveAsset={resolveAsset}
                      loupeMode={loupeOn}
                      onHoverAsset={handleHoverAsset}
                    />
                  </div>
                );
              })}
            </div>
          </div>
          {!loupeOn && selected.size === 0 && (
            <TimelineRail buckets={buckets} virtualizer={virtualizer} bucketFirstRowIndex={bucketFirstRowIndex} />
          )}
        </div>
        {loupeOn && <GridLoupePane assetId={hoveredAssetId} large={loupeLarge} />}
        {!loupeOn && metaOpen && <MetadataPanel selected={selectedAssets} onClose={onCloseMetadata} onEdit={commitEdit} />}
      </div>
      {openAsset && (
        <Viewer
          ref={viewerRef}
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
                  // from flatIds/assetById (see resolveVisibleStackAssets) - without this,
                  // openAsset would resolve to null on the next render and the
                  // viewer would fall back to the grid instead of following the
                  // pick. Chaining straight off the same await (no extra tick)
                  // keeps both state updates in one React batch.
                  setOpenId(assetId);
                }
              : undefined
          }
          onOpenApplicationsPreferences={onOpenApplicationsPreferences}
          onArtRoundTripQueued={(jobId) => trackArtJobs([jobId])}
          onProcessingSidecarCreated={markProcessingSidecar}
          onPrint={setPrintAsset}
          onAddToAlbum={(id) => setAddToAlbumTargets([id])}
          onAddToTag={(id) => setAddToTagTargets([id])}
          onHeadlessRoundtrip={(id) => requestBatchArtRoundTrip([id])}
          onExportToFolder={(a) => setExportFolderAssets([a])}
          onShareToFlickr={(a) => setExportFlickrAssets([a])}
          onSyncMetadata={(id) => syncMetadata([id], commitEdit).catch(() => {})}
          unsyncedMetadata={unsyncedMetadata}
          scannedForProcessingSidecar={scannedForProcessingSidecar}
        />
      )}
      {printAsset && <PrintDialog asset={printAsset} onClose={() => setPrintAsset(null)} />}
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
          message={`Paste image processing onto ${pasteProcessingTargets.length} photo${pasteProcessingTargets.length === 1 ? '' : 's'}? This replaces any existing ${
            copiedProcessingSource?.tools.map((t) => RAW_CONVERTER_LABEL[t]).join('/') || 'RAW-editor'
          } edits on each one.`}
          confirmLabel="Paste"
          onConfirm={confirmPasteImageProcessing}
          onClose={cancelPasteImageProcessing}
        />
      )}
      {batchArtTargets && (
        <ConfirmDialog
          title="Headless Roundtrip?"
          message={`Export ${batchArtTargets.length} photo${batchArtTargets.length === 1 ? '' : 's'} through ART-cli in the background, applying each one's own sidecar (if any) over your ART default profile?`}
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
          stackByAssetId={stackByAssetId}
        />
      )}
      {exportFolderAssets && (
        <ExportToFolderDialog assets={exportFolderAssets} onClose={() => setExportFolderAssets(null)} onExported={() => {}} />
      )}
      {exportFlickrAssets && (
        <ExportToFlickrDialog assets={exportFlickrAssets} onClose={() => setExportFlickrAssets(null)} onExported={() => {}} />
      )}
      {addToAlbumTargets && <AddToAlbumDialog assetIds={addToAlbumTargets} onClose={() => setAddToAlbumTargets(null)} />}
      {addToTagTargets && <AddToTagDialog assetIds={addToTagTargets} onClose={() => setAddToTagTargets(null)} />}
    </div>
  );
});

export default PhotosBrowser;

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

// Renders exactly one row of the flattened PhotoRow list - a month header, a
// day header, one row of asset tiles, or an expanded stack's band. Wrapped in
// memo() so that, unlike the old BucketContent/DayGroups (which relied on
// staying mounted across scroll ticks for their internal useMemo to pay off),
// a row that virtualizes in and out repeatedly - and every row's parent
// re-rendering on every scroll tick regardless - doesn't redo any work as
// long as its own `row` object and the handful of callback props are
// referentially stable, which they are (`rows` only changes when the
// underlying data/columns/expanded-stacks actually do; the callbacks are all
// useCallback-wrapped in PhotosBrowser).
const PhotoRowView = memo(function PhotoRowView({
  row,
  bucket,
  columns,
  selected,
  onToggleSelect,
  onToggleOne,
  onOpen,
  onContextMenu,
  onToggleStackExpand,
  onUnstack,
  onSetPick,
  onRate,
  resolveAsset,
  loupeMode,
  onHoverAsset,
}: {
  row: PhotoRow;
  bucket: TimeBucketInfo;
  columns: number;
  selected: Set<string>;
  onToggleSelect: (id: string, mods: ClickMods) => void;
  onToggleOne: (id: string) => void;
  onOpen: (id: string) => void;
  onContextMenu: (id: string, x: number, y: number) => void;
  onToggleStackExpand: (stackId: string) => void;
  onUnstack: (stackId: string, memberIds: string[]) => Promise<void>;
  onSetPick: (stackId: string, assetId: string, memberIds: string[]) => Promise<void>;
  onRate: (assetId: string, rating: number) => Promise<void>;
  resolveAsset: (id: string) => AssetSummary | undefined;
  loupeMode: boolean;
  onHoverAsset: (id: string | null) => void;
}) {
  switch (row.kind) {
    case 'loading': {
      const monthLabel = parseCalendarDate(bucket.timeBucket).toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
      return (
        <div style={{ paddingTop: MONTH_TOP_PADDING }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-dim)', marginBottom: 10 }}>
            {monthLabel} <span style={{ color: 'var(--text-dimmer)', fontWeight: 400 }}>· {bucket.count}</span>
          </div>
          <div style={{ color: 'var(--text-dimmer)', fontSize: 12.5 }}>Loading…</div>
        </div>
      );
    }
    case 'month': {
      const monthLabel = parseCalendarDate(bucket.timeBucket).toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
      return (
        <div style={{ paddingTop: MONTH_TOP_PADDING, fontSize: 13, fontWeight: 700, color: 'var(--text-dim)' }}>
          {monthLabel} <span style={{ color: 'var(--text-dimmer)', fontWeight: 400 }}>· {bucket.count}</span>
        </div>
      );
    }
    case 'day':
      return (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '14px 2px 10px', color: 'var(--text)' }}>
          <span style={{ fontSize: 13.5, fontWeight: 700 }}>{row.dayLabel}</span>
          <span style={{ fontSize: 12, color: 'var(--text-dimmer)' }}>
            {row.place ? `${row.place} · ` : ''}
            {row.count}
          </span>
        </div>
      );
    case 'assets':
      // `gap` only spaces items apart *within* a grid, but each row here is
      // its own single-row grid (one per virtualized row) - the actual
      // vertical gap before the next row instead has to come from this row's
      // own rendered (and therefore measured) height, hence the real
      // paddingBottom rather than relying on `gap` for it. Must match the
      // GRID_GAP baked into `assetRowHeight`'s estimate above, or the
      // virtualizer's measured height won't agree with what it guessed and
      // rows will visibly snap together/apart on the next remeasure.
      return (
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${columns}, 1fr)`, gap: GRID_GAP, paddingBottom: GRID_GAP }}>
          {row.items.map((a) => (
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
              loupeMode={loupeMode}
              onHoverAsset={onHoverAsset}
            />
          ))}
        </div>
      );
    case 'stackband':
      // paddingBottom (not margin) for the same reason as the 'assets' case
      // above: this row's real vertical gap to whatever follows has to come
      // from its own rendered height, matched to GRID_GAP like every other
      // row kind - StackBand itself no longer carries its own margin, so an
      // expanded stack doesn't sit noticeably tighter against its neighbors
      // than a plain asset row does.
      return (
        <div style={{ paddingBottom: GRID_GAP }}>
          <StackBand
            stackId={row.stackId}
            selected={selected}
            onSelectMember={(id) => onToggleSelect(id, { shiftKey: false, ctrlKey: false, metaKey: false })}
            onOpen={onOpen}
            onCollapse={() => onToggleStackExpand(row.stackId)}
            onUnstack={(memberIds) => onUnstack(row.stackId, memberIds)}
            onSetPick={(assetId, memberIds) => onSetPick(row.stackId, assetId, memberIds)}
            onRate={onRate}
            onContextMenu={onContextMenu}
            resolveAsset={resolveAsset}
            loupeMode={loupeMode}
            onHoverAsset={onHoverAsset}
          />
        </div>
      );
  }
});

