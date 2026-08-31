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

import { forwardRef, useCallback, useDeferredValue, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { retryOnVaultReady } from '../lib/vaultReadyRetry';
import {
  batchRawCliRoundTrip,
  deleteAssets,
  getFolderAssets,
  getFolderPaths,
  launchRawCliRoundTrip,
  launchEditor,
  RAW_CONVERTER_LABEL,
  updateAssetMetadata,
  type ArtJob,
  type ArtRoundTripTarget,
  type AssetMetadataPatch,
  type AssetSummary,
  type EditJob,
} from '../lib/api';
import { useStacking } from '../lib/useStacking';
import { buildFolderTree, collectAssetPaths, findFolderNode, type FolderNode } from '../lib/folderTree';
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
import ConfirmDialog from '../components/ConfirmDialog';
import NoSidecarDialog from '../components/NoSidecarDialog';
import InlineWarningBanner from '../components/InlineWarningBanner';
import { isTypingTarget, matchesShortcut, useShortcuts, type ShortcutId } from '../lib/shortcuts';
import { isRawAsset, isRoundTripEligible, isVideoAsset, matchesFilters, type Filters } from '../lib/filters';
import { resolveVisibleStackAssets } from '../lib/stacks';
import { useRawOverrides } from '../lib/rawOverrides';
import { useApplications } from '../lib/applications';
import { copyImageProcessingEntry, useAssetActions } from '../lib/useAssetActions';
import { type MenuAction } from '../lib/actionMenu';
import { pendingStyle } from '../lib/pending';
import { useEditQueue } from '../lib/editQueue';
import { useEditJobReconciliation } from '../lib/useEditJobReconciliation';
import { useArtQueue } from '../lib/artQueue';
import { useArtJobReconciliation } from '../lib/useArtJobReconciliation';
import { useBucketMemo } from '../lib/bucketMemo';
import { ingestRoundTripExport, subscribeLateRoundTripOutcome, type RoundTripIngestOutcome } from '../lib/roundTrip';
import { useNoSidecarChoice } from '../lib/useNoSidecarChoice';
import { centerAssetInContainerSoon } from '../lib/scrollCenter';

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
  rotateLeft: () => void;
  rotateRight: () => void;
  openExportToFolder: () => void;
  openExportToFlickr: () => void;
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
  // Grid thumbnail size - controlled from MenuBar's slider (App.tsx owns
  // the state) since it moved out of this view's own bottom status bar.
  thumbSize: number;
  // Grid loupe mode - see PhotosBrowser.tsx's identical prop for the full
  // explanation. App.tsx owns the boolean, shared across both grid views.
  loupeOn: boolean;
  onToggleLoupe: () => void;
  // Loupe circle size - set in Preferences → Configuration → Window
  // ("Thumbnail Loupe Size"). Only meaningful while loupeOn.
  loupeLarge: boolean;
}>(function FoldersBrowser({ metaOpen, onCloseMetadata, filters, onOpenApplicationsPreferences, active = true, thumbSize, loupeOn, onToggleLoupe, loupeLarge }, ref) {
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
  // Lets rotateLeft/rotateRight (Edit menu) reach the currently-open Viewer
  // - null whenever nothing's open, since <Viewer> below is only mounted at
  // all when openAsset exists.
  const viewerRef = useRef<ViewerHandle>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // See PhotosBrowser.tsx's identical state/effect/ref - which tile the
  // cursor is currently over while loupeOn, driving GridLoupePane's preview
  // (cleared on loupe off), plus a never-cleared mirror ref used only to
  // re-center the grid on that tile at the instant loupeOn toggles.
  const [hoveredAssetId, setHoveredAssetId] = useState<string | null>(null);
  useEffect(() => {
    if (!loupeOn) setHoveredAssetId(null);
  }, [loupeOn]);
  const lastHoveredAssetId = useRef<string | null>(null);
  const handleHoverAsset = useCallback((id: string | null) => {
    if (id) lastHoveredAssetId.current = id;
    setHoveredAssetId(id);
  }, []);
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !lastHoveredAssetId.current) return;
    centerAssetInContainerSoon(container, lastHoveredAssetId.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loupeOn]);
  const lastClickedId = useRef<string | null>(null);
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

  // See `vaultReadyRetry.ts` - same startup race as `PhotosBrowser`'s
  // timeline fetch.
  useEffect(() => {
    let cancelled = false;
    function load() {
      getFolderPaths()
        .then((paths) => {
          if (cancelled) return;
          setFolderPaths(paths);
          const tree = buildFolderTree(paths);
          if (tree.children.length === 1) setExpandedPaths({ [tree.children[0].path]: true });
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
        applyStackInfo(memberIds, info);
      }
      // Tracks the rating/favorite/description copy roundTrip.ts's
      // finishIngest already enqueued onto the EditQueue - see
      // PhotosBrowser.tsx's identical registration for the full explanation.
      for (const jobId of outcome.metadataJobIds) {
        rollbackById.current.set(jobId, { id: outcome.asset.id, prevValues: outcome.metadataPrevValues });
      }
      trackJobs(outcome.metadataJobIds);
      const original = outcome.original;
      scanUnsyncedMetadata([original]);
    },
    [addAssetLocal, trackJobs, applyStackInfo, scanUnsyncedMetadata],
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
      await dissolveAndRestackMany([...stackIdsTouched], idSet);
      await deleteAssets(ids, false);
      removeAssetsLocal(ids);
    },
    [removeAssetsLocal, stackByAssetId, dissolveAndRestackMany],
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

  // See PhotosBrowser.tsx's identical callback for the full explanation -
  // launch-only, single-asset, redirects to Preferences when unconfigured,
  // branches to the ART CLI round trip when rawRoundTripEnabled.
  const { applications, activeRawEditorApp, rawRoundTripEnabled } = useApplications();
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
      await launchEditor(asset.originalPath, choice);
    },
    [selectedAssets, applications, activeRawEditorApp, rawRoundTripEnabled, onOpenApplicationsPreferences, resolveArtRoundTripOutcome, trackArtJobs],
  );

  // Headless RAW Roundtrip (ART CLI round trip Variant 2) - see
  // PhotosBrowser.tsx's identical setup for the full explanation.
  // artJobs/reconcileArtJob/trackArtJobs (shared with Variant 1's own launch
  // above) are declared earlier, before launchEditorForSelection.
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
    // since batch_raw_cli_round_trip itself still re-checks each target's
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
  // `resolveVisibleStackAssets`) still resolves instead of silently rendering an
  // empty menu - same fix `Viewer.tsx`'s peek architecture already needed
  // for the identical structural reason (§7.16).
  // Ordered into logical groups - Organize / Stacking / Edit / Copy-Paste /
  // Utility / Destructive - matching SelectionBar's own group order
  // (primary/stack/edit/copyPaste/more/destructive) so the two surfaces
  // agree on where a given action "lives", with DIVIDER between groups
  // (ContextMenu.tsx collapses one away if the group on either side of it
  // ended up empty). Previously this grew in whatever order features were
  // added over time, which read as arbitrary - see PhotosBrowser.tsx's
  // identical restructure.
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

  // See PhotosBrowser.tsx's identical effect for the full explanation -
  // right-clicking a RAW asset, or plain-selecting exactly one (SelectionBar's
  // own trigger for the same button), that doesn't currently show Copy Image
  // Processing live-rechecks disk once, covering sidecars created outside
  // this view's own tracked flows (an external ART/RawTherapee run, or a
  // paste that happened in the Photos view, which keeps its own separate
  // processingSidecarAssets cache). Previously context-menu-only, which left
  // SelectionBar showing a stale cache for the identical single selection.
  useEffect(() => {
    const candidateId = contextMenu?.assetId ?? (selected.size === 1 ? [...selected][0] : null);
    if (!candidateId) return;
    const asset = assetByIdAll.get(candidateId);
    if (!asset || !asset.originalPath || asset.hasProcessingSidecar || !isRawAsset(asset)) return;
    scanUnsyncedMetadata([asset], true);
  }, [contextMenu, selected, assetByIdAll, scanUnsyncedMetadata]);

  const navigateOpen = (dir: 1 | -1) => {
    const ni = openIndex + dir;
    if (ni < 0 || ni >= flatIds.length) return;
    setOpenId(flatIds[ni]);
  };

  const selectAll = useCallback(() => setSelected(new Set(flatIds)), [flatIds]);
  const deselectAll = useCallback(() => setSelected(new Set()), []);

  // See PhotosBrowser.tsx's identical effect - loupe mode is browse-only.
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
      // Rotate only ever acts on whichever photo is actually open in the
      // Viewer (see PhotosBrowser's identical rotateLeft/rotateRight) -
      // silent no-op whenever the Viewer isn't currently mounted.
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
      commitEdit,
      commitEditMany,
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
    // See PhotosBrowser.tsx's identical guard - also skipped while inactive
    // (kept mounted but hidden behind another tab), otherwise this keeps
    // consuming checkSidecarMetadata's shared, concurrency-limited permit
    // pool for a tab nobody's looking at, starving out permits for whichever
    // tab is actually in front of the user.
    if (!active) return;
    for (const item of virtualizer.getVirtualItems()) {
      const key = activeBucketKeys[item.index];
      if (!key || assetCache[key] || inFlight.current.has(key)) continue;
      inFlight.current.add(key);
      getFolderAssets(key)
        .then((assets) => {
          setAssetCache((c) => ({ ...c, [key]: assets }));
          scanUnsyncedMetadata(assets);
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
        {!loupeOn && (
          <div style={{ width: 208, flexShrink: 0, borderRight: '1px solid rgba(0,0,0,0.35)', padding: '10px 8px', overflow: 'auto', background: 'var(--canvas)' }}>
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
        )}

        <div ref={containerRef} style={{ flex: loupeOn ? '0 0 33.333%' : 1, overflow: 'auto', minHeight: 0, padding: 16, background: 'var(--canvas)', ...pendingStyle(isFiltering) }}>
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
                                loupeMode={loupeOn}
                                onHoverAsset={handleHoverAsset}
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
                              loupeMode={loupeOn}
                              onHoverAsset={handleHoverAsset}
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
                  // See PhotosBrowser.tsx's identical handler for why setOpenId
                  // is chained straight off this await.
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
        color: selected ? 'var(--accent-text)' : 'var(--text-dim)',
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
            color: 'var(--text-dim)',
          }}
        />
      </div>
      <div style={{ width: 15, height: 12, borderRadius: 2.5, background: 'var(--overlay-strong)', flexShrink: 0 }} />
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
