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

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type CSSProperties } from 'react';
import { retryOnVaultReady } from '../lib/vaultReadyRetry';
import {
  createTag,
  deleteAssets,
  deleteTag,
  getTag,
  listTags,
  RAW_CONVERTER_LABEL,
  untagAssets,
  updateAssetMetadata,
  type AssetMetadataPatch,
  type AssetSummary,
  type EditJob,
  type MetadataEditTarget,
  type TagDetail,
  type TagSummary,
} from '../lib/api';
import { useStacking } from '../lib/useStacking';
import { copyImageProcessingEntry, useAssetActions } from '../lib/useAssetActions';
import { type MenuAction } from '../lib/actionMenu';
import { isRawAsset, isVideoAsset } from '../lib/filters';
import { resolveVisibleStackAssets } from '../lib/stacks';
import AssetTile, { type ClickMods } from '../components/AssetTile';
import GridLoupePane from '../components/GridLoupePane';
import SelectionBar from '../components/SelectionBar';
import StackBand from '../components/StackBand';
import SmartStackDialog from '../components/SmartStackDialog';
import ContextMenu, { DIVIDER, type ContextMenuEntry } from '../components/ContextMenu';
import AddToAlbumDialog from '../components/AddToAlbumDialog';
import AddToTagDialog, { TAG_COLORS } from '../components/AddToTagDialog';
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
import { centerAssetInContainerSoon } from '../lib/scrollCenter';

// See PhotosBrowser.tsx/FoldersBrowser.tsx/AlbumsBrowser.tsx's identical helper.
function prevValuesFor(asset: AssetSummary | undefined, patch: AssetMetadataPatch): Partial<AssetSummary> {
  const prev: Partial<AssetSummary> = {};
  if (patch.rating !== undefined) prev.rating = asset?.rating ?? null;
  if (patch.isFavorite !== undefined) prev.isFavorite = asset?.isFavorite ?? false;
  if (patch.description !== undefined) prev.description = asset?.description ?? null;
  return prev;
}

