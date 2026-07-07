import { forwardRef, useCallback, useDeferredValue, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  createStack,
  deleteAssets,
  deleteStack,
  getStack,
  getTimelineBuckets,
  getTimelineBucketAssets,
  listStacks,
  setStackPick,
  updateAssetMetadata,
  type AssetMetadataPatch,
  type AssetStackInfo,
  type AssetSummary,
  type TimeBucketInfo,
} from '../lib/api';
import Viewer from '../components/Viewer';
import AssetTile, { type ClickMods } from '../components/AssetTile';
import StackBand from '../components/StackBand';
import ContextMenu, { type ContextMenuItem } from '../components/ContextMenu';
import SmartStackDialog from '../components/SmartStackDialog';
import MetadataPanel from '../components/MetadataPanel';
import ConfirmDialog from '../components/ConfirmDialog';
import { isTypingTarget, matchesShortcut, useShortcuts, type ShortcutId } from '../lib/shortcuts';
import { matchesFilters, type Filters } from '../lib/filters';
import { isHiddenStackChild } from '../lib/stacks';
import type { SmartStackGroup } from '../lib/smartStack';
import { useRawOverrides } from '../lib/rawOverrides';
import { pendingStyle } from '../lib/pending';

const COLUMNS_GUESS = 6;
const THUMB_SIZE = 168;
const ROW_HEIGHT_GUESS = Math.round((THUMB_SIZE * 2) / 3) + 12;

// "2024-06-01" -> "06 — June"
function monthNodeLabel(timeBucket: string): string {
  const mm = timeBucket.slice(5, 7);
  const date = new Date(2000, parseInt(mm, 10) - 1, 1);
  return `${mm} — ${date.toLocaleDateString(undefined, { month: 'long' })}`;
}

export interface FoldersBrowserHandle {
  selectAll: () => void;
  deselectAll: () => void;
  stackSelected: () => void;
  openSmartStack: () => void;
  toggleRawOverrideForSelection: () => void;
}

