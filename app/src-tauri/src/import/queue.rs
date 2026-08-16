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

//! Decoupled, bounded-concurrency background queue for the actual file
//! copies - the same architecture as `edit_queue.rs` (`Pending → Writing →
//! Done|Failed` board, `mpsc`-fed drain worker spawned once from `lib.rs`'s
//! `.setup()`, poll-based status command), adapted for import: `Copying`
//! instead of `Writing`, and a persisted dedupe cache (`history.rs`)
//! updated as each copy succeeds instead of a rollback-on-failure contract.
//!
//! Concurrency defaults lower than the edit queue's 4
//! (`DEFAULT_MAX_CONCURRENT_IMPORT_JOBS = 2`) - this moves large RAW files
//! over the same constrained NFS/Tailscale mount that already caused the
//! suspend-blocking (`suspend_guard.rs`) and UI-freeze (`edit_queue.rs`'s
//! own doc comment) issues found earlier, and a multi-hundred-file SD card
//! import is a much bigger burst than any metadata edit ever was. It's
//! user-configurable (`ImportSettings::max_concurrent_jobs`, read once at
//! app startup - see `run` below) since a confirmed real-world link for
//! this feature can run as slow as ~400KB/s, where the useful value of
//! *any* concurrency is genuinely a judgment call for the user to make
//! about their own link, not something to hardcode.
//!
//! Each copy job is bounded by an **idle** timeout, not a flat total-time
//! one - `COPY_IDLE_TIMEOUT` fires only once a job has made zero byte-level
//! progress for that long (see `await_copy`), so a large file that's
//! genuinely still advancing at 400KB/s is never mistaken for stuck no
//! matter how long it takes in total.

use std::collections::{HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Manager};
use tokio::sync::{mpsc, Semaphore};
use tokio::task::JoinHandle;

use crate::io_guard;
use crate::state::AppState;

use super::hash;
use super::history::{self, ImportHistory, ImportRecord};
use super::naming::{self, FolderDepth};
use super::scan::ScannedGroup;

/// Default and allowed range for `ImportSettings::max_concurrent_jobs` -
/// clamped to this range wherever the configured value is used, so a
/// corrupted/hand-edited config.json can't set an unreasonable value.
pub const DEFAULT_MAX_CONCURRENT_IMPORT_JOBS: usize = 2;
pub const MIN_CONCURRENT_IMPORT_JOBS: usize = 1;
pub const MAX_CONCURRENT_IMPORT_JOBS_LIMIT: usize = 4;

/// Same "first guess, easy to tune" framing as `edit_queue.rs`'s own cap.
const MAX_COMPLETED_HISTORY: usize = 200;

/// A copy job that makes literally zero progress for this long is treated
/// as stuck and failed outright - see the module doc comment above for why
/// this is an *idle* timeout, not a bound on total elapsed time. Almost
/// always means an unreachable NFS/network destination; nothing in
/// userspace can rescue the underlying blocking task once the kernel has it
/// in an uninterruptible wait (see requirements.md's NFS write-up), so this
/// just stops it from permanently occupying one of the few concurrency
/// slots - the abandoned blocking-pool thread itself still leaks, but
/// that's a cheap, elastic resource next to the tightly-capped semaphore.
const COPY_IDLE_TIMEOUT: Duration = Duration::from_secs(3 * 60);

/// Generous backstop against a pathological byte-at-a-time trickle that
/// never actually stalls long enough to trip the idle timeout above - not
/// expected to bind in any real scenario, just a final bound.
const COPY_ABSOLUTE_CAP: Duration = Duration::from_secs(4 * 60 * 60);

/// How often the idle-timeout supervisor polls the copy's progress counter
/// (and pushes it into the job board for the Activity panel).
const PROGRESS_POLL_INTERVAL: Duration = Duration::from_secs(10);