export interface TagsBrowserHandle {
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

// Real Immich tags (GET/POST/DELETE /tags, PUT/DELETE /tags/{id}/assets) -
// closest in shape to AlbumsBrowser.tsx (tag membership is user-editable,
// so Delete means Remove from Tag here too, not Move to Trash like
// PeopleBrowser), with two differences: no rename (Immich's PUT /tags/{id}
// accepts only `color`, not `name` - there's no rename-tag endpoint at
// all), and the list view is a flat list of colored pills rather than a
// grid of cover-thumbnail cards, since Immich exposes no per-tag asset
// count or thumbnail (unlike Albums' assetCount/albumThumbnailAssetId or
// People's /statistics fan-out) - showing counts here would mean firing a
// full /search/metadata call per tag on every list load.
const TagsBrowser = forwardRef<TagsBrowserHandle, {
  metaOpen: boolean;
  onCloseMetadata: () => void;
  // Number of tags, for the sidebar row - only meaningful in the list view.
  onCount?: (n: number) => void;
  active?: boolean;
  // Grid loupe mode - see PhotosBrowser.tsx's identical prop for the full
  // explanation. App.tsx owns the boolean, shared across every grid view.
  loupeOn: boolean;
  onToggleLoupe: () => void;
  // Loupe circle size - set in Preferences → Configuration → Window
  // ("Thumbnail Loupe Size"). Only meaningful while loupeOn.
  loupeLarge: boolean;
  // Grid thumbnail size, in px - shared across every grid view. See
  // App.tsx's `thumbSize` state and MenuBar's slider.
  thumbSize: number;
}>(function TagsBrowser({
  metaOpen,
  onCloseMetadata,
  onCount,
  active = true,
  loupeOn,
  onToggleLoupe,
  loupeLarge,
  thumbSize,
}, ref) {
  const [tags, setTags] = useState<TagSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [tagSearch, setTagSearch] = useState('');
  const [newTagName, setNewTagName] = useState('');
  const [newTagColor, setNewTagColor] = useState<string | null>(null);
  const [creatingTag, setCreatingTag] = useState(false);
  const [confirmDeleteTag, setConfirmDeleteTag] = useState<TagSummary | null>(null);
  // Bulk-select state for the list view - separate from `selected` below
  // (that one is asset selection inside a tag's detail view; this one is
  // tag selection in the list view, a different domain entirely).
  const [selectedTagIds, setSelectedTagIds] = useState<Set<string>>(new Set());
  const [confirmDeleteSelectedTags, setConfirmDeleteSelectedTags] = useState(false);

  const [openTagId, setOpenTagId] = useState<string | null>(null);
  const [tag, setTag] = useState<TagDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [enqueueError, setEnqueueError] = useState<string | null>(null);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const lastClickedId = useRef<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; assetId: string } | null>(null);
  const [confirmDeleteSelection, setConfirmDeleteSelection] = useState(false);
  const [confirmRemoveSelection, setConfirmRemoveSelection] = useState(false);
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
  // See FoldersBrowser.tsx's identical state/effect/ref - which tile the
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
  const gridContainerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = gridContainerRef.current;
    if (!container || !lastHoveredAssetId.current) return;
    centerAssetInContainerSoon(container, lastHoveredAssetId.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loupeOn]);
  const [addToAlbumTargets, setAddToAlbumTargets] = useState<string[] | null>(null);
  const [addToTagTargets, setAddToTagTargets] = useState<string[] | null>(null);
  const [exportFolderAssets, setExportFolderAssets] = useState<AssetSummary[] | null>(null);
  const [exportFlickrAssets, setExportFlickrAssets] = useState<AssetSummary[] | null>(null);
  // Copy/Paste Image Processing/Metadata, Sync Metadata from Sidecar, Show in
  // File Manager, and batch Rotate - shared with every other photo-grid page
  // via useAssetActions.ts. Called here (before overlaidAssets below) since
  // that overlay needs unsyncedMetadata/processingSidecarAssets - see the
  // hook's own doc comment for why.
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
  const { shortcuts, capturing } = useShortcuts();

  const refreshTagList = useCallback(() => {
    listTags()
      .then((t) => {
        setTags(t);
        onCount?.(t.length);
        setListError(null);
      })
      .catch((e) => setListError(String(e)));
    // onCount's identity changing on re-renders shouldn't retrigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    refreshTagList();
  }, [refreshTagList]);

  // See `vaultReadyRetry.ts` - the fetch above can fire and fail with "No
  // API key configured" before the credential vault has actually opened.
  useEffect(() => retryOnVaultReady(refreshTagList), [refreshTagList]);

  // Re-fetches the tag list whenever navigating back from a detail view -
  // deleting the open tag from within it should be reflected on return.
  useEffect(() => {
    if (openTagId === null) refreshTagList();
  }, [openTagId, refreshTagList]);

  useEffect(() => {
    if (!openTagId) {
      setTag(null);
      return;
    }
    setTag(null);
    setDetailError(null);
    setSelected(new Set());
    getTag(openTagId)
      .then((t) => {
        setTag(t);
        scanUnsyncedMetadata(t.assets);
      })
      .catch((e) => setDetailError(String(e)));
  }, [openTagId, scanUnsyncedMetadata]);