// Immich doesn't expose real filesystem folders for camera-imported assets -
// like the design prototype, this reinterprets "Folders" as a Year > Month
// tree over the same timeline buckets the Photos view uses, letting you jump
// straight to a month (or a whole year, or everything) as a flat grid instead
// of the Photos view's continuously-scrolling day-grouped timeline.
const FoldersBrowser = forwardRef<FoldersBrowserHandle, {
  metaOpen: boolean;
  onCloseMetadata: () => void;
  filters: Filters;
}>(function FoldersBrowser({ metaOpen, onCloseMetadata, filters }, ref) {
  const [buckets, setBuckets] = useState<TimeBucketInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedYears, setExpandedYears] = useState<Record<string, boolean>>({});
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
    getTimelineBuckets()
      .then((b) => {
        setBuckets(b);
        if (b.length) setExpandedYears({ [b[0].timeBucket.slice(0, 4)]: true });
      })
      .catch((e) => setError(String(e)));
  }, []);

  const yearGroups = useMemo(() => {
    const map = new Map<string, TimeBucketInfo[]>();
    for (const b of buckets ?? []) {
      const year = b.timeBucket.slice(0, 4);
      if (!map.has(year)) map.set(year, []);
      map.get(year)!.push(b);
    }
    return [...map.entries()];
  }, [buckets]);

  const totalCount = useMemo(() => (buckets ?? []).reduce((sum, b) => sum + b.count, 0), [buckets]);

  // Which buckets feed the currently selected tree node - "all" is every
  // bucket, a year id is that year's month buckets, anything else is a single
  // leaf month bucket (its own time_bucket key).
  const activeBucketKeys = useMemo(() => {
    if (!buckets) return [];
    if (selectedNode === 'all') return buckets.map((b) => b.timeBucket);
    if (/^\d{4}$/.test(selectedNode)) {
      return buckets.filter((b) => b.timeBucket.slice(0, 4) === selectedNode).map((b) => b.timeBucket);
    }
    return [selectedNode];
  }, [buckets, selectedNode]);

  const bucketCountByKey = useMemo(() => {
    const map = new Map<string, number>();
    for (const b of buckets ?? []) map.set(b.timeBucket, b.count);
    return map;
  }, [buckets]);

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
  const filteredAssetCache = useMemo(() => {
    const out: Record<string, AssetSummary[]> = {};
    for (const [key, assets] of Object.entries(assetCache)) {
      out[key] = assets
        .map((a) => ({ ...a, stack: stackByAssetId.get(a.id) ?? null, isRawOverride: overrideIds.has(a.id) }))
        .filter((a) => !isHiddenStackChild(a) && matchesFilters(a, deferredFilters));
    }
    return out;
  }, [assetCache, deferredFilters, stackByAssetId, overrideIds]);

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
  const assetByIdAll = useMemo(() => {
    const map = new Map<string, AssetSummary>();
    for (const assets of Object.values(assetCache)) {
      for (const a of assets) map.set(a.id, { ...a, stack: stackByAssetId.get(a.id) ?? null, isRawOverride: overrideIds.has(a.id) });
    }
    return map;
  }, [assetCache, stackByAssetId, overrideIds]);

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

  const commitEdit = useCallback(
    async (id: string, patch: AssetMetadataPatch) => {
      await updateAssetMetadata([id], patch);
      patchAssetLocal(id, patch);
    },
    [patchAssetLocal],
  );

  const commitEditMany = useCallback(
    async (ids: string[], patch: AssetMetadataPatch) => {
      await updateAssetMetadata(ids, patch);
      for (const id of ids) patchAssetLocal(id, patch);
    },
    [patchAssetLocal],
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
    return items;
  }, [contextMenu, assetById, selected, createStackForSelection, unstackByStackId]);

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
    }),
    [selectAll, deselectAll, createStackForSelection, selected, toggleRawOverrideForSelection],
  );

  // Switching tree nodes starts from a fresh scroll position and selection -
  // otherwise a selection made in one month could look like it silently
  // carried over into an unrelated one.
  useEffect(() => {
    setSelected(new Set());
    containerRef.current?.scrollTo(0, 0);
  }, [selectedNode]);

  useEffect(() => {
    if (openId) return;
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
        const ids = [...selected];
        const allFav = selectedAssets.every((a) => a.isFavorite);
        commitEditMany(ids, { isFavorite: !allFav }).catch(() => {});
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
  }, [openId, selectAll, deselectAll, selected, selectedAssets, shortcuts, capturing, commitEditMany, createStackForSelection]);

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

  const virtualizer = useVirtualizer({
    count: activeBucketKeys.length,
    getScrollElement: () => containerRef.current,
    estimateSize: (index) => {
      const count = bucketCountByKey.get(activeBucketKeys[index]) ?? 0;
      const rows = Math.ceil(count / COLUMNS_GUESS);
      return rows * ROW_HEIGHT_GUESS;
    },
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
      getTimelineBucketAssets(key)
        .then((assets) => setAssetCache((c) => ({ ...c, [key]: assets })))
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

  if (!buckets) {
    return <div style={{ padding: 24, color: 'var(--text-dim)' }}>Loading folders…</div>;
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <div style={{ width: 208, flexShrink: 0, borderRight: '1px solid rgba(0,0,0,0.35)', padding: '10px 8px', overflow: 'auto' }}>
          <TreeRow
            label="All Originals"
            count={totalCount}
            depth={0}
            selected={selectedNode === 'all'}
            hasChildren={false}
            onSelect={() => setSelectedNode('all')}
          />
          {yearGroups.map(([year, monthBuckets]) => (
            <div key={year}>
              <TreeRow
                label={year}
                count={monthBuckets.reduce((sum, b) => sum + b.count, 0)}
                depth={0}
                selected={selectedNode === year}
                hasChildren
                expanded={!!expandedYears[year]}
                onSelect={() => setSelectedNode(year)}
                onToggle={() => setExpandedYears((e) => ({ ...e, [year]: !e[year] }))}
              />
              {expandedYears[year] &&
                monthBuckets.map((b) => (
                  <TreeRow
                    key={b.timeBucket}
                    label={monthNodeLabel(b.timeBucket)}
                    count={b.count}
                    depth={1}
                    selected={selectedNode === b.timeBucket}
                    hasChildren={false}
                    onSelect={() => setSelectedNode(b.timeBucket)}
                  />
                ))}
            </div>
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
        {selected.size > 0 && (
          <div onClick={() => setConfirmDeleteSelection(true)} style={{ cursor: 'default', color: '#ff8080' }}>
            Move to Trash
          </div>
        )}
        {selected.size >= 2 && (
          <div onClick={() => createStackForSelection([...selected]).catch(() => {})} style={{ cursor: 'default' }}>
            Stack {selected.size} Photos
          </div>
        )}
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
  count,
  depth,
  selected,
  hasChildren,
  expanded,
  onSelect,
  onToggle,
}: {
  label: string;
  count: number;
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
      <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>{count}</span>
    </div>
  );
}
