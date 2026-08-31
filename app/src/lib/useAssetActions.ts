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

import { useCallback, useState } from 'react';
import {
  checkSidecarMetadata,
  evictThumbCacheForAsset,
  pasteImageProcessing,
  regenerateAssetThumbnail,
  revealInFileManager,
  rotateAsset,
  type AssetMetadataPatch,
  type AssetSummary,
  type MetadataEditTarget,
  type MetadataSyncQuery,
  type ProcessingJob,
  type UnsyncedMetadata,
} from './api';
import { bumpImageVersion } from './imageVersion';
import { isRawAsset, isVideoAsset } from './filters';
import { useClipboard, type CopiedProcessingSource } from './clipboard';
import { useLibraryStatus } from './libraryStatus';
import { useProcessingQueue } from './processingQueue';
import { useProcessingJobReconciliation } from './useProcessingJobReconciliation';

interface PasteProcessingTarget {
  id: string;
  originalPath: string | null;
}

export interface UseAssetActionsResult {
  copiedProcessingSource: CopiedProcessingSource | null;
  copiedMetadata: AssetMetadataPatch | null;
  // Asset id -> rating/description found in that asset's local sidecar or
  // embedded file that Immich doesn't have yet. Populated by scanUnsyncedMetadata.
  unsyncedMetadata: Map<string, UnsyncedMetadata>;
  // Asset ids known to currently have an ART/RawTherapee processing sidecar
  // on disk - piggybacked off the same scan as unsyncedMetadata.
  processingSidecarAssets: Set<string>;
  // Asset ids that have completed at least one sidecar scan, regardless of
  // its result - lets a caller tell "confirmed: no sidecar" apart from
  // "haven't checked yet" for an id absent from processingSidecarAssets.
  // See copyImageProcessingEntry.
  scannedForProcessingSidecar: Set<string>;
  // Runs the sidecar/embedded-metadata + processing-sidecar scan over
  // whatever asset list a page just fetched - call once per newly-loaded
  // batch (a bucket at a time for Photos/Folders, the whole list at once for
  // Albums/Tags/People/Search). `priority` (default false) routes the call
  // through the backend's separate interactive lane - pass true only for a
  // single-asset check tied directly to something the user just did (see
  // each page's "recheck effect"), not for an ambient/bulk batch.
  scanUnsyncedMetadata: (assets: AssetSummary[], priority?: boolean) => void;
  // Optimistic direct flip for a caller that already *knows* a sidecar now
  // exists (a just-completed Tweak Roundtrip/paste) rather than needing
  // scanUnsyncedMetadata's live re-check.
  markProcessingSidecar: (assetId: string) => void;
  handleCopyImageProcessing: (asset: AssetSummary) => void;
  handleCopyMetadata: (asset: AssetSummary) => void;
  // Takes the page's own commitEditMany rather than owning it - keeps this
  // hook constructor-independent of assetByIdAll/commitEdit* (both of which
  // are themselves derived from state this hook owns, unsyncedMetadata/
  // processingSidecarAssets - see the doc comment on useAssetActions below
  // for why that ordering matters).
  handlePasteMetadata: (ids: string[], commitEditMany: (ids: string[], patch: AssetMetadataPatch) => Promise<void>) => void;
  requestPasteImageProcessing: (ids: string[], assetByIdAll: Map<string, AssetSummary>) => void;
  // Non-null while the "Paste image processing?" confirm should be showing -
  // render a ConfirmDialog around this + confirmPasteImageProcessing/
  // cancelPasteImageProcessing, same shape as PhotosBrowser.tsx's original.
  pasteProcessingTargets: PasteProcessingTarget[] | null;
  cancelPasteImageProcessing: () => void;
  confirmPasteImageProcessing: () => Promise<void>;
  handleShowInFileManager: (asset: AssetSummary) => void;
  syncMetadata: (ids: string[], commitEdit: (id: string, patch: AssetMetadataPatch) => Promise<void>) => Promise<void>;
  // Batch rotate - new capability, not something any page had before. Loops
  // rotateAsset per eligible id (skips video/no-originalPath the same way
  // Viewer.tsx's single-asset handleRotate does) rather than a new backend
  // command, since rotate_asset is already single-file.
  rotateSelection: (ids: string[], clockwise: boolean, assetByIdAll: Map<string, AssetSummary>) => Promise<void>;
  rotatingIds: Set<string>;
}

