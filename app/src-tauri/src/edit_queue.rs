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

//! Decoupled, bounded-concurrency background queue for rating/favorite/
//! description edits. `commands::update_asset_metadata` no longer waits on
//! any of this - it just resolves each target's local sidecar path (cheap,
//! no I/O), pushes a `Pending` job per target, and returns immediately. The
//! frontend applies its own optimistic patch before this queue has done
//! anything at all; this module's only job is to actually perform the
//! writes in the background and let the frontend poll for outcomes via
//! `commands::get_edit_queue_status`.
//!
//! The XMP sidecar write is still the *authoritative* mechanism for
//! persisting `rating`/`description` (Immich's own PUT has been confirmed to
//! return `200 OK` for External Library assets without the value actually
//! being persisted - see the plan file's root-cause writeup). So a real XMP
//! write failure (permission denied, missing folder, etc.) is `Failed` -
//! fatal, and the frontend rolls its optimistic patch back. Immich's PUT is
//! still attempted (concurrently, not sequentially) so its own UI/exifInfo
//! stay in sync, but a failure there is merely advisory: the edit already
//! stuck via the sidecar, so this surfaces as a `Done` job with a warning
//! attached, never a rollback.
//!
//! Bounded to `MAX_CONCURRENT_JOBS` concurrent writes on purpose: this
//! session already saw a burst of concurrent NFS calls saturate the single
//! shared `hard`+`sync` Tailscale-backed mount for minutes at a time -
//! unbounded fan-out would risk making that worse, not better.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Manager};
use tokio::sync::{mpsc, Semaphore};

use crate::asset_locks::AssetLocks;
use crate::commands::{LensEditTarget, MetadataEditTarget};
use crate::config::LibraryConfig;
use crate::exiftool;
use crate::immich::ImmichClient;
use crate::io_guard::{self, IoGuard};
use crate::lens_catalog;
use crate::lens_edit::{self, LensChange, ProfileKind};
use crate::paths;
use crate::state::AppState;
use crate::xmp;

/// Deliberately small and named - see the module doc comment above for why.
pub const MAX_CONCURRENT_JOBS: usize = 4;

