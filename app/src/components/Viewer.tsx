import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getStack,
  launchArtRoundTrip,
  launchEditor,
  openVideoExternally,
  pasteImageProcessing,
  revealInFileManager,
  thumbnailSrc,
  type AssetMetadataPatch,
  type AssetSummary,
  type MetadataEditTarget,
  type ProcessingJob,
} from '../lib/api';
import { decodeThumbHash } from '../lib/thumbhash';
import { formatDims, formatSize } from '../lib/exifFormat';
import MetadataRows, { Star } from './MetadataRows';
import ConfirmDialog from './ConfirmDialog';
import { isTypingTarget, matchesShortcut, useShortcuts } from '../lib/shortcuts';
import { overlayRawOverrides, useRawOverrides } from '../lib/rawOverrides';
import { isOriginalZoomable, isRawAsset, isVideoAsset } from '../lib/filters';
import { useApplications } from '../lib/applications';
import { useClipboard } from '../lib/clipboard';
import { useNoSidecarChoice } from '../lib/useNoSidecarChoice';
import { useProcessingQueue } from '../lib/processingQueue';
import { useProcessingJobReconciliation } from '../lib/useProcessingJobReconciliation';

const MIN_ZOOM = 25;
const MAX_ZOOM = 400;
const LOUPE_SIZE = 220;
const LOUPE_MAGNIFICATION = 3;

// Where the image actually renders inside a same-aspect-agnostic box under
// object-fit: contain - needed to map cursor position to image-content
// coordinates for the loupe, and to keep the math correct for any photo's
// aspect ratio (portrait, panorama, etc).
function containRect(boxW: number, boxH: number, natW: number, natH: number) {
  const boxAspect = boxW / boxH;
  const imgAspect = natW / natH;
  let w: number, h: number;
  if (imgAspect > boxAspect) {
    w = boxW;
    h = boxW / imgAspect;
  } else {
    h = boxH;
    w = boxH * imgAspect;
  }
  return { w, h, x: (boxW - w) / 2, y: (boxH - h) / 2 };
}

// MediaError.code is 1-4 (MEDIA_ERR_ABORTED/NETWORK/DECODE/SRC_NOT_SUPPORTED),
// with no further standard detail - but WebKitGTK on Linux is one of the few
// engines that also populates the non-standard `.message` with the actual
// underlying platform diagnostic (often lifted straight from GStreamer, e.g.
// naming the specific missing plugin or element), so it's surfaced here
// verbatim rather than collapsed into one generic sentence per code - the
// generic sentence alone wasn't enough to tell a genuinely-unsupported codec
// apart from, say, GStreamer failing to even resolve the `immich-thumb://`
// source scheme.
function describeVideoError(error: MediaError | null): string {
  const detail = error?.message ? ` (${error.message})` : '';
  switch (error?.code) {
    case MediaError.MEDIA_ERR_NETWORK:
      return `Couldn't download the video - check the connection to your Immich server.${detail}`;
    case MediaError.MEDIA_ERR_DECODE:
      return `Could not decode this video.${detail}`;
    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
      return `This video's format/source isn't supported.${detail}`;
    default:
      return `Could not play this video.${detail}`;
  }
}

function headerButtonStyle(active: boolean) {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 7,
    height: 30,
    padding: '0 13px',
    borderRadius: 8,
    fontSize: 12.5,
    cursor: 'default',
    background: active ? '#3584e4' : 'rgba(255,255,255,0.08)',
  } as const;
}