  // Cross-references stack membership onto this tag's assets - see
  // useStacking and PhotosBrowser.tsx's identical note.
  // resolveVisibleStackAssets then keeps a stack's non-pick members out of
  // the grid/selection/keynav, while assetByIdAll below still resolves them
  // by id for StackBand/Viewer/context-menu targets.
  const overlaidAssets = useMemo(
    () =>
      (tag?.assets ?? []).map((a) => ({
        ...a,
        stack: stackByAssetId.get(a.id) ?? null,
        unsyncedMetadata: unsyncedMetadata.get(a.id),
        hasProcessingSidecar: processingSidecarAssets.has(a.id),
      })),
    [tag, stackByAssetId, unsyncedMetadata, processingSidecarAssets],
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

  // assetByIdAll (not assetById) so selecting a non-pick stack member from
  // StackBand still resolves here - see PhotosBrowser.tsx's identical note.
  const selectedAssets = useMemo(
    () => [...selected].map((id) => assetByIdAll.get(id)).filter((a): a is AssetSummary => !!a),
    [selected, assetByIdAll],
  );
  const allSelectedFavorited = selectedAssets.length > 0 && selectedAssets.every((a) => a.isFavorite);

  const patchAssetLocal = useCallback((id: string, patch: Partial<AssetSummary>) => {
    setTag((t) => {
      if (!t) return t;
      const idx = t.assets.findIndex((x) => x.id === id);
      if (idx === -1) return t;
      const next = t.assets.slice();
      next[idx] = { ...next[idx], ...patch };
      return { ...t, assets: next };
    });
  }, []);

  const removeAssetsLocal = useCallback((ids: string[]) => {
    const idSet = new Set(ids);
    setTag((t) => (t ? { ...t, assets: t.assets.filter((x) => !idSet.has(x.id)) } : t));
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

  const removeFromTag = useCallback(
    async (ids: string[]) => {
      if (!tag) return;
      await untagAssets(tag.id, ids);
      removeAssetsLocal(ids);
    },
    [tag, removeAssetsLocal],
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
  // PhotosBrowser.tsx/AlbumsBrowser.tsx's identical restructure, with
  // DIVIDER between groups.
  const contextMenuItems: ContextMenuEntry[] = useMemo(() => {
    if (!contextMenu) return [];
    // assetByIdAll (not assetById) so a right-click forwarded from inside an
    // expanded StackBand still resolves - see PhotosBrowser.tsx's identical
    // note.
    const asset = assetByIdAll.get(contextMenu.assetId);
    const targetIds = selected.size >= 2 ? [...selected] : asset ? [asset.id] : [];
    const targetsIncludeRaw = targetIds.some((id) => {
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
      items.push({
        label: targetIds.length > 1 ? `Remove ${targetIds.length} Photos from Tag` : 'Remove from Tag',
        onClick: () => removeFromTag(targetIds).catch((e) => setEnqueueError(String(e))),
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

    // Edit
    if (asset && selected.size <= 1 && asset.originalPath && !isVideoAsset(asset)) {
      items.push({ label: 'Rotate Left', onClick: () => rotateSelection([asset.id], false, assetByIdAll).catch(() => {}) });
      items.push({ label: 'Rotate Right', onClick: () => rotateSelection([asset.id], true, assetByIdAll).catch(() => {}) });
    }
    items.push(DIVIDER);

    // Copy/Paste
    if (asset) {
      const copyEntry = copyImageProcessingEntry(asset, scannedForProcessingSidecar, handleCopyImageProcessing);
      if (copyEntry) items.push(copyEntry);
    }
    if (copiedProcessingSource && targetsIncludeRaw) {
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
      items.push({ label: 'Sync Metadata from Sidecar', onClick: () => syncMetadata([asset.id], commitEdit).catch(() => {}) });
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
    removeFromTag,
    handleShowInFileManager,
    trashAssets,
    createStackForSelection,
    unstackByStackId,
    rotateSelection,
    unsyncedMetadata,
    scannedForProcessingSidecar,
    syncMetadata,
    commitEdit,
    commitEditMany,
    copiedProcessingSource,
    copiedMetadata,
    handleCopyImageProcessing,
    requestPasteImageProcessing,
    handleCopyMetadata,
    handlePasteMetadata,
  ]);

  // See PhotosBrowser.tsx's identical effect - right-clicking a RAW asset,
  // or plain-selecting exactly one (SelectionBar's own trigger for the same
  // button), that doesn't currently show Copy Image Processing live-rechecks
  // disk once. Without this, a sidecar created outside this view's own
  // tracked flows stays invisible - on both the context menu AND
  // SelectionBar - until this tag is closed and reopened.
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
      // Matches Photos/Folders/Albums/People's File-menu export handlers:
      // the current selection, else the asset open in the Viewer, else
      // nothing (a silent no-op - there's no selection to disable the menu
      // item on).
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
    if (!openTagId || openId || !active) return;
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
        setConfirmRemoveSelection(true);
      } else if (matchesShortcut(e, shortcuts.favorite) && selected.size > 0) {
        e.preventDefault();
        toggleFavoriteForSelection();
      } else if (matchesShortcut(e, shortcuts.favorite) && loupeOn && hoveredAssetId) {
        e.preventDefault();
        const hovered = assetById.get(hoveredAssetId);
        commitEdit(hoveredAssetId, { isFavorite: !hovered?.isFavorite }).catch(() => {});
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
    openTagId,
    openId,
    active,
    onToggleLoupe,
    selectAll,
    deselectAll,
    selected,
    shortcuts,
    capturing,
    commitEdit,
    commitEditMany,
    toggleFavoriteForSelection,
    setAddToTagTargets,
    loupeOn,
    hoveredAssetId,
    assetById,
  ]);

  async function handleCreateTag() {
    const name = newTagName.trim();
    if (!name) return;
    setCreatingTag(true);
    setListError(null);
    try {
      const created = await createTag(name, newTagColor);
      setNewTagName('');
      setNewTagColor(null);
      refreshTagList();
      setOpenTagId(created.id);
    } catch (e) {
      setListError(String(e));
    } finally {
      setCreatingTag(false);
    }
  }

  const filteredTags = useMemo(() => {
    if (!tags) return [];
    const q = tagSearch.trim().toLowerCase();
    if (!q) return tags;
    return tags.filter((t) => t.name.toLowerCase().includes(q));
  }, [tags, tagSearch]);

  const toggleTagSelect = useCallback((id: string) => {
    setSelectedTagIds((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const clearTagSelection = useCallback(() => setSelectedTagIds(new Set()), []);

  async function handleBulkDeleteTags() {
    await Promise.all([...selectedTagIds].map((id) => deleteTag(id)));
    setConfirmDeleteSelectedTags(false);
    clearTagSelection();
    refreshTagList();
  }

  // ---------- Tag list view ----------
  if (!openTagId) {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ flexShrink: 0, padding: '16px 20px 12px', borderBottom: '1px solid rgba(0,0,0,0.3)' }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              value={newTagName}
              onChange={(e) => setNewTagName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreateTag();
              }}
              placeholder="New tag name…"
              style={inputStyle}
            />
            <button onClick={handleCreateTag} disabled={creatingTag || !newTagName.trim()} style={btnPrimary(!creatingTag && !!newTagName.trim())}>
              {creatingTag ? 'Creating…' : 'New Tag'}
            </button>
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
            {TAG_COLORS.map((c) => (
              <div
                key={c}
                onClick={() => setNewTagColor(newTagColor === c ? null : c)}
                title={c}
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: '50%',
                  background: c,
                  cursor: 'default',
                  boxShadow: newTagColor === c ? '0 0 0 2px var(--canvas), 0 0 0 4px var(--border-strong)' : '0 0 0 1px var(--border-strong)',
                }}
              />
            ))}
          </div>
        </div>

        {tags && tags.length > 0 && (
          <div style={{ flexShrink: 0, padding: '12px 20px 0' }}>
            <input value={tagSearch} onChange={(e) => setTagSearch(e.target.value)} placeholder="Search tags…" style={inputStyle} />
          </div>
        )}

        {selectedTagIds.size > 0 && (
          <div
            style={{
              flexShrink: 0,
              margin: '12px 20px 0',
              height: 40,
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '0 12px',
              borderRadius: 9,
              background: 'rgba(53,132,228,0.14)',
              border: '1px solid rgba(53,132,228,0.3)',
            }}
          >
            <span style={{ fontSize: 12.5, fontWeight: 600 }}>{selectedTagIds.size} selected</span>
            <div style={{ flex: 1 }} />
            <div onClick={clearTagSelection} style={{ fontSize: 12.5, cursor: 'default', color: 'var(--text-dim)' }}>
              Clear
            </div>
            <div onClick={() => setConfirmDeleteSelectedTags(true)} style={{ fontSize: 12.5, cursor: 'default', color: '#ff8080' }}>
              Delete Selected
            </div>
          </div>
        )}

        <div style={{ flex: 1, overflow: 'auto', padding: 20, background: 'var(--canvas)' }}>
          {listError && <div style={{ color: 'var(--danger)', fontSize: 13, marginBottom: 12 }}>Couldn't load tags — {listError}.</div>}
          {!tags && !listError && <div style={{ color: 'var(--text-dim)', fontSize: 13 }}>Loading tags…</div>}
          {tags && tags.length === 0 && !listError && (
            <div style={{ color: 'var(--text-dimmer)', fontSize: 13 }}>No tags yet — create one above.</div>
          )}
          {tags && tags.length > 0 && filteredTags.length === 0 && (
            <div style={{ color: 'var(--text-dimmer)', fontSize: 13 }}>No tags match your search.</div>
          )}
          {filteredTags.length > 0 && (
            <div>
              {filteredTags.map((t) => (
                <TagPill
                  key={t.id}
                  tag={t}
                  onOpen={() => setOpenTagId(t.id)}
                  onDelete={() => setConfirmDeleteTag(t)}
                  selected={selectedTagIds.has(t.id)}
                  onToggleSelect={() => toggleTagSelect(t.id)}
                />
              ))}
            </div>
          )}
        </div>

        {confirmDeleteTag && (
          <ConfirmDialog
            title="Delete tag?"
            message={`This deletes "${confirmDeleteTag.name}". The photos tagged with it stay in your library untouched.`}
            confirmLabel="Delete Tag"
            onConfirm={async () => {
              await deleteTag(confirmDeleteTag.id);
              setConfirmDeleteTag(null);
              refreshTagList();
            }}
            onClose={() => setConfirmDeleteTag(null)}
          />
        )}
        {confirmDeleteSelectedTags && (
          <ConfirmDialog
            title="Delete tags?"
            message={`This deletes ${selectedTagIds.size} tag${selectedTagIds.size === 1 ? '' : 's'}. The photos tagged with them stay in your library untouched.`}
            confirmLabel="Delete Tags"
            onConfirm={handleBulkDeleteTags}
            onClose={() => setConfirmDeleteSelectedTags(false)}
          />
        )}
      </div>
    );
  }

  // ---------- Tag detail view ----------
  if (detailError) {
    return (
      <div style={{ padding: 24, color: 'var(--text-dim)' }}>
        Couldn't load this tag — {detailError}.{' '}
        <span onClick={() => setOpenTagId(null)} style={{ color: 'var(--accent)', cursor: 'default' }}>
          Back to Tags
        </span>
      </div>
    );
  }

  if (!tag) {
    return <div style={{ padding: 24, color: 'var(--text-dim)' }}>Loading tag…</div>;
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, position: 'relative' }}>
      {enqueueError && <InlineWarningBanner message={enqueueError} onDismiss={() => setEnqueueError(null)} />}
      <div style={{ flexShrink: 0, height: 46, display: 'flex', alignItems: 'center', gap: 10, padding: '0 16px', borderBottom: '1px solid rgba(0,0,0,0.3)' }}>
        <div onClick={() => setOpenTagId(null)} style={{ cursor: 'default', color: 'var(--accent)', fontSize: 13 }}>
          ← Tags
        </div>
        <div style={{ width: 1, height: 18, background: 'var(--overlay-strong)' }} />
        <div style={{ width: 10, height: 10, borderRadius: '50%', flexShrink: 0, background: tag.color ?? 'var(--text-dimmer)' }} />
        <span style={{ fontSize: 14, fontWeight: 700 }}>{tag.name}</span>
        <span style={{ fontSize: 12.5, color: 'var(--text-dimmer)' }}>
          {tag.assets.length} photo{tag.assets.length === 1 ? '' : 's'}
        </span>
        <div style={{ flex: 1 }} />
        <BarTextButton onClick={() => setConfirmDeleteTag({ id: tag.id, name: tag.name, color: tag.color })} danger>
          Delete Tag
        </BarTextButton>
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
          actions={(() => {
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
            const unsyncedSelected = [...selected].filter((id) => unsyncedMetadata.has(id));
            const copyImageProcessingBarEntry =
              selectedAssets.length === 1 ? copyImageProcessingEntry(selectedAssets[0], scannedForProcessingSidecar, handleCopyImageProcessing) : null;
            const actions: MenuAction[] = [
              { id: 'addToTag', group: 'organize', label: 'Add to Tag', disabled: !!TAG_ASSIGN_DISABLED_REASON, disabledReason: TAG_ASSIGN_DISABLED_REASON ?? undefined, onClick: () => setAddToTagTargets([...selected]) },
              { id: 'addToAlbum', group: 'organize', label: 'Add to Album', onClick: () => setAddToAlbumTargets([...selected]) },
              { id: 'stack', group: 'stack', label: stackBusy ? 'Working…' : `Stack ${selected.size} Photos`, disabled: !canStack || stackBusy, onClick: () => createStackForSelection([...selected]).catch(() => {}) },
              { id: 'smartStack', group: 'stack', label: stackBusy ? 'Working…' : 'Smart Stack', disabled: !canStack || stackBusy, onClick: () => setSmartStackOpen(true) },
              ...(hasStackedSelection
                ? [{ id: 'unstack', group: 'stack' as const, label: stackBusy ? 'Working…' : 'Unstack', disabled: stackBusy, onClick: () => unstackSelection().catch((e: unknown) => setEnqueueError(String(e))) }]
                : []),
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
              { id: 'pasteImageProcessing', group: 'copyPaste', label: 'Paste Image Processing', disabled: !canPasteImageProcessing, onClick: () => requestPasteImageProcessing([...selected], assetByIdAll) },
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
              {
                id: 'showInFileManager',
                group: 'more',
                label: 'Show in File Manager',
                disabled: selectedAssets.length !== 1 || !selectedAssets[0].originalPath,
                disabledReason: 'Select a single photo to show it in the file manager',
                onClick: () => handleShowInFileManager(selectedAssets[0]),
              },
              ...(unsyncedSelected.length > 0
                ? [{ id: 'syncMetadata', group: 'more' as const, label: 'Sync Metadata from Sidecar', onClick: () => syncMetadata(unsyncedSelected, commitEdit).catch(() => {}) }]
                : []),
              { id: 'removeFromTag', group: 'destructive', label: 'Remove from Tag', onClick: () => setConfirmRemoveSelection(true) },
              { id: 'moveToTrash', group: 'destructive', label: 'Move to Trash', onClick: () => setConfirmDeleteSelection(true) },
            ];
            return actions;
          })()}
        />
        </div>
      )}

      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <div ref={gridContainerRef} style={{ flex: loupeOn ? '0 0 33.333%' : 1, overflow: 'auto', minHeight: 0, padding: 16, background: 'var(--canvas)' }}>
          {visibleAssets.length === 0 ? (
            <div style={{ color: 'var(--text-dimmer)', fontSize: 12.5 }}>
              No photos tagged yet — select photos anywhere and use "Add to Tag".
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fill, minmax(${thumbSize}px, 1fr))`, gap: 12 }}>
              {visibleAssets.map((a) => {
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
          )}
        </div>
        {loupeOn && <GridLoupePane assetId={hoveredAssetId} large={loupeLarge} />}
        {!loupeOn && metaOpen && <MetadataPanel selected={selectedAssets} onClose={onCloseMetadata} onEdit={commitEdit} />}
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
          onRemoveFromTag={(id) => removeFromTag([id]).catch((e) => setEnqueueError(String(e)))}
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
      {confirmRemoveSelection && (
        <ConfirmDialog
          title="Remove from tag?"
          message={`This removes ${selected.size} photo${selected.size === 1 ? '' : 's'} from "${tag.name}". The photos themselves stay in your library.`}
          confirmLabel="Remove from Tag"
          onConfirm={() => removeFromTag([...selected])}
          onClose={() => setConfirmRemoveSelection(false)}
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
      {confirmDeleteTag && (
        <ConfirmDialog
          title="Delete tag?"
          message={`This deletes "${confirmDeleteTag.name}". The photos tagged with it stay in your library untouched.`}
          confirmLabel="Delete Tag"
          onConfirm={async () => {
            await deleteTag(confirmDeleteTag.id);
            setConfirmDeleteTag(null);
            setOpenTagId(null);
          }}
          onClose={() => setConfirmDeleteTag(null)}
        />
      )}
    </div>
  );
});

export default TagsBrowser;

function TagPill({
  tag,
  onOpen,
  onDelete,
  selected,
  onToggleSelect,
}: {
  tag: TagSummary;
  onOpen: () => void;
  onDelete: () => void;
  selected: boolean;
  onToggleSelect: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      onClick={onOpen}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        height: 42,
        padding: '0 10px',
        borderRadius: 9,
        cursor: 'default',
        background: selected ? 'rgba(53,132,228,0.14)' : 'transparent',
      }}
    >
      <div
        onClick={(e) => {
          e.stopPropagation();
          onToggleSelect();
        }}
        style={{
          width: 16,
          height: 16,
          borderRadius: 4,
          flexShrink: 0,
          border: selected ? 'none' : '1.5px solid var(--border-strong)',
          background: selected ? 'var(--accent)' : 'transparent',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 11,
          color: '#fff',
        }}
      >
        {selected && '✓'}
      </div>
      <div style={{ width: 12, height: 12, borderRadius: '50%', flexShrink: 0, background: tag.color ?? 'var(--text-dimmer)' }} />
      <div style={{ flex: 1, minWidth: 0, fontSize: 13.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {tag.name}
      </div>
      {hovered && (
        <div
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          title="Delete"
          style={{ ...pillIconStyle, color: '#ff8080' }}
        >
          ✕
        </div>
      )}
    </div>
  );
}

function BarTextButton({ onClick, danger, children }: { onClick: () => void; danger?: boolean; children: React.ReactNode }) {
  return (
    <div onClick={onClick} style={{ fontSize: 12.5, cursor: 'default', color: danger ? '#ff8080' : 'var(--text-dim)', padding: '0 6px' }}>
      {children}
    </div>
  );
}

const pillIconStyle: CSSProperties = {
  width: 22,
  height: 22,
  borderRadius: 6,
  background: 'rgba(0,0,0,0.6)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'default',
  fontSize: 12,
  color: '#fff',
};

const inputStyle: CSSProperties = {
  flex: 1,
  height: 34,
  padding: '0 12px',
  background: 'var(--surface-sunken)',
  border: '1px solid var(--border)',
  borderRadius: 9,
  color: 'var(--text)',
  fontSize: 13,
};

const btnBase: CSSProperties = {
  height: 34,
  padding: '0 16px',
  borderRadius: 9,
  border: 'none',
  fontSize: 12.5,
  cursor: 'default',
  whiteSpace: 'nowrap',
};

function btnPrimary(enabled: boolean): CSSProperties {
  return {
    ...btnBase,
    background: '#3584e4',
    color: '#fff',
    fontWeight: 700,
    opacity: enabled ? 1 : 0.5,
    pointerEvents: enabled ? 'auto' : 'none',
  };
}
