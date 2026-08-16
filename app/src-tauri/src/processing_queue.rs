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

//! Decoupled, bounded-concurrency background queue for **Paste Image
//! Processing** - applying every RAW-editor tool's develop-adjustment
//! settings a source asset has (ART `.arp`, RawTherapee `.pp3`, and/or
//! darktable's `.xmp`-embedded history - see `paths::find_all_processing_sources`)
//! onto one or more target assets, "one for each" tool the source actually
//! has settings from.
//!
//! Deliberately a separate, smaller queue from `edit_queue.rs` rather than a
//! new job kind bolted onto it: most of these jobs are a plain local file
//! copy with no Immich call at all (a processing sidecar has no Immich-side
//! representation), so it doesn't fit `edit_queue`'s hardcoded
//! `tokio::join!`(XMP-write, Immich-PUT) dispatch. Same architectural
//! idioms as `edit_queue.rs` are reused throughout: a `Pending -> Copying ->
//! Done|Failed` board, a bounded `Semaphore`, `io_guard::guarded_spawn_blocking`
//! for the actual I/O, and a capped completed-history trim.
//!
//! One `ProcessingJob` per **(target, tool)** pair, not per target - a
//! source with settings from two tools produces two jobs per target, each
//! independently `Done`/`Failed` (e.g. ART copies fine, darktable's `.xmp`
//! merge fails), mirroring `art_queue.rs`'s per-tool `ArtJob` model for RAW
//! CLI roundtrip jobs. `commands::paste_image_processing` resolves the
//! source's local path and *every* tool's `ProcessingSource` it has settings
//! for, and confirms at least one exists, *before* calling `enqueue` - a
//! source with nothing to paste is a synchronous error, never a queued job
//! doomed to fail.
//!
//! `Sidecar` sources (ART/RawTherapee) are still a plain whole-file copy
//! (`atomic_copy_sidecar`, unchanged). `DarkTable` sources instead go through
//! `xmp::paste_darktable_island` - a surgical merge, not a copy, since
//! darktable's history shares the target's `.xmp` with rating/description
//! (owned by `EditQueue`/Copy-Paste Metadata). Both kinds of job acquire the
//! same per-target lock from the `AssetLocks` this queue now shares with
//! `EditQueue` (see that type's own doc comment) before touching disk, so a
//! `DarkTable` job here can never race an `EditQueue` rating write to the
//! same `.xmp`.

use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Manager};
use tokio::sync::{mpsc, Semaphore};

use crate::asset_locks::AssetLocks;
use crate::commands::MetadataEditTarget;
use crate::config::{LibraryConfig, RawConverterKind};
use crate::io_guard;
use crate::paths::{self, ProcessingSource};
use crate::state::AppState;
use crate::xmp;

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
    // Which tool's settings this job is pasting - mirrors the
    // `RawConverterKind` wire format `art_queue::ArtJob::tool` already
    // established, so the Activity panel can reuse the same label map for
    // both features' per-job rows.
    pub tool: RawConverterKind,
    pub status: ProcessingJobStatus,
    pub created_at_ms: u64,
    pub finished_at_ms: Option<u64>,
    pub error: Option<String>,
}

/// What the worker needs to actually perform one job - resolved up front at
/// enqueue time, same as `edit_queue::QueuedWork`. One `QueuedCopy` per
/// (target, tool) pair - `source` alone determines both which tool this is
/// (`ProcessingSource::tool`) and how to apply it (`run`'s match below).
pub(crate) struct QueuedCopy {
    job_id: u64,
    target_asset_id: String,
    target_local_path: Option<PathBuf>,
    source: ProcessingSource,
}

pub struct ProcessingQueue {
    board: Mutex<VecDeque<ProcessingJob>>,
    next_id: AtomicU64,
    tx: mpsc::UnboundedSender<QueuedCopy>,
    // Shared with `EditQueue` via `AssetLocks` (see its own doc comment) -
    // serializes same-target jobs (e.g. a rapid re-paste) so two writers can
    // never race on the same destination path's temp filename, while
    // different targets still run concurrently. Now load-bearing across
    // queues, not just within this one: a `DarkTable` job here and an
    // `EditQueue` rating/description write both touch the same target's
    // `.xmp`.
    asset_locks: Arc<AssetLocks>,
}