export default function Viewer({
  asset,
  hasPrev,
  hasNext,
  onClose,
  onPrev,
  onNext,
  stripAssets,
  onSelect,
  onEdit,
  onDelete,
  onUnstack,
  onSetStackPick,
  onOpenApplicationsPreferences,
  onArtRoundTripQueued,
  onProcessingSidecarCreated,
  onPrint,
}: {
  asset: AssetSummary;
  hasPrev: boolean;
  hasNext: boolean;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  stripAssets: AssetSummary[];
  onSelect: (id: string) => void;
  onEdit: (id: string, patch: AssetMetadataPatch) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  // Only present when the open asset is a stack's pick with other members -
  // omitted (no button shown) otherwise.
  onUnstack?: () => Promise<void>;
  onSetStackPick?: (assetId: string, memberIds: string[]) => Promise<void>;
  // Opens Preferences straight to the Applications tab - used when the user
  // clicks an editor button with no app chosen for that role yet.
  onOpenApplicationsPreferences?: () => void;
  // Fired once the ART CLI round trip (Variant 1) has handed its export off
  // to the background ArtQueue (see launch_art_round_trip's doc comment) -
  // the parent (PhotosBrowser/FoldersBrowser) tracks jobId via its own
  // trackArtJobs the same way it already does for a Variant 2 (Headless RAW
  // Roundtrip) job, applying the outcome to its assetCache/stackByAssetId
  // once the job actually settles rather than while this call is in flight.
  onArtRoundTripQueued?: (jobId: number) => void;
  // Fired once a Paste Image Processing job started from this viewer
  // actually settles as `done` - lets the parent (PhotosBrowser/
  // FoldersBrowser) mark the target as having a sidecar in its own
  // processingSidecarAssets cache, the same way a round trip does. Without
  // this, hasProcessingSidecar stays stale on the grid behind the viewer
  // until the next full bucket/folder reload.
  onProcessingSidecarCreated?: (assetId: string) => void;
  // Prints the currently-open (non-RAW) asset - omitted (no button shown)
  // for RAW assets, matching Print's "no RAW support in v1" scope.
  onPrint?: (asset: AssetSummary) => void;
}) {
  const [zoom, setZoom] = useState(100);
  const [infoOpen, setInfoOpen] = useState(true);
  const [filmstripOpen, setFilmstripOpen] = useState(true);
  const [loupeOn, setLoupeOn] = useState(false);
  const [loupePos, setLoupePos] = useState<{ x: number; y: number } | null>(null);
  // Keyed by asset id (not a plain boolean) so a change to `asset` clears
  // "loaded" the instant it happens, in the very same render - a boolean
  // reset via useEffect runs a render late, so for one frame the *previous*
  // image's loaded=true would apply to the newly-swapped-in asset, hiding
  // the blur placeholder before the new image has actually arrived (visible
  // as a stuck-blurry preview when switching stack pick without a full
  // navigate, since prev/next already happened to dodge this by unmounting
  // less state).
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [thumbLoadedId, setThumbLoadedId] = useState<string | null>(null);
  // Set once the full-resolution `original` file (not Immich's fixed-size
  // `preview` rendition) has loaded for the currently zoomed/loupe'd asset -
  // see `wantHiRes` below for why `preview` alone isn't enough at high zoom.
  const [hiResLoadedId, setHiResLoadedId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmPasteProcessing, setConfirmPasteProcessing] = useState(false);
  const [stackMembers, setStackMembers] = useState<AssetSummary[] | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);
  // Keyed by asset id (not a plain string) for the same reason as
  // loadedId/thumbLoadedId above - clears the moment `shown` changes, in the
  // same render, so a previous video's playback error doesn't flash over
  // the next one for a frame before the reset effect runs.
  const [videoErrorId, setVideoErrorId] = useState<{ id: string; message: string } | null>(null);
  // The actual <video src> - a `blob:` object URL wrapping the fetched
  // original file, not `thumbnailSrc(id, 'original')` directly. WebKitGTK
  // resolves a <video>'s src through GStreamer's own URI handling
  // (`playbin` needs a registered source element for the URL's scheme)
  // rather than through the same generic resource loader an <img src> or a
  // plain `fetch()` uses - and GStreamer has no source element for our
  // custom `immich-thumb://` scheme, so pointing <video> at it directly
  // fails immediately with SRC_NOT_SUPPORTED, before decoding ever starts.
  // Fetching the bytes ourselves (which *does* go through the normal
  // resource loader, same as the poster image below) and handing GStreamer
  // a `blob:` URL instead sidesteps the whole problem, since `blob:` is a
  // scheme every media backend understands natively.
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoLoading, setVideoLoading] = useState(false);
  // Bytes downloaded so far for the in-flight video fetch below - the whole
  // file has to be downloaded before a `blob:` URL can exist at all (no
  // progressive playback), so without this the "Loading video…" state looks
  // identical whether it's 2 seconds from done or genuinely stuck (a slow
  // link or a multi-GB original can make those look the same otherwise).
  const [videoProgress, setVideoProgress] = useState<{ loaded: number; total: number | null } | null>(null);
  const { resolve: resolveArtRoundTripOutcome, dialog: noSidecarDialog } = useNoSidecarChoice();
  // True while ART itself is open for this asset (and briefly after, while
  // the export path/sidecar are resolved) - disables/relabels the Tweak RAW
  // Roundtrip button so a second click can't overlap a second launch for the
  // *same* asset. Not held for the ART-cli conversion itself - that runs in
  // the background once kicked off (see launch_art_round_trip's doc
  // comment), which is what lets this button be used again for a *different*
  // asset right away instead of waiting on the whole export to finish.
  const [artBusy, setArtBusy] = useState(false);
  const { applications, artRoundTripEnabled } = useApplications();
  const { copiedProcessingSource, setCopiedProcessingSource, copiedMetadata, setCopiedMetadata } = useClipboard();
  // Clicking a non-pick stack member in the info panel "peeks" at it in the
  // main stage without actually navigating there (that member is hidden from
  // the app's flat asset list - see isHiddenStackChild - so openId/assetById
  // can't resolve it the way a real navigation needs). Only "Set Pick"
  // actually promotes it, which does go through the real onSetStackPick/
  // openId path and clears the peek as a side effect of `asset` changing.
  const [peekAsset, setPeekAsset] = useState<AssetSummary | null>(null);
  const shown = peekAsset ?? asset;
  const isVideo = isVideoAsset(shown);
  const loaded = loadedId === shown.id;
  const thumbLoaded = thumbLoadedId === shown.id;
  const { shortcuts, capturing } = useShortcuts();
  const { overrideIds } = useRawOverrides();
  const placeholder = useMemo(() => (shown.thumbHash ? decodeThumbHash(shown.thumbHash) : null), [shown.thumbHash]);
  const stageRef = useRef<HTMLDivElement>(null);
  const previewImgRef = useRef<HTMLImageElement>(null);
  const stackId = asset.stack?.id ?? null;
  // Tracks the stage's live box size so the hi-res decision below (see
  // `fitExceedsPreview`) reacts to window resizes, panel toggles, etc. - a
  // one-off getBoundingClientRect() read during render would go stale the
  // instant the layout changes without some other state update also
  // happening to trigger a re-render.
  const [stageSize, setStageSize] = useState<{ w: number; h: number } | null>(null);

  // Fetches the full member list whenever the open asset's stack changes (or
  // stops/starts having one) - StackBand.tsx does the same fetch-on-mount,
  // there's no shared cache to reuse since Immich only returns full stack
  // membership from this one endpoint, not as part of AssetSummary.
  useEffect(() => {
    if (!stackId) {
      setStackMembers(null);
      return;
    }
    let cancelled = false;
    setStackMembers(null);
    getStack(stackId)
      .then((stack) => {
        if (!cancelled) setStackMembers(overlayRawOverrides(stack.assets, overrideIds));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stackId]);

  // The stage element itself never unmounts across the Viewer's lifetime
  // (only its contents change), so one observer set up on mount covers every
  // resize - window resizes, the OS window being maximized/restored, and the
  // Info/Filmstrip panels toggling (both resize the stage without a window
  // resize event).
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      setStageSize({ w: rect.width, h: rect.height });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // New asset (via prev/next, filmstrip click, or reopen) - reset per-image
  // transient state, and the loupe cursor lands in a stale spot otherwise.
  // (loaded/thumbLoaded reset themselves - see loadedId/thumbLoadedId above.)
  useEffect(() => {
    setZoom(100);
    setLoupePos(null);
    setPeekAsset(null);
  }, [asset.id]);

  // Fetches the video's true original bytes as a Blob and swaps `videoUrl`
  // to a fresh object URL wrapping it - see `videoUrl`'s doc comment above
  // for why the <video> element can't just point at `thumbnailSrc` directly
  // the way the poster image does. Revokes the previous object URL on every
  // re-run (asset change) and on unmount so switching through a filmstrip of
  // videos doesn't leak one blob per video visited.
  //
  // Uses XMLHttpRequest, not fetch() - WebKitGTK's fetch() implementation
  // rejects custom (non-http) URI schemes outright with a generic
  // "TypeError: Load failed", even though the exact same `immich-thumb://`
  // URL loads fine as a subresource (the poster <img> above, or any grid
  // thumbnail) and via XMLHttpRequest. fetch() and XHR go through
  // meaningfully different WebKit loader code paths for a custom scheme;
  // only the older XHR one actually works here.
  useEffect(() => {
    if (!isVideo) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    setVideoUrl(null);
    setVideoErrorId(null);
    setVideoLoading(true);
    setVideoProgress({ loaded: 0, total: null });
    const xhr = new XMLHttpRequest();
    xhr.open('GET', thumbnailSrc(shown.id, 'original'));
    xhr.responseType = 'blob';
    xhr.onprogress = (e) => {
      if (cancelled) return;
      setVideoProgress({ loaded: e.loaded, total: e.lengthComputable ? e.total : null });
    };
    xhr.onload = () => {
      if (cancelled) return;
      if (xhr.status < 200 || xhr.status >= 300) {
        setVideoErrorId({ id: shown.id, message: `Couldn't download the video (server returned ${xhr.status}).` });
      } else {
        objectUrl = URL.createObjectURL(xhr.response as Blob);
        setVideoUrl(objectUrl);
      }
      setVideoLoading(false);
    };
    xhr.onerror = () => {
      if (cancelled) return;
      setVideoErrorId({ id: shown.id, message: "Couldn't download the video." });
      setVideoLoading(false);
    };
    xhr.send();
    return () => {
      cancelled = true;
      xhr.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [isVideo, shown.id]);

  // Edits to a peeked stack member (favorite/rating, via shortcut or the info
  // panel) only reach the server + the browser's own assetCache through
  // onEdit - `peekAsset`/`stackMembers` are a separate local snapshot fetched
  // once via getStack, so without also patching them here the edit would
  // silently "stick" server-side but never show up on screen (the pick
  // updates fine since `asset` itself is derived from the browser's reactive
  // state, unlike this snapshot).
  const handleEdit = useCallback(
    async (id: string, patch: AssetMetadataPatch) => {
      await onEdit(id, patch);
      setPeekAsset((cur) => (cur && cur.id === id ? { ...cur, ...patch } : cur));
      setStackMembers((cur) => (cur ? cur.map((m) => (m.id === id ? { ...m, ...patch } : m)) : cur));
    },
    [onEdit],
  );

  // Passing shown.id/shown.fileName registers a round-trip watch on this
  // asset's folder (see round_trip.rs + PhotosBrowser.tsx's
  // 'round-trip-file-detected' listener), so a matching output file the
  // editor later saves back gets picked up and auto-stacked without the user
  // hitting Refresh Timeline. Redirects to Preferences → Applications
  // instead of launching when that role has no app chosen yet, rather than
  // just disabling the button with no way to fix it from here.
  //
  // When ART round trip is configured (artRoundTripEnabled), the rawEditor
  // role becomes "Tweak RAW Roundtrip" and branches to the ART CLI flow
  // instead: awaits ART's own process exit (launchArtRoundTrip), then hands
  // the resulting jobId to the parent via onArtRoundTripQueued as soon as the
  // export is running in the background, rather than waiting for it to
  // finish - no dependency on round_trip.rs's passive file watcher for this
  // path.
  const handleLaunch = useCallback(
    async (role: 'rawEditor' | 'externalEditor') => {
      const choice = applications[role];
      if (!choice) {
        onOpenApplicationsPreferences?.();
        return;
      }
      setLaunchError(null);
      if (role === 'rawEditor' && artRoundTripEnabled) {
        setArtBusy(true);
        try {
          const rtOutcome = await launchArtRoundTrip(shown.id, shown.originalPath, shown.fileName, shown.fileExtension, choice);
          const jobId = await resolveArtRoundTripOutcome(rtOutcome);
          onArtRoundTripQueued?.(jobId);
        } catch (e) {
          setLaunchError(String(e));
        } finally {
          setArtBusy(false);
        }
        return;
      }
      try {
        await launchEditor(shown.originalPath, choice, shown.id, shown.fileName);
      } catch (e) {
        setLaunchError(String(e));
      }
    },
    [applications, artRoundTripEnabled, shown, onOpenApplicationsPreferences, onArtRoundTripQueued, resolveArtRoundTripOutcome],
  );

  // Same clipboard, same fields, as the grid's Copy/Paste Image Processing/
  // Metadata (PhotosBrowser.tsx/FoldersBrowser.tsx) - copying here from the
  // open photo and pasting there onto a selection (or vice versa) works
  // automatically since both read/write the one shared ClipboardProvider.
  const handleCopyImageProcessing = useCallback(() => {
    if (!shown.originalPath || !shown.hasProcessingSidecar) return;
    setCopiedProcessingSource({ assetId: shown.id, originalPath: shown.originalPath, fileName: shown.fileName });
  }, [shown, setCopiedProcessingSource]);

  const handleCopyMetadata = useCallback(() => {
    setCopiedMetadata({ rating: shown.rating ?? undefined, isFavorite: shown.isFavorite, description: shown.description ?? undefined });
  }, [shown, setCopiedMetadata]);

  const handleShowInFileManager = useCallback(() => {
    if (!shown.originalPath) return;
    revealInFileManager(shown.originalPath).catch((e) => setLaunchError(String(e)));
  }, [shown]);

  // In-app video playback goes through WebKitGTK's own bundled GStreamer
  // pipeline (see the <video> element below), which has proven far less
  // reliable on some systems/codecs than the OS's own default video player -
  // this hands the file off to that instead, same as double-clicking it in a
  // file manager would.
  const handleOpenInVideoPlayer = useCallback(() => {
    if (!shown.originalPath) return;
    openVideoExternally(shown.originalPath).catch((e) => setLaunchError(String(e)));
  }, [shown]);

  const handlePasteMetadata = useCallback(() => {
    if (!copiedMetadata) return;
    handleEdit(shown.id, copiedMetadata).catch(() => {});
  }, [copiedMetadata, handleEdit, shown.id]);

  const { jobs: processingJobs, refresh: refreshProcessingQueue } = useProcessingQueue();
  const reconcileProcessingJob = useCallback(
    (job: ProcessingJob) => {
      if (job.status === 'failed') {
        setLaunchError(job.error ?? "Couldn't paste image processing onto a photo.");
        return;
      }
      onProcessingSidecarCreated?.(job.targetAssetId);
    },
    [onProcessingSidecarCreated],
  );
  const { trackJobs: trackProcessingJobs } = useProcessingJobReconciliation(processingJobs, reconcileProcessingJob);

  // Up/Down (stackPrev/stackNext) walk through the open stack's own members
  // (peeking each one, same as clicking its tile in the info panel) - Left/
  // Right stay dedicated to the normal cross-asset onPrev/onNext (the
  // filmstrip order) so the two navigations don't fight over the same keys.
  // Without this, a stack's hidden non-pick members could only ever be
  // reached by clicking their tile in the info panel, since they're excluded
  // from the flat asset list onPrev/onNext walk.
  const tryStackNav = useCallback(
    (dir: -1 | 1): boolean => {
      if (!stackMembers || stackMembers.length < 2) return false;
      const idx = stackMembers.findIndex((m) => m.id === shown.id);
      if (idx === -1) return false;
      const nextIdx = idx + dir;
      if (nextIdx < 0 || nextIdx >= stackMembers.length) return false;
      const target = stackMembers[nextIdx];
      setPeekAsset(target.id === asset.id ? null : target);
      return true;
    },
    [stackMembers, shown.id, asset.id],
  );

  const confirmPasteImageProcessingAction = useCallback(async () => {
    if (!copiedProcessingSource) return;
    const targets: MetadataEditTarget[] = [{ id: shown.id, originalPath: shown.originalPath }];
    const jobIds = await pasteImageProcessing(copiedProcessingSource.originalPath, targets);
    trackProcessingJobs(jobIds);
    // See processingQueue.tsx's doc comment on `refresh` - without this, a
    // fast paste can complete entirely between two scheduled polls, leaving
    // the TitleBar pill never shown at all.
    refreshProcessingQueue();
  }, [copiedProcessingSource, shown.id, shown.originalPath, trackProcessingJobs, refreshProcessingQueue]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Let the confirm dialog own Escape (cancel) while it's open, rather
      // than also closing the whole viewer underneath it.
      if (confirmDelete || confirmPasteProcessing) {
        if (e.key === 'Escape') {
          setConfirmDelete(false);
          setConfirmPasteProcessing(false);
        }
        return;
      }
      if (isTypingTarget(e) || capturing) return;
      if (matchesShortcut(e, shortcuts.deselect)) onClose();
      else if (matchesShortcut(e, shortcuts.prev) && hasPrev) onPrev();
      else if (matchesShortcut(e, shortcuts.next) && hasNext) onNext();
      else if (matchesShortcut(e, shortcuts.stackPrev)) tryStackNav(-1);
      else if (matchesShortcut(e, shortcuts.stackNext)) tryStackNav(1);
      else if (matchesShortcut(e, shortcuts.toggleInfo)) setInfoOpen((v) => !v);
      else if (matchesShortcut(e, shortcuts.toggleFilmstrip)) setFilmstripOpen((v) => !v);
      else if (matchesShortcut(e, shortcuts.loupe)) setLoupeOn((v) => !v);
      else if (matchesShortcut(e, shortcuts.favorite)) handleEdit(shown.id, { isFavorite: !shown.isFavorite }).catch(() => {});
      else if (matchesShortcut(e, shortcuts.copyMetadata)) handleCopyMetadata();
      else if (matchesShortcut(e, shortcuts.pasteMetadata) && copiedMetadata) handlePasteMetadata();
      else if (matchesShortcut(e, shortcuts.copyImageProcessing) && isRawAsset(shown)) handleCopyImageProcessing();
      else if (matchesShortcut(e, shortcuts.pasteImageProcessing) && copiedProcessingSource && isRawAsset(shown)) setConfirmPasteProcessing(true);
      else if (matchesShortcut(e, shortcuts.rate0)) handleEdit(shown.id, { rating: 0 }).catch(() => {});
      else if (matchesShortcut(e, shortcuts.rate1)) handleEdit(shown.id, { rating: 1 }).catch(() => {});
      else if (matchesShortcut(e, shortcuts.rate2)) handleEdit(shown.id, { rating: 2 }).catch(() => {});
      else if (matchesShortcut(e, shortcuts.rate3)) handleEdit(shown.id, { rating: 3 }).catch(() => {});
      else if (matchesShortcut(e, shortcuts.rate4)) handleEdit(shown.id, { rating: 4 }).catch(() => {});
      else if (matchesShortcut(e, shortcuts.rate5)) handleEdit(shown.id, { rating: 5 }).catch(() => {});
      else if (matchesShortcut(e, shortcuts.reject)) handleEdit(shown.id, { rating: shown.rating === -1 ? 0 : -1 }).catch(() => {});
      else if (matchesShortcut(e, shortcuts.delete)) setConfirmDelete(true);
      else if (matchesShortcut(e, shortcuts.openInRawEditor) && isRawAsset(shown) && !artBusy) handleLaunch('rawEditor').catch(() => {});
      else if (matchesShortcut(e, shortcuts.openInExternalEditor)) handleLaunch('externalEditor').catch(() => {});
      else if (matchesShortcut(e, shortcuts.print) && onPrint && !isRawAsset(shown) && !isVideo) onPrint(shown);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    onClose,
    onPrev,
    onNext,
    hasPrev,
    hasNext,
    tryStackNav,
    confirmDelete,
    confirmPasteProcessing,
    shortcuts,
    capturing,
    shown,
    isVideo,
    onEdit,
    handleEdit,
    handleLaunch,
    artBusy,
    handleCopyMetadata,
    handlePasteMetadata,
    handleCopyImageProcessing,
    copiedMetadata,
    copiedProcessingSource,
    onPrint,
  ]);

  const previewSrc = thumbnailSrc(shown.id, 'preview');

  // Uses the loaded <img>'s own naturalWidth/naturalHeight (not
  // shown.exifImageWidth/Height) - EXIF dimensions are frequently absent
  // (screenshots, assets Immich hasn't finished metadata-extracting) and,
  // when present, describe the *original* file rather than the possibly
  // reoriented preview rendition actually on screen, which silently broke
  // the loupe (or misaligned it) for exactly those assets.
  const natW = previewImgRef.current?.naturalWidth;
  const natH = previewImgRef.current?.naturalHeight;

  // Immich's `preview` rendition is a fixed resolution (~1440px longest
  // edge). That's soft once stretched past 100% zoom or magnified 3x under
  // the loupe - but it can *also* be soft at the plain default "fit to
  // window" zoom, with no zooming involved at all, if the window/screen
  // alone needs more pixels than `preview` has just to fill itself (a
  // maximized viewer on a large or high-DPI display easily exceeds 1440px
  // of *device* pixels along the image's long edge). `fitExceedsPreview`
  // catches that case by comparing the fitted box's device-pixel size
  // against the loaded preview's native resolution, so the swap to the full
  // original kicks in whenever it's actually needed, not just on an
  // explicit zoom/loupe action.
  let fitExceedsPreview = false;
  if (loaded && stageSize && natW && natH) {
    const dpr = window.devicePixelRatio || 1;
    const { w, h } = containRect(stageSize.w, stageSize.h, natW, natH);
    fitExceedsPreview = w * dpr > natW + 1 || h * dpr > natH + 1;
  }
  const wantHiRes = (zoom > 100 || loupeOn || fitExceedsPreview) && isOriginalZoomable(shown);
  const hiResSrc = thumbnailSrc(shown.id, 'original');
  const hiResReady = wantHiRes && hiResLoadedId === shown.id;

  // The loupe magnifies the "fit" (unzoomed) rendering of the already-loaded
  // preview image - it doesn't compose with the manual zoom slider. Once
  // `hiResReady`, it magnifies the full original instead of the
  // fixed-resolution preview, so 3x magnification still shows real
  // pixel-level detail rather than an upsampled blur.
  // Gated on `loaded`: reusing previewSrc as a CSS background before the main
  // <img> has finished fetching it would race a second, independent request
  // for the same bytes over a possibly-slow remote connection instead of
  // hitting the now-warm local disk cache from the first request.
  let loupeStyle: React.CSSProperties | null = null;
  if (loupeOn && loaded && loupePos && stageRef.current && natW && natH) {
    const rect = stageRef.current.getBoundingClientRect();
    const { w, h, x, y } = containRect(rect.width, rect.height, natW, natH);
    const cx = loupePos.x - x;
    const cy = loupePos.y - y;
    if (cx >= 0 && cy >= 0 && cx <= w && cy <= h) {
      loupeStyle = {
        position: 'absolute',
        left: loupePos.x - LOUPE_SIZE / 2,
        top: loupePos.y - LOUPE_SIZE / 2,
        width: LOUPE_SIZE,
        height: LOUPE_SIZE,
        borderRadius: '50%',
        border: '2px solid rgba(255,255,255,0.5)',
        boxShadow: '0 8px 30px rgba(0,0,0,0.6)',
        backgroundColor: '#000',
        backgroundImage: `url(${hiResReady ? hiResSrc : previewSrc})`,
        backgroundRepeat: 'no-repeat',
        backgroundSize: `${w * LOUPE_MAGNIFICATION}px ${h * LOUPE_MAGNIFICATION}px`,
        backgroundPosition: `${-(cx * LOUPE_MAGNIFICATION - LOUPE_SIZE / 2)}px ${-(cy * LOUPE_MAGNIFICATION - LOUPE_SIZE / 2)}px`,
        pointerEvents: 'none',
        zIndex: 5,
      };
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 200,
        background: '#161616',
        display: 'flex',
        flexDirection: 'column',
        color: '#fff',
      }}
    >
      <div
        style={{
          height: 48,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '0 14px',
          borderBottom: '1px solid rgba(0,0,0,0.4)',
          background: '#222',
        }}
      >
        <div
          onClick={onClose}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            height: 30,
            padding: '0 12px 0 9px',
            borderRadius: 8,
            background: 'rgba(255,255,255,0.07)',
            fontSize: 13,
            cursor: 'default',
          }}
        >
          <div
            style={{
              width: 8,
              height: 8,
              borderLeft: '1.8px solid #fff',
              borderBottom: '1.8px solid #fff',
              transform: 'rotate(45deg)',
            }}
          />
          Back
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {shown.fileName}
            {peekAsset && <span style={{ fontWeight: 400, color: 'rgba(255,255,255,0.45)' }}> · previewing stack member</span>}
          </div>
          <div style={{ fontSize: 11.5, color: 'rgba(255,255,255,0.45)' }}>
            {formatDims(shown)} · {formatSize(shown.fileSizeInByte)}
          </div>
        </div>
        <div style={{ flex: 1 }} />
        {onUnstack && (
          <div
            onClick={() => onUnstack().catch(() => {})}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              height: 30,
              padding: '0 13px',
              borderRadius: 8,
              background: 'rgba(255,255,255,0.08)',
              fontSize: 12.5,
              cursor: 'default',
            }}
          >
            Unstack
          </div>
        )}
        {isRawAsset(shown) && (
          <div
            onClick={() => !artBusy && handleLaunch('rawEditor')}
            title={artBusy ? 'Waiting on ART…' : undefined}
            style={{ ...headerButtonStyle(false), opacity: artBusy ? 0.5 : 1 }}
          >
            {artBusy ? 'Working…' : 'Tweak RAW Roundtrip'}
          </div>
        )}
        <div onClick={() => handleLaunch('externalEditor')} style={headerButtonStyle(false)}>
          Open in Ext. Editor
        </div>
        {isVideo && shown.originalPath && (
          <div onClick={handleOpenInVideoPlayer} style={headerButtonStyle(false)}>
            Open in Video Player
          </div>
        )}
        {onPrint && !isRawAsset(shown) && !isVideo && (
          <div onClick={() => onPrint(shown)} style={headerButtonStyle(false)}>
            Print
          </div>
        )}
        {shown.originalPath && (
          <div onClick={handleShowInFileManager} style={headerButtonStyle(false)}>
            Show in File Manager
          </div>
        )}
        <div style={{ width: 1, height: 22, background: 'rgba(255,255,255,0.12)', margin: '0 2px' }} />
        {isRawAsset(shown) && shown.hasProcessingSidecar && (
          <div onClick={handleCopyImageProcessing} style={headerButtonStyle(false)}>
            Copy Image Processing
          </div>
        )}
        {isRawAsset(shown) && copiedProcessingSource && (
          <div onClick={() => setConfirmPasteProcessing(true)} style={headerButtonStyle(false)}>
            Paste Image Processing
          </div>
        )}
        <div onClick={handleCopyMetadata} style={headerButtonStyle(false)}>
          Copy Metadata
        </div>
        {copiedMetadata && (
          <div onClick={handlePasteMetadata} style={headerButtonStyle(false)}>
            Paste Metadata
          </div>
        )}
        {launchError && (
          <div style={{ fontSize: 11.5, color: 'var(--danger)', maxWidth: 220, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={launchError}>
            {launchError}
          </div>
        )}
        <div
          onClick={() => setConfirmDelete(true)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            height: 30,
            padding: '0 13px',
            borderRadius: 8,
            background: 'rgba(224,27,36,0.16)',
            color: '#ff8080',
            fontSize: 12.5,
            cursor: 'default',
          }}
        >
          Move to Trash
        </div>
        {/* Zoom and Loupe have nothing to act on for a video (there's no
            still-image rendition to magnify or scale) - hidden rather than
            disabled so it's clear they just don't apply here. */}
        {!isVideo && (
          <>
            <div style={{ width: 1, height: 22, background: 'rgba(255,255,255,0.12)', margin: '0 2px' }} />
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                height: 30,
                padding: '0 4px 0 8px',
                borderRadius: 8,
                background: 'rgba(255,255,255,0.06)',
              }}
            >
              <div
                onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z - 25))}
                style={{ width: 22, height: 22, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'default' }}
              >
                <div style={{ width: 10, height: 1.7, background: 'currentColor', borderRadius: 1 }} />
              </div>
              <input
                type="range"
                min={MIN_ZOOM}
                max={MAX_ZOOM}
                step={5}
                value={zoom}
                onChange={(e) => setZoom(Number(e.target.value))}
                style={{ width: 92 }}
              />
              <div
                onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z + 25))}
                style={{ width: 22, height: 22, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'default', position: 'relative' }}
              >
                <div style={{ position: 'absolute', width: 10, height: 1.7, background: 'currentColor', borderRadius: 1 }} />
                <div style={{ position: 'absolute', width: 1.7, height: 10, background: 'currentColor', borderRadius: 1 }} />
              </div>
              <div
                onClick={() => setZoom(100)}
                style={{
                  minWidth: 40,
                  height: 22,
                  padding: '0 7px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: 6,
                  font: '600 12px ui-monospace,monospace',
                  cursor: 'default',
                }}
              >
                {zoom}%
              </div>
            </div>
            <div style={{ width: 1, height: 22, background: 'rgba(255,255,255,0.12)', margin: '0 2px' }} />
            <div onClick={() => setLoupeOn((v) => !v)} style={headerButtonStyle(loupeOn)}>
              <div style={{ position: 'relative', width: 13, height: 13, flexShrink: 0 }}>
                <div style={{ position: 'absolute', left: 0, top: 0, width: 9, height: 9, border: '1.7px solid currentColor', borderRadius: '50%' }} />
                <div style={{ position: 'absolute', left: 8, top: 8, width: 5, height: 1.7, background: 'currentColor', borderRadius: 1, transformOrigin: 'left center', transform: 'rotate(45deg)' }} />
              </div>
              Loupe
            </div>
          </>
        )}
        <div onClick={() => setInfoOpen((v) => !v)} style={headerButtonStyle(infoOpen)}>
          Info
        </div>
        <div onClick={() => setFilmstripOpen((v) => !v)} style={headerButtonStyle(filmstripOpen)}>
          Filmstrip
        </div>
      </div>

      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <div style={{ flex: 1, position: 'relative', minHeight: 0, background: '#161616' }}>
          <div style={{ position: 'absolute', inset: 0, overflow: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 28 }}>
            {/* Fixed-size stage (not sized by the images) so both layers fill the
                available viewing area via objectFit rather than collapsing to
                the thumbhash placeholder's own tiny intrinsic bitmap size. */}
            <div
              ref={stageRef}
              onMouseMove={(e) => {
                if (isVideo || !loupeOn || !stageRef.current) return;
                const rect = stageRef.current.getBoundingClientRect();
                setLoupePos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
              }}
              onMouseLeave={() => setLoupePos(null)}
              style={{ position: 'relative', width: '100%', height: '100%', cursor: !isVideo && loupeOn ? 'none' : 'default' }}
            >
              {isVideo ? (
                // No zoom/loupe/hi-res tiers for video - just the one
                // rendition, played from `videoUrl` (a `blob:` object URL -
                // see its doc comment above for why not `thumbnailSrc`
                // directly). Keyed on the asset id so switching videos
                // doesn't keep the previous one's playback position/paused
                // state.
                <>
                  {videoUrl && (
                    <video
                      key={shown.id}
                      controls
                      poster={thumbnailSrc(shown.id, 'preview')}
                      src={videoUrl}
                      onError={(e) => {
                        // Logged in full (not just the on-screen summary) so
                        // the devtools console has the raw MediaError.code
                        // even when `.message` comes back empty.
                        console.error('Video playback error', e.currentTarget.error);
                        setVideoErrorId({ id: shown.id, message: describeVideoError(e.currentTarget.error) });
                      }}
                      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
                    />
                  )}
                  {videoLoading && !videoUrl && !videoErrorId && (
                    <div
                      style={{
                        position: 'absolute',
                        inset: 0,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 13,
                        color: 'rgba(255,255,255,0.5)',
                      }}
                    >
                      Loading video…
                      {videoProgress && videoProgress.loaded > 0 && (
                        <span style={{ marginLeft: 6 }}>
                          {formatSize(videoProgress.loaded)}
                          {videoProgress.total ? ` / ${formatSize(videoProgress.total)}` : ''}
                        </span>
                      )}
                    </div>
                  )}
                  {videoErrorId?.id === shown.id && (
                    <div
                      style={{
                        position: 'absolute',
                        inset: 0,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        padding: 32,
                        pointerEvents: 'none',
                      }}
                    >
                      <div style={{ maxWidth: 420, textAlign: 'center', fontSize: 13, lineHeight: 1.6, color: 'rgba(255,255,255,0.75)' }}>
                        {videoErrorId.message}
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <>
                  {placeholder && (
                    <img
                      src={placeholder}
                      alt=""
                      style={{
                        position: 'absolute',
                        inset: 0,
                        width: '100%',
                        height: '100%',
                        objectFit: 'contain',
                        filter: 'blur(12px)',
                        transform: `scale(${zoom / 100})`,
                        opacity: loaded || thumbLoaded ? 0 : 1,
                        transition: 'opacity 200ms',
                      }}
                    />
                  )}
                  {/* The grid already fetched+cached this asset's small `thumbnail`
                      rendition (that's how it was visible to click in the first
                      place) - showing it here is a local disk read, effectively
                      instant regardless of how slow the remote link is, so it
                      replaces the abstract thumbhash blur with a real recognizable
                      image right away while the full-size `preview` loads in. */}
                  <img
                    src={thumbnailSrc(shown.id, 'thumbnail')}
                    alt=""
                    onLoad={() => setThumbLoadedId(shown.id)}
                    style={{
                      position: 'absolute',
                      inset: 0,
                      width: '100%',
                      height: '100%',
                      objectFit: 'contain',
                      transform: `scale(${zoom / 100})`,
                      opacity: loaded ? 0 : thumbLoaded ? 1 : 0,
                      transition: 'opacity 150ms',
                    }}
                  />
                  <img
                    ref={previewImgRef}
                    src={previewSrc}
                    alt=""
                    onLoad={() => setLoadedId(shown.id)}
                    style={{
                      position: 'absolute',
                      inset: 0,
                      width: '100%',
                      height: '100%',
                      objectFit: 'contain',
                      transform: `scale(${zoom / 100})`,
                      opacity: loaded ? 1 : 0,
                      transition: 'opacity 150ms',
                    }}
                  />
                  {/* Only mounted while actually needed (zoomed past 100% or the
                      loupe is on) - fetching the full original for every photo
                      just to sit at 100% zoom would be wasted bandwidth. Sits on
                      top of the `preview` layer above, which stays visible as a
                      (softer) fallback until this one finishes loading. */}
                  {wantHiRes && (
                    <img
                      src={hiResSrc}
                      alt=""
                      onLoad={() => setHiResLoadedId(shown.id)}
                      style={{
                        position: 'absolute',
                        inset: 0,
                        width: '100%',
                        height: '100%',
                        objectFit: 'contain',
                        transform: `scale(${zoom / 100})`,
                        opacity: hiResReady ? 1 : 0,
                        transition: 'opacity 150ms',
                      }}
                    />
                  )}
                  {loupeStyle && <div style={loupeStyle} />}
                </>
              )}
            </div>
          </div>

          {hasPrev && (
            <div
              onClick={onPrev}
              style={{
                position: 'absolute',
                left: 14,
                top: '50%',
                transform: 'translateY(-50%)',
                width: 40,
                height: 40,
                borderRadius: '50%',
                background: 'rgba(0,0,0,0.4)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'default',
              }}
            >
              <div style={{ width: 10, height: 10, borderLeft: '2px solid #fff', borderBottom: '2px solid #fff', transform: 'rotate(45deg)' }} />
            </div>
          )}
          {hasNext && (
            <div
              onClick={onNext}
              style={{
                position: 'absolute',
                right: 14,
                top: '50%',
                transform: 'translateY(-50%)',
                width: 40,
                height: 40,
                borderRadius: '50%',
                background: 'rgba(0,0,0,0.4)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'default',
              }}
            >
              <div style={{ width: 10, height: 10, borderRight: '2px solid #fff', borderTop: '2px solid #fff', transform: 'rotate(45deg)' }} />
            </div>
          )}
        </div>

        {infoOpen && (
          <div
            style={{
              width: 288,
              flexShrink: 0,
              borderLeft: '1px solid rgba(0,0,0,0.4)',
              background: '#222',
              display: 'flex',
              flexDirection: 'column',
              minHeight: 0,
            }}
          >
            <div style={{ padding: 18, flexShrink: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 14 }}>Information</div>
              <MetadataRows asset={shown} onEdit={(patch) => handleEdit(shown.id, patch)} />
            </div>
            {stackId && (
              // flex:1 (not a capped maxHeight) so this fills whatever space is
              // left below the metadata all the way to the bottom of the panel
              // instead of only fitting a couple of rows before scrolling.
              <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: '0 18px 18px' }}>
                <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.55)', marginBottom: 8, flexShrink: 0 }}>
                  Stack · {stackMembers?.length ?? asset.stack!.assetCount} · click a photo to view it
                </div>
                {!stackMembers ? (
                  <div style={{ color: 'var(--text-dimmer)', fontSize: 12.5 }}>Loading…</div>
                ) : (
                  <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexWrap: 'wrap', alignContent: 'flex-start', gap: 8, paddingRight: 4 }}>
                    {stackMembers.map((m) => {
                      const isPick = m.id === asset.stack!.primaryAssetId;
                      const isShown = m.id === shown.id;
                      const isRaw = isRawAsset(m);
                      return (
                        <div
                          key={m.id}
                          onClick={() => setPeekAsset(m.id === asset.id ? null : m)}
                          style={{
                            position: 'relative',
                            width: 122,
                            aspectRatio: '3 / 2',
                            flexShrink: 0,
                            borderRadius: 8,
                            overflow: 'hidden',
                            cursor: 'default',
                            boxShadow: isShown ? '0 0 0 2px #3584e4' : '0 0 0 1px rgba(255,255,255,0.08)',
                            touchAction: 'manipulation',
                          }}
                        >
                          <img
                            src={thumbnailSrc(m.id)}
                            alt=""
                            loading="lazy"
                            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                          />
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              if (onSetStackPick) onSetStackPick(m.id, stackMembers.map((x) => x.id)).catch(() => {});
                            }}
                            disabled={isPick}
                            title={isPick ? 'Stack pick' : 'Set as stack pick'}
                            style={{
                              position: 'absolute',
                              top: 4,
                              left: '50%',
                              transform: 'translateX(-50%)',
                              height: 20,
                              padding: '0 8px',
                              borderRadius: 10,
                              border: 'none',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              cursor: 'default',
                              fontSize: 10.5,
                              fontWeight: 700,
                              whiteSpace: 'nowrap',
                              background: isPick ? '#f5c518' : 'rgba(0,0,0,0.6)',
                              color: isPick ? '#1c1c1c' : '#fff',
                            }}
                          >
                            {isPick ? 'Pick' : 'Set Pick'}
                          </button>
                          <div
                            style={{ position: 'absolute', left: 5, bottom: 5, display: 'flex', gap: 4, padding: '2px 4px', borderRadius: 5, background: 'rgba(0,0,0,0.42)' }}
                          >
                            {[1, 2, 3, 4, 5].map((v) => (
                              <Star key={v} filled={v <= (m.rating || 0)} size={6} />
                            ))}
                          </div>
                          {m.fileExtension && (
                            <div
                              style={{
                                position: 'absolute',
                                right: 5,
                                bottom: 5,
                                font: '600 8.5px ui-monospace,monospace',
                                letterSpacing: '.04em',
                                padding: '2px 4px',
                                borderRadius: 4,
                                color: isRaw ? '#241c00' : '#fff',
                                background: isRaw ? '#e5a50a' : 'rgba(0,0,0,0.5)',
                              }}
                            >
                              {m.fileExtension}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {filmstripOpen && <Filmstrip items={stripAssets} activeId={asset.id} onSelect={onSelect} />}

      {confirmDelete && (
        <ConfirmDialog
          title="Move to trash?"
          message={`This moves "${shown.fileName}" to Immich's trash. You can restore it from Trash later.`}
          confirmLabel="Move to Trash"
          onConfirm={async () => {
            await onDelete(shown.id);
            onClose();
          }}
          onClose={() => setConfirmDelete(false)}
        />
      )}
      {confirmPasteProcessing && (
        <ConfirmDialog
          title="Paste image processing?"
          message={`Paste image processing onto "${shown.fileName}"? This replaces any existing RawTherapee/ART edits on it.`}
          confirmLabel="Paste"
          onConfirm={confirmPasteImageProcessingAction}
          onClose={() => setConfirmPasteProcessing(false)}
        />
      )}
      {noSidecarDialog}
    </div>
  );
}

// How many tiles to actually mount on either side of the active photo. `items`
// can be every asset across every month scrolled through this session (the
// grid's cache is unbounded/permanent) - mounting all of them at once here
// was the real cause of the multi-second freeze on open: each tile ran a
// synchronous thumbhash-to-canvas decode, and with a few thousand loaded
// assets that's seconds of blocking work before React can even paint the
// viewer. Windowing bounds that cost regardless of library size.
const FILMSTRIP_WINDOW = 120;

function Filmstrip({
  items,
  activeId,
  onSelect,
}: {
  items: AssetSummary[];
  activeId: string;
  onSelect: (id: string) => void;
}) {
  const activeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ inline: 'center', block: 'nearest' });
  }, [activeId]);

  const activeIndex = items.findIndex((a) => a.id === activeId);
  const windowed =
    activeIndex === -1
      ? items.slice(0, FILMSTRIP_WINDOW * 2)
      : items.slice(Math.max(0, activeIndex - FILMSTRIP_WINDOW), activeIndex + FILMSTRIP_WINDOW + 1);

  return (
    <div
      style={{
        height: 88,
        flexShrink: 0,
        borderTop: '1px solid rgba(0,0,0,0.4)',
        background: '#1e1e1e',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '0 14px',
        overflowX: 'auto',
      }}
    >
      {windowed.map((a) => {
        const active = a.id === activeId;
        return (
          <div
            key={a.id}
            ref={active ? activeRef : undefined}
            onClick={() => onSelect(a.id)}
            style={{
              position: 'relative',
              flexShrink: 0,
              height: 64,
              aspectRatio: '3 / 2',
              borderRadius: 6,
              overflow: 'hidden',
              cursor: 'default',
              background: '#222',
              boxShadow: active ? '0 0 0 2px #3584e4' : '0 0 0 1px rgba(255,255,255,0.08)',
              touchAction: 'manipulation',
            }}
          >
            {/* Plain lazy img, not the thumbhash-decoding AssetThumbImage - these
                tiles are almost always already disk-cached (you just scrolled
                past them in the grid), so a blur-up placeholder buys nothing
                here and isn't worth the decode cost at this volume. */}
            <img
              src={thumbnailSrc(a.id)}
              alt=""
              loading="lazy"
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
            <div style={{ position: 'absolute', left: 4, bottom: 4, display: 'flex', gap: 4, padding: '2px 4px', borderRadius: 5, background: 'rgba(0,0,0,0.42)' }}>
              {[1, 2, 3, 4, 5].map((v) => (
                <Star key={v} filled={v <= (a.rating || 0)} size={6} />
              ))}
            </div>
            {a.stack && (
              <div
                style={{
                  position: 'absolute',
                  right: 4,
                  top: 4,
                  width: 16,
                  height: 14,
                  borderRadius: 4,
                  background: 'rgba(0,0,0,0.42)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <div style={{ position: 'relative', width: 9, height: 8 }}>
                  <div style={{ position: 'absolute', left: 0, top: 0, width: 6, height: 6, border: '1.1px solid #dc8add', borderRadius: 1 }} />
                  <div style={{ position: 'absolute', left: 3, top: 2, width: 6, height: 6, border: '1.1px solid #dc8add', borderRadius: 1, background: '#222' }} />
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
