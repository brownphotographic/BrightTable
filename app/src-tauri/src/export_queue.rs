//! Background queue for **Export to Folder** and **Export to Flickr** - one
//! `ExportJob` per asset per target, modeled directly on `art_queue.rs`
//! (same `Pending -> Running -> Done|Failed` board, bounded `Semaphore`,
//! capped completed-history trim, per-job `watch`-channel cancellation).
//!
//! Unlike `art_queue.rs`, a job here does its own async network/disk I/O
//! (an Immich fetch, a local file read/write, or a Flickr upload) rather
//! than spawning an external process, so there's no `--progress` stream to
//! parse - progress is coarse (`None` while running, `100` the instant a job
//! succeeds), matching how a short-lived job with no natural midpoint would
//! render anyway. Cancellation is checked once, right before a job's work
//! actually starts (same as a job still queued behind the semaphore) - not
//! threaded into the upload/copy itself, since these are seconds-long
//! operations, not `ART-cli`'s multi-minute renders.
//!
//! Two targets share one board/worker so the Activity panel's Export section
//! (§ frontend `ActivityPanel.tsx`) can show folder and Flickr jobs
//! together, same as how `art_queue.rs`'s board carries both ART round-trip
//! variants.

use std::collections::{HashMap, VecDeque};
use std::fs::OpenOptions;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tokio::sync::{mpsc, watch, OwnedSemaphorePermit, Semaphore};

use crate::art;
use crate::art_queue::{self, ArtQueue};
use crate::config::LibraryConfig;
use crate::exiftool::{self, MetadataPolicy};
use crate::export_naming;
use crate::flickr::{self, FlickrPrivacy};
use crate::immich::ImmichClient;
use crate::paths;
use crate::state::AppState;

/// Network/disk I/O, not a single heavyweight external process like
/// `ART-cli` - a higher cap than `art_queue::MAX_CONCURRENT_ART_JOBS` is
/// safe here.
pub const MAX_CONCURRENT_EXPORT_JOBS: usize = 3;

