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
import { useVirtualizer } from '@tanstack/react-virtual';
import { retryOnVaultReady } from '../lib/vaultReadyRetry';
import {
  createAlbum,
  deleteAlbum,
  deleteAssets,
  getAlbum,
  listAlbums,
  removeAssetsFromAlbum,
  renameAlbum,
  revealInFileManager,
  thumbnailSrc,
  updateAssetMetadata,
  type AlbumDetail,
  type AlbumSummary,
  type AssetMetadataPatch,
  type AssetSummary,
  type EditJob,
  type MetadataEditTarget,
} from '../lib/api';
import { useStacking } from '../lib/useStacking';
import { isHiddenStackChild } from '../lib/stacks';
import AssetTile, { type ClickMods } from '../components/AssetTile';
import GridLoupePane from '../components/GridLoupePane';
import SelectionBar from '../components/SelectionBar';
import StackBand from '../components/StackBand';
import SmartStackDialog from '../components/SmartStackDialog';
import ContextMenu, { type ContextMenuItem } from '../components/ContextMenu';
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
import { centerAssetInContainerSoon } from '../lib/scrollCenter';

// See PhotosBrowser.tsx/FoldersBrowser.tsx's identical helper.
function prevValuesFor(asset: AssetSummary | undefined, patch: AssetMetadataPatch): Partial<AssetSummary> {
  const prev: Partial<AssetSummary> = {};
  if (patch.rating !== undefined) prev.rating = asset?.rating ?? null;
  if (patch.isFavorite !== undefined) prev.isFavorite = asset?.isFavorite ?? false;
  if (patch.description !== undefined) prev.description = asset?.description ?? null;
  return prev;
}

// See PeopleBrowser.tsx's identical constant/comment - an album's whole
// asset list is fetched up front too, so this windows it the same way for
// the same reason (a large album mounting every AssetTile at once could peg
// the webview's render thread and freeze the whole single-page app, not
// just this tab).
const ALBUM_GRID_CHUNK_SIZE = 60;

export interface AlbumsBrowserHandle {
  openExportToFolder: () => void;
  openExportToFlickr: () => void;
}