// Whether/how "Copy Image Processing" should appear for a single asset -
// shared by every page's contextMenuItems/selectionBarActions and by
// Viewer.tsx's menuActions, replacing what used to be each call site's own
// `isRawAsset(asset) && asset.hasProcessingSidecar` check. That check alone
// can't distinguish "confirmed: no sidecar" from "haven't been scanned yet",
// so a photo whose bucket scan just hadn't landed (batched, behind a
// concurrency-limited permit pool - easy to lose the race against a
// right-click under real NFS latency) looked identical to one that
// genuinely has nothing to copy: the option was just silently absent, with
// no way to tell why, until the scan eventually landed and the menu
// (already-open ones included, via the normal recompute-on-state-change) put
// it back. This surfaces the in-between state instead of hiding it.
export function copyImageProcessingEntry(
  asset: AssetSummary,
  scannedForProcessingSidecar: Set<string>,
  handleCopyImageProcessing: (asset: AssetSummary) => void,
): { label: string; disabled?: boolean; onClick: () => void } | null {
  if (!isRawAsset(asset)) return null;
  if (asset.hasProcessingSidecar) {
    return { label: 'Copy Image Processing', onClick: () => handleCopyImageProcessing(asset) };
  }
  // No originalPath means scanUnsyncedMetadata can never scan this asset
  // (it filters those out before querying) - showing "(checking…)" forever
  // would be worse than today's silent omission, so this must fall through
  // to "confirmed: nothing to show" rather than "pending" in that case.
  if (!asset.originalPath || scannedForProcessingSidecar.has(asset.id)) return null;
  return { label: 'Copy Image Processing (checking…)', disabled: true, onClick: () => handleCopyImageProcessing(asset) };
}

