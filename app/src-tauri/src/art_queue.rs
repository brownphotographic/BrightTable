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

//! Background queue for **Headless RAW Roundtrip** (Variant 2 of the ART CLI
//! round trip) - fully headless `ART-cli` exports of one or more assets at
//! once, with visible per-asset progress. Modeled directly on `processing_queue.rs`
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
//! `commands::batch_raw_cli_round_trip` (through its own `guarded_spawn_blocking`
//! call, since *that* resolution is real blocking disk work) - `enqueue`
//! itself does no I/O.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Manager};
use tokio::sync::{mpsc, watch, OwnedSemaphorePermit, Semaphore};

use crate::art;
use crate::cli_process::{self, SidecarCliMode};
use crate::config::RawConverterKind;
use crate::darktable;
use crate::paths;
use crate::rawtherapee;
use crate::state::AppState;

/// Deliberately lower than the other queues' `4` - a RAW converter CLI's
/// demosaic/denoise pass is CPU/RAM-heavy, unlike a sidecar copy or XMP
/// write. Serialized to 1 (confirmed live for ART-cli): a single full-
/// resolution `ART-cli` process was observed using 1-2.5GB resident / 12GB+
/// virtual memory on its own - with ordinary other apps also running, even 2
/// concurrent exports left a 15GB machine little headroom before swapping,
/// and once genuinely thrashing every concurrent `ART-cli` stalls in
/// "D (disk sleep)" on `folio_wait_bit_common` indefinitely rather than just
/// running slower. Applied to RawTherapee-cli jobs on this same shared queue
/// too, on the assumption its demosaic pass is the same class of cost (ART
/// forked RawTherapee's own processing pipeline) - not yet independently
/// confirmed live. A tunable default, not a hard requirement - raise it back
/// on a machine confirmed to have the RAM headroom for more concurrent
/// exports.
pub const MAX_CONCURRENT_RAW_CLI_JOBS: usize = 1;

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
    /// Which converter this job runs through - lets the Activity panel label
    /// each row (e.g. "ART" vs "RawTherapee") instead of assuming ART like
    /// this board did before RawTherapee shared it.
    pub tool: RawConverterKind,
    pub status: ArtJobStatus,
    /// Set once `Done` - the generated export's bare filename (same
    /// directory as the original RAW), used by the frontend's incremental
    /// per-asset ingestion (`useArtJobReconciliation`) to call
    /// `ingestRoundTripExport` without needing a second round trip to
    /// discover it.
    pub export_file_name: Option<String>,
    /// Live 0-100 percentage while `Running`, parsed from the converter
    /// CLI's own progress output where it emits one (see
    /// `cli_process::run_cli_with_progress`) - `None` until the first
    /// progress line arrives, and left at its last value (not reset) once
    /// the job settles, same "show how far it got" idiom as
    /// `import::ImportJob::bytes_copied`.
    pub progress_percent: Option<u8>,
    pub created_at_ms: u64,
    pub finished_at_ms: Option<u64>,
    pub error: Option<String>,
    /// True once `ArtQueue::request_cancel` has been called for this job
    /// while it was still `Pending`/`Running` - the frontend renders this as
    /// "Cancelling…" until the job's own worker task actually notices (via
    /// its `cancel_senders` channel) and finishes it: skipped before ever
    /// running if still `Pending`, or best-effort `child.kill()`'d if already
    /// `Running` (see `art::run_art_cli_with_progress`'s cancellation
    /// branch). Left `true` on the finished row too - harmless, since the
    /// frontend keys its "cancelled" styling off `status`/`error` by then,
    /// not this flag.
    pub cancel_requested: bool,
}