/// Same cap and reasoning as `art_queue::MAX_COMPLETED_HISTORY`.
const MAX_COMPLETED_HISTORY: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ExportJobStatus {
    Pending,
    Running,
    Done,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExportTargetKind {
    Folder,
    Flickr,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExportFormat {
    /// Immich's own `preview` rendition, optionally downsized to
    /// `RenditionOptions::size_px` and always re-encoded at
    /// `RenditionOptions::quality` (even at "Full" size, so the quality
    /// slider always takes effect).
    Jpeg,
    /// The untouched source file - local copy when a path mapping resolves
    /// it (see `paths::resolve_local_path`), otherwise Immich's
    /// `/assets/{id}/original` download.
    Original,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportJob {
    pub job_id: u64,
    pub asset_id: String,
    pub target: ExportTargetKind,
    pub status: ExportJobStatus,
    /// Set once `Done` - the delivered file's name (on disk, or as uploaded
    /// to Flickr).
    pub export_file_name: Option<String>,
    /// `None` until the job finishes (no natural midpoint to report - see
    /// the module doc comment), `Some(100)` on success.
    pub progress_percent: Option<u8>,
    pub created_at_ms: u64,
    pub finished_at_ms: Option<u64>,
    pub error: Option<String>,
    pub cancel_requested: bool,
}

#[derive(Clone)]
pub struct RenditionOptions {
    pub format: ExportFormat,
    pub size_px: Option<u32>,
    pub quality: u8,
    pub metadata: MetadataPolicy,
}

/// Coordinates a "New album" Flickr export across every job in the same
/// batch: whichever job's upload finishes first creates the album (Flickr
/// requires an existing photo id as a photoset's primary photo) and stores
/// its id here; every other job just links its own uploaded photo into that
/// id via `flickr.photosets.addPhoto`. One fresh cell per `export_to_flickr`
/// call (built in `commands.rs`), shared (cloned) into every target in that
/// call - never reused across separate export actions.
pub type PendingAlbumCell = Arc<tokio::sync::Mutex<Option<String>>>;

#[derive(Clone)]
pub enum FlickrAlbumChoice {
    None,
    Existing(String),
    New { title: String, cell: PendingAlbumCell },
}

#[derive(Clone)]
pub enum ExportDelivery {
    Folder { destination: PathBuf },
    Flickr { title: String, privacy: FlickrPrivacy, album: FlickrAlbumChoice },
}

/// One asset's worth of export work, fully resolved by the caller
/// (`commands::export_to_folder`/`export_to_flickr`) before it's handed to
/// the queue - `enqueue` itself does no I/O, same shape as
/// `art_queue::QueuedArtWork`.
pub struct ExportTarget {
    pub asset_id: String,
    pub original_path: Option<String>,
    pub file_name: String,
    pub file_extension: String,
    /// Whether this asset is RAW - resolved by the frontend's `isRawAsset()`
    /// (see `commands.rs`'s `ExportAssetTarget::is_raw` doc comment for why
    /// the backend trusts this instead of re-deriving it from
    /// `file_extension` alone: the frontend's `isRawOverride` exception has
    /// no backend-visible equivalent). Only changes behavior for
    /// `RenditionOptions::format == ExportFormat::Jpeg`, where `true` routes
    /// through a headless `ART-cli` conversion instead of Immich's `preview`
    /// rendition - see `resolve_rendition`.
    pub is_raw: bool,
    pub rendition: RenditionOptions,
    pub delivery: ExportDelivery,
}

pub(crate) struct QueuedExport {
    job_id: u64,
    asset_id: String,
    original_path: Option<String>,
    file_name: String,
    file_extension: String,
    is_raw: bool,
    rendition: RenditionOptions,
    delivery: ExportDelivery,
}

pub struct ExportQueue {
    board: Mutex<VecDeque<ExportJob>>,
    next_id: AtomicU64,
    tx: mpsc::UnboundedSender<QueuedExport>,
    semaphore: Arc<Semaphore>,
    cancel_senders: Mutex<HashMap<u64, watch::Sender<bool>>>,
}

impl ExportQueue {
    pub fn new() -> (Arc<Self>, mpsc::UnboundedReceiver<QueuedExport>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let queue = Arc::new(Self {
            board: Mutex::new(VecDeque::new()),
            next_id: AtomicU64::new(1),
            tx,
            semaphore: Arc::new(Semaphore::new(MAX_CONCURRENT_EXPORT_JOBS)),
            cancel_senders: Mutex::new(HashMap::new()),
        });
        (queue, rx)
    }

    pub async fn acquire_permit(&self) -> OwnedSemaphorePermit {
        self.semaphore.clone().acquire_owned().await.expect("ExportQueue's semaphore is never closed")
    }

    /// Pushes one `Pending` job per target and hands each to the drain
    /// worker, returning the assigned job ids in the same order as
    /// `targets` - same "enqueue and let the frontend poll" shape as
    /// `art_queue::ArtQueue::enqueue`.
    pub fn enqueue(&self, targets: Vec<ExportTarget>) -> Vec<u64> {
        let mut ids = Vec::with_capacity(targets.len());
        let mut board = self.board.lock().unwrap();
        for t in targets {
            let job_id = self.next_id.fetch_add(1, Ordering::Relaxed);
            let target_kind = match &t.delivery {
                ExportDelivery::Folder { .. } => ExportTargetKind::Folder,
                ExportDelivery::Flickr { .. } => ExportTargetKind::Flickr,
            };
            board.push_back(ExportJob {
                job_id,
                asset_id: t.asset_id.clone(),
                target: target_kind,
                status: ExportJobStatus::Pending,
                export_file_name: None,
                progress_percent: None,
                created_at_ms: now_ms(),
                finished_at_ms: None,
                error: None,
                cancel_requested: false,
            });
            self.register_cancel_channel(job_id);
            // A send error here only means the app is shutting down - same
            // as every other queue's `enqueue`.
            let _ = self.tx.send(QueuedExport {
                job_id,
                asset_id: t.asset_id,
                original_path: t.original_path,
                file_name: t.file_name,
                file_extension: t.file_extension,
                is_raw: t.is_raw,
                rendition: t.rendition,
                delivery: t.delivery,
            });
            ids.push(job_id);
        }
        ids
    }

    pub fn snapshot(&self) -> Vec<ExportJob> {
        self.board.lock().unwrap().iter().cloned().collect()
    }

    pub fn pending_count(&self) -> usize {
        self.board.lock().unwrap().iter().filter(|j| matches!(j.status, ExportJobStatus::Pending | ExportJobStatus::Running)).count()
    }

    pub fn clear_completed(&self) {
        let mut board = self.board.lock().unwrap();
        board.retain(|j| matches!(j.status, ExportJobStatus::Pending | ExportJobStatus::Running));
    }

    fn register_cancel_channel(&self, job_id: u64) {
        let (tx, _rx) = watch::channel(false);
        self.cancel_senders.lock().unwrap().insert(job_id, tx);
    }

    fn cancel_receiver(&self, job_id: u64) -> Option<watch::Receiver<bool>> {
        self.cancel_senders.lock().unwrap().get(&job_id).map(|tx| tx.subscribe())
    }

    /// Same semantics as `art_queue::ArtQueue::request_cancel` - a no-op
    /// (returns `false`) once a job is already `Done`/`Failed`.
    pub fn request_cancel(&self, job_id: u64) -> bool {
        let mut board = self.board.lock().unwrap();
        let Some(job) = board.iter_mut().find(|j| j.job_id == job_id) else { return false };
        if !matches!(job.status, ExportJobStatus::Pending | ExportJobStatus::Running) {
            return false;
        }
        job.cancel_requested = true;
        drop(board);
        if let Some(tx) = self.cancel_senders.lock().unwrap().get(&job_id) {
            let _ = tx.send(true);
        }
        true
    }

    fn set_status(&self, job_id: u64, status: ExportJobStatus) {
        let mut board = self.board.lock().unwrap();
        if let Some(job) = board.iter_mut().find(|j| j.job_id == job_id) {
            job.status = status;
        }
    }

    fn set_progress(&self, job_id: u64, percent: u8) {
        let mut board = self.board.lock().unwrap();
        if let Some(job) = board.iter_mut().find(|j| j.job_id == job_id) {
            job.progress_percent = Some(percent);
        }
    }

    fn finish(&self, job_id: u64, status: ExportJobStatus, export_file_name: Option<String>, error: Option<String>) {
        let mut board = self.board.lock().unwrap();
        if let Some(job) = board.iter_mut().find(|j| j.job_id == job_id) {
            job.status = status;
            job.finished_at_ms = Some(now_ms());
            job.export_file_name = export_file_name;
            job.error = error;
        }
        trim_completed(&mut board);
        drop(board);
        self.cancel_senders.lock().unwrap().remove(&job_id);
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Identical trimming rule to `art_queue::trim_completed`.
fn trim_completed(board: &mut VecDeque<ExportJob>) {
    let completed = board.iter().filter(|j| matches!(j.status, ExportJobStatus::Done | ExportJobStatus::Failed)).count();
    let mut to_remove = completed.saturating_sub(MAX_COMPLETED_HISTORY);
    let mut i = 0;
    while to_remove > 0 && i < board.len() {
        if matches!(board[i].status, ExportJobStatus::Done | ExportJobStatus::Failed) {
            board.remove(i);
            to_remove -= 1;
        } else {
            i += 1;
        }
    }
}

/// The drain worker - spawned once from `lib.rs`'s `.setup()`, same shape as
/// `art_queue::run`.
pub async fn run(app: AppHandle, mut rx: mpsc::UnboundedReceiver<QueuedExport>) {
    let queue = app.state::<AppState>().export_queue.clone();
    let http = app.state::<AppState>().http.clone();

    while let Some(work) = rx.recv().await {
        let queue = queue.clone();
        let http = http.clone();
        let app = app.clone();

        tauri::async_runtime::spawn(async move {
            let _permit = queue.acquire_permit().await;

            // Re-checked here (not just at `request_cancel` time) - see
            // `art_queue::run`'s identical comment for why: a cancel can
            // land while this job was still queued behind the semaphore.
            let cancel_rx = queue.cancel_receiver(work.job_id).unwrap_or_else(|| watch::channel(false).1);
            if *cancel_rx.borrow() {
                queue.finish(work.job_id, ExportJobStatus::Failed, None, Some("Cancelled by user".to_string()));
                return;
            }
            queue.set_status(work.job_id, ExportJobStatus::Running);

            let (library_cfg, flickr_cfg, applications_cfg, auto_resolution, art_queue) = {
                let app_state = app.state::<AppState>();
                let guard = app_state.config.lock().unwrap();
                (
                    guard.library.clone(),
                    guard.sharing.flickr.clone(),
                    guard.applications.clone(),
                    app_state.auto_resolution.clone(),
                    app_state.art_queue.clone(),
                )
            };

            // `cancel_rx` is cloned here (not moved) because the RAW branch
            // of `resolve_rendition` needs to thread it into a real,
            // potentially multi-minute `ART-cli` invocation - see the module
            // doc comment's cancellation note.
            match run_one(&http, &library_cfg, &flickr_cfg, &applications_cfg, &art_queue, &work, &auto_resolution, cancel_rx).await {
                Ok(export_file_name) => {
                    queue.set_progress(work.job_id, 100);
                    queue.finish(work.job_id, ExportJobStatus::Done, Some(export_file_name), None);
                }
                Err(e) => queue.finish(work.job_id, ExportJobStatus::Failed, None, Some(e)),
            }
        });
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_one(
    http: &reqwest::Client,
    library_cfg: &LibraryConfig,
    flickr_cfg: &crate::config::FlickrConfig,
    applications_cfg: &crate::config::ApplicationsConfig,
    art_queue: &ArtQueue,
    work: &QueuedExport,
    auto_resolution: &Mutex<Option<crate::config::AutoResolution>>,
    cancel_rx: watch::Receiver<bool>,
) -> Result<String, String> {
    let immich = ImmichClient::from_config(library_cfg, http.clone(), auto_resolution).await?;
    let (bytes, filename, mime) = resolve_rendition(
        &immich,
        library_cfg,
        &applications_cfg.art_cli_path,
        &applications_cfg.exiftool_path,
        art_queue,
        &work.asset_id,
        &work.original_path,
        &work.file_name,
        &work.file_extension,
        work.is_raw,
        &work.rendition,
        work.job_id,
        cancel_rx,
    )
    .await?;

    let bytes = apply_metadata_policy(
        bytes,
        &filename,
        matches!(work.rendition.format, ExportFormat::Original),
        work.rendition.metadata,
        &applications_cfg.exiftool_path,
        &immich,
        library_cfg,
        &work.asset_id,
        &work.original_path,
        &work.file_name,
        work.job_id,
    )
    .await?;

    match &work.delivery {
        ExportDelivery::Folder { destination } => deliver_to_folder(bytes, filename, destination.clone()).await,
        ExportDelivery::Flickr { title, privacy, album } => {
            if !flickr_cfg.connected {
                return Err("Flickr isn't connected — go to Preferences → Sharing to set it up".to_string());
            }
            deliver_to_flickr(http, flickr_cfg, bytes, filename, mime, title.clone(), *privacy, album.clone()).await
        }
    }
}

/// Produces the bytes to actually deliver, plus a filename and MIME type -
/// shared by both delivery targets (see the module doc comment for why
/// there's just one rendition step regardless of where it ends up).
///
/// `is_raw && format == Jpeg` is the one branch that doesn't go anywhere near
/// Immich's own `preview` rendition at all - it headless-converts the RAW's
/// local file through `ART-cli` first (same sidecar-aware mechanism as
/// Headless RAW Roundtrip, see `convert_raw_to_jpeg`), then feeds that
/// full-resolution output into the *same* `encode_jpeg_rendition` resize/
/// quality step a non-RAW asset's Immich preview goes through - unifying the
/// two source paths before delivery/metadata handling ever sees them.
#[allow(clippy::too_many_arguments)]
async fn resolve_rendition(
    immich: &ImmichClient,
    library_cfg: &LibraryConfig,
    art_cli_path: &str,
    exiftool_path: &str,
    art_queue: &ArtQueue,
    asset_id: &str,
    original_path: &Option<String>,
    file_name: &str,
    file_extension: &str,
    is_raw: bool,
    rendition: &RenditionOptions,
    job_id: u64,
    cancel_rx: watch::Receiver<bool>,
) -> Result<(Vec<u8>, String, String), String> {
    match rendition.format {
        ExportFormat::Original => {
            let (bytes, filename) = fetch_true_original(immich, library_cfg, asset_id, original_path, file_name).await?;
            let mime = guess_mime(&filename);
            Ok((bytes, filename, mime))
        }
        ExportFormat::Jpeg => {
            let bytes = if is_raw {
                if art_cli_path.trim().is_empty() {
                    return Err("Configure ART-cli in Preferences → Applications to export RAW photos as JPEG".to_string());
                }
                let raw_path = original_path
                    .as_deref()
                    .and_then(|op| paths::resolve_local_path(op, library_cfg))
                    .ok_or_else(|| format!("No local path mapping configured for {file_name} — set up External Library mapping in Preferences → Library"))?;
                convert_raw_to_jpeg(art_cli_path, exiftool_path, art_queue, &raw_path, job_id, cancel_rx).await?
            } else {
                let (bytes, _mime) = immich.get_thumbnail_bytes(asset_id, "preview").await?;
                bytes
            };
            let size_px = rendition.size_px;
            let quality = rendition.quality;
            let out = tokio::task::spawn_blocking(move || encode_jpeg_rendition(&bytes, size_px, quality)).await.map_err(|e| e.to_string())??;
            let base = export_naming::base_name(file_name, file_extension);
            Ok((out, format!("{base}.jpg"), "image/jpeg".to_string()))
        }
    }
}

/// Reads an asset's true, unaltered original bytes - the local file when a
/// path mapping resolves it, otherwise Immich's `/assets/{id}/original`
/// download. Shared by the `Original` export format (`resolve_rendition`)
/// and `apply_metadata_policy`'s need for a full-metadata source to copy tags
/// from onto an otherwise metadata-free `Jpeg`-format rendition. `pub(crate)`
/// so `print.rs` can reuse the same source-resolution logic for a
/// print-quality image instead of duplicating it.
pub(crate) async fn fetch_true_original(
    immich: &ImmichClient,
    library_cfg: &LibraryConfig,
    asset_id: &str,
    original_path: &Option<String>,
    file_name: &str,
) -> Result<(Vec<u8>, String), String> {
    if let Some(op) = original_path {
        if let Some(local) = paths::resolve_local_path(op, library_cfg) {
            let read_path = local.clone();
            let bytes = tokio::task::spawn_blocking(move || std::fs::read(&read_path)).await.map_err(|e| e.to_string())?.map_err(|e| format!("Could not read local file: {e}"))?;
            let filename = local.file_name().and_then(|n| n.to_str()).unwrap_or(file_name).to_string();
            return Ok((bytes, filename));
        }
    }
    let (bytes, _mime) = immich.get_original_bytes(asset_id).await?;
    Ok((bytes, file_name.to_string()))
}

/// Headless-converts one RAW file through `ART-cli`, applying its own
/// sidecar (`.arp`/`.pp3`) if one exists or ART's default profile otherwise -
/// the exact same sidecar-presence-driven mode choice
/// `art_queue::mode_for_sidecar` already makes for Headless RAW Roundtrip.
/// Acquires a permit from `art_queue` - the **same** semaphore (capped at
/// `art_queue::MAX_CONCURRENT_ART_JOBS = 1`) Headless RAW Roundtrip's own
/// worker uses, not `ExportQueue`'s higher-concurrency one, so an export
/// batch full of RAW assets can never run alongside a Headless RAW Roundtrip
/// (or another RAW export job) and oversubscribe `ART-cli`'s confirmed-live
/// memory ceiling. `cancel_rx` is threaded into `ART-cli`'s own run so a
/// cancelled export actually kills a multi-minute conversion in progress,
/// not just a queued-but-not-yet-started one (see the module doc comment).
///
/// Goes through `run_art_cli_with_metadata_fallback` (not the bare
/// `run_art_cli_with_progress`) for the same Exiv2-crash `Mode=0` retry
/// Headless RAW Roundtrip's worker (`art_queue::run`) already gets - this was
/// previously the one `ART-cli` call site without it, so a `Mode=1` crash
/// here failed the export outright instead of recovering like the other two
/// call sites do.
async fn convert_raw_to_jpeg(art_cli_path: &str, exiftool_path: &str, art_queue: &ArtQueue, raw_path: &Path, job_id: u64, cancel_rx: watch::Receiver<bool>) -> Result<Vec<u8>, String> {
    let raw_path_owned = raw_path.to_path_buf();
    let has_sidecar = tokio::task::spawn_blocking(move || paths::find_processing_sidecar(&raw_path_owned).is_some()).await.map_err(|e| e.to_string())?;
    let mode = art_queue::mode_for_sidecar(has_sidecar);
    let temp_path = std::env::temp_dir().join(format!("immature-export-raw-{job_id}.jpg"));

    let _permit = art_queue.acquire_permit().await;
    // Re-checked here (not just wherever the caller last checked it) since
    // this permit acquisition can itself block for a while behind another
    // in-flight ART-cli process - same "cancel can land while queued"
    // reasoning as every other queue's worker in this codebase.
    if *cancel_rx.borrow() {
        return Err(art::CANCELLED_BY_USER.to_string());
    }
    let run = art::run_art_cli_with_metadata_fallback(art_cli_path, exiftool_path, raw_path, &temp_path, mode, |_percent| {}, cancel_rx);
    let outcome = match tokio::time::timeout(art::ART_CLI_RUN_TIMEOUT, run).await {
        Ok(r) => r,
        Err(_) => Err(format!("Timed out after {}s running ART-cli", art::ART_CLI_RUN_TIMEOUT.as_secs())),
    };
    let bytes = match outcome {
        Ok(()) => {
            let p = temp_path.clone();
            tokio::task::spawn_blocking(move || std::fs::read(&p)).await.map_err(|e| e.to_string())?.map_err(|e| format!("Could not read ART-cli output: {e}"))
        }
        Err(e) => Err(e),
    };
    let _ = std::fs::remove_file(&temp_path);
    bytes
}

/// Applies a metadata policy to the final rendition bytes before delivery,
/// shelling out to `exiftool` when there's real work to do. Two of the four
/// `(is_original_format, policy)` combinations are no-ops handled without
/// ever touching `exiftool`: `Original` + `Keep` (the bytes already are the
/// untouched original) and non-`Original` + `StripAll` (the `image` crate's
/// decode/re-encode in `encode_jpeg_rendition` already dropped everything).
///
/// `exiftool_path` empty while real work is needed is expected to be
/// unreachable in practice - `commands.rs`'s `export_to_folder`/
/// `export_to_flickr` reject the whole batch up front when the chosen
/// format/policy combination would need `exiftool` and none is configured -
/// but is still handled here defensively rather than assumed.
#[allow(clippy::too_many_arguments)]
async fn apply_metadata_policy(
    bytes: Vec<u8>,
    filename: &str,
    is_original_format: bool,
    policy: MetadataPolicy,
    exiftool_path: &str,
    immich: &ImmichClient,
    library_cfg: &LibraryConfig,
    asset_id: &str,
    original_path: &Option<String>,
    file_name: &str,
    job_id: u64,
) -> Result<Vec<u8>, String> {
    if is_original_format && matches!(policy, MetadataPolicy::Keep) {
        return Ok(bytes);
    }
    if !is_original_format && matches!(policy, MetadataPolicy::StripAll) {
        return Ok(bytes);
    }

    let (_, target_ext) = split_base_ext(filename);
    let target_temp = std::env::temp_dir().join(format!("immature-export-meta-{job_id}.{target_ext}"));
    tokio::fs::write(&target_temp, &bytes).await.map_err(|e| format!("Could not write temp file for metadata: {e}"))?;

    // A `Jpeg`-format rendition has no metadata of its own to edit yet (see
    // the module doc comment) - `Keep`/`RemoveGps` both need the asset's true
    // original fetched as a `-TagsFromFile` source. `Original` format is
    // already the full source, so it's edited in place instead (`RemoveGps`/
    // `StripAll` only - `Keep` already returned above).
    let source_temp = if !is_original_format && matches!(policy, MetadataPolicy::Keep | MetadataPolicy::RemoveGps) {
        let (source_bytes, source_filename) = fetch_true_original(immich, library_cfg, asset_id, original_path, file_name).await?;
        let (_, source_ext) = split_base_ext(&source_filename);
        let p = std::env::temp_dir().join(format!("immature-export-meta-src-{job_id}.{source_ext}"));
        tokio::fs::write(&p, &source_bytes).await.map_err(|e| format!("Could not write temp source file for metadata: {e}"))?;
        Some(p)
    } else {
        None
    };

    let args = exiftool::build_exiftool_args(policy, source_temp.as_deref(), &target_temp);
    let run_result = if let Some(args) = args {
        if exiftool_path.trim().is_empty() {
            Err("Configure exiftool in Preferences → Applications to use this metadata option (or choose \"Strip all metadata\", which needs no configuration)".to_string())
        } else {
            exiftool::run_exiftool(exiftool_path, &args).await
        }
    } else {
        Ok(())
    };

    let read_result = if run_result.is_ok() {
        tokio::fs::read(&target_temp).await.map_err(|e| format!("Could not read metadata-processed file: {e}"))
    } else {
        Ok(Vec::new())
    };

    let _ = tokio::fs::remove_file(&target_temp).await;
    if let Some(p) = &source_temp {
        let _ = tokio::fs::remove_file(p).await;
    }

    run_result?;
    read_result
}

/// Decodes Immich's `preview` JPEG, optionally downsizes it (fit within a
/// `size_px` x `size_px` box, preserving aspect ratio - `DynamicImage::resize`
/// already does exactly this), and always re-encodes at `quality` so the
/// quality slider takes effect even at "Full" size. Runs on a blocking
/// thread - both decode and encode are CPU-bound, not I/O.
fn encode_jpeg_rendition(bytes: &[u8], size_px: Option<u32>, quality: u8) -> Result<Vec<u8>, String> {
    let img = image::load_from_memory(bytes).map_err(|e| format!("Could not decode preview image: {e}"))?;
    let img = match size_px {
        Some(target) if img.width().max(img.height()) > target => img.resize(target, target, image::imageops::FilterType::Lanczos3),
        _ => img,
    };
    let mut out = Vec::new();
    let mut cursor = io::Cursor::new(&mut out);
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, quality);
    img.write_with_encoder(encoder).map_err(|e| format!("Could not encode JPEG: {e}"))?;
    Ok(out)
}

fn guess_mime(filename: &str) -> String {
    let ext = filename.rsplit('.').next().unwrap_or("").to_lowercase();
    match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "tif" | "tiff" => "image/tiff",
        "heic" | "heif" => "image/heic",
        "webp" => "image/webp",
        _ => "application/octet-stream",
    }
    .to_string()
}

async fn deliver_to_folder(bytes: Vec<u8>, filename: String, destination: PathBuf) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        std::fs::create_dir_all(&destination).map_err(|e| format!("Could not create export folder: {e}"))?;
        let (base, ext) = split_base_ext(&filename);
        let path = next_available_path(&destination, base, ext).map_err(|e| format!("Could not create export file: {e}"))?;
        if let Err(e) = std::fs::write(&path, &bytes) {
            let _ = std::fs::remove_file(&path);
            return Err(format!("Could not write export file: {e}"));
        }
        Ok(path.file_name().and_then(|n| n.to_str()).map(str::to_string).unwrap_or(filename))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn split_base_ext(filename: &str) -> (&str, &str) {
    match filename.rfind('.') {
        Some(idx) if idx > 0 => (&filename[..idx], &filename[idx + 1..]),
        _ => (filename, "export"),
    }
}

/// Same atomic-claim technique as `export_naming::next_export_path` (avoids
/// two concurrent resolutions both seeing the same "first free" name as
/// available), but with plain `{base}.{ext}` / `{base}-{n}.{ext}` naming -
/// Export to Folder has no round-trip suffix convention to match, unlike the
/// ART CLI export `export_naming.rs` was built for.
fn next_available_path(dir: &Path, base: &str, ext: &str) -> io::Result<PathBuf> {
    let mut n: u32 = 0;
    loop {
        let candidate = if n == 0 { dir.join(format!("{base}.{ext}")) } else { dir.join(format!("{base}-{n}.{ext}")) };
        match OpenOptions::new().write(true).create_new(true).open(&candidate) {
            Ok(_) => return Ok(candidate),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => n += 1,
            Err(e) => return Err(e),
        }
    }
}

async fn deliver_to_flickr(
    http: &reqwest::Client,
    flickr_cfg: &crate::config::FlickrConfig,
    bytes: Vec<u8>,
    filename: String,
    mime: String,
    title: String,
    privacy: FlickrPrivacy,
    album: FlickrAlbumChoice,
) -> Result<String, String> {
    let photo_id = flickr::upload(http, flickr_cfg, bytes, &filename, &mime, &title, privacy).await?;
    match album {
        FlickrAlbumChoice::None => {}
        FlickrAlbumChoice::Existing(album_id) => {
            flickr::add_to_album(http, flickr_cfg, &album_id, &photo_id).await?;
        }
        FlickrAlbumChoice::New { title: album_title, cell } => {
            let mut guard = cell.lock().await;
            match guard.clone() {
                Some(album_id) => {
                    drop(guard);
                    flickr::add_to_album(http, flickr_cfg, &album_id, &photo_id).await?;
                }
                None => {
                    let album_id = flickr::create_album(http, flickr_cfg, &album_title, &photo_id).await?;
                    *guard = Some(album_id);
                }
            }
        }
    }
    Ok(filename)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enqueue_assigns_ids_and_starts_pending() {
        let (queue, _rx) = ExportQueue::new();
        let ids = queue.enqueue(vec![
            ExportTarget {
                asset_id: "a".into(),
                original_path: None,
                file_name: "a.jpg".into(),
                file_extension: "jpg".into(),
                is_raw: false,
                rendition: RenditionOptions { format: ExportFormat::Original, size_px: None, quality: 90, metadata: MetadataPolicy::Keep },
                delivery: ExportDelivery::Folder { destination: PathBuf::from("/tmp/exports") },
            },
            ExportTarget {
                asset_id: "b".into(),
                original_path: None,
                file_name: "b.jpg".into(),
                file_extension: "jpg".into(),
                is_raw: false,
                rendition: RenditionOptions { format: ExportFormat::Jpeg, size_px: Some(1024), quality: 85, metadata: MetadataPolicy::Keep },
                delivery: ExportDelivery::Flickr { title: "b".into(), privacy: FlickrPrivacy::Public, album: FlickrAlbumChoice::None },
            },
        ]);
        assert_eq!(ids, vec![1, 2]);
        let snap = queue.snapshot();
        assert_eq!(snap.len(), 2);
        assert!(snap.iter().all(|j| j.status == ExportJobStatus::Pending));
        assert_eq!(snap[0].target, ExportTargetKind::Folder);
        assert_eq!(snap[1].target, ExportTargetKind::Flickr);
        assert_eq!(queue.pending_count(), 2);
    }

    #[test]
    fn request_cancel_flags_a_pending_job_and_signals_its_receiver() {
        let (queue, _rx) = ExportQueue::new();
        let ids = queue.enqueue(vec![ExportTarget {
            asset_id: "a".into(),
            original_path: None,
            file_name: "a.jpg".into(),
            file_extension: "jpg".into(),
            is_raw: false,
            rendition: RenditionOptions { format: ExportFormat::Original, size_px: None, quality: 90, metadata: MetadataPolicy::Keep },
            delivery: ExportDelivery::Folder { destination: PathBuf::from("/tmp/exports") },
        }]);
        let cancel_rx = queue.cancel_receiver(ids[0]).expect("job should have a registered cancel channel");
        assert!(!*cancel_rx.borrow());
        assert!(queue.request_cancel(ids[0]));
        assert!(queue.snapshot()[0].cancel_requested);
        assert!(*cancel_rx.borrow());
    }

    #[test]
    fn request_cancel_is_a_no_op_once_the_job_has_finished() {
        let (queue, _rx) = ExportQueue::new();
        let ids = queue.enqueue(vec![ExportTarget {
            asset_id: "a".into(),
            original_path: None,
            file_name: "a.jpg".into(),
            file_extension: "jpg".into(),
            is_raw: false,
            rendition: RenditionOptions { format: ExportFormat::Original, size_px: None, quality: 90, metadata: MetadataPolicy::Keep },
            delivery: ExportDelivery::Folder { destination: PathBuf::from("/tmp/exports") },
        }]);
        queue.finish(ids[0], ExportJobStatus::Done, Some("a.jpg".into()), None);
        assert!(!queue.request_cancel(ids[0]));
    }

    #[test]
    fn clear_completed_drops_only_done_and_failed() {
        let (queue, _rx) = ExportQueue::new();
        let ids = queue.enqueue(vec![
            ExportTarget {
                asset_id: "a".into(),
                original_path: None,
                file_name: "a.jpg".into(),
                file_extension: "jpg".into(),
                is_raw: false,
                rendition: RenditionOptions { format: ExportFormat::Original, size_px: None, quality: 90, metadata: MetadataPolicy::Keep },
                delivery: ExportDelivery::Folder { destination: PathBuf::from("/tmp/exports") },
            },
            ExportTarget {
                asset_id: "b".into(),
                original_path: None,
                file_name: "b.jpg".into(),
                file_extension: "jpg".into(),
                is_raw: false,
                rendition: RenditionOptions { format: ExportFormat::Original, size_px: None, quality: 90, metadata: MetadataPolicy::Keep },
                delivery: ExportDelivery::Folder { destination: PathBuf::from("/tmp/exports") },
            },
        ]);
        queue.finish(ids[0], ExportJobStatus::Done, Some("a.jpg".into()), None);
        queue.clear_completed();
        let snap = queue.snapshot();
        assert_eq!(snap.len(), 1);
        assert_eq!(snap[0].job_id, ids[1]);
    }

    #[test]
    fn next_available_path_starts_bare_then_numbers_on_collision() {
        let dir = std::env::temp_dir().join(format!("immature-test-export-queue-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let first = next_available_path(&dir, "IMG_1", "jpg").unwrap();
        assert_eq!(first, dir.join("IMG_1.jpg"));
        let second = next_available_path(&dir, "IMG_1", "jpg").unwrap();
        assert_eq!(second, dir.join("IMG_1-1.jpg"));
        let third = next_available_path(&dir, "IMG_1", "jpg").unwrap();
        assert_eq!(third, dir.join("IMG_1-2.jpg"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn split_base_ext_splits_on_last_dot() {
        assert_eq!(split_base_ext("IMG_0001.jpg"), ("IMG_0001", "jpg"));
        assert_eq!(split_base_ext("v1.2.jpg"), ("v1.2", "jpg"));
        assert_eq!(split_base_ext("no_extension"), ("no_extension", "export"));
    }
}
