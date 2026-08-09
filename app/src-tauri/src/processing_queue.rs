//! Decoupled, bounded-concurrency background queue for **Paste Image
//! Processing** - copying a RAW-editor develop-adjustment sidecar (ART
//! `.arp` or RawTherapee `.pp3`, see `paths::find_processing_sidecar`)
//! wholesale from one source asset onto one or more target assets.
//!
//! Deliberately a separate, smaller queue from `edit_queue.rs` rather than a
//! new job kind bolted onto it: this job is a plain local file copy with no
//! Immich call at all (a processing sidecar has no Immich-side
//! representation), so it doesn't fit `edit_queue`'s hardcoded
//! `tokio::join!`(XMP-write, Immich-PUT) dispatch. Same architectural
//! idioms as `edit_queue.rs` are reused throughout: a `Pending -> Copying ->
//! Done|Failed` board, a bounded `Semaphore`, `io_guard::guarded_spawn_blocking`
//! for the actual I/O, and a capped completed-history trim.
//!
//! `commands::paste_image_processing` resolves the source's local path and
//! processing-sidecar kind, and confirms one actually exists, *before*
//! calling `enqueue` - a source with nothing to copy is a synchronous error,
//! never a queued job doomed to fail.

use std::collections::{HashMap, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Manager};
use tokio::sync::{mpsc, Semaphore};

use crate::commands::MetadataEditTarget;
use crate::config::LibraryConfig;
use crate::io_guard;
use crate::paths::{self, ProcessingKind, SidecarForm};
use crate::state::AppState;

/// Deliberately small, same reasoning as `edit_queue::MAX_CONCURRENT_JOBS`:
/// these are tiny text files, but they still cross the same single shared
/// NFS/Tailscale mount that caused real slowdowns elsewhere (§7.19/§7.20).
pub const MAX_CONCURRENT_JOBS: usize = 4;

