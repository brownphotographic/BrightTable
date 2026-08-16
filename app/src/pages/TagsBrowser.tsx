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
import {
  createTag,
  deleteAssets,
  deleteTag,
  getTag,
  listTags,
  revealInFileManager,
  untagAssets,
  updateAssetMetadata,
  type AssetMetadataPatch,
  type AssetSummary,
  type EditJob,
  type MetadataEditTarget,
  type TagDetail,
  type TagSummary,
} from '../lib/api';
import AssetTile, { type ClickMods } from '../components/AssetTile';
import GridLoupePane from '../components/GridLoupePane';
import SelectionBar from '../components/SelectionBar';
import ContextMenu, { type ContextMenuItem } from '../components/ContextMenu';
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
  const { shortcuts, capturing } = useShortcuts();

  const refreshTagList = useCallback(() => {
    listTags()
      .then((t) => {
        setTags(t);
        onCount?.(t.length);
      })
      .catch((e) => setListError(String(e)));
    // onCount's identity changing on re-renders shouldn't retrigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    refreshTagList();
  }, [refreshTagList]);

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
      .then(setTag)
      .catch((e) => setDetailError(String(e)));
  }, [openTagId]);

  const assetById = useMemo(() => {
    const map = new Map<string, AssetSummary>();
    for (const a of tag?.assets ?? []) map.set(a.id, a);
    return map;
  }, [tag]);

  const flatIds = useMemo(() => (tag?.assets ?? []).map((a) => a.id), [tag]);

  const selectedAssets = useMemo(
    () => [...selected].map((id) => assetById.get(id)).filter((a): a is AssetSummary => !!a),
    [selected, assetById],
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

  const trashAssets = useCallback(
    async (ids: string[]) => {
      await deleteAssets(ids, false);
      removeAssetsLocal(ids);
    },
    [removeAssetsLocal],
  );

  const removeFromTag = useCallback(
    async (ids: string[]) => {
      if (!tag) return;
      await untagAssets(tag.id, ids);
      removeAssetsLocal(ids);
    },
    [tag, removeAssetsLocal],
  );

  const handleShowInFileManager = useCallback((asset: AssetSummary) => {
    if (!asset.originalPath) return;
    revealInFileManager(asset.originalPath).catch((e) => setEnqueueError(String(e)));
  }, []);

  const openIndex = openId ? flatIds.indexOf(openId) : -1;
  const openAsset = openId ? assetById.get(openId) ?? null : null;
  const stripAssets = useMemo(() => tag?.assets ?? [], [tag]);

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
    const asset = assetById.get(contextMenu.assetId);
    const targetIds = selected.size >= 2 ? [...selected] : asset ? [asset.id] : [];
    const items: ContextMenuItem[] = [];
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
    if (asset?.originalPath) {
      items.push({ label: 'Show in File Manager', onClick: () => handleShowInFileManager(asset) });
    }
    if (targetIds.length > 0) {
      const exportAssets = targetIds.map((id) => assetById.get(id)).filter((a): a is AssetSummary => !!a);
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
  }, [contextMenu, assetById, selected, removeFromTag, handleShowInFileManager, trashAssets]);

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
    }),
    [selectedAssets, openAsset],
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
          unsyncedCount={0}
          onSyncMetadata={() => {}}
          onDelete={() => setConfirmDeleteSelection(true)}
          canOpenInRawEditor={false}
          onOpenInRawEditor={() => {}}
          onAddToAlbum={() => setAddToAlbumTargets([...selected])}
          onAddToTag={() => setAddToTagTargets([...selected])}
          onRemoveFromTag={() => setConfirmRemoveSelection(true)}
        />
        </div>
      )}

      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <div ref={gridContainerRef} style={{ flex: loupeOn ? '0 0 33.333%' : 1, overflow: 'auto', minHeight: 0, padding: 16, background: 'var(--canvas)' }}>
          {tag.assets.length === 0 ? (
            <div style={{ color: 'var(--text-dimmer)', fontSize: 12.5 }}>
              No photos tagged yet — select photos anywhere and use "Add to Tag".
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fill, minmax(${thumbSize}px, 1fr))`, gap: 12 }}>
              {tag.assets.map((a) => (
                <AssetTile
                  key={a.id}
                  asset={a}
                  selected={selected.has(a.id)}
                  onToggleSelect={handleThumbClick}
                  onToggleOne={toggleOne}
                  onOpen={setOpenId}
                  onContextMenu={(assetId, x, y) => setContextMenu({ assetId, x, y })}
                  onRate={(id, rating) => commitEdit(id, { rating })}
                  loupeMode={loupeOn}
                  onHoverAsset={handleHoverAsset}
                />
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