// Real Immich albums (GET/POST/PATCH/DELETE /albums, PUT/DELETE
// /albums/{id}/assets) - replaces the old placeholder. Deliberately scoped
// down from Photos/Folders' full feature set: no Stacks, Smart Stack, ART
// round trip, or Copy/Paste Image Processing/Metadata here - those are all
// RAW-culling-pipeline concepts orthogonal to "which photos are in this
// album", and SelectionBar's relevant props are now optional specifically so
// this view can omit them rather than wiring up no-ops. Rating/favorite
// edits still go through the same background EditQueue as every other view,
// for the same XMP-sidecar-write reason (see FoldersBrowser.tsx). Export to
// Folder/Flickr are the exception - those are shared with Photos/Folders via
// the File menu, so this view exposes just enough of a handle for that.
const AlbumsBrowser = forwardRef<AlbumsBrowserHandle, {
  metaOpen: boolean;
  onCloseMetadata: () => void;
  // Number of albums, for the sidebar row - only meaningful in the list view.
  onCount?: (n: number) => void;
  active?: boolean;
  // Grid loupe mode - see PhotosBrowser.tsx's identical prop for the full
  // explanation. App.tsx owns the boolean, shared across every grid view.
  loupeOn: boolean;
  onToggleLoupe: () => void;
  // Grid thumbnail size, in px - shared across every grid view. See
  // App.tsx's `thumbSize` state and MenuBar's slider.
  thumbSize: number;
}>(function AlbumsBrowser({
  metaOpen,
  onCloseMetadata,
  onCount,
  active = true,
  loupeOn,
  onToggleLoupe,
  thumbSize,
}, ref) {
  const [albums, setAlbums] = useState<AlbumSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [newAlbumName, setNewAlbumName] = useState('');
  const [creatingAlbum, setCreatingAlbum] = useState(false);
  const [renamingAlbum, setRenamingAlbum] = useState<AlbumSummary | null>(null);
  const [confirmDeleteAlbum, setConfirmDeleteAlbum] = useState<AlbumSummary | null>(null);

  const [openAlbumId, setOpenAlbumId] = useState<string | null>(null);
  const [album, setAlbum] = useState<AlbumDetail | null>(null);
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
    dissolveStack,
    restackRemainder,
    createStackForSelection,
    applySmartStackGroups,
    setStackPickAction,
    unstack,
    unstackByStackId,
    unstackSelection,
    hasStackedSelection,
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
  const [addToAlbumTargets, setAddToAlbumTargets] = useState<string[] | null>(null);
  const [addToTagTargets, setAddToTagTargets] = useState<string[] | null>(null);
  const [exportFolderAssets, setExportFolderAssets] = useState<AssetSummary[] | null>(null);
  const [exportFlickrAssets, setExportFlickrAssets] = useState<AssetSummary[] | null>(null);
  const { shortcuts, capturing } = useShortcuts();

  const refreshAlbumList = useCallback(() => {
    listAlbums()
      .then((a) => {
        setAlbums(a);
        onCount?.(a.length);
        setListError(null);
      })
      .catch((e) => setListError(String(e)));
    // onCount's identity changing on re-renders shouldn't retrigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    refreshAlbumList();
  }, [refreshAlbumList]);

  // See `vaultReadyRetry.ts` - the fetch above can fire and fail with "No
  // API key configured" before the credential vault has actually opened.
  useEffect(() => retryOnVaultReady(refreshAlbumList), [refreshAlbumList]);

  // Re-fetches the album list whenever navigating back from a detail view -
  // adding/removing assets or renaming while inside one can change a cover/
  // count/name that the list needs to reflect on return.
  useEffect(() => {
    if (openAlbumId === null) refreshAlbumList();
  }, [openAlbumId, refreshAlbumList]);

  useEffect(() => {
    if (!openAlbumId) {
      setAlbum(null);
      return;
    }
    setAlbum(null);
    setDetailError(null);
    setSelected(new Set());
    getAlbum(openAlbumId)
      .then(setAlbum)
      .catch((e) => setDetailError(String(e)));
  }, [openAlbumId]);

  // Cross-references stack membership onto this album's assets (the server
  // never inlines `.stack` here either - see PhotosBrowser.tsx's identical
  // note) - see useStacking. isHiddenStackChild then keeps a stack's
  // non-pick members out of the grid/selection/keynav, same as Photos/
  // Folders, while assetByIdAll below still resolves them by id for
  // StackBand/Viewer/context-menu targets.
  const overlaidAssets = useMemo(
    () => (album?.assets ?? []).map((a) => ({ ...a, stack: stackByAssetId.get(a.id) ?? null })),
    [album, stackByAssetId],
  );
  const visibleAssets = useMemo(() => overlaidAssets.filter((a) => !isHiddenStackChild(a)), [overlaidAssets]);

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
    for (let i = 0; i < visibleAssets.length; i += ALBUM_GRID_CHUNK_SIZE) {
      chunks.push(visibleAssets.slice(i, i + ALBUM_GRID_CHUNK_SIZE));
    }
    return chunks;
  }, [visibleAssets]);

  const gridContainerRef = useRef<HTMLDivElement>(null);
  const gridVirtualizer = useVirtualizer({
    count: assetChunks.length,
    getScrollElement: () => gridContainerRef.current,
    // A rough guess (~6 columns of 3:2 tiles) - corrected per-chunk once it
    // actually renders via virtualizer.measureElement, same as Folders'
    // bucket virtualizer.
    estimateSize: () => Math.ceil(ALBUM_GRID_CHUNK_SIZE / 6) * 124,
    overscan: 2,
  });

  useEffect(() => {
    // A newly-opened album's chunk heights have nothing to do with the
    // previous one's - avoid rendering a window sized off stale estimates.
    gridVirtualizer.measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openAlbumId]);

  useEffect(() => {
    const container = gridContainerRef.current;
    if (!container || !lastHoveredAssetId.current) return;
    centerAssetInContainerSoon(container, lastHoveredAssetId.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loupeOn]);

  // assetByIdAll (not assetById) so selecting a non-pick stack member from
  // StackBand still resolves here - see PhotosBrowser.tsx's identical note.
  const selectedAssets = useMemo(
    () => [...selected].map((id) => assetByIdAll.get(id)).filter((a): a is AssetSummary => !!a),
    [selected, assetByIdAll],
  );
  const allSelectedFavorited = selectedAssets.length > 0 && selectedAssets.every((a) => a.isFavorite);

  const patchAssetLocal = useCallback((id: string, patch: Partial<AssetSummary>) => {
    setAlbum((a) => {
      if (!a) return a;
      const idx = a.assets.findIndex((x) => x.id === id);
      if (idx === -1) return a;
      const next = a.assets.slice();
      next[idx] = { ...next[idx], ...patch };
      return { ...a, assets: next };
    });
  }, []);

  const removeAssetsLocal = useCallback((ids: string[]) => {
    const idSet = new Set(ids);
    setAlbum((a) => (a ? { ...a, assets: a.assets.filter((x) => !idSet.has(x.id)) } : a));
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

  // Immich trashes a stack as one atomic unit, so trashing an id that's
  // still part of a stack would take its siblings down too - pull each
  // affected stack apart first and re-stack whatever's left over, so only
  // the requested id(s) actually go. See PhotosBrowser.tsx's identical
  // removeAssets for the full explanation.
  const trashAssets = useCallback(
    async (ids: string[]) => {
      const idSet = new Set(ids);
      const stackIdsTouched = new Set<string>();
      for (const id of ids) {
        const info = stackByAssetId.get(id);
        if (info) stackIdsTouched.add(info.id);
      }
      for (const stackId of stackIdsTouched) {
        const memberIds = await dissolveStack(stackId);
        await restackRemainder(memberIds.filter((id) => !idSet.has(id)));
      }
      await deleteAssets(ids, false);
      removeAssetsLocal(ids);
    },
    [removeAssetsLocal, stackByAssetId, dissolveStack, restackRemainder],
  );

  const removeFromAlbum = useCallback(
    async (ids: string[]) => {
      if (!album) return;
      await removeAssetsFromAlbum(album.id, ids);
      removeAssetsLocal(ids);
    },
    [album, removeAssetsLocal],
  );

  const handleShowInFileManager = useCallback((asset: AssetSummary) => {
    if (!asset.originalPath) return;
    revealInFileManager(asset.originalPath).catch((e) => setEnqueueError(String(e)));
  }, []);

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

  const contextMenuItems: ContextMenuItem[] = useMemo(() => {
    if (!contextMenu) return [];
    // assetByIdAll (not assetById) so a right-click forwarded from inside an
    // expanded StackBand (a hidden, non-pick member) still resolves - see
    // PhotosBrowser.tsx's identical note.
    const asset = assetByIdAll.get(contextMenu.assetId);
    const targetIds = selected.size >= 2 ? [...selected] : asset ? [asset.id] : [];
    const items: ContextMenuItem[] = [];
    if (selected.size >= 2) {
      items.push({ label: `Stack ${selected.size} Photos`, onClick: () => createStackForSelection([...selected]).catch(() => {}) });
      items.push({ label: `Smart Stack ${selected.size} Photos`, onClick: () => setSmartStackOpen(true) });
    }
    if (asset?.stack) {
      items.push({ label: 'Unstack', onClick: () => unstackByStackId(asset.stack!.id).catch(() => {}) });
    }
    if (targetIds.length > 0) {
      items.push({
        label: targetIds.length > 1 ? `Add ${targetIds.length} Photos to Album…` : 'Add to Album…',
        onClick: () => setAddToAlbumTargets(targetIds),
      });
      items.push({
        label: targetIds.length > 1 ? `Remove ${targetIds.length} Photos from Album` : 'Remove from Album',
        onClick: () => removeFromAlbum(targetIds).catch((e) => setEnqueueError(String(e))),
      });
      items.push({
        label: (targetIds.length > 1 ? `Add ${targetIds.length} Photos to Tag…` : 'Add to Tag…') + (TAG_ASSIGN_DISABLED_REASON ? ' (disabled)' : ''),
        onClick: () => setAddToTagTargets(targetIds),
        disabled: !!TAG_ASSIGN_DISABLED_REASON,
      });
    }
    if (asset?.originalPath) {
      items.push({ label: 'Show in File Manager', onClick: () => handleShowInFileManager(asset) });
    }
    if (targetIds.length > 0) {
      const exportAssets = targetIds.map((id) => assetByIdAll.get(id)).filter((a): a is AssetSummary => !!a);
      items.push({ label: 'Export to Folder…', onClick: () => setExportFolderAssets(exportAssets) });
      items.push({ label: 'Share to Flickr…', onClick: () => setExportFlickrAssets(exportAssets) });
    }
    if (targetIds.length > 0) {
      items.push({
        label: targetIds.length > 1 ? `Move ${targetIds.length} Photos to Trash` : 'Move to Trash',
        onClick: () => trashAssets(targetIds).catch((e) => setEnqueueError(String(e))),
      });
    }
    return items;
  }, [contextMenu, assetByIdAll, selected, removeFromAlbum, handleShowInFileManager, trashAssets, createStackForSelection, unstackByStackId]);

  useImperativeHandle(
    ref,
    () => ({
      // Matches Photos/Folders' File-menu export handlers: the current
      // selection, else the asset open in the Viewer, else nothing (a
      // silent no-op - there's no selection to disable the menu item on).
      openExportToFolder: () => {
        const target = selectedAssets.length > 0 ? selectedAssets : openAsset ? [openAsset] : [];
        if (target.length > 0) setExportFolderAssets(target);
      },
      openExportToFlickr: () => {
        const target = selectedAssets.length > 0 ? selectedAssets : openAsset ? [openAsset] : [];
        if (target.length > 0) setExportFlickrAssets(target);
      },
    }),
    [selectedAssets, openAsset],
  );

  useEffect(() => {
    if (!openAlbumId || openId || !active) return;
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
    openAlbumId,
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

  async function handleCreateAlbum() {
    const name = newAlbumName.trim();
    if (!name) return;
    setCreatingAlbum(true);
    setListError(null);
    try {
      const created = await createAlbum(name, []);
      setNewAlbumName('');
      refreshAlbumList();
      setOpenAlbumId(created.id);
    } catch (e) {
      setListError(String(e));
    } finally {
      setCreatingAlbum(false);
    }
  }

  // ---------- Album list view ----------
  if (!openAlbumId) {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ flexShrink: 0, padding: '16px 20px 12px', display: 'flex', gap: 8, borderBottom: '1px solid rgba(0,0,0,0.3)' }}>
          <input
            value={newAlbumName}
            onChange={(e) => setNewAlbumName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreateAlbum();
            }}
            placeholder="New album name…"
            style={inputStyle}
          />
          <button onClick={handleCreateAlbum} disabled={creatingAlbum || !newAlbumName.trim()} style={btnPrimary(!creatingAlbum && !!newAlbumName.trim())}>
            {creatingAlbum ? 'Creating…' : 'New Album'}
          </button>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: 20, background: 'var(--canvas)' }}>
          {listError && <div style={{ color: 'var(--danger)', fontSize: 13, marginBottom: 12 }}>Couldn't load albums — {listError}.</div>}
          {!albums && !listError && <div style={{ color: 'var(--text-dim)', fontSize: 13 }}>Loading albums…</div>}
          {albums && albums.length === 0 && !listError && (
            <div style={{ color: 'var(--text-dimmer)', fontSize: 13 }}>No albums yet — create one above.</div>
          )}
          {albums && albums.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 16 }}>
              {albums.map((a) => (
                <AlbumCard
                  key={a.id}
                  album={a}
                  onOpen={() => setOpenAlbumId(a.id)}
                  onRename={() => setRenamingAlbum(a)}
                  onDelete={() => setConfirmDeleteAlbum(a)}
                />
              ))}
            </div>
          )}
        </div>

        {renamingAlbum && (
          <RenameAlbumDialog
            album={renamingAlbum}
            onClose={() => setRenamingAlbum(null)}
            onRenamed={() => {
              setRenamingAlbum(null);
              refreshAlbumList();
            }}
          />
        )}
        {confirmDeleteAlbum && (
          <ConfirmDialog
            title="Delete album?"
            message={`This deletes "${confirmDeleteAlbum.albumName}". The photos in it stay in your library untouched.`}
            confirmLabel="Delete Album"
            onConfirm={async () => {
              await deleteAlbum(confirmDeleteAlbum.id);
              setConfirmDeleteAlbum(null);
              refreshAlbumList();
            }}
            onClose={() => setConfirmDeleteAlbum(null)}
          />
        )}
      </div>
    );
  }

  // ---------- Album detail view ----------
  if (detailError) {
    return (
      <div style={{ padding: 24, color: 'var(--text-dim)' }}>
        Couldn't load this album — {detailError}.{' '}
        <span onClick={() => setOpenAlbumId(null)} style={{ color: 'var(--accent)', cursor: 'default' }}>
          Back to Albums
        </span>
      </div>
    );
  }

  if (!album) {
    return <div style={{ padding: 24, color: 'var(--text-dim)' }}>Loading album…</div>;
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, position: 'relative' }}>
      {enqueueError && <InlineWarningBanner message={enqueueError} onDismiss={() => setEnqueueError(null)} />}
      <div style={{ flexShrink: 0, height: 46, display: 'flex', alignItems: 'center', gap: 10, padding: '0 16px', borderBottom: '1px solid rgba(0,0,0,0.3)' }}>
        <div onClick={() => setOpenAlbumId(null)} style={{ cursor: 'default', color: 'var(--accent)', fontSize: 13 }}>
          ← Albums
        </div>
        <div style={{ width: 1, height: 18, background: 'var(--overlay-strong)' }} />
        <span style={{ fontSize: 14, fontWeight: 700 }}>{album.albumName}</span>
        <span style={{ fontSize: 12.5, color: 'var(--text-dimmer)' }}>
          {album.assets.length} photo{album.assets.length === 1 ? '' : 's'}
        </span>
        <div style={{ flex: 1 }} />
        <BarTextButton onClick={() => setRenamingAlbum({ id: album.id, albumName: album.albumName, description: album.description, albumThumbnailAssetId: album.albumThumbnailAssetId, assetCount: album.assets.length })}>
          Rename
        </BarTextButton>
        <BarTextButton
          onClick={() =>
            setConfirmDeleteAlbum({ id: album.id, albumName: album.albumName, description: album.description, albumThumbnailAssetId: album.albumThumbnailAssetId, assetCount: album.assets.length })
          }
          danger
        >
          Delete Album
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
          onStack={() => createStackForSelection([...selected]).catch(() => {})}
          onSmartStack={() => setSmartStackOpen(true)}
          onFavorite={toggleFavoriteForSelection}
          allFavorited={allSelectedFavorited}
          onRate={(rating) => commitEditMany([...selected], { rating }).catch(() => {})}
          unsyncedCount={0}
          onSyncMetadata={() => {}}
          onDelete={() => setConfirmDeleteSelection(true)}
          canOpenInRawEditor={false}
          onOpenInRawEditor={() => {}}
          onAddToAlbum={() => setAddToAlbumTargets([...selected])}
          onRemoveFromAlbum={() => setConfirmRemoveSelection(true)}
          onAddToTag={() => setAddToTagTargets([...selected])}
          onBulkUnstack={() => unstackSelection().catch((e) => setEnqueueError(String(e)))}
          hasStackedSelection={hasStackedSelection}
        />
        </div>
      )}

      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <div ref={gridContainerRef} style={{ flex: loupeOn ? '0 0 33.333%' : 1, overflow: 'auto', minHeight: 0, padding: 16, background: 'var(--canvas)' }}>
          {visibleAssets.length === 0 ? (
            <div style={{ color: 'var(--text-dimmer)', fontSize: 12.5 }}>
              No photos in this album yet — select photos in Photos or Folders and use "Add to Album".
            </div>
          ) : (
            <div style={{ height: gridVirtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
              {gridVirtualizer.getVirtualItems().map((item) => (
                <div
                  key={item.key}
                  ref={gridVirtualizer.measureElement}
                  data-index={item.index}
                  style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${item.start}px)` }}
                >
                  <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fill, minmax(${thumbSize}px, 1fr))`, gap: 12, paddingBottom: 12 }}>
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
                </div>
              ))}
            </div>
          )}
        </div>
        {loupeOn && <GridLoupePane assetId={hoveredAssetId} />}
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
          title="Remove from album?"
          message={`This removes ${selected.size} photo${selected.size === 1 ? '' : 's'} from "${album.albumName}". The photos themselves stay in your library.`}
          confirmLabel="Remove from Album"
          onConfirm={() => removeFromAlbum([...selected])}
          onClose={() => setConfirmRemoveSelection(false)}
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
      {renamingAlbum && (
        <RenameAlbumDialog
          album={renamingAlbum}
          onClose={() => setRenamingAlbum(null)}
          onRenamed={(name) => {
            setRenamingAlbum(null);
            setAlbum((a) => (a ? { ...a, albumName: name } : a));
          }}
        />
      )}
      {confirmDeleteAlbum && (
        <ConfirmDialog
          title="Delete album?"
          message={`This deletes "${confirmDeleteAlbum.albumName}". The photos in it stay in your library untouched.`}
          confirmLabel="Delete Album"
          onConfirm={async () => {
            await deleteAlbum(confirmDeleteAlbum.id);
            setConfirmDeleteAlbum(null);
            setOpenAlbumId(null);
          }}
          onClose={() => setConfirmDeleteAlbum(null)}
        />
      )}
    </div>
  );
});

