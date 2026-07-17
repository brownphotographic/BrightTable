//! Background queue for **Batch RAW Roundtrip** (Variant 2 of the ART CLI
//! round trip) - fully headless `ART-cli` exports of N assets at once, with
//! visible per-asset progress. Modeled directly on `processing_queue.rs`
//! (closest sibling: local-I/O-only worker per job, no Immich API call
//! inside the job itself), same `Pending -> Running -> Done|Failed` board, a
//! bounded `Semaphore`, and a capped completed-history trim.
//!
//! Unlike `processing_queue.rs`, a job here spawns a real `ART-cli` child
//! process rather than doing a blocking `fs` copy, so it doesn't go through
//! `io_guard::guarded_spawn_blocking` - an in-flight `tokio::process::Command`
//! child isn't tracked by `io_guard` (which only gates new `spawn_blocking`
//! calls), so the existing `suspend_guard` mechanism remains the real
//! backstop for an in-progress export during a suspend transition, same
//! pre-existing limitation class as other long-running I/O in this app. Each
//! job's own `raw_path`/`export_path` are resolved up front by
//! `commands::batch_art_round_trip` (through its own `guarded_spawn_blocking`
//! call, since *that* resolution is real blocking disk work) - `enqueue`
//! itself does no I/O.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Manager};
use tokio::sync::{mpsc, Semaphore};

use crate::art::{self, ArtCliMode};
use crate::state::AppState;

/// Deliberately lower than the other queues' `4` - ART-cli's demosaic/
/// denoise pass is CPU/RAM-heavy, unlike a sidecar copy or XMP write. A
/// tunable default, not a hard requirement.
pub const MAX_CONCURRENT_ART_JOBS: usize = 2;

