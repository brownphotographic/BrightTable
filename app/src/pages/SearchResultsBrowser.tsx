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

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  deleteAssets,
  RAW_CONVERTER_LABEL,
  searchAssets,
  updateAssetMetadata,
  type AssetMetadataPatch,
  type AssetSummary,
  type EditJob,
  type MetadataEditTarget,
} from '../lib/api';
import { useStacking } from '../lib/useStacking';
import { copyImageProcessingEntry, useAssetActions } from '../lib/useAssetActions';
import { type MenuAction } from '../lib/actionMenu';
import { resolveVisibleStackAssets } from '../lib/stacks';
import { isRawAsset, isVideoAsset } from '../lib/filters';
import AssetTile, { type ClickMods } from '../components/AssetTile';
import SelectionBar from '../components/SelectionBar';
import StackBand from '../components/StackBand';
import SmartStackDialog from '../components/SmartStackDialog';
import ContextMenu, { DIVIDER, type ContextMenuEntry } from '../components/ContextMenu';
import AddToAlbumDialog from '../components/AddToAlbumDialog';
import AddToTagDialog from '../components/AddToTagDialog';
import { TAG_ASSIGN_DISABLED_REASON } from '../lib/featureFlags';
import ExportToFolderDialog from '../components/ExportToFolderDialog';
import ExportToFlickrDialog from '../components/ExportToFlickrDialog';
import MetadataPanel from '../components/MetadataPanel';
import ConfirmDialog from '../components/ConfirmDialog';
import InlineWarningBanner from '../components/InlineWarningBanner';
import Viewer from '../components/Viewer';
import { isTypingTarget, matchesShortcut, useShortcuts, type ShortcutId } from '../lib/shortcuts';
import { useEditQueue } from '../lib/editQueue';
import { useEditJobReconciliation } from '../lib/useEditJobReconciliation';

// See PhotosBrowser.tsx/FoldersBrowser.tsx/AlbumsBrowser.tsx's identical helper.
function prevValuesFor(asset: AssetSummary | undefined, patch: AssetMetadataPatch): Partial<AssetSummary> {
  const prev: Partial<AssetSummary> = {};
  if (patch.rating !== undefined) prev.rating = asset?.rating ?? null;
  if (patch.isFavorite !== undefined) prev.isFavorite = asset?.isFavorite ?? false;
  if (patch.description !== undefined) prev.description = asset?.description ?? null;
  return prev;
}

export interface SearchResultsBrowserHandle {
  openExportToFolder: () => void;
  openExportToFlickr: () => void;
  selectAll: () => void;
  deselectAll: () => void;
  stackSelected: () => void;
  openSmartStack: () => void;
  syncAllUnsyncedMetadata: () => void;
  copyImageProcessing: () => void;
  pasteImageProcessing: () => void;
  copyMetadata: () => void;
  pasteMetadata: () => void;
  rotateLeft: () => void;
  rotateRight: () => void;
}

// See AlbumsBrowser.tsx/PeopleBrowser.tsx's identical constant/comment - a
// smart-search hit list is fetched up front too (up to 4000 assets across
// search_paginated's page cap), so this windows it the same way for the same
// reason: mounting every AssetTile at once could peg the webview's render
// thread and freeze the whole single-page app, not just this tab - which is
// exactly what made typing a follow-up search feel laggy on a large result set.
const SEARCH_GRID_CHUNK_SIZE = 60;