/// What the worker needs to actually perform one job - resolved up front at
/// enqueue time (by `commands::batch_raw_cli_round_trip`), same as
/// `edit_queue::QueuedWork`/`processing_queue::QueuedCopy`.
pub(crate) struct QueuedArtWork {
    job_id: u64,
    asset_id: String,
    tool: RawConverterKind,
    cli_path: String,
    raw_path: PathBuf,
    export_path: PathBuf,
    /// Whether `raw_path` had a `.arp`/`.pp3` sidecar at enqueue time
    /// (resolved by `commands::batch_raw_cli_round_trip`, same
    /// `find_processing_sidecar` check `launch_raw_cli_round_trip` does for
    /// Variant 1) - picks `run`'s `SidecarCliMode` per job. Confirmed live against
    /// a real ART-cli 1.26.7: unlike `-s` (which just warns and falls back to
    /// neutral values when no sidecar exists), `-S` actually exits non-zero
    /// with "no sidecar procparams found" in that case rather than silently
    /// skipping to the default profile the way this module's own doc
    /// comments used to assume - so a target confirmed to have no sidecar
    /// must use plain `-d` (`SidecarCliMode::DefaultOnly`), not `-d -S`
    /// (`SidecarCliMode::DefaultThenSidecarOverride`), or the export fails
    /// outright instead of falling back.
    has_sidecar: bool,
}

pub struct ArtQueue {
    board: Mutex<VecDeque<ArtJob>>,
    next_id: AtomicU64,
    tx: mpsc::UnboundedSender<QueuedArtWork>,
    // Same reasoning as `edit_queue::EditQueue::asset_locks`: serializes
    // same-asset jobs so two exports for the same asset can never race on
    // the same collision-numbered export path, while different assets still
    // run concurrently up to `MAX_CONCURRENT_RAW_CLI_JOBS`.
    asset_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    // Shared by both `run` (Variant 2's worker) and `commands::launch_raw_cli_round_trip`
    // (Variant 1) - confirmed live that without a shared cap, one interactive
    // round trip running alongside an already-full batch of `MAX_CONCURRENT_RAW_CLI_JOBS`
    // gives 3 concurrent full-resolution `ART-cli` demosaic processes, which
    // is enough to push a 15GB machine into swap thrashing (each process
    // observed at 800MB-1GB+ RSS) - every one of them then stalls in
    // "D (disk sleep)" on `folio_wait_bit_common`, indistinguishable from a
    // real hang from the UI's perspective. One semaphore for every `ART-cli`
    // invocation regardless of variant closes that gap.
    semaphore: Arc<Semaphore>,
    // One `watch` channel per still-live job, created alongside its board row
    // (`enqueue`/`start_manual`) and removed in `finish` - lets
    // `request_cancel` signal a job's own worker task (or, for Variant 1,
    // `commands::launch_raw_cli_round_trip`/`finish_raw_cli_round_trip_with_default_profile`)
    // without either side needing a reference to the other. `watch` rather
    // than a plain `AtomicBool` so the holder can `.changed().await` it
    // instead of polling - a cancel takes effect the moment it's requested,
    // not on the next poll tick.
    cancel_senders: Mutex<HashMap<u64, watch::Sender<bool>>>,
}

impl ArtQueue {
    pub fn new() -> (Arc<Self>, mpsc::UnboundedReceiver<QueuedArtWork>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let queue = Arc::new(Self {
            board: Mutex::new(VecDeque::new()),
            next_id: AtomicU64::new(1),
            tx,
            asset_locks: Mutex::new(HashMap::new()),
            semaphore: Arc::new(Semaphore::new(MAX_CONCURRENT_RAW_CLI_JOBS)),
            cancel_senders: Mutex::new(HashMap::new()),
        });
        (queue, rx)
    }

    /// Blocks until a concurrency slot is free - see `semaphore`'s doc
    /// comment. Callers should acquire this immediately before actually
    /// spawning `ART-cli` (not while merely waiting on the user inside the
    /// GUI editor), and hold the returned permit for the process's full
    /// lifetime.
    pub async fn acquire_permit(&self) -> OwnedSemaphorePermit {
        self.semaphore.clone().acquire_owned().await.expect("ArtQueue's semaphore is never closed")
    }