export default AlbumsBrowser;

function AlbumCard({
  album,
  onOpen,
  onRename,
  onDelete,
}: {
  album: AlbumSummary;
  onOpen: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      onClick={onOpen}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ cursor: 'default' }}
    >
      <div style={{ aspectRatio: '4 / 3', borderRadius: 8, overflow: 'hidden', position: 'relative', background: 'var(--surface-sunken)', boxShadow: '0 0 0 1px var(--border)' }}>
        {album.albumThumbnailAssetId ? (
          <img src={thumbnailSrc(album.albumThumbnailAssetId)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : (
          <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dimmer)', fontSize: 12 }}>
            Empty album
          </div>
        )}
        {hovered && (
          <div style={{ position: 'absolute', top: 6, right: 6, display: 'flex', gap: 5 }}>
            <div
              onClick={(e) => {
                e.stopPropagation();
                onRename();
              }}
              title="Rename"
              style={pillIconStyle}
            >
              ✎
            </div>
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
          </div>
        )}
      </div>
      <div style={{ marginTop: 8, fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{album.albumName}</div>
      <div style={{ fontSize: 11.5, color: 'var(--text-dimmer)' }}>
        {album.assetCount} photo{album.assetCount === 1 ? '' : 's'}
      </div>
    </div>
  );
}

function RenameAlbumDialog({
  album,
  onClose,
  onRenamed,
}: {
  album: AlbumSummary;
  onClose: () => void;
  onRenamed: (name: string) => void;
}) {
  const [name, setName] = useState(album.albumName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      await renameAlbum(album.id, trimmed);
      onRenamed(trimmed);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={busy ? undefined : onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 360, maxWidth: '92%', background: 'var(--dialog-bg)', borderRadius: 14, boxShadow: '0 24px 70px rgba(0,0,0,0.7)', border: '1px solid var(--border)', padding: 20 }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 14 }}>Rename Album</div>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSave();
          }}
          autoFocus
          style={{ ...inputStyle, width: '100%', marginBottom: 10 }}
        />
        {error && <div style={{ fontSize: 12, color: 'var(--danger)', marginBottom: 10 }}>{error}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose} disabled={busy} style={btnSecondary}>
            Cancel
          </button>
          <button onClick={handleSave} disabled={busy || !name.trim()} style={btnPrimary(!busy && !!name.trim())}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
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

const btnSecondary: CSSProperties = {
  ...btnBase,
  border: '1px solid var(--border-strong)',
  background: 'var(--overlay-weak)',
  color: 'var(--text)',
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