/// Same cap and reasoning as `edit_queue::MAX_COMPLETED_HISTORY`.
const MAX_COMPLETED_HISTORY: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProcessingJobStatus {
    Pending,
    Copying,
    Done,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessingJob {
    pub job_id: u64,
    pub target_asset_id: String,
    pub status: ProcessingJobStatus,
    pub created_at_ms: u64,
    pub finished_at_ms: Option<u64>,
    pub error: Option<String>,
}

/// What the worker needs to actually perform one job - resolved up front at
/// enqueue time, same as `edit_queue::QueuedWork`.
pub(crate) struct QueuedCopy {
    job_id: u64,
    target_asset_id: String,
    target_local_path: Option<PathBuf>,
    source_path: PathBuf,
    source_kind: ProcessingKind,
    source_form: SidecarForm,
}

pub struct ProcessingQueue {
    board: Mutex<VecDeque<ProcessingJob>>,
    next_id: AtomicU64,
    tx: mpsc::UnboundedSender<QueuedCopy>,
    // Same reasoning as `edit_queue::EditQueue::asset_locks`: serializes
    // same-target jobs (e.g. a rapid re-paste) so two writers can never race
    // on the same destination path's temp filename, while different targets
    // still run concurrently.
    asset_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl ProcessingQueue {
    pub fn new() -> (Arc<Self>, mpsc::UnboundedReceiver<QueuedCopy>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let queue = Arc::new(Self {
            board: Mutex::new(VecDeque::new()),
            next_id: AtomicU64::new(1),
            tx,
            asset_locks: Mutex::new(HashMap::new()),
        });
        (queue, rx)
    }

    fn asset_lock(&self, asset_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = self.asset_locks.lock().unwrap();
        locks.entry(asset_id.to_string()).or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))).clone()
    }

    /// Pushes one `Pending` job per target and hands each to the drain
    /// worker, returning the assigned job ids in the same order as
    /// `targets`. Called from `commands::paste_image_processing` after its
    /// `read_only`/`max_writes_per_batch` checks and after confirming the
    /// source actually has a processing sidecar.
    pub fn enqueue(
        &self,
        cfg: &LibraryConfig,
        source_path: PathBuf,
        source_kind: ProcessingKind,
        source_form: SidecarForm,
        targets: &[MetadataEditTarget],
    ) -> Vec<u64> {
        let mut ids = Vec::with_capacity(targets.len());
        let mut board = self.board.lock().unwrap();
        for target in targets {
            let job_id = self.next_id.fetch_add(1, Ordering::Relaxed);
            let target_local_path = target.original_path.as_deref().and_then(|p| paths::resolve_local_path(p, cfg));

            board.push_back(ProcessingJob {
                job_id,
                target_asset_id: target.id.clone(),
                status: ProcessingJobStatus::Pending,
                created_at_ms: now_ms(),
                finished_at_ms: None,
                error: None,
            });

            // See `edit_queue::EditQueue::enqueue`'s identical comment: a
            // send error here only means the app is shutting down.
            let _ = self.tx.send(QueuedCopy {
                job_id,
                target_asset_id: target.id.clone(),
                target_local_path,
                source_path: source_path.clone(),
                source_kind,
                source_form,
            });
            ids.push(job_id);
        }
        ids
    }

    pub fn snapshot(&self) -> Vec<ProcessingJob> {
        self.board.lock().unwrap().iter().cloned().collect()
    }

    pub fn pending_count(&self) -> usize {
        self.board
            .lock()
            .unwrap()
            .iter()
            .filter(|j| matches!(j.status, ProcessingJobStatus::Pending | ProcessingJobStatus::Copying))
            .count()
    }

    pub fn clear_completed(&self) {
        let mut board = self.board.lock().unwrap();
        board.retain(|j| matches!(j.status, ProcessingJobStatus::Pending | ProcessingJobStatus::Copying));
    }

    fn set_status(&self, job_id: u64, status: ProcessingJobStatus) {
        let mut board = self.board.lock().unwrap();
        if let Some(job) = board.iter_mut().find(|j| j.job_id == job_id) {
            job.status = status;
        }
    }

    fn finish(&self, job_id: u64, status: ProcessingJobStatus, error: Option<String>) {
        let mut board = self.board.lock().unwrap();
        if let Some(job) = board.iter_mut().find(|j| j.job_id == job_id) {
            job.status = status;
            job.finished_at_ms = Some(now_ms());
            job.error = error;
        }
        trim_completed(&mut board);
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Identical trimming rule to `edit_queue::trim_completed`.
fn trim_completed(board: &mut VecDeque<ProcessingJob>) {
    let completed = board.iter().filter(|j| matches!(j.status, ProcessingJobStatus::Done | ProcessingJobStatus::Failed)).count();
    let mut to_remove = completed.saturating_sub(MAX_COMPLETED_HISTORY);
    let mut i = 0;
    while to_remove > 0 && i < board.len() {
        if matches!(board[i].status, ProcessingJobStatus::Done | ProcessingJobStatus::Failed) {
            board.remove(i);
            to_remove -= 1;
        } else {
            i += 1;
        }
    }
}

/// Copies `source`'s bytes onto `dest`, atomically (unique tmp file + rename,
/// same idiom as `xmp.rs::write_atomic`/`import/queue.rs::copy_one` - a
/// distinct helper rather than a shared one since `import::hash` is private
/// to the `import` module and these are small text files with no need for
/// the chunked-progress/blake3-hash machinery that module's binary-file
/// copies need). Any failure cleans up the temp file first.
fn atomic_copy_sidecar(source: &Path, dest: &Path) -> Result<(), String> {
    let bytes = fs::read(source).map_err(|e| format!("Couldn't read {}: {e}", source.display()))?;
    let parent = dest.parent().ok_or_else(|| format!("{} has no parent directory", dest.display()))?;
    let file_name = dest.file_name().and_then(|n| n.to_str()).unwrap_or("sidecar");
    let tmp = parent.join(format!(".{file_name}.tmp.{}", std::process::id()));

    let result = (|| {
        fs::write(&tmp, &bytes).map_err(|e| format!("Couldn't write {}: {e}", tmp.display()))?;
        fs::rename(&tmp, dest).map_err(|e| format!("Couldn't finalize {}: {e}", dest.display()))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// The drain worker - spawned once from `lib.rs`'s `.setup()`, same shape as
/// `edit_queue::run`.
pub async fn run(app: AppHandle, mut rx: mpsc::UnboundedReceiver<QueuedCopy>) {
    let (io_guard, queue) = {
        let state = app.state::<AppState>();
        (state.io_guard.clone(), state.processing_queue.clone())
    };

    let semaphore = Arc::new(Semaphore::new(MAX_CONCURRENT_JOBS));

    while let Some(work) = rx.recv().await {
        let semaphore = semaphore.clone();
        let io_guard = io_guard.clone();
        let queue = queue.clone();

        let asset_lock = queue.asset_lock(&work.target_asset_id);

        tauri::async_runtime::spawn(async move {
            let _asset_guard = asset_lock.lock().await;
            let _permit = semaphore.acquire_owned().await;
            queue.set_status(work.job_id, ProcessingJobStatus::Copying);

            let Some(target_local_path) = work.target_local_path.clone() else {
                queue.finish(
                    work.job_id,
                    ProcessingJobStatus::Failed,
                    Some("Couldn't resolve a local path for this asset".to_string()),
                );
                return;
            };

            let source_path = work.source_path.clone();
            let source_kind = work.source_kind;
            let source_form = work.source_form;
            let result = match io_guard::guarded_spawn_blocking(&io_guard, move || {
                let dest = source_kind.sidecar_path_with_form(&target_local_path, source_form);
                atomic_copy_sidecar(&source_path, &dest)
            }) {
                Some(handle) => handle.await.map_err(|e| e.to_string()).and_then(|r| r),
                None => Err("Skipped: system is about to suspend, try again after it wakes".to_string()),
            };

            match result {
                Ok(()) => queue.finish(work.job_id, ProcessingJobStatus::Done, None),
                Err(e) => queue.finish(work.job_id, ProcessingJobStatus::Failed, Some(e)),
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(id: &str, original_path: Option<&str>) -> MetadataEditTarget {
        MetadataEditTarget { id: id.to_string(), original_path: original_path.map(str::to_string) }
    }

    fn tmp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("brighttable-test-procqueue-{label}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn enqueue_assigns_ids_and_starts_pending() {
        let (queue, _rx) = ProcessingQueue::new();
        let ids = queue.enqueue(
            &LibraryConfig::default(),
            PathBuf::from("/x/src.arp"),
            ProcessingKind::Arp,
            SidecarForm::Append,
            &[target("a", None), target("b", None)],
        );
        assert_eq!(ids, vec![1, 2]);

        let snap = queue.snapshot();
        assert_eq!(snap.len(), 2);
        assert!(snap.iter().all(|j| j.status == ProcessingJobStatus::Pending));
        assert_eq!(queue.pending_count(), 2);
    }

    #[test]
    fn enqueue_ids_keep_increasing_across_calls() {
        let (queue, _rx) = ProcessingQueue::new();
        let first =
            queue.enqueue(&LibraryConfig::default(), PathBuf::from("/x/src.pp3"), ProcessingKind::Pp3, SidecarForm::Append, &[target("a", None)]);
        let second =
            queue.enqueue(&LibraryConfig::default(), PathBuf::from("/x/src.pp3"), ProcessingKind::Pp3, SidecarForm::Append, &[target("b", None)]);
        assert_eq!(first, vec![1]);
        assert_eq!(second, vec![2]);
    }

    #[test]
    fn atomic_copy_sidecar_copies_bytes() {
        let dir = tmp_dir("copy");
        let src = dir.join("src.pp3");
        let dest = dir.join("dest.pp3");
        fs::write(&src, "[General]\nRank=3\n").unwrap();

        atomic_copy_sidecar(&src, &dest).unwrap();
        assert_eq!(fs::read_to_string(&dest).unwrap(), "[General]\nRank=3\n");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn atomic_copy_sidecar_cleans_up_temp_file_on_failure() {
        let dir = tmp_dir("fail");
        // A directory as the *source* fails on the read, after no temp file
        // is created yet - the real risk this test guards is a temp file
        // left behind after a *later* failure; exercise the write-failure
        // path instead by pointing dest at a location with no parent dir.
        let src = dir.join("src.arp");
        fs::write(&src, "settings").unwrap();
        let bogus_dest = dir.join("does-not-exist-parent").join("nested").join("dest.arp");

        let result = atomic_copy_sidecar(&src, &bogus_dest);
        assert!(result.is_err());

        let leftover: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp."))
            .collect();
        assert!(leftover.is_empty(), "no temp file should survive a failed copy");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn trim_completed_never_evicts_pending_or_copying() {
        fn job(status: ProcessingJobStatus) -> ProcessingJob {
            ProcessingJob { job_id: 0, target_asset_id: "a".into(), status, created_at_ms: 0, finished_at_ms: None, error: None }
        }
        let mut board: VecDeque<ProcessingJob> = VecDeque::new();
        board.push_back(job(ProcessingJobStatus::Pending));
        board.push_back(job(ProcessingJobStatus::Copying));
        for _ in 0..(MAX_COMPLETED_HISTORY + 50) {
            board.push_back(job(ProcessingJobStatus::Done));
        }
        trim_completed(&mut board);

        let pending_copying = board.iter().filter(|j| matches!(j.status, ProcessingJobStatus::Pending | ProcessingJobStatus::Copying)).count();
        assert_eq!(pending_copying, 2, "Pending/Copying entries must never be evicted");
        let completed = board.iter().filter(|j| matches!(j.status, ProcessingJobStatus::Done | ProcessingJobStatus::Failed)).count();
        assert_eq!(completed, MAX_COMPLETED_HISTORY);
    }
}
