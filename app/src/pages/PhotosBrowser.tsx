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
}

const PhotosBrowser = forwardRef<PhotosBrowserHandle, {
  onTotalCount?: (n: number) => void;
  metaOpen: boolean;
  onCloseMetadata: () => void;
  filters: Filters;
}>(function PhotosBrowser({ onTotalCount, metaOpen, onCloseMetadata, filters }, ref) {
  const [buckets, setBuckets] = useState<TimeBucketInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
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
  const filteredAssetCache = useMemo(() => {
    const out: Record<string, AssetSummary[]> = {};
    for (const [key, assets] of Object.entries(assetCache)) {
      out[key] = assets
        .map((a) => ({ ...a, stack: stackByAssetId.get(a.id) ?? null, isRawOverride: overrideIds.has(a.id) }))
        .filter((a) => !isHiddenStackChild(a) && matchesFilters(a, deferredFilters));
    }
    return out;
  }, [assetCache, deferredFilters, stackByAssetId, overrideIds]);

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
  const assetByIdAll = useMemo(() => {
    const map = new Map<string, AssetSummary>();
    for (const assets of Object.values(assetCache)) {
      for (const a of assets) map.set(a.id, { ...a, stack: stackByAssetId.get(a.id) ?? null, isRawOverride: overrideIds.has(a.id) });
    }
    return map;
  }, [assetCache, stackByAssetId, overrideIds]);

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

  // Applied only after the server confirms the write - no optimistic update/
  // rollback dance, since a failed edit should just leave the UI as it was.
  const commitEdit = useCallback(
    async (id: string, patch: AssetMetadataPatch) => {
      await updateAssetMetadata([id], patch);
      patchAssetLocal(id, patch);
    },
    [patchAssetLocal],
  );

  // Bulk sibling of commitEdit - used by the grid's rating/favorite keyboard
  // shortcuts, which (unlike the Metadata panel's mouse-driven single-asset
  // editing) apply to the whole current selection at once.
  const commitEditMany = useCallback(
    async (ids: string[], patch: AssetMetadataPatch) => {
      await updateAssetMetadata(ids, patch);
      for (const id of ids) patchAssetLocal(id, patch);
    },
    [patchAssetLocal],
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

  const navigateOpen = (dir: 1 | -1) => {
    const ni = openIndex + dir;
    if (ni < 0 || ni >= flatIds.length) return;
    setOpenId(flatIds[ni]);
  };

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
    }),
    [selectAll, deselectAll, createStackForSelection, selected, toggleRawOverrideForSelection],
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
        .then((assets) => setAssetCache((c) => ({ ...c, [bucket.timeBucket]: assets })))
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
        onDeleteSelected={() => setConfirmDeleteSelection(true)}
        onStackSelected={() => createStackForSelection([...selected]).catch(() => {})}
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
  onDeleteSelected,
  onStackSelected,
}: {
  totalCount: number;
  selectedCount: number;
  thumbSize: number;
  onThumbSize: (n: number) => void;
  onDeleteSelected: () => void;
  onStackSelected: () => void;
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
      {selectedCount > 0 && (
        <div onClick={onDeleteSelected} style={{ cursor: 'default', color: '#ff8080' }}>
          Move to Trash
        </div>
      )}
      {selectedCount >= 2 && (
        <div onClick={onStackSelected} style={{ cursor: 'default' }}>
          Stack {selectedCount} Photos
        </div>
      )}
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