/// Same cap and reasoning as `edit_queue::MAX_COMPLETED_HISTORY`.
const MAX_COMPLETED_HISTORY: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ArtJobStatus {
    Pending,
    Running,
    Done,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtJob {
    pub job_id: u64,
    pub asset_id: String,
    pub status: ArtJobStatus,
    /// Set once `Done` - the generated export's bare filename (same
    /// directory as the original RAW), used by the frontend's incremental
    /// per-asset ingestion (`useArtJobReconciliation`) to call
    /// `ingestRoundTripExport` without needing a second round trip to
    /// discover it.
    pub export_file_name: Option<String>,
    pub created_at_ms: u64,
    pub finished_at_ms: Option<u64>,
    pub error: Option<String>,
}

/// What the worker needs to actually perform one job - resolved up front at
/// enqueue time (by `commands::batch_art_round_trip`), same as
/// `edit_queue::QueuedWork`/`processing_queue::QueuedCopy`.
pub(crate) struct QueuedArtWork {
    job_id: u64,
    asset_id: String,
    art_cli_path: String,
    raw_path: PathBuf,
    export_path: PathBuf,
}

pub struct ArtQueue {
    board: Mutex<VecDeque<ArtJob>>,
    next_id: AtomicU64,
    tx: mpsc::UnboundedSender<QueuedArtWork>,
    // Same reasoning as `edit_queue::EditQueue::asset_locks`: serializes
    // same-asset jobs so two exports for the same asset can never race on
    // the same collision-numbered export path, while different assets still
    // run concurrently up to `MAX_CONCURRENT_ART_JOBS`.
    asset_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl ArtQueue {
    pub fn new() -> (Arc<Self>, mpsc::UnboundedReceiver<QueuedArtWork>) {
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

    /// Pushes one `Pending` job per already-resolved target and hands each to
    /// the drain worker, returning the assigned job ids in the same order as
    /// `targets`. Called from `commands::batch_art_round_trip` after its
    /// `read_only`/`max_writes_per_batch` checks and after resolving every
    /// target's local/export path.
    pub fn enqueue(&self, art_cli_path: &str, targets: Vec<(String, PathBuf, PathBuf)>) -> Vec<u64> {
        let mut ids = Vec::with_capacity(targets.len());
        let mut board = self.board.lock().unwrap();
        for (asset_id, raw_path, export_path) in targets {
            let job_id = self.next_id.fetch_add(1, Ordering::Relaxed);
            board.push_back(ArtJob {
                job_id,
                asset_id: asset_id.clone(),
                status: ArtJobStatus::Pending,
                export_file_name: None,
                created_at_ms: now_ms(),
                finished_at_ms: None,
                error: None,
            });
            // See `edit_queue::EditQueue::enqueue`'s identical comment: a
            // send error here only means the app is shutting down.
            let _ = self.tx.send(QueuedArtWork { job_id, asset_id, art_cli_path: art_cli_path.to_string(), raw_path, export_path });
            ids.push(job_id);
        }
        ids
    }

    pub fn snapshot(&self) -> Vec<ArtJob> {
        self.board.lock().unwrap().iter().cloned().collect()
    }

    pub fn pending_count(&self) -> usize {
        self.board.lock().unwrap().iter().filter(|j| matches!(j.status, ArtJobStatus::Pending | ArtJobStatus::Running)).count()
    }

    pub fn clear_completed(&self) {
        let mut board = self.board.lock().unwrap();
        board.retain(|j| matches!(j.status, ArtJobStatus::Pending | ArtJobStatus::Running));
    }

    fn set_status(&self, job_id: u64, status: ArtJobStatus) {
        let mut board = self.board.lock().unwrap();
        if let Some(job) = board.iter_mut().find(|j| j.job_id == job_id) {
            job.status = status;
        }
    }

    fn finish(&self, job_id: u64, status: ArtJobStatus, export_file_name: Option<String>, error: Option<String>) {
        let mut board = self.board.lock().unwrap();
        if let Some(job) = board.iter_mut().find(|j| j.job_id == job_id) {
            job.status = status;
            job.finished_at_ms = Some(now_ms());
            job.export_file_name = export_file_name;
            job.error = error;
        }
        trim_completed(&mut board);
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Identical trimming rule to `edit_queue::trim_completed`.
fn trim_completed(board: &mut VecDeque<ArtJob>) {
    let completed = board.iter().filter(|j| matches!(j.status, ArtJobStatus::Done | ArtJobStatus::Failed)).count();
    let mut to_remove = completed.saturating_sub(MAX_COMPLETED_HISTORY);
    let mut i = 0;
    while to_remove > 0 && i < board.len() {
        if matches!(board[i].status, ArtJobStatus::Done | ArtJobStatus::Failed) {
            board.remove(i);
            to_remove -= 1;
        } else {
            i += 1;
        }
    }
}

/// The drain worker - spawned once from `lib.rs`'s `.setup()`, same shape as
/// `processing_queue::run`. Batch round trip always applies the user's ART
/// default profile with each asset's own sidecar layered over it (see
/// `art::ArtCliMode::DefaultThenSidecarOverride`'s doc comment) - unlike
/// Variant 1's interactive round trip, there's no "ART just wrote this
/// sidecar from the user's live edit" case here.
pub async fn run(app: AppHandle, mut rx: mpsc::UnboundedReceiver<QueuedArtWork>) {
    let queue = app.state::<AppState>().art_queue.clone();
    let semaphore = Arc::new(Semaphore::new(MAX_CONCURRENT_ART_JOBS));

    while let Some(work) = rx.recv().await {
        let semaphore = semaphore.clone();
        let queue = queue.clone();
        let asset_lock = queue.asset_lock(&work.asset_id);

        tauri::async_runtime::spawn(async move {
            let _asset_guard = asset_lock.lock().await;
            let _permit = semaphore.acquire_owned().await;
            queue.set_status(work.job_id, ArtJobStatus::Running);

            let args = art::build_art_cli_args(ArtCliMode::DefaultThenSidecarOverride, &work.export_path, &work.raw_path);
            match art::run_art_cli(&work.art_cli_path, &args).await {
                Ok(()) => {
                    let export_file_name = work.export_path.file_name().and_then(|n| n.to_str()).map(str::to_string);
                    queue.finish(work.job_id, ArtJobStatus::Done, export_file_name, None);
                }
                Err(e) => queue.finish(work.job_id, ArtJobStatus::Failed, None, Some(e)),
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enqueue_assigns_ids_and_starts_pending() {
        let (queue, _rx) = ArtQueue::new();
        let ids = queue.enqueue(
            "/usr/bin/ART-cli",
            vec![("a".into(), PathBuf::from("/x/a.DNG"), PathBuf::from("/x/a_converted-1.jpg")), ("b".into(), PathBuf::from("/x/b.DNG"), PathBuf::from("/x/b_converted-1.jpg"))],
        );
        assert_eq!(ids, vec![1, 2]);

        let snap = queue.snapshot();
        assert_eq!(snap.len(), 2);
        assert!(snap.iter().all(|j| j.status == ArtJobStatus::Pending));
        assert_eq!(queue.pending_count(), 2);
    }

    #[test]
    fn enqueue_ids_keep_increasing_across_calls() {
        let (queue, _rx) = ArtQueue::new();
        let first = queue.enqueue("/usr/bin/ART-cli", vec![("a".into(), PathBuf::from("/x/a.DNG"), PathBuf::from("/x/a_converted-1.jpg"))]);
        let second = queue.enqueue("/usr/bin/ART-cli", vec![("b".into(), PathBuf::from("/x/b.DNG"), PathBuf::from("/x/b_converted-1.jpg"))]);
        assert_eq!(first, vec![1]);
        assert_eq!(second, vec![2]);
    }

    #[test]
    fn asset_lock_is_shared_per_asset_and_distinct_across_assets() {
        let (queue, _rx) = ArtQueue::new();
        let a1 = queue.asset_lock("asset-a");
        let a2 = queue.asset_lock("asset-a");
        let b = queue.asset_lock("asset-b");
        assert!(Arc::ptr_eq(&a1, &a2), "same asset id must reuse the same lock");
        assert!(!Arc::ptr_eq(&a1, &b), "different asset ids must get independent locks");
    }

    #[test]
    fn clear_completed_drops_only_done_and_failed() {
        let (queue, _rx) = ArtQueue::new();
        let ids = queue.enqueue(
            "/usr/bin/ART-cli",
            vec![("a".into(), PathBuf::from("/x/a.DNG"), PathBuf::from("/x/a_converted-1.jpg")), ("b".into(), PathBuf::from("/x/b.DNG"), PathBuf::from("/x/b_converted-1.jpg"))],
        );
        queue.finish(ids[0], ArtJobStatus::Done, Some("a_converted-1.jpg".into()), None);
        queue.clear_completed();
        let snap = queue.snapshot();
        assert_eq!(snap.len(), 1);
        assert_eq!(snap[0].job_id, ids[1]);
    }

    #[test]
    fn trim_completed_never_evicts_pending_or_running() {
        fn job(status: ArtJobStatus) -> ArtJob {
            ArtJob { job_id: 0, asset_id: "a".into(), status, export_file_name: None, created_at_ms: 0, finished_at_ms: None, error: None }
        }
        let mut board: VecDeque<ArtJob> = VecDeque::new();
        board.push_back(job(ArtJobStatus::Pending));
        board.push_back(job(ArtJobStatus::Running));
        for _ in 0..(MAX_COMPLETED_HISTORY + 50) {
            board.push_back(job(ArtJobStatus::Done));
        }
        trim_completed(&mut board);

        let pending_running = board.iter().filter(|j| matches!(j.status, ArtJobStatus::Pending | ArtJobStatus::Running)).count();
        assert_eq!(pending_running, 2, "Pending/Running entries must never be evicted");
        let completed = board.iter().filter(|j| matches!(j.status, ArtJobStatus::Done | ArtJobStatus::Failed)).count();
        assert_eq!(completed, MAX_COMPLETED_HISTORY);
    }
}