/// History is a dedupe cache, not a job log - rewriting the whole file on
/// every single completed copy would add up over a large batch, so it's
/// flushed every this-many completions instead (and always once the queue
/// fully drains, so a batch smaller than this still gets saved promptly).
const HISTORY_SAVE_INTERVAL: usize = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ImportJobStatus {
    Pending,
    Copying,
    Done,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportJob {
    pub job_id: u64,
    pub source_path: String,
    pub dest_path: String,
    pub status: ImportJobStatus,
    pub size_bytes: u64,
    /// Live progress while `Copying`, updated roughly every
    /// `PROGRESS_POLL_INTERVAL` - lets the Activity panel show real numbers
    /// ("12.4 / 45.0 MB") instead of a `Copying…` row that looks identical
    /// whether it's genuinely advancing or fully stuck, which is exactly
    /// what made a slow-but-working link indistinguishable from a hung one
    /// before this existed. Left at its last value (not reset) on `Failed`,
    /// so a failure still shows how far the copy got.
    pub bytes_copied: u64,
    pub created_at_ms: u64,
    pub finished_at_ms: Option<u64>,
    pub error: Option<String>,
}

pub(crate) struct QueuedCopy {
    job_id: u64,
    source_path: PathBuf,
    dest_path: PathBuf,
    size_bytes: u64,
    partial_hash: String,
}

pub struct ImportQueue {
    board: Mutex<VecDeque<ImportJob>>,
    next_id: AtomicU64,
    tx: mpsc::UnboundedSender<QueuedCopy>,
    history: Mutex<ImportHistory>,
    history_path: PathBuf,
    completed_since_save: Mutex<usize>,
}

impl ImportQueue {
    pub fn new(history_path: PathBuf) -> (Arc<Self>, mpsc::UnboundedReceiver<QueuedCopy>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let history = ImportHistory::load(&history_path);
        let queue = Arc::new(Self {
            board: Mutex::new(VecDeque::new()),
            next_id: AtomicU64::new(1),
            tx,
            history: Mutex::new(history),
            history_path,
            completed_since_save: Mutex::new(0),
        });
        (queue, rx)
    }

    /// Skips groups already fully imported (`ScannedGroup::already_imported`),
    /// resolves each remaining group's destination directory/stem once
    /// (shared across every member so a RAW+JPEG pair can never diverge),
    /// and enqueues one job per file. Returns the assigned job ids, in the
    /// same order the files were encountered.
    ///
    /// Every disk-touching step (`naming::resolve_stem`'s collision checks
    /// against the destination folder) happens **before** `board`'s lock is
    /// ever taken - a real bug, found live: `board` is also locked by
    /// `snapshot`/`pending_count` (polled every second by the frontend) and
    /// by the drain worker's own `set_status`/`finish` calls, none of which
    /// do any I/O of their own. If the destination is an unreachable NFS
    /// mount, a single `fs::read_dir` there can hang forever in the kernel -
    /// an accepted, unrescuable-from-userspace limitation - but if that
    /// happened while this method held `board`'s lock, every one of those
    /// other callers piles up behind it and never returns either, which
    /// looks exactly like (and in practice starves enough of the async
    /// runtime's worker threads to become) the *entire app* hanging, not
    /// just this one import. Scoping the I/O to before the lock means a
    /// stuck destination only ever blocks this one `enqueue` call.
    pub fn enqueue(&self, local_root: &Path, depth: FolderDepth, groups: &[ScannedGroup]) -> Vec<u64> {
        struct Prepared {
            source_path: String,
            dest_path: PathBuf,
            size_bytes: u64,
            partial_hash: String,
        }

        let mut used_stems: HashSet<PathBuf> = HashSet::new();
        // One real directory listing per unique destination folder, not
        // one per group - groups very commonly share a folder (every file
        // captured in the same month, under Year/Month depth), and without
        // this a large batch meant that many separate `fs::read_dir` calls
        // in a row against what can be a slow, real NFS-backed directory.
        // Found live: a 382-file, single-month batch felt fully hung for a
        // long stretch (nothing appears in the queue/Activity panel until
        // this whole loop finishes) even though it was actually just doing
        // 382 redundant re-listings of the same folder.
        let mut stem_cache = naming::StemCache::new();
        let mut prepared = Vec::new();
        for group in groups {
            if group.already_imported {
                continue;
            }
            let dir = naming::dest_dir(local_root, depth, &group.capture_time);
            let stem = naming::resolve_stem(&mut stem_cache, &dir, &group.capture_time.filename_stem(), &mut used_stems);
            for file in &group.files {
                prepared.push(Prepared {
                    source_path: file.source_path.clone(),
                    dest_path: dir.join(format!("{stem}.{}", file.extension)),
                    size_bytes: file.size_bytes,
                    partial_hash: file.partial_hash.clone(),
                });
            }
        }

        let mut ids = Vec::with_capacity(prepared.len());
        let mut board = self.board.lock().unwrap();
        for p in prepared {
            let job_id = self.next_id.fetch_add(1, Ordering::Relaxed);
            board.push_back(ImportJob {
                job_id,
                source_path: p.source_path.clone(),
                dest_path: p.dest_path.to_string_lossy().to_string(),
                status: ImportJobStatus::Pending,
                size_bytes: p.size_bytes,
                bytes_copied: 0,
                created_at_ms: now_ms(),
                finished_at_ms: None,
                error: None,
            });

            // Ignoring the send error, same as edit_queue.rs's enqueue: it
            // can only mean the worker's receiver was dropped (app shutting
            // down) - the job stays visible as Pending, which is harmless
            // since the process is exiting anyway.
            let _ = self.tx.send(QueuedCopy {
                job_id,
                source_path: PathBuf::from(&p.source_path),
                dest_path: p.dest_path,
                size_bytes: p.size_bytes,
                partial_hash: p.partial_hash,
            });
            ids.push(job_id);
        }
        ids
    }

    pub fn snapshot(&self) -> Vec<ImportJob> {
        self.board.lock().unwrap().iter().cloned().collect()
    }

    /// Checked against this queue's own in-memory history, not a fresh
    /// read of `import_history.json` - the debounced save (see
    /// `maybe_persist_history`) means the on-disk file can lag behind very
    /// recent completions within the same session.
    pub fn mark_already_imported(&self, groups: &mut [ScannedGroup]) {
        let history = self.history.lock().unwrap();
        history::mark_already_imported(groups, &history);
    }

    pub fn pending_count(&self) -> usize {
        self.board
            .lock()
            .unwrap()
            .iter()
            .filter(|j| matches!(j.status, ImportJobStatus::Pending | ImportJobStatus::Copying))
            .count()
    }

    pub fn clear_completed(&self) {
        let mut board = self.board.lock().unwrap();
        board.retain(|j| matches!(j.status, ImportJobStatus::Pending | ImportJobStatus::Copying));
    }

    fn set_status(&self, job_id: u64, status: ImportJobStatus) {
        let mut board = self.board.lock().unwrap();
        if let Some(job) = board.iter_mut().find(|j| j.job_id == job_id) {
            job.status = status;
        }
    }

    fn set_progress(&self, job_id: u64, bytes_copied: u64) {
        let mut board = self.board.lock().unwrap();
        if let Some(job) = board.iter_mut().find(|j| j.job_id == job_id) {
            job.bytes_copied = bytes_copied;
        }
    }

    fn finish(&self, job_id: u64, status: ImportJobStatus, error: Option<String>) {
        let mut board = self.board.lock().unwrap();
        if let Some(job) = board.iter_mut().find(|j| j.job_id == job_id) {
            job.status = status;
            job.finished_at_ms = Some(now_ms());
            job.error = error;
        }
        trim_completed(&mut board);
    }

    fn finish_success(&self, job_id: u64, source_path: &Path, dest_path: &Path, partial_hash: &str, size_bytes: u64, full_hash: String) {
        {
            let mut history = self.history.lock().unwrap();
            history.record(
                partial_hash,
                size_bytes,
                ImportRecord {
                    source_path: source_path.to_string_lossy().to_string(),
                    dest_path: dest_path.to_string_lossy().to_string(),
                    original_filename: source_path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                    converted_filename: dest_path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                    size_bytes,
                    imported_at_ms: history::now_ms(),
                    full_hash,
                },
            );
        }
        self.finish(job_id, ImportJobStatus::Done, None);
        self.maybe_persist_history();
    }

    fn finish_failure(&self, job_id: u64, error: String) {
        self.finish(job_id, ImportJobStatus::Failed, Some(error));
        self.maybe_persist_history();
    }

    fn maybe_persist_history(&self) {
        let mut count = self.completed_since_save.lock().unwrap();
        *count += 1;
        let should_flush = *count >= HISTORY_SAVE_INTERVAL || self.pending_count() == 0;
        if should_flush {
            *count = 0;
            let history = self.history.lock().unwrap();
            let _ = history.save(&self.history_path);
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn trim_completed(board: &mut VecDeque<ImportJob>) {
    let completed = board.iter().filter(|j| matches!(j.status, ImportJobStatus::Done | ImportJobStatus::Failed)).count();
    let mut to_remove = completed.saturating_sub(MAX_COMPLETED_HISTORY);
    let mut i = 0;
    while to_remove > 0 && i < board.len() {
        if matches!(board[i].status, ImportJobStatus::Done | ImportJobStatus::Failed) {
            board.remove(i);
            to_remove -= 1;
        } else {
            i += 1;
        }
    }
}

/// Copies through a unique temp name then renames into place - same atomic
/// idiom as `thumb_cache.rs`/`xmp.rs`, guarding against a half-written
/// destination file if the app exits or the NFS mount drops mid-copy.
/// Verifies the copied byte count against `expected_size` (captured at
/// scan time) before renaming into place - a cheap, real integrity check
/// (RPD-style verified copy) against a bad read over a slow/flaky card
/// reader, using the hash `copy_with_hash` already computes as a byproduct
/// of the copy rather than a separate re-read pass.
///
/// Any failure at all - a raw read/write error, a size mismatch, or a
/// failed rename - cleans up the temp file via the outer `copy_one`; a real
/// bug found live left `.part-N` files behind on an NFS outage mid-copy,
/// because only the size-mismatch and rename-failure branches used to clean
/// up, not a raw copy failure (by far the most common failure mode on a
/// flaky link).
fn copy_one(job_id: u64, source: &Path, dest: &Path, expected_size: u64, progress: &AtomicU64) -> Result<hash::CopyOutcome, String> {
    let parent = dest.parent().ok_or_else(|| format!("{} has no parent directory", dest.display()))?;
    fs::create_dir_all(parent).map_err(|e| format!("Couldn't create {}: {e}", parent.display()))?;
    let file_name = dest.file_name().and_then(|n| n.to_str()).unwrap_or("import");
    let tmp = parent.join(format!(".{file_name}.part-{job_id}"));

    let result = copy_one_inner(source, &tmp, dest, expected_size, progress);
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

fn copy_one_inner(source: &Path, tmp: &Path, dest: &Path, expected_size: u64, progress: &AtomicU64) -> Result<hash::CopyOutcome, String> {
    let outcome =
        hash::copy_with_hash(source, tmp, Some(progress)).map_err(|e| format!("Couldn't copy {}: {e}", source.display()))?;
    if outcome.bytes_copied != expected_size {
        return Err(format!("Copied {} bytes but expected {expected_size} from {}", outcome.bytes_copied, source.display()));
    }
    fs::rename(tmp, dest).map_err(|e| format!("Couldn't finalize {}: {e}", dest.display()))?;
    Ok(outcome)
}

/// Awaits a copy job's `JoinHandle`, treating "no byte-level progress for
/// `COPY_IDLE_TIMEOUT`" as stuck rather than bounding total elapsed time -
/// see the module doc comment for why: a confirmed real-world link for this
/// feature can run as slow as ~400KB/s, so a large file can legitimately
/// take a long time while still genuinely advancing, and only a truly
/// stalled transfer (zero movement) should ever be treated as failed. Also
/// pushes the live byte count into the job board every poll, for the
/// Activity panel. On a real timeout/cap, the `handle` is simply dropped -
/// not `.abort()`-ed, since a blocking task can't be cancelled - so the
/// underlying blocking-pool thread leaks for good, but that's a cheap,
/// elastic resource next to the tightly-capped concurrency semaphore this
/// exists to protect.
async fn await_copy(
    mut handle: JoinHandle<Result<hash::CopyOutcome, String>>,
    progress: Arc<AtomicU64>,
    queue: &Arc<ImportQueue>,
    job_id: u64,
) -> Result<hash::CopyOutcome, String> {
    let started = tokio::time::Instant::now();
    let mut last_seen = 0u64;
    let mut last_progress_at = tokio::time::Instant::now();
    loop {
        tokio::select! {
            result = &mut handle => {
                return result.map_err(|e| e.to_string()).and_then(|r| r);
            }
            _ = tokio::time::sleep(PROGRESS_POLL_INTERVAL) => {
                let now_bytes = progress.load(Ordering::Relaxed);
                queue.set_progress(job_id, now_bytes);
                if now_bytes != last_seen {
                    last_seen = now_bytes;
                    last_progress_at = tokio::time::Instant::now();
                } else if last_progress_at.elapsed() >= COPY_IDLE_TIMEOUT {
                    return Err(format!(
                        "No progress for {}s copying - check the destination connection (NFS/network share)",
                        COPY_IDLE_TIMEOUT.as_secs()
                    ));
                }
                if started.elapsed() >= COPY_ABSOLUTE_CAP {
                    return Err(format!(
                        "Exceeded the overall {}h cap copying - check the destination connection (NFS/network share)",
                        COPY_ABSOLUTE_CAP.as_secs() / 3600
                    ));
                }
            }
        }
    }
}

/// The drain worker - spawned once from `lib.rs`'s `.setup()`, same pattern
/// as `edit_queue::run`. `max_concurrent_jobs` (from
/// `ImportSettings::max_concurrent_jobs`) is read once at startup and used
/// to size the semaphore for this whole session - changing the setting
/// takes effect on next launch, not live, to avoid the real complexity of
/// safely resizing a `Semaphore` with jobs already in flight.
pub async fn run(app: AppHandle, mut rx: mpsc::UnboundedReceiver<QueuedCopy>, max_concurrent_jobs: usize) {
    let (io_guard, queue) = {
        let state = app.state::<AppState>();
        (state.io_guard.clone(), state.import_queue.clone())
    };

    let max_jobs = max_concurrent_jobs.clamp(MIN_CONCURRENT_IMPORT_JOBS, MAX_CONCURRENT_IMPORT_JOBS_LIMIT);
    let semaphore = Arc::new(Semaphore::new(max_jobs));

    while let Some(work) = rx.recv().await {
        let semaphore = semaphore.clone();
        let io_guard = io_guard.clone();
        let queue = queue.clone();

        tauri::async_runtime::spawn(async move {
            let _permit = semaphore.acquire_owned().await;
            queue.set_status(work.job_id, ImportJobStatus::Copying);

            let job_id = work.job_id;
            let source = work.source_path.clone();
            let dest = work.dest_path.clone();
            let size_bytes = work.size_bytes;
            let progress = Arc::new(AtomicU64::new(0));
            let progress_for_copy = progress.clone();
            let result = io_guard::guarded_spawn_blocking(&io_guard, move || {
                copy_one(job_id, &source, &dest, size_bytes, &progress_for_copy)
            });

            let outcome = match result {
                Some(handle) => await_copy(handle, progress, &queue, work.job_id).await,
                None => Err("Skipped: system is about to suspend, try again after it wakes".to_string()),
            };

            match outcome {
                Ok(copy_outcome) => {
                    queue.set_progress(work.job_id, copy_outcome.bytes_copied);
                    queue.finish_success(
                        work.job_id,
                        &work.source_path,
                        &work.dest_path,
                        &work.partial_hash,
                        work.size_bytes,
                        copy_outcome.hash,
                    )
                }
                Err(e) => queue.finish_failure(work.job_id, e),
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::import::capture_time::CaptureTime;
    use crate::import::scan::ScannedFile;
    use std::fs;

    fn ct(second: u8) -> CaptureTime {
        CaptureTime { year: 2026, month: 6, day: 21, hour: 8, minute: 23, second }
    }

    fn file(path: &str, ext: &str, hash: &str) -> ScannedFile {
        ScannedFile {
            source_path: path.to_string(),
            extension: ext.to_string(),
            size_bytes: 10,
            partial_hash: hash.to_string(),
            capture_time: ct(13),
            capture_time_is_exif: true,
        }
    }

    fn group(basename: &str, files: Vec<ScannedFile>, already_imported: bool) -> ScannedGroup {
        ScannedGroup { basename: basename.to_string(), files, capture_time: ct(13), already_imported }
    }

    fn new_queue() -> Arc<ImportQueue> {
        let path = std::env::temp_dir().join(format!("brighttable-test-queue-history-{}-{}", std::process::id(), rand_suffix()));
        ImportQueue::new(path).0
    }

    // No external rand crate in this codebase - a cheap per-call counter is
    // enough to keep parallel test runs' history file paths from colliding.
    fn rand_suffix() -> u64 {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        COUNTER.fetch_add(1, Ordering::Relaxed)
    }

    #[test]
    fn enqueue_skips_already_imported_groups() {
        let queue = new_queue();
        let dir = std::env::temp_dir().join(format!("brighttable-test-queue-skip-{}", std::process::id()));
        let groups =
            vec![group("skip-me", vec![file("/sd/a.CR3", "CR3", "h1")], true), group("copy-me", vec![file("/sd/b.CR3", "CR3", "h2")], false)];

        let ids = queue.enqueue(&dir, FolderDepth::Flat, &groups);
        assert_eq!(ids.len(), 1, "only the non-already-imported group's file should be enqueued");

        let snap = queue.snapshot();
        assert_eq!(snap.len(), 1);
        assert!(snap[0].source_path.ends_with("b.CR3"));
    }

    #[test]
    fn enqueue_keeps_raw_and_jpeg_pair_on_the_same_stem() {
        let queue = new_queue();
        let dir = std::env::temp_dir().join(format!("brighttable-test-queue-pair-{}", std::process::id()));
        let groups = vec![group(
            "IMG_0001",
            vec![file("/sd/IMG_0001.CR3", "CR3", "raw-hash"), file("/sd/IMG_0001.JPG", "JPG", "jpeg-hash")],
            false,
        )];

        let ids = queue.enqueue(&dir, FolderDepth::Flat, &groups);
        assert_eq!(ids.len(), 2);

        let snap = queue.snapshot();
        let raw_dest = &snap.iter().find(|j| j.source_path.ends_with("CR3")).unwrap().dest_path;
        let jpeg_dest = &snap.iter().find(|j| j.source_path.ends_with("JPG")).unwrap().dest_path;
        let raw_stem = Path::new(raw_dest).file_stem().unwrap();
        let jpeg_stem = Path::new(jpeg_dest).file_stem().unwrap();
        assert_eq!(raw_stem, jpeg_stem, "a RAW+JPEG pair must share one destination stem");
    }

    #[test]
    fn enqueue_nests_year_month_folders_when_requested() {
        let queue = new_queue();
        let dir = std::env::temp_dir().join(format!("brighttable-test-queue-yearmonth-{}", std::process::id()));
        let groups = vec![group("IMG_0002", vec![file("/sd/IMG_0002.JPG", "JPG", "h3")], false)];

        queue.enqueue(&dir, FolderDepth::YearMonth, &groups);
        let snap = queue.snapshot();
        assert!(snap[0].dest_path.contains("2026/2026_06/20260621_08-23-13.JPG"));
    }

    #[test]
    fn trim_completed_never_evicts_pending_or_copying() {
        let mut board: VecDeque<ImportJob> = VecDeque::new();
        board.push_back(ImportJob {
            job_id: 1,
            source_path: "s".into(),
            dest_path: "d".into(),
            status: ImportJobStatus::Pending,
            size_bytes: 0,
            bytes_copied: 0,
            created_at_ms: 0,
            finished_at_ms: None,
            error: None,
        });
        for i in 0..(MAX_COMPLETED_HISTORY + 20) {
            board.push_back(ImportJob {
                job_id: i as u64 + 2,
                source_path: "s".into(),
                dest_path: "d".into(),
                status: ImportJobStatus::Done,
                size_bytes: 0,
                bytes_copied: 0,
                created_at_ms: 0,
                finished_at_ms: Some(0),
                error: None,
            });
        }
        trim_completed(&mut board);
        assert_eq!(board.iter().filter(|j| j.status == ImportJobStatus::Pending).count(), 1);
        assert_eq!(board.iter().filter(|j| j.status == ImportJobStatus::Done).count(), MAX_COMPLETED_HISTORY);
    }

    #[test]
    fn copy_one_copies_content_and_cleans_up_temp_file() {
        let dir = std::env::temp_dir().join(format!("brighttable-test-copyone-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let src = dir.join("src.bin");
        let dest = dir.join("dest.bin");
        fs::write(&src, b"copy me").unwrap();

        let progress = AtomicU64::new(0);
        let outcome = copy_one(1, &src, &dest, 7, &progress).unwrap();
        assert_eq!(outcome.bytes_copied, 7);
        assert_eq!(progress.load(Ordering::Relaxed), 7);
        assert_eq!(fs::read(&dest).unwrap(), b"copy me");

        let leftover_tmp: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains(".part-"))
            .collect();
        assert!(leftover_tmp.is_empty(), "the temp file must not survive a successful copy");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn copy_one_fails_and_cleans_up_on_size_mismatch() {
        let dir = std::env::temp_dir().join(format!("brighttable-test-copyone-mismatch-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let src = dir.join("src.bin");
        let dest = dir.join("dest.bin");
        fs::write(&src, b"copy me").unwrap();

        let err = copy_one(1, &src, &dest, 999, &AtomicU64::new(0)).unwrap_err();
        assert!(err.contains("Copied 7 bytes but expected 999"), "unexpected error message: {err}");
        assert!(!dest.exists(), "a size-mismatched copy must not be renamed into place");

        let leftover_tmp: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains(".part-"))
            .collect();
        assert!(leftover_tmp.is_empty(), "the temp file must be cleaned up after a failed verification");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn copy_one_cleans_up_temp_file_on_a_raw_copy_failure_not_just_size_mismatch() {
        // Regression test for a real bug found live: an NFS outage mid-copy
        // left ".part-N" files behind, because only the size-mismatch and
        // rename-failure branches used to clean up the temp file - a raw
        // read/write failure (by far the most common failure mode on a
        // flaky link) did not. A directory as the "source" opens fine but
        // fails on the first `read()` (EISDIR) - unlike a missing source
        // file (which fails at `File::open`, before any temp file exists),
        // this lets the temp file actually get created first, reproducing
        // the scenario that used to leak one.
        let dir = std::env::temp_dir().join(format!("brighttable-test-copyone-rawfail-{}", std::process::id()));
        let source_dir = dir.join("not-a-real-file");
        fs::create_dir_all(&source_dir).unwrap();
        let dest = dir.join("dest.bin");

        let err = copy_one(1, &source_dir, &dest, 100, &AtomicU64::new(0)).unwrap_err();
        assert!(err.contains("Couldn't copy"), "unexpected error message: {err}");
        assert!(!dest.exists());

        let leftover_tmp: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains(".part-"))
            .collect();
        assert!(leftover_tmp.is_empty(), "a raw copy failure must not leave a temp file behind either");

        let _ = fs::remove_dir_all(&dir);
    }

    // `start_paused = true` runs the runtime on a virtual clock that
    // auto-advances whenever every task is blocked purely on a timer - lets
    // these exercise real multi-minute timeout/backoff logic without
    // actually waiting minutes of wall-clock time in the test suite.

    #[tokio::test(start_paused = true)]
    async fn await_copy_times_out_after_idle_period_with_no_progress() {
        let queue = new_queue();
        let progress = Arc::new(AtomicU64::new(0));
        // Simulates a copy stuck forever (e.g. blocked in the kernel on a
        // dead NFS mount) - never updates `progress`, never completes.
        let handle: JoinHandle<Result<hash::CopyOutcome, String>> = tokio::task::spawn(async {
            tokio::time::sleep(Duration::from_secs(10 * 60 * 60)).await;
            unreachable!("must be timed out by await_copy long before this");
        });

        let result = await_copy(handle, progress, &queue, 1).await;
        let err = result.unwrap_err();
        assert!(err.contains("No progress"), "unexpected error message: {err}");
    }

    #[tokio::test(start_paused = true)]
    async fn await_copy_does_not_time_out_while_progress_keeps_advancing() {
        let queue = new_queue();
        let progress = Arc::new(AtomicU64::new(0));
        let progress_for_task = progress.clone();
        // Advances every minute for 50 minutes - well past what the old
        // flat 10-minute total-time timeout would have allowed, but never
        // actually idle, since it moves well inside COPY_IDLE_TIMEOUT (3
        // minutes) every time. Proves a slow-but-genuinely-progressing
        // transfer is never mistaken for stuck, confirmed live against a
        // real link running as slow as ~400KB/s.
        let handle: JoinHandle<Result<hash::CopyOutcome, String>> = tokio::task::spawn(async move {
            for i in 1..=50u64 {
                tokio::time::sleep(Duration::from_secs(60)).await;
                progress_for_task.store(i * 1024, Ordering::Relaxed);
            }
            Ok(hash::CopyOutcome { bytes_copied: 50 * 1024, hash: "done".to_string() })
        });

        let result = await_copy(handle, progress, &queue, 1).await;
        assert_eq!(result.unwrap().bytes_copied, 50 * 1024);
    }
}