// Shared by every page with a photo grid (Photos, Folders, Albums, People,
// Tags, Search Results) - Copy/Paste Image Processing, Copy/Paste Metadata,
// Sync Metadata from Sidecar, Show in File Manager, and batch Rotate were
// previously duplicated between PhotosBrowser.tsx/FoldersBrowser.tsx (and
// entirely absent on the other four pages). Extracted here the same way
// useStacking.ts already was for stacking, so a third+ consumer doesn't mean
// a third+ copy.
//
// Deliberately takes `assetByIdAll`/`commitEdit`/`commitEditMany` as
// call-time arguments on the specific functions that need them, rather than
// as constructor params like useStacking's `selected`/`setSelected` - unlike
// stacking, this hook's own `unsyncedMetadata`/`processingSidecarAssets`
// state is itself an *input* to every page's `assetByIdAll` (each page
// overlays them onto its raw asset cache to build it - see
// PhotosBrowser.tsx's filteredAssetCache/overlaidAssetCache), which are in
// turn inputs to that page's `commitEdit`/`commitEditMany`. Requiring those
// three as constructor params would force this hook to be called *after*
// them, creating a cycle. Deliberately does NOT own Headless Roundtrip - its
// ingestion path is deeply page-cache-specific (see the plan) and stays with
// Photos/Folders' own existing implementation.
export function useAssetActions({ onError }: { onError: (message: string) => void }): UseAssetActionsResult {
  const { copiedProcessingSource, setCopiedProcessingSource, copiedMetadata, setCopiedMetadata } = useClipboard();
  const { reportLocalMountAlert } = useLibraryStatus();

  const [unsyncedMetadata, setUnsyncedMetadata] = useState<Map<string, UnsyncedMetadata>>(new Map());
  const [processingSidecarAssets, setProcessingSidecarAssets] = useState<Set<string>>(new Set());
  // Every asset id that has completed at least one checkSidecarMetadata
  // round trip - regardless of the result. `processingSidecarAssets` above
  // only ever grows (it has no way to represent "checked, and there's
  // genuinely nothing there" - the backend omits an asset from `results`
  // entirely when it has no rating/description/sidecar gap at all), so on
  // its own a caller can't tell "confirmed: no sidecar" apart from "haven't
  // checked yet". That gap is exactly what let Copy Image Processing look
  // confidently absent for an asset whose scan just hadn't landed yet (it's
  // batched per bucket, behind a concurrency-limited permit pool, so under
  // real NFS latency a right-click can easily land before its own bucket's
  // scan even starts) - see each page's copyImageProcessingEntry usage.
  const [scannedForProcessingSidecar, setScannedForProcessingSidecar] = useState<Set<string>>(new Set());

  const scanUnsyncedMetadata = useCallback((assets: AssetSummary[], priority = false) => {
    const queries: MetadataSyncQuery[] = assets
      .filter((a) => a.originalPath)
      .map((a) => ({ assetId: a.id, originalPath: a.originalPath, currentRating: a.rating, currentDescription: a.description }));
    if (queries.length === 0) return;
    checkSidecarMetadata(queries, priority)
      .then((results) => {
        setUnsyncedMetadata((m) => {
          const withGap = results.filter((r) => r.rating !== null || r.description !== null);
          if (withGap.length === 0) return m;
          const next = new Map(m);
          for (const r of withGap) next.set(r.assetId, { rating: r.rating ?? undefined, description: r.description ?? undefined });
          return next;
        });
        setProcessingSidecarAssets((s) => {
          const withSidecar = results.filter((r) => r.hasProcessingSidecar);
          if (withSidecar.length === 0) return s;
          const next = new Set(s);
          for (const r of withSidecar) next.add(r.assetId);
          return next;
        });
        setScannedForProcessingSidecar((s) => {
          const next = new Set(s);
          for (const q of queries) next.add(q.assetId);
          return next;
        });
      })
      // Best-effort per its own doc comment (commands.rs) - a per-asset miss
      // is routine and silently produces no result, but a *rejected* call
      // (confirmed live: a timeout when the NFS-mounted library mount briefly
      // dropped out) previously vanished with zero signal, silently leaving
      // Copy Image Processing/Sync Metadata looking permanently unavailable
      // for whatever was mid-scan with no way to tell why. Routed through
      // the same connection-status pill every other library-connectivity
      // problem already surfaces through, rather than a banner - this scan
      // reruns on its own next time the asset is selected/right-clicked (see
      // each page's "recheck effect"), so a blink is enough; it doesn't need
      // a standing error the user has to dismiss.
      .catch((e) => {
        reportLocalMountAlert(String(e));
        // Still mark these ids as scanned on failure, same as a completed
        // scan that found nothing - otherwise copyImageProcessingEntry's
        // "(checking…)" state is stuck forever instead of falling back to
        // "confirmed: nothing to show" (matching this call's pre-existing
        // silent-failure behavior). The recheck effect already re-fires this
        // scan next time the asset is selected/right-clicked, so a failed
        // attempt isn't a dead end.
        setScannedForProcessingSidecar((s) => {
          const next = new Set(s);
          for (const q of queries) next.add(q.assetId);
          return next;
        });
      });
  }, [reportLocalMountAlert]);

  const markProcessingSidecar = useCallback((assetId: string) => {
    setProcessingSidecarAssets((s) => (s.has(assetId) ? s : new Set(s).add(assetId)));
  }, []);

  const handleCopyImageProcessing = useCallback(
    (asset: AssetSummary) => {
      if (!asset.originalPath) return;
      const originalPath = asset.originalPath;
      // Optimistic instant UI from the passively-cached flag, but the live
      // re-check below is the actual source of truth and always runs - a
      // stale-false cache read must never be trusted to *rule out* a copy.
      if (asset.hasProcessingSidecar) {
        setCopiedProcessingSource({ assetId: asset.id, originalPath, fileName: asset.fileName, tools: asset.processingSidecarTools ?? [] });
      }
      checkSidecarMetadata([{ assetId: asset.id, originalPath, currentRating: asset.rating, currentDescription: asset.description }], true)
        .then(([result]) => {
          if (result?.hasProcessingSidecar) {
            setCopiedProcessingSource({ assetId: asset.id, originalPath, fileName: asset.fileName, tools: result.processingSidecarTools });
          }
        })
        .catch(() => {});
    },
    [setCopiedProcessingSource],
  );

  const handleCopyMetadata = useCallback(
    (asset: AssetSummary) => {
      setCopiedMetadata({ rating: asset.rating ?? undefined, isFavorite: asset.isFavorite, description: asset.description ?? undefined });
    },
    [setCopiedMetadata],
  );

  const handlePasteMetadata = useCallback(
    (ids: string[], commitEditMany: (ids: string[], patch: AssetMetadataPatch) => Promise<void>) => {
      if (!copiedMetadata || ids.length === 0) return;
      commitEditMany(ids, copiedMetadata).catch(() => {});
    },
    [copiedMetadata],
  );

  // RAW-only - a non-RAW target has no processing-sidecar concept at all, so
  // filtering here (rather than leaving it to the backend) also means the
  // confirm dialog's "N photo(s)" count already reflects what's really about
  // to be pasted onto. originalPath is captured now (not re-looked-up at
  // confirm time) so confirmPasteImageProcessing doesn't need assetByIdAll.
  const [pasteProcessingTargets, setPasteProcessingTargets] = useState<PasteProcessingTarget[] | null>(null);
  const requestPasteImageProcessing = useCallback(
    (ids: string[], assetByIdAll: Map<string, AssetSummary>) => {
      if (!copiedProcessingSource) return;
      const rawTargets = ids
        .map((id) => assetByIdAll.get(id))
        .filter((a): a is AssetSummary => !!a && isRawAsset(a))
        .map((a) => ({ id: a.id, originalPath: a.originalPath }));
      if (rawTargets.length === 0) return;
      setPasteProcessingTargets(rawTargets);
    },
    [copiedProcessingSource],
  );
  const cancelPasteImageProcessing = useCallback(() => setPasteProcessingTargets(null), []);

  const { jobs: processingJobs, refresh: refreshProcessingQueue } = useProcessingQueue();
  const reconcileProcessingJob = useCallback(
    (job: ProcessingJob) => {
      if (job.status === 'failed') {
        onError(job.error ?? "Couldn't paste image processing onto a photo.");
        return;
      }
      setProcessingSidecarAssets((s) => (s.has(job.targetAssetId) ? s : new Set(s).add(job.targetAssetId)));
    },
    [onError],
  );
  const { trackJobs: trackProcessingJobs } = useProcessingJobReconciliation(processingJobs, reconcileProcessingJob);

  const confirmPasteImageProcessing = useCallback(async () => {
    if (!copiedProcessingSource || !pasteProcessingTargets) return;
    const targets: MetadataEditTarget[] = pasteProcessingTargets.map((t) => ({ id: t.id, originalPath: t.originalPath }));
    const jobIds = await pasteImageProcessing(copiedProcessingSource.originalPath, targets);
    trackProcessingJobs(jobIds);
    refreshProcessingQueue();
  }, [copiedProcessingSource, pasteProcessingTargets, trackProcessingJobs, refreshProcessingQueue]);

  const handleShowInFileManager = useCallback(
    (asset: AssetSummary) => {
      if (!asset.originalPath) return;
      revealInFileManager(asset.originalPath).catch((e) => onError(String(e)));
    },
    [onError],
  );

  const syncMetadata = useCallback(
    async (ids: string[], commitEdit: (id: string, patch: AssetMetadataPatch) => Promise<void>) => {
      for (const id of ids) {
        const gap = unsyncedMetadata.get(id);
        if (!gap) continue;
        const patch: AssetMetadataPatch = {};
        if (gap.rating !== undefined) patch.rating = gap.rating;
        if (gap.description !== undefined) patch.description = gap.description;
        await commitEdit(id, patch);
      }
      setUnsyncedMetadata((m) => {
        const next = new Map(m);
        for (const id of ids) next.delete(id);
        return next;
      });
    },
    [unsyncedMetadata],
  );

  const [rotatingIds, setRotatingIds] = useState<Set<string>>(new Set());
  const rotateSelection = useCallback(async (ids: string[], clockwise: boolean, assetByIdAll: Map<string, AssetSummary>) => {
    const targets = ids.filter((id) => {
      const a = assetByIdAll.get(id);
      return !!a && !!a.originalPath && !isVideoAsset(a);
    });
    if (targets.length === 0) return;
    setRotatingIds((s) => new Set([...s, ...targets]));
    try {
      for (const id of targets) {
        const originalPath = assetByIdAll.get(id)!.originalPath;
        try {
          await rotateAsset(originalPath, clockwise);
          bumpImageVersion(id);
          evictThumbCacheForAsset(id).catch(() => {});
          regenerateAssetThumbnail(id).catch(() => {});
        } catch (e) {
          onError(String(e));
        }
      }
    } finally {
      setRotatingIds((s) => {
        const next = new Set(s);
        for (const id of targets) next.delete(id);
        return next;
      });
    }
  }, [onError]);

  return {
    copiedProcessingSource,
    copiedMetadata,
    unsyncedMetadata,
    processingSidecarAssets,
    scannedForProcessingSidecar,
    scanUnsyncedMetadata,
    markProcessingSidecar,
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
  };
}
