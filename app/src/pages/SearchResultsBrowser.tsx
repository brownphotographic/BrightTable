import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import {
  deleteAssets,
  revealInFileManager,
  searchAssets,
  updateAssetMetadata,
  type AssetMetadataPatch,
  type AssetSummary,
  type EditJob,
  type MetadataEditTarget,
} from '../lib/api';
import AssetTile, { type ClickMods } from '../components/AssetTile';
import SelectionBar from '../components/SelectionBar';
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
}

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
  const [addToAlbumTargets, setAddToAlbumTargets] = useState<string[] | null>(null);
  const [addToTagTargets, setAddToTagTargets] = useState<string[] | null>(null);
  const [exportFolderAssets, setExportFolderAssets] = useState<AssetSummary[] | null>(null);
  const [exportFlickrAssets, setExportFlickrAssets] = useState<AssetSummary[] | null>(null);
  const { shortcuts, capturing } = useShortcuts();

  useEffect(() => {
    setAssets(null);
    setError(null);
    setSelected(new Set());
    searchAssets(query)
      .then(setAssets)
      .catch((e) => setError(String(e)));
  }, [query]);

  const assetById = useMemo(() => {
    const map = new Map<string, AssetSummary>();
    for (const a of assets ?? []) map.set(a.id, a);
    return map;
  }, [assets]);

  const flatIds = useMemo(() => (assets ?? []).map((a) => a.id), [assets]);

  const selectedAssets = useMemo(
    () => [...selected].map((id) => assetById.get(id)).filter((a): a is AssetSummary => !!a),
    [selected, assetById],
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

  const trashAssets = useCallback(
    async (ids: string[]) => {
      await deleteAssets(ids, false);
      removeAssetsLocal(ids);
    },
    [removeAssetsLocal],
  );

  const handleShowInFileManager = useCallback((asset: AssetSummary) => {
    if (!asset.originalPath) return;
    revealInFileManager(asset.originalPath).catch((e) => setEnqueueError(String(e)));
  }, []);

  const openIndex = openId ? flatIds.indexOf(openId) : -1;
  const openAsset = openId ? assetById.get(openId) ?? null : null;
  const stripAssets = assets ?? [];

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
  }, [contextMenu, assetById, selected, handleShowInFileManager, trashAssets]);

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
    }),
    [selectedAssets, openAsset],
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

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, position: 'relative' }}>
      {enqueueError && <InlineWarningBanner message={enqueueError} onDismiss={() => setEnqueueError(null)} />}
      <div style={{ flexShrink: 0, height: 46, display: 'flex', alignItems: 'center', gap: 10, padding: '0 16px', borderBottom: '1px solid rgba(0,0,0,0.3)' }}>
        <div onClick={onClose} style={{ cursor: 'default', color: 'var(--accent)', fontSize: 13 }}>
          ✕ Close Search
        </div>
        <div style={{ width: 1, height: 18, background: 'rgba(255,255,255,0.15)' }} />
        <span style={{ fontSize: 14, fontWeight: 700 }}>"{query}"</span>
        {assets && (
          <span style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.4)' }}>
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
          unsyncedCount={0}
          onSyncMetadata={() => {}}
          onDelete={() => setConfirmDeleteSelection(true)}
          canOpenInRawEditor={false}
          onOpenInRawEditor={() => {}}
          onAddToAlbum={() => setAddToAlbumTargets([...selected])}
          onAddToTag={() => setAddToTagTargets([...selected])}
        />
        </div>
      )}

      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <div style={{ flex: 1, overflow: 'auto', minHeight: 0, padding: 16 }}>
          {error && <div style={{ color: 'var(--danger)', fontSize: 13 }}>Couldn't search — {error}.</div>}
          {!assets && !error && <div style={{ color: 'var(--text-dim)', fontSize: 13 }}>Searching…</div>}
          {assets && assets.length === 0 && !error && (
            <div style={{ color: 'var(--text-dimmer)', fontSize: 12.5 }}>No photos matched "{query}".</div>
          )}
          {assets && assets.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(168px, 1fr))', gap: 12 }}>
              {assets.map((a) => (
                <AssetTile
                  key={a.id}
                  asset={a}
                  selected={selected.has(a.id)}
                  onToggleSelect={handleThumbClick}
                  onToggleOne={toggleOne}
                  onOpen={setOpenId}
                  onContextMenu={(assetId, x, y) => setContextMenu({ assetId, x, y })}
                  onRate={(id, rating) => commitEdit(id, { rating })}
                />
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