impl ProcessingQueue {
    pub fn new(asset_locks: Arc<AssetLocks>) -> (Arc<Self>, mpsc::UnboundedReceiver<QueuedCopy>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let queue = Arc::new(Self { board: Mutex::new(VecDeque::new()), next_id: AtomicU64::new(1), tx, asset_locks });
        (queue, rx)
    }

    fn asset_lock(&self, asset_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.asset_locks.lock_for(asset_id)
    }

    /// Pushes one `Pending` job per **(target, source)** pair and hands each
    /// to the drain worker, returning the assigned job ids - `targets.len()
    /// * sources.len()` of them, ordered all-sources-for-target-1 then
    /// all-sources-for-target-2 etc. Called from `commands::paste_image_processing`
    /// after its `read_only`/`max_writes_per_batch` checks and after
    /// confirming `sources` is non-empty (the source has *something* to
    /// paste).
    pub fn enqueue(&self, cfg: &LibraryConfig, sources: &[ProcessingSource], targets: &[MetadataEditTarget]) -> Vec<u64> {
        let mut ids = Vec::with_capacity(targets.len() * sources.len());
        let mut board = self.board.lock().unwrap();
        for target in targets {
            let target_local_path = target.original_path.as_deref().and_then(|p| paths::resolve_local_path(p, cfg));
            for source in sources {
                let job_id = self.next_id.fetch_add(1, Ordering::Relaxed);

                board.push_back(ProcessingJob {
                    job_id,
                    target_asset_id: target.id.clone(),
                    tool: source.tool(),
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
                    target_local_path: target_local_path.clone(),
                    source: source.clone(),
                });
                ids.push(job_id);
            }
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
/// copies need). Any failure cleans up the temp file first. Used for
/// `ProcessingSource::Sidecar` jobs (ART/RawTherapee) - `DarkTable` jobs go
/// through `apply_darktable_source` instead, since a plain byte copy would
/// clobber the target's own rating/description in that shared `.xmp`.
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

/// Applies one `ProcessingSource` onto `target_local_path` - the worker's
/// per-source dispatch, run inside `io_guard::guarded_spawn_blocking` (both
/// branches do blocking file I/O). `Sidecar` is a plain copy;
/// `DarkTable` reads the source `.xmp` fresh (its content may have changed
/// since `find_all_processing_sources` ran) and merges via
/// `xmp::paste_darktable_island`, targeting the target's own `.xmp` write
/// path (`paths::xmp_write_path` - same same-form-if-exists-else-append
/// precedence rating/description writes already use).
fn apply_processing_source(source: &ProcessingSource, target_local_path: &Path) -> Result<(), String> {
    match source {
        ProcessingSource::Sidecar { path, kind, form } => {
            let dest = kind.sidecar_path_with_form(target_local_path, *form);
            atomic_copy_sidecar(path, &dest)
        }
        ProcessingSource::DarkTable { xmp_path } => {
            let source_text = fs::read_to_string(xmp_path).map_err(|e| format!("Couldn't read {}: {e}", xmp_path.display()))?;
            let dest = paths::xmp_write_path(target_local_path);
            xmp::paste_darktable_island(&source_text, &dest)
        }
    }
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

            let source = work.source.clone();
            let result = match io_guard::guarded_spawn_blocking(&io_guard, move || apply_processing_source(&source, &target_local_path)) {
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
    use crate::paths::{ProcessingKind, SidecarForm};

    fn target(id: &str, original_path: Option<&str>) -> MetadataEditTarget {
        MetadataEditTarget { id: id.to_string(), original_path: original_path.map(str::to_string) }
    }

    fn tmp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("brighttable-test-procqueue-{label}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sidecar_source(path: &str, kind: ProcessingKind) -> ProcessingSource {
        ProcessingSource::Sidecar { path: PathBuf::from(path), kind, form: SidecarForm::Append }
    }

    fn darktable_source(xmp_path: &str) -> ProcessingSource {
        ProcessingSource::DarkTable { xmp_path: PathBuf::from(xmp_path) }
    }

    #[test]
    fn enqueue_assigns_ids_and_starts_pending() {
        let (queue, _rx) = ProcessingQueue::new(AssetLocks::new());
        let ids = queue.enqueue(&LibraryConfig::default(), &[sidecar_source("/x/src.arp", ProcessingKind::Arp)], &[target("a", None), target("b", None)]);
        assert_eq!(ids, vec![1, 2]);

        let snap = queue.snapshot();
        assert_eq!(snap.len(), 2);
        assert!(snap.iter().all(|j| j.status == ProcessingJobStatus::Pending));
        assert!(snap.iter().all(|j| j.tool == RawConverterKind::Art));
        assert_eq!(queue.pending_count(), 2);
    }

    #[test]
    fn enqueue_ids_keep_increasing_across_calls() {
        let (queue, _rx) = ProcessingQueue::new(AssetLocks::new());
        let first = queue.enqueue(&LibraryConfig::default(), &[sidecar_source("/x/src.pp3", ProcessingKind::Pp3)], &[target("a", None)]);
        let second = queue.enqueue(&LibraryConfig::default(), &[sidecar_source("/x/src.pp3", ProcessingKind::Pp3)], &[target("b", None)]);
        assert_eq!(first, vec![1]);
        assert_eq!(second, vec![2]);
    }

    #[test]
    fn enqueue_fans_out_one_job_per_target_times_source() {
        let (queue, _rx) = ProcessingQueue::new(AssetLocks::new());
        let sources = [sidecar_source("/x/src.arp", ProcessingKind::Arp), darktable_source("/x/src.xmp")];
        let ids = queue.enqueue(&LibraryConfig::default(), &sources, &[target("a", None), target("b", None)]);
        assert_eq!(ids.len(), 4, "2 targets * 2 sources");

        let snap = queue.snapshot();
        let a_tools: Vec<_> = snap.iter().filter(|j| j.target_asset_id == "a").map(|j| j.tool).collect();
        let b_tools: Vec<_> = snap.iter().filter(|j| j.target_asset_id == "b").map(|j| j.tool).collect();
        assert_eq!(a_tools, vec![RawConverterKind::Art, RawConverterKind::DarkTable]);
        assert_eq!(b_tools, vec![RawConverterKind::Art, RawConverterKind::DarkTable]);
        assert_eq!(queue.pending_count(), 4);
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
            ProcessingJob { job_id: 0, target_asset_id: "a".into(), tool: RawConverterKind::Art, status, created_at_ms: 0, finished_at_ms: None, error: None }
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

    #[test]
    fn apply_processing_source_copies_a_sidecar() {
        let dir = tmp_dir("apply-sidecar");
        let src = dir.join("src.arp");
        fs::write(&src, "settings").unwrap();
        let target_original = dir.join("target.CR2");

        let source = ProcessingSource::Sidecar { path: src, kind: ProcessingKind::Arp, form: SidecarForm::Append };
        apply_processing_source(&source, &target_original).unwrap();

        assert_eq!(fs::read_to_string(paths::arp_sidecar_path(&target_original)).unwrap(), "settings");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn apply_processing_source_merges_darktable_history_without_clobbering_target_rating() {
        let dir = tmp_dir("apply-darktable");
        let src_xmp = dir.join("src.CR2.xmp");
        fs::write(&src_xmp, r#"<rdf:Description darktable:history_end="2"><darktable:history/></rdf:Description>"#).unwrap();
        let target_original = dir.join("target.CR2");
        fs::write(paths::xmp_sidecar_path(&target_original), r#"<rdf:Description xmp:Rating="4"/>"#).unwrap();

        let source = ProcessingSource::DarkTable { xmp_path: src_xmp };
        apply_processing_source(&source, &target_original).unwrap();

        let out = fs::read_to_string(paths::xmp_sidecar_path(&target_original)).unwrap();
        assert_eq!(xmp::read_rating(&out), Some(4), "{out}");
        assert!(xmp::has_darktable_history(&out), "{out}");

        let _ = fs::remove_dir_all(&dir);
    }
}
