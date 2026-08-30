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

//! Decoupled, bounded-concurrency background queue for stack create/dissolve
//! operations - modeled directly on `edit_queue.rs`. `useStacking.ts`'s
//! multi-stack operations (bulk Unstack, Smart Stack apply, manual multi-
//! select Stack, dissolve-before-trash) used to run as a plain sequential
//! frontend loop, one Immich round trip at a time, invisible to the
//! Activity pill and to the quit-safety check. This queue gives them the
//! same treatment every other background write already has: real
//! concurrency (bounded, since these are still network calls against one
//! Immich server), a status the frontend can poll, and a `pending_count()`
//! the `CloseRequested` handler in `lib.rs` can sum alongside the other
//! five queues.
//!
//! Two job kinds only - `Dissolve` (delete one stack, freeing its members)
//! and `Create` (create one new stack from a given id list, first id =
//! pick). All the higher-level orchestration (which old stacks a Smart
//! Stack group needs dissolved first, how to union freed members into a
//! new selection, per-page trash-then-restack sequencing) stays in
//! `useStacking.ts` exactly as it was - this module only parallelizes the
//! individual atomic calls that TypeScript used to await one at a time.
//!
//! No per-asset lock (unlike `edit_queue`/`processing_queue`, which
//! serialize same-asset jobs because they both write the same local `.xmp`
//! sidecar): stack mutations never touch local files, and Immich's stack
//! membership is exclusive per asset, so concurrent `Dissolve`s of
//! *distinct* stack ids and concurrent `Create`s from *disjoint* id sets
//! can never race each other. Just a local `Semaphore` for a concurrency
//! cap, same idiom as `edit_queue.rs`'s `MAX_CONCURRENT_JOBS`.
//!
//! No cancellation (unlike `art_queue.rs`/`export_queue.rs`): every job is
//! one fast atomic HTTP call, not a long-running CLI process - there's
//! nothing meaningful to cancel mid-job.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Manager};
use tokio::sync::{mpsc, Semaphore};

use crate::config::LibraryConfig;
use crate::immich::ImmichClient;
use crate::state::AppState;

/// Deliberately a bit higher than `edit_queue::MAX_CONCURRENT_JOBS` (4) -
/// these are small single-request calls against one Immich server, not
/// disk/NFS-bound writes, so there's less reason to keep it as tight.
pub const MAX_CONCURRENT_JOBS: usize = 6;

/// Same rationale/value as `edit_queue::MAX_COMPLETED_HISTORY`.
const MAX_COMPLETED_HISTORY: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum JobStatus {
    Pending,
    Working,
    Done,
    Failed,
}

// The enum-level `rename_all` only renames the tag values themselves
// ("Dissolve" -> "dissolve", "Create" -> "create") - it does NOT cascade
// down to the fields inside each variant, which need their own per-variant
// `rename_all` to actually come out camelCase (confirmed live: without
// this, the wire shape was `{"kind":"create","asset_ids":[...]}` -
// snake_case - while the TS side expected `assetIds`, so
// `job.kind.assetIds` was silently `undefined` and crashed ActivityPanel
// the first time it tried to render a Create job row).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum StackJobKind {
    #[serde(rename_all = "camelCase")]
    Dissolve { stack_id: String },
    #[serde(rename_all = "camelCase")]
    Create { asset_ids: Vec<String> },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StackJob {
    pub job_id: u64,
    pub kind: StackJobKind,
    pub status: JobStatus,
    pub created_at_ms: u64,
    pub finished_at_ms: Option<u64>,
    pub error: Option<String>,
    /// Dissolve only: the freed member ids - `None` on the "stack already
    /// gone server-side" case (any `get_stack` failure, matching the old
    /// frontend loop's own tolerance exactly), which the caller then falls
    /// back to its own `stackByAssetId` cache for, same as before.
    pub result_member_ids: Option<Vec<String>>,
    /// Create only: the new stack's id/pick.
    pub result_stack_id: Option<String>,
    pub result_primary_asset_id: Option<String>,
}

/// What the worker needs to run one job - resolved at enqueue time so the
/// worker never touches `AppState.config` mid-drain, same contract as
/// `edit_queue::QueuedWork`.
pub(crate) enum QueuedStackWork {
    Dissolve { job_id: u64, stack_id: String, cfg: LibraryConfig },
    Create { job_id: u64, asset_ids: Vec<String>, cfg: LibraryConfig },
}

pub struct StackQueue {
    // Plain std Mutex, same idiom as `EditQueue::board` - only ever held for
    // a short synchronous read/write, never across an `.await`.
    board: Mutex<VecDeque<StackJob>>,
    next_id: AtomicU64,
    tx: mpsc::UnboundedSender<QueuedStackWork>,
}