// Real Immich search (POST /search/smart, Immich's own natural-language
// "smart search") - a flat results grid replacing whichever tab was showing
// (see App.tsx), not a tab of its own. Closest in shape to a collection
// detail view (Albums/People/Tags) since it's "here's a flat list of
// assets, let me browse/select/edit them" - reuses that exact plumbing -
// but there's no underlying collection to add/remove-from, so unlike those
// there's no Rename/Delete-the-collection concept and no "Remove from X"
// selection-bar action, just the plain Photos/Folders-style Move to Trash.
const SearchResultsBrowser = forwardRef<SearchResultsBrowserHandle, {
  query: string;
  metaOpen: boolean;
  onCloseMetadata: () => void;
  onClose: () => void;
  active?: boolean;
}>(function SearchResultsBrowser({ query, metaOpen, onCloseMetadata, onClose, active = true }, ref) {
  const [assets, setAssets] = useState<AssetSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [enqueueError, setEnqueueError] = useState<string | null>(null);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const lastClickedId = useRef<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; assetId: string } | null>(null);
  const [confirmDeleteSelection, setConfirmDeleteSelection] = useState(false);
  const [smartStackOpen, setSmartStackOpen] = useState(false);
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
    busy: stackBusy,
  } = useStacking(selected, setSelected);
  const [addToAlbumTargets, setAddToAlbumTargets] = useState<string[] | null>(null);
  const [addToTagTargets, setAddToTagTargets] = useState<string[] | null>(null);
  const [exportFolderAssets, setExportFolderAssets] = useState<AssetSummary[] | null>(null);
  const [exportFlickrAssets, setExportFlickrAssets] = useState<AssetSummary[] | null>(null);
  const { shortcuts, capturing } = useShortcuts();
  // Copy/Paste Image Processing/Metadata, Sync Metadata from Sidecar, Show in
  // File Manager, and batch Rotate - shared with every other photo-grid page
  // via useAssetActions.ts. Headless Roundtrip/Tweak Roundtrip/Open in Ext.
  // Editor deliberately stay Photos/Folders-only (RAW-workflow concepts, see
  // the plan) - not offered here.
  const {
    unsyncedMetadata,
    processingSidecarAssets,
    scannedForProcessingSidecar,
    scanUnsyncedMetadata,
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

  useEffect(() => {
    setAssets(null);
    setError(null);
    setSelected(new Set());
    searchAssets(query)
      .then((results) => {
        setAssets(results);
        scanUnsyncedMetadata(results);
      })
      .catch((e) => setError(String(e)));
  }, [query, scanUnsyncedMetadata]);

  // Cross-references stack membership onto this search's results - see
  // useStacking and PhotosBrowser.tsx's identical note.
  // resolveVisibleStackAssets then keeps a stack's non-pick members out of
  // the grid/selection/keynav, while assetByIdAll below still resolves them
  // by id for StackBand/Viewer/context-menu targets.
  const overlaidAssets = useMemo(
    () =>
      (assets ?? []).map((a) => ({
        ...a,
        stack: stackByAssetId.get(a.id) ?? null,
        unsyncedMetadata: unsyncedMetadata.get(a.id),
        hasProcessingSidecar: processingSidecarAssets.has(a.id),
      })),
    [assets, stackByAssetId, unsyncedMetadata, processingSidecarAssets],
  );
  const visibleAssets = useMemo(() => resolveVisibleStackAssets(overlaidAssets), [overlaidAssets]);

  const assetById = useMemo(() => {
    const map = new Map<string, AssetSummary>();
    for (const a of visibleAssets) map.set(a.id, a);
    return map;
  }, [visibleAssets]);

  const assetByIdAll = useMemo(() => {
    const map = new Map<string, AssetSummary>();
    for (const a of overlaidAssets) map.set(a.id, a);
    return map;
  }, [overlaidAssets]);

  const flatIds = useMemo(() => visibleAssets.map((a) => a.id), [visibleAssets]);

  const assetChunks = useMemo(() => {
    const chunks: AssetSummary[][] = [];
    for (let i = 0; i < visibleAssets.length; i += SEARCH_GRID_CHUNK_SIZE) {
      chunks.push(visibleAssets.slice(i, i + SEARCH_GRID_CHUNK_SIZE));
    }
    return chunks;
  }, [visibleAssets]);

  const gridContainerRef = useRef<HTMLDivElement>(null);
  const gridVirtualizer = useVirtualizer({
    count: assetChunks.length,
    getScrollElement: () => gridContainerRef.current,
    // A rough guess (~6 columns of 3:2 tiles) - corrected per-chunk once it
    // actually renders via virtualizer.measureElement, same as Albums'/
    // People's chunk virtualizers.
    estimateSize: () => Math.ceil(SEARCH_GRID_CHUNK_SIZE / 6) * 124,
    overscan: 2,
  });

  useEffect(() => {
    // A new query's chunk heights have nothing to do with the previous one's -
    // avoid rendering a window sized off stale estimates.
    gridVirtualizer.measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  // assetByIdAll (not assetById) so selecting a non-pick stack member from
  // StackBand still resolves here - see PhotosBrowser.tsx's identical note.
  const selectedAssets = useMemo(
    () => [...selected].map((id) => assetByIdAll.get(id)).filter((a): a is AssetSummary => !!a),
    [selected, assetByIdAll],
  );
  const allSelectedFavorited = selectedAssets.length > 0 && selectedAssets.every((a) => a.isFavorite);

  const patchAssetLocal = useCallback((id: string, patch: Partial<AssetSummary>) => {
    setAssets((all) => {
      if (!all) return all;
      const idx = all.findIndex((x) => x.id === id);
      if (idx === -1) return all;
      const next = all.slice();
      next[idx] = { ...next[idx], ...patch };
      return next;
    });
  }, []);

  const removeAssetsLocal = useCallback((ids: string[]) => {
    const idSet = new Set(ids);
    setAssets((all) => (all ? all.filter((x) => !idSet.has(x.id)) : all));
    setSelected((s) => {
      if (![...idSet].some((id) => s.has(id))) return s;
      const next = new Set(s);
      for (const id of idSet) next.delete(id);
      return next;
    });
    setOpenId((cur) => (cur && idSet.has(cur) ? null : cur));
  }, []);

  // See FoldersBrowser.tsx's identical setup for the full explanation - the
  // same optimistic-edit-with-rollback machinery every other view uses.
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

  const commitEdit = useCallback(
    async (id: string, patch: AssetMetadataPatch) => {
      const originalPath = assetById.get(id)?.originalPath ?? null;
      const prevValues = prevValuesFor(assetById.get(id), patch);
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
    [patchAssetLocal, assetById, trackJobs],
  );

  const commitEditMany = useCallback(
    async (ids: string[], patch: AssetMetadataPatch) => {
      const targets: MetadataEditTarget[] = ids.map((id) => ({ id, originalPath: assetById.get(id)?.originalPath ?? null }));
      const prevByAsset = new Map(ids.map((id) => [id, prevValuesFor(assetById.get(id), patch)]));
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
    [patchAssetLocal, assetById, trackJobs],
  );

  const toggleFavoriteForSelection = useCallback(() => {
    if (selected.size === 0) return;
    commitEditMany([...selected], { isFavorite: !allSelectedFavorited }).catch(() => {});
  }, [selected, allSelectedFavorited, commitEditMany]);

  // Immich trashes a stack as one atomic unit - see PhotosBrowser.tsx's
  // identical removeAssets for the full explanation.
  const trashAssets = useCallback(
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
  // assetByIdAll so opening a non-pick stack member (StackBand's onOpen)
  // still resolves - see PhotosBrowser.tsx's identical note.
  const openAsset = openId ? assetByIdAll.get(openId) ?? null : null;
  const stripAssets = useMemo(
    () => flatIds.map((id) => assetById.get(id)).filter((a): a is AssetSummary => !!a),
    [flatIds, assetById],
  );

  const selectAll = useCallback(() => setSelected(new Set(flatIds)), [flatIds]);
  const deselectAll = useCallback(() => setSelected(new Set()), []);

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

  const navigateOpen = (dir: 1 | -1) => {
    const ni = openIndex + dir;
    if (ni < 0 || ni >= flatIds.length) return;
    setOpenId(flatIds[ni]);
  };

  // Ordered into logical groups - Organize / Stacking / Edit / Copy-Paste /
  // Utility / Destructive - matching SelectionBar's own group order and
  // AlbumsBrowser.tsx/PhotosBrowser.tsx's identical restructure, with
  // DIVIDER between groups.
  const contextMenuItems: ContextMenuEntry[] = useMemo(() => {
    if (!contextMenu) return [];
    // assetByIdAll (not assetById) so a right-click forwarded from inside an
    // expanded StackBand still resolves - see PhotosBrowser.tsx's identical
    // note.
    const asset = assetByIdAll.get(contextMenu.assetId);
    const targetIds = selected.size >= 2 ? [...selected] : asset ? [asset.id] : [];
    const pasteTargetsIncludeRaw = targetIds.some((id) => {
      const a = assetByIdAll.get(id);
      return !!a && isRawAsset(a);
    });
    const items: ContextMenuEntry[] = [];

    // Organize
    if (targetIds.length > 0) {
      items.push({
        label: targetIds.length > 1 ? `Add ${targetIds.length} Photos to Album…` : 'Add to Album…',
        onClick: () => setAddToAlbumTargets(targetIds),
      });
      items.push({
        label: (targetIds.length > 1 ? `Add ${targetIds.length} Photos to Tag…` : 'Add to Tag…') + (TAG_ASSIGN_DISABLED_REASON ? ' (disabled)' : ''),
        onClick: () => setAddToTagTargets(targetIds),
        disabled: !!TAG_ASSIGN_DISABLED_REASON,
      });
    }
    items.push(DIVIDER);

    // Stacking
    if (selected.size >= 2) {
      items.push({ label: `Stack ${selected.size} Photos`, onClick: () => createStackForSelection([...selected]).catch(() => {}) });
      items.push({ label: `Smart Stack ${selected.size} Photos`, onClick: () => setSmartStackOpen(true) });
    }
    if (asset?.stack) {
      items.push({ label: 'Unstack', onClick: () => unstackByStackId(asset.stack!.id).catch(() => {}) });
    }
    items.push(DIVIDER);

    // Edit - Rotate mirrors Viewer.tsx's single-open-asset gating, using
    // rotateSelection so this menu and SelectionBar's Edit ▾ share the same
    // batch-capable implementation.
    if (asset && targetIds.length <= 1 && asset.originalPath && !isVideoAsset(asset)) {
      items.push({ label: 'Rotate Left', onClick: () => rotateSelection([asset.id], false, assetByIdAll).catch(() => {}) });
      items.push({ label: 'Rotate Right', onClick: () => rotateSelection([asset.id], true, assetByIdAll).catch(() => {}) });
    }
    items.push(DIVIDER);

    // Copy/Paste
    if (asset) {
      const copyEntry = copyImageProcessingEntry(asset, scannedForProcessingSidecar, handleCopyImageProcessing);
      if (copyEntry) items.push(copyEntry);
    }
    if (copiedProcessingSource && pasteTargetsIncludeRaw) {
      items.push({
        label: targetIds.length > 1 ? `Paste Image Processing to ${targetIds.length} Photos` : 'Paste Image Processing',
        onClick: () => requestPasteImageProcessing(targetIds, assetByIdAll),
      });
    }
    if (asset) {
      items.push({ label: 'Copy Metadata', onClick: () => handleCopyMetadata(asset) });
    }
    if (copiedMetadata && targetIds.length > 0) {
      items.push({
        label: targetIds.length > 1 ? `Paste Metadata to ${targetIds.length} Photos` : 'Paste Metadata',
        onClick: () => handlePasteMetadata(targetIds, commitEditMany),
      });
    }
    items.push(DIVIDER);

    // Utility
    if (asset?.originalPath) {
      items.push({ label: 'Show in File Manager', onClick: () => handleShowInFileManager(asset) });
    }
    if (asset && unsyncedMetadata.has(asset.id)) {
      items.push({
        label: 'Sync Metadata from Sidecar',
        onClick: () => syncMetadata([asset.id], commitEdit).catch(() => {}),
      });
    }
    if (targetIds.length > 0) {
      const exportAssets = targetIds.map((id) => assetByIdAll.get(id)).filter((a): a is AssetSummary => !!a);
      items.push({ label: 'Export to Folder…', onClick: () => setExportFolderAssets(exportAssets) });
      items.push({ label: 'Share to Flickr…', onClick: () => setExportFlickrAssets(exportAssets) });
    }
    items.push(DIVIDER);

    // Destructive
    if (targetIds.length > 0) {
      items.push({
        label: targetIds.length > 1 ? `Move ${targetIds.length} Photos to Trash` : 'Move to Trash',
        onClick: () => trashAssets(targetIds).catch((e) => setEnqueueError(String(e))),
      });
    }
    return items;
  }, [
    contextMenu,
    assetByIdAll,
    selected,
    handleShowInFileManager,
    trashAssets,
    createStackForSelection,
    unstackByStackId,
    unsyncedMetadata,
    scannedForProcessingSidecar,
    syncMetadata,
    commitEdit,
    commitEditMany,
    copiedProcessingSource,
    copiedMetadata,
    handleCopyImageProcessing,
    handleCopyMetadata,
    handlePasteMetadata,
    requestPasteImageProcessing,
    rotateSelection,
  ]);

  // See PhotosBrowser.tsx's identical effect - right-clicking a RAW asset,
  // or plain-selecting exactly one (SelectionBar's own trigger for the same
  // button), that doesn't currently show Copy Image Processing live-rechecks
  // disk once. Without this, a sidecar created outside this view's own
  // tracked flows stays invisible - on both the context menu AND
  // SelectionBar - until the search is re-run.
  useEffect(() => {
    const candidateId = contextMenu?.assetId ?? (selected.size === 1 ? [...selected][0] : null);
    if (!candidateId) return;
    const asset = assetByIdAll.get(candidateId);
    if (!asset || !asset.originalPath || asset.hasProcessingSidecar || !isRawAsset(asset)) return;
    scanUnsyncedMetadata([asset], true);
  }, [contextMenu, selected, assetByIdAll, scanUnsyncedMetadata]);

  useImperativeHandle(
    ref,
    () => ({
      openExportToFolder: () => {
        const target = selectedAssets.length > 0 ? selectedAssets : openAsset ? [openAsset] : [];
        if (target.length > 0) setExportFolderAssets(target);
      },
      openExportToFlickr: () => {
        const target = selectedAssets.length > 0 ? selectedAssets : openAsset ? [openAsset] : [];
        if (target.length > 0) setExportFlickrAssets(target);
      },
      selectAll,
      deselectAll,
      stackSelected: () => {
        createStackForSelection([...selected]).catch(() => {});
      },
      openSmartStack: () => setSmartStackOpen(true),
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
      rotateLeft: () => {
        rotateSelection([...selected], false, assetByIdAll).catch(() => {});
      },
      rotateRight: () => {
        rotateSelection([...selected], true, assetByIdAll).catch(() => {});
      },
    }),
    [
      selectedAssets,
      openAsset,
      selectAll,
      deselectAll,
      createStackForSelection,
      selected,
      syncMetadata,
      unsyncedMetadata,
      commitEdit,
      handleCopyImageProcessing,
      requestPasteImageProcessing,
      assetByIdAll,
      handleCopyMetadata,
      handlePasteMetadata,
      commitEditMany,
      rotateSelection,
    ],
  );

  useEffect(() => {
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
      } else if (matchesShortcut(e, shortcuts.addToTag) && selected.size > 0 && !TAG_ASSIGN_DISABLED_REASON) {
        e.preventDefault();
        setAddToTagTargets([...selected]);
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
  }, [openId, active, selectAll, deselectAll, selected, shortcuts, capturing, commitEditMany, toggleFavoriteForSelection, setAddToTagTargets]);

  const canStack = selected.size >= 2;
  const canPasteImageProcessing =
    !!copiedProcessingSource &&
    [...selected].some((id) => {
      const a = assetByIdAll.get(id);
      return !!a && isRawAsset(a);
    });
  const selectionCanRotate = [...selected].some((id) => {
    const a = assetByIdAll.get(id);
    return !!a && !!a.originalPath && !isVideoAsset(a);
  });
  const unsyncedSelectedIds = [...selected].filter((id) => unsyncedMetadata.has(id));
  const copyImageProcessingBarEntry =
    selectedAssets.length === 1 ? copyImageProcessingEntry(selectedAssets[0], scannedForProcessingSidecar, handleCopyImageProcessing) : null;
  // No Headless Roundtrip/Tweak Roundtrip/Open in Ext. Editor here - see the
  // hook wiring comment above this page deliberately omits those RAW-
  // workflow-specific actions, unlike PhotosBrowser.tsx/FoldersBrowser.tsx.
  const selectionBarActions: MenuAction[] = [
    { id: 'addToTag', group: 'organize', label: 'Add to Tag', disabled: !!TAG_ASSIGN_DISABLED_REASON, disabledReason: TAG_ASSIGN_DISABLED_REASON ?? undefined, onClick: () => setAddToTagTargets([...selected]) },
    { id: 'addToAlbum', group: 'organize', label: 'Add to Album', onClick: () => setAddToAlbumTargets([...selected]) },
    { id: 'stack', group: 'stack', label: stackBusy ? 'Working…' : `Stack ${selected.size} Photos`, disabled: !canStack || stackBusy, onClick: () => createStackForSelection([...selected]).catch(() => {}) },
    { id: 'smartStack', group: 'stack', label: stackBusy ? 'Working…' : 'Smart Stack', disabled: !canStack || stackBusy, onClick: () => setSmartStackOpen(true) },
    { id: 'unstack', group: 'stack', label: stackBusy ? 'Working…' : 'Unstack', disabled: !hasStackedSelection || stackBusy, onClick: () => unstackSelection().catch((e) => setEnqueueError(String(e))) },
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
    // gating.
    {
      id: 'showInFileManager',
      group: 'more',
      label: 'Show in File Manager',
      disabled: selectedAssets.length !== 1 || !selectedAssets[0].originalPath,
      disabledReason: 'Select a single photo to show it in the file manager',
      onClick: () => handleShowInFileManager(selectedAssets[0]),
    },
    ...(unsyncedSelectedIds.length > 0
      ? [
          {
            id: 'syncMetadata',
            group: 'more' as const,
            label: 'Sync Metadata from Sidecar',
            onClick: () => syncMetadata(unsyncedSelectedIds, commitEdit).catch(() => {}),
          },
        ]
      : []),
    { id: 'moveToTrash', group: 'destructive', label: 'Move to Trash', onClick: () => setConfirmDeleteSelection(true) },
  ];

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, position: 'relative' }}>
      {enqueueError && <InlineWarningBanner message={enqueueError} onDismiss={() => setEnqueueError(null)} />}
      <div style={{ flexShrink: 0, height: 46, display: 'flex', alignItems: 'center', gap: 10, padding: '0 16px', borderBottom: '1px solid rgba(0,0,0,0.3)' }}>
        <div onClick={onClose} style={{ cursor: 'default', color: 'var(--accent)', fontSize: 13 }}>
          ✕ Close Search
        </div>
        <div style={{ width: 1, height: 18, background: 'var(--overlay-strong)' }} />
        <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>"{query}"</span>
        {assets && (
          <span style={{ fontSize: 12.5, color: 'var(--text-dimmer)' }}>
            {assets.length} result{assets.length === 1 ? '' : 's'}
          </span>
        )}
      </div>

      {selected.size > 0 && (
        // Overlaid below the fixed header, not in-flow - see
        // PhotosBrowser.tsx's identical comment for why: an in-flow bar
        // reflows the grid on the very click that first selects something,
        // so a following double-click's second click misses the tile it
        // started on.
        <div style={{ position: 'absolute', top: 46, left: 0, right: 0, zIndex: 5 }}>
          <SelectionBar
            count={selected.size}
            onCancel={deselectAll}
            onFavorite={toggleFavoriteForSelection}
            allFavorited={allSelectedFavorited}
            onRate={(rating) => commitEditMany([...selected], { rating }).catch(() => {})}
            actions={selectionBarActions}
          />
        </div>
      )}

      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <div ref={gridContainerRef} style={{ flex: 1, overflow: 'auto', minHeight: 0, padding: 16, background: 'var(--canvas)' }}>
          {error && <div style={{ color: 'var(--danger)', fontSize: 13 }}>Couldn't search — {error}.</div>}
          {!assets && !error && <div style={{ color: 'var(--text-dim)', fontSize: 13 }}>Searching…</div>}
          {assets && visibleAssets.length === 0 && !error && (
            <div style={{ color: 'var(--text-dimmer)', fontSize: 12.5 }}>No photos matched "{query}".</div>
          )}
          {assets && visibleAssets.length > 0 && (
            <div style={{ height: gridVirtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
              {gridVirtualizer.getVirtualItems().map((item) => (
                <div
                  key={item.key}
                  ref={gridVirtualizer.measureElement}
                  data-index={item.index}
                  style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${item.start}px)` }}
                >
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(168px, 1fr))', gap: 12, paddingBottom: 12 }}>
                    {assetChunks[item.index].map((a) => {
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
                </div>
              ))}
            </div>
          )}
        </div>
        {metaOpen && <MetadataPanel selected={selectedAssets} onClose={onCloseMetadata} onEdit={commitEdit} />}
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
          onDelete={(id) => trashAssets([id])}
          onUnstack={openAsset.stack ? () => unstackByStackId(openAsset.stack!.id).catch(() => {}) : undefined}
          onAddToAlbum={(id) => setAddToAlbumTargets([id])}
          onAddToTag={(id) => setAddToTagTargets([id])}
          onExportToFolder={(a) => setExportFolderAssets([a])}
          onShareToFlickr={(a) => setExportFlickrAssets([a])}
          onSyncMetadata={(id) => syncMetadata([id], commitEdit).catch(() => {})}
          unsyncedMetadata={unsyncedMetadata}
          scannedForProcessingSidecar={scannedForProcessingSidecar}
        />
      )}
      {smartStackOpen && (
        <SmartStackDialog
          candidateAssets={selectedAssets}
          onClose={() => setSmartStackOpen(false)}
          onApply={applySmartStackGroups}
          stackByAssetId={stackByAssetId}
        />
      )}
      {contextMenu && <ContextMenu x={contextMenu.x} y={contextMenu.y} items={contextMenuItems} onClose={() => setContextMenu(null)} />}
      {confirmDeleteSelection && (
        <ConfirmDialog
          title="Move to trash?"
          message={`This moves ${selected.size} photo${selected.size === 1 ? '' : 's'} to Immich's trash. You can restore them from Trash later.`}
          confirmLabel="Move to Trash"
          onConfirm={() => trashAssets([...selected])}
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
      {addToAlbumTargets && <AddToAlbumDialog assetIds={addToAlbumTargets} onClose={() => setAddToAlbumTargets(null)} />}
      {addToTagTargets && <AddToTagDialog assetIds={addToTagTargets} onClose={() => setAddToTagTargets(null)} />}
      {exportFolderAssets && (
        <ExportToFolderDialog assets={exportFolderAssets} onClose={() => setExportFolderAssets(null)} onExported={() => {}} />
      )}
      {exportFlickrAssets && (
        <ExportToFlickrDialog assets={exportFlickrAssets} onClose={() => setExportFlickrAssets(null)} onExported={() => {}} />
      )}
    </div>
  );
});

export default SearchResultsBrowser;
