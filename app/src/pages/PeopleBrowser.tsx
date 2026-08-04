import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  deleteAssets,
  getPerson,
  listPeople,
  personThumbnailSrc,
  renamePerson,
  revealInFileManager,
  updateAssetMetadata,
  type AssetMetadataPatch,
  type AssetSummary,
  type EditJob,
  type MetadataEditTarget,
  type PersonDetail,
  type PersonSummary,
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

export interface PeopleBrowserHandle {
  openExportToFolder: () => void;
  openExportToFlickr: () => void;
}

// Real Immich people (GET /people, GET /people/{id}, PUT /people/{id}) - the
// people themselves come entirely from Immich's own server-side face
// recognition; ImmAture only lists/renames them and browses their photos,
// same trimmed-down relationship to Photos/Folders' full feature set that
// AlbumsBrowser.tsx has (no Stacks, Smart Stack, ART round trip, or Copy/
// Paste Image Processing/Metadata here). Unlike Albums, there's no create/
// delete here (a person isn't a container ImmAture owns) and no "remove this
// asset from this person" action (that's a face-recognition correction, out
// of scope) - Delete therefore means Move to Trash here, the same as Photos/
// Folders, rather than AlbumsBrowser's special-cased "remove from album".
const PeopleBrowser = forwardRef<PeopleBrowserHandle, {
  metaOpen: boolean;
  onCloseMetadata: () => void;
  // Number of people, for the sidebar row - only meaningful in the list view.
  onCount?: (n: number) => void;
  active?: boolean;
}>(function PeopleBrowser({
  metaOpen,
  onCloseMetadata,
  onCount,
  active = true,
}, ref) {
  const [people, setPeople] = useState<PersonSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [renamingPerson, setRenamingPerson] = useState<PersonSummary | null>(null);

  const [openPersonId, setOpenPersonId] = useState<string | null>(null);
  const [person, setPerson] = useState<PersonDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
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

  const refreshPeopleList = useCallback(() => {
    listPeople()
      .then((p) => {
        setPeople(p);
        onCount?.(p.length);
      })
      .catch((e) => setListError(String(e)));
    // onCount's identity changing on re-renders shouldn't retrigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    refreshPeopleList();
  }, [refreshPeopleList]);

  // Re-fetches the people list whenever navigating back from a detail view -
  // a rename while inside one can change a name the list needs to reflect on
  // return.
  useEffect(() => {
    if (openPersonId === null) refreshPeopleList();
  }, [openPersonId, refreshPeopleList]);

  useEffect(() => {
    if (!openPersonId) {
      setPerson(null);
      return;
    }
    setPerson(null);
    setDetailError(null);
    setSelected(new Set());
    getPerson(openPersonId)
      .then(setPerson)
      .catch((e) => setDetailError(String(e)));
  }, [openPersonId]);

  const assetById = useMemo(() => {
    const map = new Map<string, AssetSummary>();
    for (const a of person?.assets ?? []) map.set(a.id, a);
    return map;
  }, [person]);

  const flatIds = useMemo(() => (person?.assets ?? []).map((a) => a.id), [person]);

  const selectedAssets = useMemo(
    () => [...selected].map((id) => assetById.get(id)).filter((a): a is AssetSummary => !!a),
    [selected, assetById],
  );
  const allSelectedFavorited = selectedAssets.length > 0 && selectedAssets.every((a) => a.isFavorite);

  const patchAssetLocal = useCallback((id: string, patch: Partial<AssetSummary>) => {
    setPerson((p) => {
      if (!p) return p;
      const idx = p.assets.findIndex((x) => x.id === id);
      if (idx === -1) return p;
      const next = p.assets.slice();
      next[idx] = { ...next[idx], ...patch };
      return { ...p, assets: next };
    });
  }, []);

  const removeAssetsLocal = useCallback((ids: string[]) => {
    const idSet = new Set(ids);
    setPerson((p) => (p ? { ...p, assets: p.assets.filter((x) => !idSet.has(x.id)) } : p));
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
  const stripAssets = useMemo(() => person?.assets ?? [], [person]);

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
      // Matches Photos/Folders/Albums' File-menu export handlers: the current
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
    if (!openPersonId || openId || !active) return;
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
  }, [openPersonId, openId, active, selectAll, deselectAll, selected, shortcuts, capturing, commitEditMany, toggleFavoriteForSelection, setAddToTagTargets]);

  // ---------- People list view ----------
  if (!openPersonId) {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ flex: 1, overflow: 'auto', padding: 20 }}>
          {listError && <div style={{ color: 'var(--danger)', fontSize: 13, marginBottom: 12 }}>Couldn't load people — {listError}.</div>}
          {!people && !listError && <div style={{ color: 'var(--text-dim)', fontSize: 13 }}>Loading people…</div>}
          {people && people.length === 0 && !listError && (
            <div style={{ color: 'var(--text-dimmer)', fontSize: 13 }}>
              No people yet — Immich finds people by recognizing faces in your library; check back once it has.
            </div>
          )}
          {people && people.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 16 }}>
              {people.map((p) => (
                <PersonCard key={p.id} person={p} onOpen={() => setOpenPersonId(p.id)} onRename={() => setRenamingPerson(p)} />
              ))}
            </div>
          )}
        </div>

        {renamingPerson && (
          <RenamePersonDialog
            person={renamingPerson}
            onClose={() => setRenamingPerson(null)}
            onRenamed={() => {
              setRenamingPerson(null);
              refreshPeopleList();
            }}
          />
        )}
      </div>
    );
  }

  // ---------- Person detail view ----------
  if (detailError) {
    return (
      <div style={{ padding: 24, color: 'var(--text-dim)' }}>
        Couldn't load this person — {detailError}.{' '}
        <span onClick={() => setOpenPersonId(null)} style={{ color: 'var(--accent)', cursor: 'default' }}>
          Back to People
        </span>
      </div>
    );
  }

  if (!person) {
    return <div style={{ padding: 24, color: 'var(--text-dim)' }}>Loading person…</div>;
  }

  const displayName = person.name || 'Unnamed person';

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, position: 'relative' }}>
      {enqueueError && <InlineWarningBanner message={enqueueError} onDismiss={() => setEnqueueError(null)} />}
      <div style={{ flexShrink: 0, height: 46, display: 'flex', alignItems: 'center', gap: 10, padding: '0 16px', borderBottom: '1px solid rgba(0,0,0,0.3)' }}>
        <div onClick={() => setOpenPersonId(null)} style={{ cursor: 'default', color: 'var(--accent)', fontSize: 13 }}>
          ← People
        </div>
        <div style={{ width: 1, height: 18, background: 'rgba(255,255,255,0.15)' }} />
        <span style={{ fontSize: 14, fontWeight: 700, fontStyle: person.name ? 'normal' : 'italic', opacity: person.name ? 1 : 0.7 }}>{displayName}</span>
        <span style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.4)' }}>
          {person.assets.length} photo{person.assets.length === 1 ? '' : 's'}
        </span>
        <div style={{ flex: 1 }} />
        <BarTextButton onClick={() => setRenamingPerson({ id: person.id, name: person.name, assetCount: person.assets.length })}>
          {person.name ? 'Rename' : 'Name…'}
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
        />
        </div>
      )}

      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <div style={{ flex: 1, overflow: 'auto', minHeight: 0, padding: 16 }}>
          {person.assets.length === 0 ? (
            <div style={{ color: 'var(--text-dimmer)', fontSize: 12.5 }}>No photos of this person yet.</div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(168px, 1fr))', gap: 12 }}>
              {person.assets.map((a) => (
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
      {renamingPerson && (
        <RenamePersonDialog
          person={renamingPerson}
          onClose={() => setRenamingPerson(null)}
          onRenamed={(name) => {
            setRenamingPerson(null);
            setPerson((p) => (p ? { ...p, name } : p));
          }}
        />
      )}
    </div>
  );
});

export default PeopleBrowser;

function PersonCard({
  person,
  onOpen,
  onRename,
}: {
  person: PersonSummary;
  onOpen: () => void;
  onRename: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      onClick={onOpen}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ cursor: 'default' }}
    >
      <div style={{ aspectRatio: '1 / 1', borderRadius: '50%', overflow: 'hidden', position: 'relative', background: '#222', boxShadow: '0 0 0 1px rgba(255,255,255,0.07)' }}>
        <img src={personThumbnailSrc(person.id)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        {hovered && (
          <div style={{ position: 'absolute', top: 6, right: 6, display: 'flex', gap: 5 }}>
            <div
              onClick={(e) => {
                e.stopPropagation();
                onRename();
              }}
              title={person.name ? 'Rename' : 'Name…'}
              style={pillIconStyle}
            >
              ✎
            </div>
          </div>
        )}
      </div>
      <div
        style={{
          marginTop: 8,
          fontSize: 13,
          fontWeight: 600,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          textAlign: 'center',
          fontStyle: person.name ? 'normal' : 'italic',
          opacity: person.name ? 1 : 0.7,
        }}
      >
        {person.name || 'Unnamed person'}
      </div>
      <div style={{ fontSize: 11.5, color: 'rgba(255,255,255,0.45)', textAlign: 'center' }}>
        {person.assetCount} photo{person.assetCount === 1 ? '' : 's'}
      </div>
    </div>
  );
}

function RenamePersonDialog({
  person,
  onClose,
  onRenamed,
}: {
  person: PersonSummary;
  onClose: () => void;
  onRenamed: (name: string) => void;
}) {
  const [name, setName] = useState(person.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isNaming = !person.name;

  async function handleSave() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      await renamePerson(person.id, trimmed);
      onRenamed(trimmed);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={busy ? undefined : onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 360, maxWidth: '92%', background: '#242424', borderRadius: 14, boxShadow: '0 24px 70px rgba(0,0,0,0.7)', border: '1px solid rgba(255,255,255,0.08)', padding: 20 }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 14 }}>{isNaming ? 'Name This Person' : 'Rename Person'}</div>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSave();
          }}
          placeholder="Name…"
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
    <div onClick={onClick} style={{ fontSize: 12.5, cursor: 'default', color: danger ? '#ff8080' : 'rgba(255,255,255,0.75)', padding: '0 6px' }}>
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
  background: 'rgba(0,0,0,0.3)',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 9,
  color: '#fff',
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
  border: '1px solid rgba(255,255,255,0.14)',
  background: 'rgba(255,255,255,0.06)',
  color: '#fff',
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