impl StackQueue {
    pub fn new() -> (Arc<Self>, mpsc::UnboundedReceiver<QueuedStackWork>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let queue = Arc::new(Self { board: Mutex::new(VecDeque::new()), next_id: AtomicU64::new(1), tx });
        (queue, rx)
    }

    /// Pushes one `Pending` `Dissolve` job per stack id and hands each to
    /// the drain worker, returning the assigned job ids in the same order
    /// as `stack_ids`. `read_only` is checked by the caller (`commands.rs`)
    /// before this is reached - same split as `EditQueue::enqueue`/
    /// `update_asset_metadata`.
    pub fn enqueue_dissolve(&self, cfg: &LibraryConfig, stack_ids: Vec<String>) -> Result<Vec<u64>, String> {
        let mut ids = Vec::with_capacity(stack_ids.len());
        let mut board = self.board.lock().unwrap();
        for stack_id in stack_ids {
            let job_id = self.next_id.fetch_add(1, Ordering::Relaxed);
            board.push_back(StackJob {
                job_id,
                kind: StackJobKind::Dissolve { stack_id: stack_id.clone() },
                status: JobStatus::Pending,
                created_at_ms: now_ms(),
                finished_at_ms: None,
                error: None,
                result_member_ids: None,
                result_stack_id: None,
                result_primary_asset_id: None,
            });
            // Ignoring the send error: it can only mean the worker's
            // receiver was dropped, i.e. the app is shutting down - see
            // EditQueue::enqueue's identical comment.
            let _ = self.tx.send(QueuedStackWork::Dissolve { job_id, stack_id, cfg: cfg.clone() });
            ids.push(job_id);
        }
        Ok(ids)
    }

    /// Pushes one `Pending` `Create` job per requested id list (first id of
    /// each = pick, matching `create_stack`'s existing convention).
    pub fn enqueue_create(&self, cfg: &LibraryConfig, requests: Vec<Vec<String>>) -> Result<Vec<u64>, String> {
        let mut ids = Vec::with_capacity(requests.len());
        let mut board = self.board.lock().unwrap();
        for asset_ids in requests {
            let job_id = self.next_id.fetch_add(1, Ordering::Relaxed);
            board.push_back(StackJob {
                job_id,
                kind: StackJobKind::Create { asset_ids: asset_ids.clone() },
                status: JobStatus::Pending,
                created_at_ms: now_ms(),
                finished_at_ms: None,
                error: None,
                result_member_ids: None,
                result_stack_id: None,
                result_primary_asset_id: None,
            });
            let _ = self.tx.send(QueuedStackWork::Create { job_id, asset_ids, cfg: cfg.clone() });
            ids.push(job_id);
        }
        Ok(ids)
    }

    pub fn snapshot(&self) -> Vec<StackJob> {
        self.board.lock().unwrap().iter().cloned().collect()
    }

    pub fn pending_count(&self) -> usize {
        self.board
            .lock()
            .unwrap()
            .iter()
            .filter(|j| matches!(j.status, JobStatus::Pending | JobStatus::Working))
            .count()
    }

    /// The panel's "Clear Completed" action - drops every `Done`/`Failed`
    /// entry, leaving anything still in flight untouched.
    pub fn clear_completed(&self) {
        let mut board = self.board.lock().unwrap();
        board.retain(|j| matches!(j.status, JobStatus::Pending | JobStatus::Working));
    }