/// Caps retained `Done`/`Failed` history so a long session's board doesn't
/// grow unboundedly. A first guess, easy to tune - worth revisiting once the
/// panel's actually used for a while. Never applies to `Pending`/`Writing`
/// entries.
const MAX_COMPLETED_HISTORY: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum JobStatus {
    Pending,
    Writing,
    Done,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditJob {
    pub job_id: u64,
    pub asset_id: String,
    // The patch being applied - mirrors AssetMetadataPatch's optional fields
    // so the frontend's ActivityPanel can derive a "3★" / "Favorite" /
    // "Caption" label from whichever of these are set.
    pub rating: Option<i32>,
    pub is_favorite: Option<bool>,
    pub description: Option<String>,
    /// Set for a Change Lens job - the lens being applied (or noted), for
    /// the ActivityPanel's label.
    pub lens_model: Option<String>,
    pub status: JobStatus,
    pub created_at_ms: u64,
    pub finished_at_ms: Option<u64>,
    // Fatal - the XMP write failed, so the frontend rolls its optimistic
    // patch back once it sees this.
    pub error: Option<String>,
    // Non-fatal - the sidecar write (the authoritative mechanism) succeeded,
    // but Immich's own PUT failed. Visible-only in the ActivityPanel; no
    // rollback.
    pub immich_warning: Option<String>,
}

/// What the worker needs to actually perform one job - resolved up front at
/// enqueue time (including the local path resolve, which is cheap/no I/O) so
/// the worker itself never has to touch `AppState.config` mid-drain.
pub(crate) struct QueuedWork {
    job_id: u64,
    asset_id: String,
    local_path: Option<PathBuf>,
    rating: Option<i32>,
    is_favorite: Option<bool>,
    description: Option<String>,
    lens: Option<LensWork>,
    cfg: LibraryConfig,
}

/// A Change Lens job's per-target inputs, resolved at enqueue time like the
/// rest of `QueuedWork`.
pub(crate) struct LensWork {
    change: LensChange,
    camera_make: String,
    camera_model: String,
    crop_factor: Option<f32>,
    current_lens_model: String,
    /// The caption Immich currently has - used as the base for the lens
    /// note when the sidecar itself has no `dc:description` yet (e.g. a
    /// caption that came from embedded XMP/IPTC), so appending the note
    /// can't wipe it.
    current_description: Option<String>,
    exiftool_path: String,
    keep_original_backup: bool,
    update_raw_profiles: bool,
}

pub struct EditQueue {
    // Plain std Mutex, same idiom as `AppState.config` - only ever held for
    // a short synchronous read/write, never across an `.await`.
    board: Mutex<VecDeque<EditJob>>,
    next_id: AtomicU64,
    tx: mpsc::UnboundedSender<QueuedWork>,
    // One async lock per asset id ever edited this session, created lazily -
    // shared with `ProcessingQueue` via `AssetLocks` (see its own doc
    // comment for why: `ProcessingQueue`'s darktable-history writes now
    // target this same `.xmp` file, so the two queues must serialize against
    // each other, not just against themselves). The worker holds an asset's
    // lock across its entire write (XMP patch + Immich PUT) so two jobs for
    // the *same* asset - e.g. a quick re-rate before the first write
    // finished - can never run concurrently. Without this, both jobs' XMP
    // writes raced on the identical atomic-write temp filename
    // (`xmp.rs::write_atomic` names it from the target path plus this
    // process's pid, which is constant across concurrent jobs), so whichever
    // job's rename lost the race failed with a misleading "containing folder
    // appears to be missing" - confirmed live, not actually an NFS/mount
    // problem. Jobs for *different* assets are unaffected and still run up
    // to `MAX_CONCURRENT_JOBS` at once.
    asset_locks: Arc<AssetLocks>,
}

impl EditQueue {
    pub fn new(asset_locks: Arc<AssetLocks>) -> (Arc<Self>, mpsc::UnboundedReceiver<QueuedWork>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let queue = Arc::new(Self { board: Mutex::new(VecDeque::new()), next_id: AtomicU64::new(1), tx, asset_locks });
        (queue, rx)
    }

    fn asset_lock(&self, asset_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.asset_locks.lock_for(asset_id)
    }

    /// Pushes one `Pending` job per target and hands each to the drain
    /// worker, returning the assigned job ids in the same order as
    /// `targets` - the frontend correlates these against its own optimistic
    /// patch for later rollback. Called from `update_asset_metadata` after
    /// its `read_only`/`max_writes_per_batch` checks, which stay unchanged
    /// and still happen before anything is queued.
    pub fn enqueue(
        &self,
        cfg: &LibraryConfig,
        targets: &[MetadataEditTarget],
        rating: Option<i32>,
        is_favorite: Option<bool>,
        description: Option<&str>,
    ) -> Vec<u64> {
        let mut ids = Vec::with_capacity(targets.len());
        let mut board = self.board.lock().unwrap();
        for target in targets {
            let job_id = self.next_id.fetch_add(1, Ordering::Relaxed);
            let local_path = target
                .original_path
                .as_deref()
                .and_then(|p| paths::resolve_local_path(p, cfg));

            board.push_back(EditJob {
                job_id,
                asset_id: target.id.clone(),
                rating,
                is_favorite,
                description: description.map(str::to_string),
                lens_model: None,
                status: JobStatus::Pending,
                created_at_ms: now_ms(),
                finished_at_ms: None,
                error: None,
                immich_warning: None,
            });

            // Ignoring the send error: it can only mean the worker's
            // receiver was dropped, i.e. the app is shutting down - nothing
            // useful to do with that here, and the job stays visible on the
            // board as Pending (harmless; the process is exiting anyway).
            let _ = self.tx.send(QueuedWork {
                job_id,
                asset_id: target.id.clone(),
                local_path,
                rating,
                is_favorite,
                description: description.map(str::to_string),
                lens: None,
                cfg: cfg.clone(),
            });
            ids.push(job_id);
        }
        ids
    }

    /// Change Lens counterpart to `enqueue` - one job per target, each
    /// carrying the same `change` plus that asset's own camera/lens/caption
    /// (the note is appended to each asset's *own* description, and the crop
    /// factor depends on each asset's camera).
    pub fn enqueue_lens(
        &self,
        cfg: &LibraryConfig,
        targets: &[LensEditTarget],
        change: &LensChange,
        exiftool_path: &str,
        keep_original_backup: bool,
        update_raw_profiles: bool,
    ) -> Vec<u64> {
        let mut ids = Vec::with_capacity(targets.len());
        let mut board = self.board.lock().unwrap();
        for target in targets {
            let job_id = self.next_id.fetch_add(1, Ordering::Relaxed);
            let local_path = target.original_path.as_deref().and_then(|p| paths::resolve_local_path(p, cfg));
            let camera_make = target.make.clone().unwrap_or_default();
            let camera_model = target.model.clone().unwrap_or_default();

            board.push_back(EditJob {
                job_id,
                asset_id: target.id.clone(),
                rating: None,
                is_favorite: None,
                description: None,
                lens_model: Some(change.lens.model.clone()),
                status: JobStatus::Pending,
                created_at_ms: now_ms(),
                finished_at_ms: None,
                error: None,
                immich_warning: None,
            });

            let _ = self.tx.send(QueuedWork {
                job_id,
                asset_id: target.id.clone(),
                local_path,
                rating: None,
                is_favorite: None,
                description: None,
                lens: Some(LensWork {
                    change: change.clone(),
                    crop_factor: lens_catalog::camera_crop_factor(&camera_make, &camera_model),
                    camera_make,
                    camera_model,
                    current_lens_model: target.lens_model.clone().unwrap_or_default(),
                    current_description: target.description.clone(),
                    exiftool_path: exiftool_path.to_string(),
                    keep_original_backup,
                    update_raw_profiles,
                }),
                cfg: cfg.clone(),
            });
            ids.push(job_id);
        }
        ids
    }

    pub fn snapshot(&self) -> Vec<EditJob> {
        self.board.lock().unwrap().iter().cloned().collect()
    }

    pub fn pending_count(&self) -> usize {
        self.board
            .lock()
            .unwrap()
            .iter()
            .filter(|j| matches!(j.status, JobStatus::Pending | JobStatus::Writing))
            .count()
    }

    /// The panel's "Clear Completed" action - drops every `Done`/`Failed`
    /// entry, leaving anything still in flight untouched.
    pub fn clear_completed(&self) {
        let mut board = self.board.lock().unwrap();
        board.retain(|j| matches!(j.status, JobStatus::Pending | JobStatus::Writing));
    }

    fn set_status(&self, job_id: u64, status: JobStatus) {
        let mut board = self.board.lock().unwrap();
        if let Some(job) = board.iter_mut().find(|j| j.job_id == job_id) {
            job.status = status;
        }
    }

    fn finish(&self, job_id: u64, status: JobStatus, error: Option<String>, immich_warning: Option<String>) {
        let mut board = self.board.lock().unwrap();
        if let Some(job) = board.iter_mut().find(|j| j.job_id == job_id) {
            job.status = status;
            job.finished_at_ms = Some(now_ms());
            job.error = error;
            job.immich_warning = immich_warning;
        }
        trim_completed(&mut board);
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Evicts the oldest `Done`/`Failed` entries once their count exceeds
/// `MAX_COMPLETED_HISTORY`, walking front-to-back (creation order, since jobs
/// are always pushed to the back) - never touches `Pending`/`Writing`
/// entries, however old, wherever they sit in the deque.
fn trim_completed(board: &mut VecDeque<EditJob>) {
    let completed = board.iter().filter(|j| matches!(j.status, JobStatus::Done | JobStatus::Failed)).count();
    let mut to_remove = completed.saturating_sub(MAX_COMPLETED_HISTORY);
    let mut i = 0;
    while to_remove > 0 && i < board.len() {
        if matches!(board[i].status, JobStatus::Done | JobStatus::Failed) {
            board.remove(i);
            to_remove -= 1;
        } else {
            i += 1;
        }
    }
}

/// Pure classification of one job's outcome from its two independent
/// results - split out from `run` so it's unit-testable without any actual
/// I/O. XMP is authoritative: any XMP error is fatal (`Failed`, rollback);
/// otherwise it's `Done`, carrying an advisory warning if Immich's own PUT
/// failed.
fn classify(xmp_result: Result<(), String>, immich_result: Result<(), String>) -> (JobStatus, Option<String>, Option<String>) {
    match xmp_result {
        Err(e) => (JobStatus::Failed, Some(e), None),
        Ok(()) => match immich_result {
            Err(w) => (JobStatus::Done, None, Some(w)),
            Ok(()) => (JobStatus::Done, None, None),
        },
    }
}

/// The sidecar half of a job - unchanged mechanism (still
/// `io_guard::guarded_spawn_blocking`), just extracted into its own helper so
/// it can run concurrently with the Immich PUT via `tokio::join!`. A skip
/// (nothing to write, or no local path configured/resolved for this target)
/// is `Ok(())`, matching the pre-queue behavior where such targets were
/// silently skipped rather than treated as a failure.
async fn write_xmp(io_guard: &Arc<IoGuard>, local_path: Option<PathBuf>, rating: Option<i32>, description: Option<String>) -> Result<(), String> {
    if rating.is_none() && description.is_none() {
        return Ok(());
    }
    let Some(local) = local_path else {
        return Ok(());
    };
    match io_guard::guarded_spawn_blocking(io_guard, move || {
        // xmp_write_path does real filesystem I/O (.exists() checks to pick
        // between the two sidecar-naming conventions) - must stay inside
        // this blocking closure, not hoisted into the async fn, or it'd run
        // directly on the tokio worker thread instead of being dispatched
        // through io_guard's blocking pool.
        let write_path = paths::xmp_write_path(&local);
        xmp::patch_or_create(&write_path, rating, description.as_deref())
    }) {
        Some(handle) => handle.await.map_err(|e| e.to_string())?,
        None => Err("Skipped: system is about to suspend, try again after it wakes".to_string()),
    }
}

/// Every `.pp3`/`.arp` that already exists next to `original`, in both
/// naming forms - all of them get patched, not just the newest, since each
/// is a profile the user may open.
fn existing_raw_profiles(original: &std::path::Path) -> Vec<(PathBuf, ProfileKind)> {
    [
        (paths::pp3_sidecar_path(original), ProfileKind::Pp3),
        (paths::pp3_sidecar_path_replaced(original), ProfileKind::Pp3),
        (paths::arp_sidecar_path(original), ProfileKind::Arp),
        (paths::arp_sidecar_path_replaced(original), ProfileKind::Arp),
    ]
    .into_iter()
    .filter(|(p, _)| p.is_file())
    .collect()
}

/// One Change Lens job, in dependency order:
/// 1. the original (only when asked) - first, so a refused/failed RAW write
///    leaves nothing half-applied;
/// 2. the XMP sidecar (lens tags + the per-asset note) - authoritative for
///    Immich, same as every other edit in this queue;
/// 3. existing `.pp3`/`.arp` profiles - best effort, a warning on failure;
/// 4. Immich description PUT + metadata refresh - a warning on failure.
async fn run_lens_job(
    io_guard: &Arc<IoGuard>,
    client: Option<&ImmichClient>,
    asset_id: &str,
    local_path: Option<PathBuf>,
    work: LensWork,
) -> (JobStatus, Option<String>, Option<String>) {
    let Some(local) = local_path else {
        return (
            JobStatus::Failed,
            Some("No local path for this asset - Change Lens needs file access to its folder (Preferences → Library).".into()),
            None,
        );
    };
    let change = work.change.clone();
    let mut warnings: Vec<String> = Vec::new();

    if change.apply_lens && change.write_original {
        if work.exiftool_path.trim().is_empty() {
            return (JobStatus::Failed, Some("Writing the original needs exiftool - set its path in Preferences → Applications.".into()), None);
        }
        let args = lens_edit::original_write_args(&change, work.crop_factor, work.keep_original_backup, &work.camera_make, &local);
        if let Err(e) = exiftool::run_exiftool(&work.exiftool_path, &args).await {
            return (JobStatus::Failed, Some(format!("Couldn't write the lens to the original: {e}")), None);
        }
        match exiftool::run_exiftool_capture_stdout(&work.exiftool_path, &lens_edit::readback_args(&local)).await {
            Ok(out) => warnings.extend(lens_edit::readback_warning(&out, &change.lens.model)),
            Err(e) => warnings.push(format!("Couldn't verify the original after writing: {e}")),
        }
    }

    let sidecar_change = change.clone();
    let crop = work.crop_factor;
    let current_lens = work.current_lens_model.clone();
    let fallback_description = work.current_description.clone();
    let sidecar = io_guard::guarded_spawn_blocking(io_guard, {
        let local = local.clone();
        move || -> Result<Option<String>, String> {
            let write_path = paths::xmp_write_path(&local);
            let existing = std::fs::read_to_string(&write_path).unwrap_or_default();
            let mut props = lens_edit::sidecar_props(&sidecar_change, crop);
            if sidecar_change.apply_lens && xmp::read_simple_property(&existing, "brighttable", "OriginalLensModel").is_none() {
                props.extend(lens_edit::original_lens_prop(&current_lens));
            }
            let description = sidecar_change.add_note.then(|| {
                let base = xmp::read_description(&existing).or(fallback_description).unwrap_or_default();
                lens_edit::upsert_lens_note(&base, &sidecar_change.note_prefix, &sidecar_change.lens.model)
            });
            xmp::patch_properties(&write_path, &props, description.as_deref())?;
            Ok(description)
        }
    });
    let new_description = match sidecar {
        Some(handle) => match handle.await.map_err(|e| e.to_string()).and_then(|r| r) {
            Ok(d) => d,
            Err(e) => return (JobStatus::Failed, Some(e), None),
        },
        None => return (JobStatus::Failed, Some("Skipped: system is about to suspend, try again after it wakes".into()), None),
    };

    if change.apply_lens && work.update_raw_profiles {
        let (make, model, lens_model) = (work.camera_make.clone(), work.camera_model.clone(), change.lens.model.clone());
        let patched = io_guard::guarded_spawn_blocking(io_guard, move || -> Vec<String> {
            let mut errors = Vec::new();
            for (path, kind) in existing_raw_profiles(&local) {
                let result = std::fs::read_to_string(&path)
                    .map_err(|e| e.to_string())
                    .and_then(|text| xmp::write_atomic(&path, &lens_edit::patch_lens_profile(&text, kind, &make, &model, &lens_model)));
                if let Err(e) = result {
                    errors.push(format!("Couldn't update {}: {e}", path.display()));
                }
            }
            errors
        });
        if let Some(handle) = patched {
            match handle.await {
                Ok(errors) => warnings.extend(errors),
                Err(e) => warnings.push(e.to_string()),
            }
        }
    }

    match client {
        Some(client) => {
            if let Some(d) = new_description.as_deref() {
                if let Err(e) = client.update_asset(asset_id, None, None, Some(d), None).await {
                    warnings.push(e);
                }
            }
            // Immich only re-reads lens/focal tags from the files on a
            // metadata refresh - always needed here, unlike the plain edits.
            if let Err(e) = client.refresh_metadata(asset_id).await {
                warnings.push(format!("Immich refresh failed: {e}"));
            }
        }
        None => warnings.push("Couldn't reach Immich - it will pick up the new lens on its next metadata refresh.".into()),
    }

    let warning = (!warnings.is_empty()).then(|| warnings.join("\n"));
    (JobStatus::Done, None, warning)
}

/// The drain worker - spawned once from `lib.rs`'s `.setup()`. Pulls queued
/// work and spawns each job onto its own task, gated by a shared
/// `Semaphore(MAX_CONCURRENT_JOBS)` so at most that many writes run at once
/// regardless of how many were enqueued in a burst.
pub async fn run(app: AppHandle, mut rx: mpsc::UnboundedReceiver<QueuedWork>) {
    let (http, io_guard, queue, auto_resolution) = {
        let state = app.state::<AppState>();
        (state.http.clone(), state.io_guard.clone(), state.edit_queue.clone(), state.auto_resolution.clone())
    };

    let semaphore = Arc::new(Semaphore::new(MAX_CONCURRENT_JOBS));

    while let Some(work) = rx.recv().await {
        let semaphore = semaphore.clone();
        let http = http.clone();
        let io_guard = io_guard.clone();
        let queue = queue.clone();
        let auto_resolution = auto_resolution.clone();

        let asset_lock = queue.asset_lock(&work.asset_id);

        tauri::async_runtime::spawn(async move {
            // Acquired before the semaphore permit, and held across the
            // whole write below: a second job for this same asset queues up
            // here without occupying a permit, instead of racing this one -
            // see the field doc comment on `EditQueue::asset_locks`.
            let _asset_guard = asset_lock.lock().await;
            let _permit = semaphore.acquire_owned().await;
            queue.set_status(work.job_id, JobStatus::Writing);

            if let Some(lens) = work.lens {
                let client_result = ImmichClient::from_config(&work.cfg, http, &auto_resolution).await;
                let (status, error, warning) = run_lens_job(&io_guard, client_result.as_ref().ok(), &work.asset_id, work.local_path, lens).await;
                queue.finish(work.job_id, status, error, warning);
                return;
            }

            // Resolved eagerly (before the joined futures below) rather than
            // as a third leg of the `join!` - it must not block the XMP
            // write, which is the authoritative mechanism and doesn't need a
            // client at all. Usually no real I/O (Auto mode's LAN probe is
            // cached - see `AutoResolution`), but on a cache miss this can
            // await a short reachability probe; a resulting config/network
            // problem becomes an Immich-side error same as any other PUT
            // failure.
            let client_result = ImmichClient::from_config(&work.cfg, http, &auto_resolution).await;

            let xmp_fut = write_xmp(&io_guard, work.local_path, work.rating, work.description.clone());
            let immich_fut = async {
                match &client_result {
                    Ok(client) => {
                        client
                            .update_asset(&work.asset_id, work.rating, work.is_favorite, work.description.as_deref(), None)
                            .await
                    }
                    Err(e) => Err(e.clone()),
                }
            };
            let (xmp_result, immich_result) = tokio::join!(xmp_fut, immich_fut);

            let full_success = xmp_result.is_ok() && immich_result.is_ok();
            let (status, error, immich_warning) = classify(xmp_result, immich_result);
            queue.finish(work.job_id, status, error, immich_warning);

            if full_success {
                // Fire-and-forget: this only affects how soon Immich's own
                // exifInfo/UI catch up, not whether the edit itself stuck.
                if let Ok(client) = &client_result {
                    let _ = client.refresh_metadata(&work.asset_id).await;
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(id: &str) -> MetadataEditTarget {
        MetadataEditTarget { id: id.to_string(), original_path: None }
    }

    #[test]
    fn enqueue_assigns_ids_and_starts_pending() {
        let (queue, _rx) = EditQueue::new(AssetLocks::new());
        let ids = queue.enqueue(&LibraryConfig::default(), &[target("a"), target("b")], Some(4), None, None);
        assert_eq!(ids, vec![1, 2]);

        let snap = queue.snapshot();
        assert_eq!(snap.len(), 2);
        assert!(snap.iter().all(|j| j.status == JobStatus::Pending));
        assert_eq!(queue.pending_count(), 2);
    }

    // Shared per-asset lock semantics (same lock reused per asset id,
    // distinct across ids, serializes concurrent same-asset access) are now
    // covered by `asset_locks.rs`'s own tests - `EditQueue::asset_lock` is a
    // thin passthrough to the shared `AssetLocks` instance (see its field
    // doc comment for why it's shared with `ProcessingQueue`).

    #[test]
    fn enqueue_ids_keep_increasing_across_calls() {
        let (queue, _rx) = EditQueue::new(AssetLocks::new());
        let first = queue.enqueue(&LibraryConfig::default(), &[target("a")], None, Some(true), None);
        let second = queue.enqueue(&LibraryConfig::default(), &[target("b")], None, Some(true), None);
        assert_eq!(first, vec![1]);
        assert_eq!(second, vec![2]);
    }

    #[test]
    fn xmp_failure_is_fatal_and_rolls_back() {
        let (status, error, warning) = classify(Err("permission denied".into()), Ok(()));
        assert_eq!(status, JobStatus::Failed);
        assert_eq!(error.as_deref(), Some("permission denied"));
        assert_eq!(warning, None);

        // Fatal even when Immich also failed - the XMP error is what matters.
        let (status, error, _) = classify(Err("permission denied".into()), Err("network down".into()));
        assert_eq!(status, JobStatus::Failed);
        assert_eq!(error.as_deref(), Some("permission denied"));
    }

    #[test]
    fn immich_only_failure_is_done_with_warning_not_rollback() {
        let (status, error, warning) = classify(Ok(()), Err("Immich sync lagging".into()));
        assert_eq!(status, JobStatus::Done);
        assert_eq!(error, None);
        assert_eq!(warning.as_deref(), Some("Immich sync lagging"));
    }

    #[test]
    fn both_success_is_plain_done() {
        let (status, error, warning) = classify(Ok(()), Ok(()));
        assert_eq!(status, JobStatus::Done);
        assert_eq!(error, None);
        assert_eq!(warning, None);
    }

    fn job(status: JobStatus) -> EditJob {
        EditJob {
            job_id: 0,
            asset_id: "a".into(),
            rating: None,
            is_favorite: None,
            description: None,
            lens_model: None,
            status,
            created_at_ms: 0,
            finished_at_ms: None,
            error: None,
            immich_warning: None,
        }
    }

    #[test]
    fn trim_completed_never_evicts_pending_or_writing() {
        let mut board: VecDeque<EditJob> = VecDeque::new();
        board.push_back(job(JobStatus::Pending));
        board.push_back(job(JobStatus::Writing));
        for _ in 0..(MAX_COMPLETED_HISTORY + 50) {
            board.push_back(job(JobStatus::Done));
        }
        trim_completed(&mut board);

        let pending_writing = board.iter().filter(|j| matches!(j.status, JobStatus::Pending | JobStatus::Writing)).count();
        assert_eq!(pending_writing, 2, "Pending/Writing entries must never be evicted");
        let completed = board.iter().filter(|j| matches!(j.status, JobStatus::Done | JobStatus::Failed)).count();
        assert_eq!(completed, MAX_COMPLETED_HISTORY);
    }

    #[test]
    fn trim_completed_is_noop_under_the_cap() {
        let mut board: VecDeque<EditJob> = VecDeque::new();
        for _ in 0..5 {
            board.push_back(job(JobStatus::Done));
        }
        trim_completed(&mut board);
        assert_eq!(board.len(), 5);
    }

    fn lens_work(apply_lens: bool, add_note: bool, write_original: bool) -> LensWork {
        LensWork {
            change: LensChange {
                lens: crate::config::LensSpec {
                    maker: "Zeiss".into(),
                    model: "Planar T* 2/50 ZM".into(),
                    mount: Some("Leica M".into()),
                    focal_min: 50.0,
                    focal_max: 50.0,
                    aperture_max: 2.0,
                    aperture_max_tele: None,
                },
                apply_lens,
                add_note,
                focal_length: None,
                f_number: None,
                write_original,
                note_prefix: "Lens: ".into(),
            },
            camera_make: "Leica Camera AG".into(),
            camera_model: "LEICA M10-R".into(),
            crop_factor: Some(1.0),
            current_lens_model: "Summicron-M 1:2/50".into(),
            current_description: Some("Canal at dusk".into()),
            exiftool_path: String::new(),
            keep_original_backup: true,
            update_raw_profiles: true,
        }
    }

    fn lens_tmp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("brighttable-lens-job-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn lens_job_writes_sidecar_note_and_existing_profile() {
        let dir = lens_tmp_dir("replace");
        let raw = dir.join("L1000103.DNG");
        std::fs::write(&raw, b"not really a dng").unwrap();
        // A 0-byte sidecar, as found next to real Leica DNGs.
        std::fs::write(dir.join("L1000103.DNG.xmp"), "").unwrap();
        std::fs::write(dir.join("L1000103.DNG.arp"), "[Version]\nAppVersion=1.26.7\n\n[LensProfile]\nLcMode=lfauto\nLFLens=\n\n[Exif]\nLens=\n").unwrap();

        let guard = crate::io_guard::IoGuard::new(crate::io_guard::DEFAULT_MAX_CONCURRENT_METADATA_SCANS);
        let (status, error, warning) = run_lens_job(&guard, None, "asset-1", Some(raw.clone()), lens_work(true, true, false)).await;
        assert_eq!(status, JobStatus::Done, "{error:?}");
        assert!(warning.unwrap().contains("Couldn't reach Immich"), "no client is advisory only");

        let sidecar = std::fs::read_to_string(dir.join("L1000103.DNG.xmp")).unwrap();
        assert_eq!(xmp::read_simple_property(&sidecar, "exifEX", "LensModel").as_deref(), Some("Planar T* 2/50 ZM"));
        assert_eq!(xmp::read_simple_property(&sidecar, "exifEX", "LensMake").as_deref(), Some("Zeiss"));
        assert_eq!(xmp::read_simple_property(&sidecar, "exif", "FocalLength").as_deref(), Some("50/1"));
        assert_eq!(xmp::read_simple_property(&sidecar, "brighttable", "OriginalLensModel").as_deref(), Some("Summicron-M 1:2/50"));
        // Note appended to the caption Immich already had, not replacing it.
        assert_eq!(xmp::read_description(&sidecar).as_deref(), Some("Canal at dusk\nLens: Planar T* 2/50 ZM"));

        let arp = std::fs::read_to_string(dir.join("L1000103.DNG.arp")).unwrap();
        assert!(arp.contains("LcMode=lfmanual\n"));
        assert!(arp.contains("LFLens=Planar T* 2/50 ZM\n"));
        assert!(arp.contains("LFCameraModel=LEICA M10-R\n"));
        assert!(arp.contains("[Exif]\nLens=Planar T* 2/50 ZM\n"));
        // No .pp3 is ever created.
        assert!(!dir.join("L1000103.DNG.pp3").exists());

        // Re-applying keeps the *first* original lens and doesn't stack notes.
        let mut again = lens_work(true, true, false);
        again.current_lens_model = "Planar T* 2/50 ZM".into();
        let (status, ..) = run_lens_job(&guard, None, "asset-1", Some(raw), again).await;
        assert_eq!(status, JobStatus::Done);
        let sidecar = std::fs::read_to_string(dir.join("L1000103.DNG.xmp")).unwrap();
        assert_eq!(xmp::read_simple_property(&sidecar, "brighttable", "OriginalLensModel").as_deref(), Some("Summicron-M 1:2/50"));
        assert_eq!(xmp::read_description(&sidecar).as_deref(), Some("Canal at dusk\nLens: Planar T* 2/50 ZM"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn keep_and_note_touches_only_the_description() {
        let dir = lens_tmp_dir("keep");
        let raw = dir.join("L1.DNG");
        std::fs::write(&raw, b"x").unwrap();
        let arp_text = "[LensProfile]\nLcMode=lfauto\n";
        std::fs::write(dir.join("L1.DNG.arp"), arp_text).unwrap();
        let guard = crate::io_guard::IoGuard::new(crate::io_guard::DEFAULT_MAX_CONCURRENT_METADATA_SCANS);
        let (status, ..) = run_lens_job(&guard, None, "a", Some(raw), lens_work(false, true, false)).await;
        assert_eq!(status, JobStatus::Done);
        let sidecar = std::fs::read_to_string(dir.join("L1.DNG.xmp")).unwrap();
        assert_eq!(xmp::read_simple_property(&sidecar, "exifEX", "LensModel"), None);
        assert_eq!(xmp::read_description(&sidecar).as_deref(), Some("Canal at dusk\nLens: Planar T* 2/50 ZM"));
        assert_eq!(std::fs::read_to_string(dir.join("L1.DNG.arp")).unwrap(), arp_text);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn writing_original_without_exiftool_fails_before_touching_anything() {
        let dir = lens_tmp_dir("noexif");
        let raw = dir.join("L1.DNG");
        std::fs::write(&raw, b"x").unwrap();
        let guard = crate::io_guard::IoGuard::new(crate::io_guard::DEFAULT_MAX_CONCURRENT_METADATA_SCANS);
        let (status, error, _) = run_lens_job(&guard, None, "a", Some(raw), lens_work(true, false, true)).await;
        assert_eq!(status, JobStatus::Failed);
        assert!(error.unwrap().contains("exiftool"));
        assert!(!dir.join("L1.DNG.xmp").exists(), "nothing half-applied");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn lens_job_without_local_path_fails() {
        let guard = crate::io_guard::IoGuard::new(crate::io_guard::DEFAULT_MAX_CONCURRENT_METADATA_SCANS);
        let (status, error, _) = run_lens_job(&guard, None, "a", None, lens_work(true, false, false)).await;
        assert_eq!(status, JobStatus::Failed);
        assert!(error.unwrap().contains("local path"));
    }
}