    fn asset_lock(&self, asset_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = self.asset_locks.lock().unwrap();
        locks.entry(asset_id.to_string()).or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))).clone()
    }

    /// Pushes one `Pending` job per already-resolved target and hands each to
    /// the drain worker, returning the assigned job ids in the same order as
    /// `targets`. Called from `commands::batch_raw_cli_round_trip` after its
    /// `read_only`/`max_writes_per_batch` checks and after resolving every
    /// target's local/export path and sidecar presence.
    pub fn enqueue(&self, tool: RawConverterKind, cli_path: &str, targets: Vec<(String, PathBuf, PathBuf, bool)>) -> Vec<u64> {
        let mut ids = Vec::with_capacity(targets.len());
        let mut board = self.board.lock().unwrap();
        for (asset_id, raw_path, export_path, has_sidecar) in targets {
            let job_id = self.next_id.fetch_add(1, Ordering::Relaxed);
            board.push_back(ArtJob {
                job_id,
                asset_id: asset_id.clone(),
                tool,
                status: ArtJobStatus::Pending,
                export_file_name: None,
                progress_percent: None,
                created_at_ms: now_ms(),
                finished_at_ms: None,
                error: None,
                cancel_requested: false,
            });
            self.register_cancel_channel(job_id);
            // See `edit_queue::EditQueue::enqueue`'s identical comment: a
            // send error here only means the app is shutting down.
            let _ = self.tx.send(QueuedArtWork { job_id, asset_id, tool, cli_path: cli_path.to_string(), raw_path, export_path, has_sidecar });
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

    /// Starts tracking a Variant 1 (single-image "Tweak RAW Roundtrip") export
    /// as a `Pending` row on the same board Variant 2 uses, purely so
    /// `ActivityIndicator`/`ActivityPanel` show it too - unlike `enqueue`,
    /// this sends nothing through `tx`/the drain worker, since Variant 1
    /// always runs inside its own awaited command body
    /// (`commands::launch_raw_cli_round_trip`) rather than this queue's worker
    /// loop. The caller drives the job's status/progress/completion directly
    /// via `set_status`/`set_progress`/`finish` below.
    pub fn start_manual(&self, asset_id: String, tool: RawConverterKind) -> u64 {
        let job_id = self.next_id.fetch_add(1, Ordering::Relaxed);
        self.board.lock().unwrap().push_back(ArtJob {
            job_id,
            asset_id,
            tool,
            status: ArtJobStatus::Pending,
            export_file_name: None,
            progress_percent: None,
            created_at_ms: now_ms(),
            finished_at_ms: None,
            error: None,
            cancel_requested: false,
        });
        self.register_cancel_channel(job_id);
        job_id
    }

    fn register_cancel_channel(&self, job_id: u64) {
        let (tx, _rx) = watch::channel(false);
        self.cancel_senders.lock().unwrap().insert(job_id, tx);
    }

    /// Hands the caller a receiver to pass straight into
    /// `art::run_art_cli_with_progress` - `None` only if `job_id` was never
    /// registered or has already finished (`finish` removes its entry).
    pub fn cancel_receiver(&self, job_id: u64) -> Option<watch::Receiver<bool>> {
        self.cancel_senders.lock().unwrap().get(&job_id).map(|tx| tx.subscribe())
    }

    /// Requests cancellation of a still-`Pending`/`Running` job - a no-op
    /// (returns `false`) if it's already `Done`/`Failed` or `job_id` doesn't
    /// exist. Deliberately doesn't change `status`/call `finish` itself -
    /// see `ArtJob::cancel_requested`'s doc comment for why the actual
    /// finishing happens on the job's own worker/command task instead,
    /// avoiding a race where this call and that task both try to finish the
    /// same job.
    pub fn request_cancel(&self, job_id: u64) -> bool {
        let mut board = self.board.lock().unwrap();
        let Some(job) = board.iter_mut().find(|j| j.job_id == job_id) else { return false };
        if !matches!(job.status, ArtJobStatus::Pending | ArtJobStatus::Running) {
            return false;
        }
        job.cancel_requested = true;
        drop(board);
        if let Some(tx) = self.cancel_senders.lock().unwrap().get(&job_id) {
            let _ = tx.send(true);
        }
        true
    }

    pub fn set_status(&self, job_id: u64, status: ArtJobStatus) {
        let mut board = self.board.lock().unwrap();
        if let Some(job) = board.iter_mut().find(|j| j.job_id == job_id) {
            job.status = status;
        }
    }

    pub fn set_progress(&self, job_id: u64, percent: u8) {
        let mut board = self.board.lock().unwrap();
        if let Some(job) = board.iter_mut().find(|j| j.job_id == job_id) {
            job.progress_percent = Some(percent);
        }
    }

    pub fn finish(&self, job_id: u64, status: ArtJobStatus, export_file_name: Option<String>, error: Option<String>) {
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
/// `processing_queue::run`. Batch round trip applies the user's ART default
/// profile, layering each asset's own sidecar over it when one exists
/// (`SidecarCliMode::DefaultThenSidecarOverride`, ART-cli's `-d -S`) - but for a
/// target `commands::batch_raw_cli_round_trip` already confirmed has none
/// (`work.has_sidecar`), it uses plain `-d` (`SidecarCliMode::DefaultOnly`)
/// instead. Confirmed live: `-S` doesn't silently skip to the default profile
/// when no sidecar exists the way its own `-h` help text implies - ART-cli
/// 1.26.7 exits non-zero with "no sidecar procparams found" instead, which
/// `the exit classifier` turns into the same "nothing new to export" message
/// Variant 1 shows - so passing `-S` for a target already known to have no
/// sidecar would fail every one of them outright rather than exporting with
/// the default profile the user actually asked for.
/// Picks `run`'s per-job `SidecarCliMode` from `QueuedArtWork::has_sidecar` -
/// pulled out as its own pure function so the choice is unit-testable without
/// spinning up a full `AppHandle`/worker loop.
pub(crate) fn mode_for_sidecar(has_sidecar: bool) -> SidecarCliMode {
    if has_sidecar { SidecarCliMode::DefaultThenSidecarOverride } else { SidecarCliMode::DefaultOnly }
}

/// Dispatches one round-trip export to the right converter module - the one
/// place both `run` (Variant 2's worker, below) and `commands.rs`'s Variant 1
/// handlers pick between `art`/`rawtherapee`/`darktable` so the three can't
/// drift into different behavior for the same `RawConverterKind`. DarkTable's
/// mode mapping differs from the other two: `darktable-cli` has no `-d -S`-
/// style "apply defaults, then layer a sidecar over them" flag, so both
/// `ApplySidecar` and `DefaultThenSidecarOverride` just mean "pass the
/// resolved xmp path" here - only `DefaultOnly` omits it. The xmp path itself
/// is resolved fresh here (via `paths::find_darktable_history_sidecar`)
/// rather than threaded through as a parameter, since ART/RawTherapee's CLI
/// grammar has no equivalent argument to carry it in - see `darktable.rs`'s
/// own module doc for why darktable's argv needs this at all.
pub(crate) async fn run_round_trip_cli<F>(
    tool: RawConverterKind,
    cli_path: &str,
    exiftool_path: &str,
    raw_path: &std::path::Path,
    export_path: &std::path::Path,
    mode: SidecarCliMode,
    on_progress: F,
    cancel: watch::Receiver<bool>,
) -> Result<(), String>
where
    F: FnMut(u8) + Send,
{
    match tool {
        RawConverterKind::Art => art::run_art_cli_with_metadata_fallback(cli_path, exiftool_path, raw_path, export_path, mode, on_progress, cancel).await,
        RawConverterKind::RawTherapee => rawtherapee::run_rawtherapee_cli(cli_path, raw_path, export_path, mode, on_progress, cancel).await,
        RawConverterKind::DarkTable => {
            let xmp_path = match mode {
                SidecarCliMode::DefaultOnly => None,
                _ => paths::find_darktable_history_sidecar(raw_path),
            };
            darktable::run_darktable_cli(cli_path, raw_path, export_path, xmp_path.as_deref(), on_progress, cancel).await
        }
    }
}

pub async fn run(app: AppHandle, mut rx: mpsc::UnboundedReceiver<QueuedArtWork>) {
    let queue = app.state::<AppState>().art_queue.clone();

    while let Some(work) = rx.recv().await {
        let queue = queue.clone();
        let asset_lock = queue.asset_lock(&work.asset_id);
        let app_for_job = app.clone();

        tauri::async_runtime::spawn(async move {
            let _asset_guard = asset_lock.lock().await;
            let _permit = queue.acquire_permit().await;

            // Re-checked here (not just at `request_cancel` time) since a
            // cancel can land while this job was still `Pending`, queued
            // behind another job holding the semaphore - skips ever spawning
            // `ART-cli` for a job the user already cancelled while it waited.
            let cancel_rx = queue.cancel_receiver(work.job_id).unwrap_or_else(|| watch::channel(false).1);
            if *cancel_rx.borrow() {
                queue.finish(work.job_id, ArtJobStatus::Failed, None, Some("Cancelled by user".to_string()));
                return;
            }
            queue.set_status(work.job_id, ArtJobStatus::Running);

            // Fetched fresh here (rather than threaded through `QueuedArtWork`
            // like `cli_path` is) since it's only ever needed on ART's rare
            // Exiv2-crash fallback path inside `run_art_cli_with_metadata_fallback`
            // - not worth widening `enqueue`'s signature (and every call site/test
            // that builds a `QueuedArtWork` tuple) for a value the common case
            // never touches.
            let exiftool_path = app_for_job.state::<AppState>().config.lock().unwrap().applications.exiftool_path.clone();
            let progress_queue = queue.clone();
            let job_id = work.job_id;
            let run = run_round_trip_cli(
                work.tool,
                &work.cli_path,
                &exiftool_path,
                &work.raw_path,
                &work.export_path,
                mode_for_sidecar(work.has_sidecar),
                move |percent| {
                    progress_queue.set_progress(job_id, percent);
                },
                cancel_rx,
            );
            // Same "surface an error instead of hanging forever" reasoning as
            // Variant 1 (commands::launch_raw_cli_round_trip) - see
            // cli_process::RAW_CLI_RUN_TIMEOUT's doc comment for the budget.
            let result = match tokio::time::timeout(cli_process::RAW_CLI_RUN_TIMEOUT, run).await {
                Ok(r) => r,
                Err(_) => Err(format!("Timed out after {}s running the RAW converter CLI", cli_process::RAW_CLI_RUN_TIMEOUT.as_secs())),
            };
            match result {
                Ok(()) => {
                    queue.set_progress(work.job_id, 100);
                    let export_file_name = work.export_path.file_name().and_then(|n| n.to_str()).map(str::to_string);
                    queue.finish(work.job_id, ArtJobStatus::Done, export_file_name, None);
                }
                Err(e) => {
                    // Release the filename this job claimed (see
                    // export_naming::next_export_path's atomic `create_new`)
                    // so a failed export doesn't leave an empty placeholder
                    // for Immich to later pick up as a new, broken asset -
                    // safe even on the timeout path above, since a
                    // still-running `ART-cli` process just recreates the file
                    // (`-Y`, overwrite without prompt) when it eventually
                    // finishes.
                    let _ = std::fs::remove_file(&work.export_path);
                    queue.finish(work.job_id, ArtJobStatus::Failed, None, Some(e));
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Confirmed live against a real ART-cli 1.26.7 install: `-S` (which
    /// `DefaultThenSidecarOverride` builds) exits non-zero with "no sidecar
    /// procparams found" when the target has no `.arp`/`.pp3`, rather than
    /// silently falling back to the default profile the way its own `-h`
    /// help text implies - so a target confirmed sidecar-less must get plain
    /// `-d` (`DefaultOnly`) instead, or every such export in a batch fails.
    #[test]
    fn mode_for_sidecar_picks_default_only_without_a_sidecar() {
        assert_eq!(mode_for_sidecar(false), SidecarCliMode::DefaultOnly);
        assert_eq!(mode_for_sidecar(true), SidecarCliMode::DefaultThenSidecarOverride);
    }

    #[test]
    fn enqueue_assigns_ids_and_starts_pending() {
        let (queue, _rx) = ArtQueue::new();
        let ids = queue.enqueue(
            RawConverterKind::Art,
            "/usr/bin/ART-cli",
            vec![("a".into(), PathBuf::from("/x/a.DNG"), PathBuf::from("/x/a_converted-1.jpg"), true), ("b".into(), PathBuf::from("/x/b.DNG"), PathBuf::from("/x/b_converted-1.jpg"), true)],
        );
        assert_eq!(ids, vec![1, 2]);

        let snap = queue.snapshot();
        assert_eq!(snap.len(), 2);
        assert!(snap.iter().all(|j| j.status == ArtJobStatus::Pending));
        assert_eq!(queue.pending_count(), 2);
    }

    #[test]
    fn start_manual_tracks_a_variant_1_job_through_running_to_done() {
        let (queue, _rx) = ArtQueue::new();
        let job_id = queue.start_manual("a".into(), RawConverterKind::Art);
        assert_eq!(queue.pending_count(), 1);
        assert_eq!(queue.snapshot()[0].status, ArtJobStatus::Pending);

        queue.set_status(job_id, ArtJobStatus::Running);
        queue.set_progress(job_id, 55);
        assert_eq!(queue.pending_count(), 1);
        assert_eq!(queue.snapshot()[0].status, ArtJobStatus::Running);
        assert_eq!(queue.snapshot()[0].progress_percent, Some(55));

        queue.finish(job_id, ArtJobStatus::Done, Some("a_converted-1.jpg".into()), None);
        assert_eq!(queue.pending_count(), 0);
        let snap = queue.snapshot();
        assert_eq!(snap[0].status, ArtJobStatus::Done);
        assert_eq!(snap[0].export_file_name.as_deref(), Some("a_converted-1.jpg"));
    }

    #[test]
    fn start_manual_ids_share_the_same_sequence_as_enqueue() {
        let (queue, _rx) = ArtQueue::new();
        let enqueued = queue.enqueue(RawConverterKind::Art, "/usr/bin/ART-cli", vec![("a".into(), PathBuf::from("/x/a.DNG"), PathBuf::from("/x/a_converted-1.jpg"), true)]);
        let manual_id = queue.start_manual("b".into(), RawConverterKind::Art);
        assert_eq!(enqueued, vec![1]);
        assert_eq!(manual_id, 2);
    }

    #[test]
    fn enqueue_ids_keep_increasing_across_calls() {
        let (queue, _rx) = ArtQueue::new();
        let first = queue.enqueue(RawConverterKind::Art, "/usr/bin/ART-cli", vec![("a".into(), PathBuf::from("/x/a.DNG"), PathBuf::from("/x/a_converted-1.jpg"), true)]);
        let second = queue.enqueue(RawConverterKind::Art, "/usr/bin/ART-cli", vec![("b".into(), PathBuf::from("/x/b.DNG"), PathBuf::from("/x/b_converted-1.jpg"), true)]);
        assert_eq!(first, vec![1]);
        assert_eq!(second, vec![2]);
    }

    /// Confirmed live (see `semaphore`'s doc comment): a Variant 1 permit and
    /// Variant 2's worker permits must draw from the same budget, or an
    /// interactive round trip run alongside an already-full batch queue
    /// oversubscribes concurrent `ART-cli` processes past
    /// `MAX_CONCURRENT_RAW_CLI_JOBS`.
    #[tokio::test]
    async fn acquire_permit_is_capped_and_shared_across_every_caller() {
        let (queue, _rx) = ArtQueue::new();
        let mut permits = Vec::new();
        for _ in 0..MAX_CONCURRENT_RAW_CLI_JOBS {
            permits.push(queue.acquire_permit().await);
        }
        // Every slot is held (regardless of which "variant" asked for it) -
        // one more should block rather than being handed out immediately.
        assert!(queue.semaphore.try_acquire().is_err(), "budget should be exhausted");

        drop(permits.pop());
        // Freeing exactly one slot lets exactly one more acquire succeed.
        let _permit = queue.acquire_permit().await;
        assert!(queue.semaphore.try_acquire().is_err(), "budget should be exhausted again");
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
    fn set_progress_updates_the_matching_job_and_survives_finish() {
        let (queue, _rx) = ArtQueue::new();
        let ids = queue.enqueue(RawConverterKind::Art, "/usr/bin/ART-cli", vec![("a".into(), PathBuf::from("/x/a.DNG"), PathBuf::from("/x/a_converted-1.jpg"), true)]);
        queue.set_progress(ids[0], 42);
        assert_eq!(queue.snapshot()[0].progress_percent, Some(42));

        // Left at its last value on a failed job, not reset - same "show how
        // far it got" idiom as import::ImportJob::bytes_copied.
        queue.finish(ids[0], ArtJobStatus::Failed, None, Some("demosaic failed".into()));
        assert_eq!(queue.snapshot()[0].progress_percent, Some(42));
    }

    #[test]
    fn clear_completed_drops_only_done_and_failed() {
        let (queue, _rx) = ArtQueue::new();
        let ids = queue.enqueue(
            RawConverterKind::Art,
            "/usr/bin/ART-cli",
            vec![("a".into(), PathBuf::from("/x/a.DNG"), PathBuf::from("/x/a_converted-1.jpg"), true), ("b".into(), PathBuf::from("/x/b.DNG"), PathBuf::from("/x/b_converted-1.jpg"), true)],
        );
        queue.finish(ids[0], ArtJobStatus::Done, Some("a_converted-1.jpg".into()), None);
        queue.clear_completed();
        let snap = queue.snapshot();
        assert_eq!(snap.len(), 1);
        assert_eq!(snap[0].job_id, ids[1]);
    }

    #[test]
    fn request_cancel_flags_a_pending_job_and_signals_its_receiver() {
        let (queue, _rx) = ArtQueue::new();
        let ids = queue.enqueue(RawConverterKind::Art, "/usr/bin/ART-cli", vec![("a".into(), PathBuf::from("/x/a.DNG"), PathBuf::from("/x/a_converted-1.jpg"), true)]);
        let cancel_rx = queue.cancel_receiver(ids[0]).expect("job should have a registered cancel channel");
        assert!(!*cancel_rx.borrow(), "not cancelled yet");

        assert!(queue.request_cancel(ids[0]), "a pending job should be cancellable");
        assert!(queue.snapshot()[0].cancel_requested);
        assert!(*cancel_rx.borrow(), "the receiver handed out earlier should observe the cancellation");
    }

    #[test]
    fn request_cancel_is_a_no_op_once_the_job_has_finished() {
        let (queue, _rx) = ArtQueue::new();
        let ids = queue.enqueue(RawConverterKind::Art, "/usr/bin/ART-cli", vec![("a".into(), PathBuf::from("/x/a.DNG"), PathBuf::from("/x/a_converted-1.jpg"), true)]);
        queue.finish(ids[0], ArtJobStatus::Done, Some("a_converted-1.jpg".into()), None);

        assert!(!queue.request_cancel(ids[0]), "an already-finished job can't be cancelled");
        assert!(!queue.snapshot()[0].cancel_requested);
    }

    #[test]
    fn request_cancel_returns_false_for_an_unknown_job_id() {
        let (queue, _rx) = ArtQueue::new();
        assert!(!queue.request_cancel(999));
    }

    #[test]
    fn finish_removes_the_cancel_channel_so_a_later_cancel_is_a_no_op() {
        let (queue, _rx) = ArtQueue::new();
        let ids = queue.enqueue(RawConverterKind::Art, "/usr/bin/ART-cli", vec![("a".into(), PathBuf::from("/x/a.DNG"), PathBuf::from("/x/a_converted-1.jpg"), true)]);
        queue.finish(ids[0], ArtJobStatus::Failed, None, Some("demosaic failed".into()));
        assert!(queue.cancel_receiver(ids[0]).is_none());
    }

    #[test]
    fn trim_completed_never_evicts_pending_or_running() {
        fn job(status: ArtJobStatus) -> ArtJob {
            ArtJob {
                job_id: 0,
                asset_id: "a".into(),
                tool: RawConverterKind::Art,
                status,
                export_file_name: None,
                progress_percent: None,
                created_at_ms: 0,
                finished_at_ms: None,
                error: None,
                cancel_requested: false,
            }
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