    fn set_status(&self, job_id: u64, status: JobStatus) {
        let mut board = self.board.lock().unwrap();
        if let Some(job) = board.iter_mut().find(|j| j.job_id == job_id) {
            job.status = status;
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn finish(
        &self,
        job_id: u64,
        status: JobStatus,
        error: Option<String>,
        result_member_ids: Option<Vec<String>>,
        result_stack_id: Option<String>,
        result_primary_asset_id: Option<String>,
    ) {
        let mut board = self.board.lock().unwrap();
        if let Some(job) = board.iter_mut().find(|j| j.job_id == job_id) {
            job.status = status;
            job.finished_at_ms = Some(now_ms());
            job.error = error;
            job.result_member_ids = result_member_ids;
            job.result_stack_id = result_stack_id;
            job.result_primary_asset_id = result_primary_asset_id;
        }
        trim_completed(&mut board);
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Evicts the oldest `Done`/`Failed` entries once their count exceeds
/// `MAX_COMPLETED_HISTORY` - identical shape to `edit_queue::trim_completed`.
fn trim_completed(board: &mut VecDeque<StackJob>) {
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

/// The drain worker - spawned once from `lib.rs`'s `.setup()`. Pulls queued
/// work and spawns each job onto its own task, gated by a shared
/// `Semaphore(MAX_CONCURRENT_JOBS)` so at most that many stack calls run at
/// once regardless of how many were enqueued in one burst.
pub async fn run(app: AppHandle, mut rx: mpsc::UnboundedReceiver<QueuedStackWork>) {
    let (http, queue, auto_resolution) = {
        let state = app.state::<AppState>();
        (state.http.clone(), state.stack_queue.clone(), state.auto_resolution.clone())
    };

    let semaphore = Arc::new(Semaphore::new(MAX_CONCURRENT_JOBS));

    while let Some(work) = rx.recv().await {
        let semaphore = semaphore.clone();
        let http = http.clone();
        let queue = queue.clone();
        let auto_resolution = auto_resolution.clone();

        tauri::async_runtime::spawn(async move {
            let _permit = semaphore.acquire_owned().await;

            match work {
                QueuedStackWork::Dissolve { job_id, stack_id, cfg } => {
                    queue.set_status(job_id, JobStatus::Working);
                    let Ok(client) = ImmichClient::from_config(&cfg, http, &auto_resolution).await else {
                        queue.finish(job_id, JobStatus::Failed, Some("Could not reach Immich".into()), None, None, None);
                        return;
                    };
                    // Any get_stack failure (not just a 404) means the stack
                    // is already gone server-side under a prior mutation
                    // this queue never heard about - same tolerance the old
                    // frontend loop had. Skip the delete entirely; the
                    // caller falls back to its own stackByAssetId cache for
                    // a member list, since this job has none to report.
                    let Ok(stack) = client.get_stack(&stack_id).await else {
                        queue.finish(job_id, JobStatus::Done, None, None, None, None);
                        return;
                    };
                    if stack.assets.len() as u32 > cfg.max_writes_per_batch {
                        let msg = format!(
                            "This would unstack {} assets at once, over your cap of {} per action",
                            stack.assets.len(),
                            cfg.max_writes_per_batch
                        );
                        queue.finish(job_id, JobStatus::Failed, Some(msg), None, None, None);
                        return;
                    }
                    let member_ids: Vec<String> = stack.assets.iter().map(|a| a.id.clone()).collect();
                    match client.delete_stack(&stack_id).await {
                        Ok(()) => queue.finish(job_id, JobStatus::Done, None, Some(member_ids), None, None),
                        Err(e) => queue.finish(job_id, JobStatus::Failed, Some(e), None, None, None),
                    }
                }
                QueuedStackWork::Create { job_id, asset_ids, cfg } => {
                    queue.set_status(job_id, JobStatus::Working);
                    if asset_ids.len() as u32 > cfg.max_writes_per_batch {
                        let msg = format!(
                            "This would stack {} assets at once, over your cap of {} per action",
                            asset_ids.len(),
                            cfg.max_writes_per_batch
                        );
                        queue.finish(job_id, JobStatus::Failed, Some(msg), None, None, None);
                        return;
                    }
                    let Ok(client) = ImmichClient::from_config(&cfg, http, &auto_resolution).await else {
                        queue.finish(job_id, JobStatus::Failed, Some("Could not reach Immich".into()), None, None, None);
                        return;
                    };
                    match client.create_stack(&asset_ids).await {
                        Ok(stack) => queue.finish(
                            job_id,
                            JobStatus::Done,
                            None,
                            None,
                            Some(stack.id),
                            Some(stack.primary_asset_id),
                        ),
                        Err(e) => queue.finish(job_id, JobStatus::Failed, Some(e), None, None, None),
                    }
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Regression test for a real bug: the enum-level `rename_all` on
    // StackJobKind only renames the tag values, not the fields inside each
    // variant - without the per-variant `rename_all` also present, this
    // serialized as snake_case (`asset_ids`) while the TS side expected
    // camelCase (`assetIds`), leaving `job.kind.assetIds` `undefined` and
    // crashing ActivityPanel the first time it rendered a Create job row.
    #[test]
    fn stack_job_kind_serializes_camel_case() {
        let dissolve = StackJobKind::Dissolve { stack_id: "s1".into() };
        let json = serde_json::to_value(&dissolve).unwrap();
        assert_eq!(json, serde_json::json!({ "kind": "dissolve", "stackId": "s1" }));

        let create = StackJobKind::Create { asset_ids: vec!["a1".into(), "a2".into()] };
        let json = serde_json::to_value(&create).unwrap();
        assert_eq!(json, serde_json::json!({ "kind": "create", "assetIds": ["a1", "a2"] }));
    }
}
