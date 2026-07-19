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

use crate::config::LibraryConfig;
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
    pub rendition: RenditionOptions,
    pub delivery: ExportDelivery,
}

pub(crate) struct QueuedExport {
    job_id: u64,
    asset_id: String,
    original_path: Option<String>,
    file_name: String,
    file_extension: String,
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

            let (library_cfg, flickr_cfg) = {
                let app_state = app.state::<AppState>();
                let guard = app_state.config.lock().unwrap();
                (guard.library.clone(), guard.sharing.flickr.clone())
            };

            match run_one(&http, &library_cfg, &flickr_cfg, &work).await {
                Ok(export_file_name) => {
                    queue.set_progress(work.job_id, 100);
                    queue.finish(work.job_id, ExportJobStatus::Done, Some(export_file_name), None);
                }
                Err(e) => queue.finish(work.job_id, ExportJobStatus::Failed, None, Some(e)),
            }
        });
    }
}

async fn run_one(http: &reqwest::Client, library_cfg: &LibraryConfig, flickr_cfg: &crate::config::FlickrConfig, work: &QueuedExport) -> Result<String, String> {
    let immich = ImmichClient::from_config(library_cfg, http.clone())?;
    let (bytes, filename, mime) =
        resolve_rendition(&immich, library_cfg, &work.asset_id, &work.original_path, &work.file_name, &work.file_extension, &work.rendition).await?;

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
async fn resolve_rendition(
    immich: &ImmichClient,
    library_cfg: &LibraryConfig,
    asset_id: &str,
    original_path: &Option<String>,
    file_name: &str,
    file_extension: &str,
    rendition: &RenditionOptions,
) -> Result<(Vec<u8>, String, String), String> {
    match rendition.format {
        ExportFormat::Original => {
            if let Some(op) = original_path {
                if let Some(local) = paths::resolve_local_path(op, library_cfg) {
                    let read_path = local.clone();
                    let bytes = tokio::task::spawn_blocking(move || std::fs::read(&read_path)).await.map_err(|e| e.to_string())?.map_err(|e| format!("Could not read local file: {e}"))?;
                    let filename = local.file_name().and_then(|n| n.to_str()).unwrap_or(file_name).to_string();
                    let mime = guess_mime(&filename);
                    return Ok((bytes, filename, mime));
                }
            }
            let (bytes, mime) = immich.get_original_bytes(asset_id).await?;
            Ok((bytes, file_name.to_string(), mime))
        }
        ExportFormat::Jpeg => {
            let (bytes, _mime) = immich.get_thumbnail_bytes(asset_id, "preview").await?;
            let size_px = rendition.size_px;
            let quality = rendition.quality;
            let out = tokio::task::spawn_blocking(move || encode_jpeg_rendition(&bytes, size_px, quality)).await.map_err(|e| e.to_string())??;
            let base = export_naming::base_name(file_name, file_extension);
            Ok((out, format!("{base}.jpg"), "image/jpeg".to_string()))
        }
    }
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
                rendition: RenditionOptions { format: ExportFormat::Original, size_px: None, quality: 90 },
                delivery: ExportDelivery::Folder { destination: PathBuf::from("/tmp/exports") },
            },
            ExportTarget {
                asset_id: "b".into(),
                original_path: None,
                file_name: "b.jpg".into(),
                file_extension: "jpg".into(),
                rendition: RenditionOptions { format: ExportFormat::Jpeg, size_px: Some(1024), quality: 85 },
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
            rendition: RenditionOptions { format: ExportFormat::Original, size_px: None, quality: 90 },
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
            rendition: RenditionOptions { format: ExportFormat::Original, size_px: None, quality: 90 },
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
                rendition: RenditionOptions { format: ExportFormat::Original, size_px: None, quality: 90 },
                delivery: ExportDelivery::Folder { destination: PathBuf::from("/tmp/exports") },
            },
            ExportTarget {
                asset_id: "b".into(),
                original_path: None,
                file_name: "b.jpg".into(),
                file_extension: "jpg".into(),
                rendition: RenditionOptions { format: ExportFormat::Original, size_px: None, quality: 90 },
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
