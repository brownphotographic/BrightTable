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

//! Shared, cross-platform signal that lets any part of the app pause
//! *starting* new blocking filesystem I/O (NFS-backed sidecar/thumbnail
//! reads and writes) and track how many such calls are currently running.
//!
//! On Linux this is driven by `suspend_guard` (systemd-logind's sleep
//! inhibitor) so BrightTable can stop starting new NFS-touching work right
//! before a suspend and give in-flight work a bounded chance to finish. On
//! every other platform nothing ever calls `set_paused(true)`, so this is a
//! permanently-inert no-op there - this file itself has no
//! platform-specific code, which is what keeps `commands.rs`/`protocol.rs`
//! free of their own `#[cfg]` blocks.
//!
//! IMPORTANT: this can only stop *new* blocking calls from starting. It
//! cannot rescue a thread already blocked inside the kernel in NFS `D`
//! state - see `suspend_guard.rs` and the `system-sleep` force-unmount hook
//! (requirements.md 7.19) for the mechanism that actually guarantees
//! suspend isn't stuck forever.
//!
//! Also owns a separate, smaller cap: `metadata_scan_semaphore` bounds how
//! many `commands::check_sidecar_metadata` calls run at once. That command
//! is fired once per timeline bucket/folder as it loads, with no queue of
//! its own (unlike `edit_queue`/`import_queue`/`art_queue`, which all
//! already bound their own concurrency) - confirmed live that scrolling
//! across a large, decades-spanning library fired enough of these
//! concurrently to leave ~85 OS threads simultaneously blocked in the
//! kernel on the NFS mount (`rpc_wait_bit_killable`/`d_alloc_parallel`),
//! degrading that mount's latency for minutes at a time for every other
//! caller, BrightTable or not. Unlike `paused`/`inflight` above, this is a
//! real admission-control cap, not just a suspend-time signal.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore};

/// Default and allowed range for `LibraryConfig::max_concurrent_metadata_scans` -
/// clamped to this range wherever the configured value is used, so a
/// corrupted/hand-edited config.json can't set an unreasonable value. Higher
/// than the other queues' hardcoded `4` (`edit_queue`/`processing_queue`) is
/// fine as a default since each unit of work here is a stat plus a small
/// embedded-metadata read, not a full-resolution image decode or copy.
pub const DEFAULT_MAX_CONCURRENT_METADATA_SCANS: usize = 4;
pub const MIN_CONCURRENT_METADATA_SCANS: usize = 1;
pub const MAX_CONCURRENT_METADATA_SCANS_LIMIT: usize = 16;

/// Fixed (not user-configurable) size of the separate "interactive" lane -
/// see `acquire_interactive_metadata_scan_permit`. Small on purpose: this
/// exists to skip a queueing delay, not to add more concurrent NFS load on
/// top of the bulk lane's already-tuned cap.
pub const INTERACTIVE_METADATA_SCAN_PERMITS: usize = 2;

pub struct IoGuard {
    paused: AtomicBool,
    inflight: AtomicUsize,
    drained: Notify,
    metadata_scan_semaphore: Arc<Semaphore>,
    interactive_metadata_scan_semaphore: Arc<Semaphore>,
}

impl IoGuard {
    pub fn new(max_concurrent_metadata_scans: usize) -> Arc<Self> {
        let max_scans = max_concurrent_metadata_scans
            .clamp(MIN_CONCURRENT_METADATA_SCANS, MAX_CONCURRENT_METADATA_SCANS_LIMIT);
        Arc::new(Self {
            paused: AtomicBool::new(false),
            inflight: AtomicUsize::new(0),
            drained: Notify::new(),
            metadata_scan_semaphore: Arc::new(Semaphore::new(max_scans)),
            interactive_metadata_scan_semaphore: Arc::new(Semaphore::new(INTERACTIVE_METADATA_SCAN_PERMITS)),
        })
    }

    /// Blocks until a `check_sidecar_metadata` concurrency slot is free -
    /// same "shared bounded `Semaphore`" pattern as `ArtQueue::acquire_permit`.
    /// This is the bulk lane: the per-bucket/folder prefetch scan fired as
    /// each one loads (see `commands::check_sidecar_metadata`'s own doc
    /// comment) queues here with no priority over any other caller.
    pub async fn acquire_metadata_scan_permit(&self) -> OwnedSemaphorePermit {
        self.metadata_scan_semaphore.clone().acquire_owned().await.expect("IoGuard's metadata scan semaphore is never closed")
    }

    /// A second, separate, small permit pool for a single-asset check tied
    /// directly to what the user is doing right now - right-clicking/
    /// selecting a photo (each page's "recheck effect"), or clicking Copy
    /// Image Processing itself. Kept apart from `metadata_scan_semaphore`
    /// above so that request doesn't have to wait in line behind however
    /// many ambient bucket-prefetch scans got queued while scrolling a large
    /// library first. Confirmed live: browsing a 91k-asset library can queue
    /// far more bulk-lane requests than its 4-slot cap drains quickly, so a
    /// right-click on a tiny, currently-visible folder minutes later was
    /// still stuck behind that entire backlog. This doesn't raise the total
    /// number of concurrent NFS-touching scans much (2 more, hard-capped,
    /// not user-configurable) - it only stops BrightTable's own queue
    /// ordering from being the reason an on-screen interaction stalls.
    pub async fn acquire_interactive_metadata_scan_permit(&self) -> OwnedSemaphorePermit {
        self.interactive_metadata_scan_semaphore
            .clone()
            .acquire_owned()
            .await
            .expect("IoGuard's interactive metadata scan semaphore is never closed")
    }

    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::Relaxed)
    }

    pub fn set_paused(&self, paused: bool) {
        self.paused.store(paused, Ordering::Relaxed);
    }

    fn begin(self: &Arc<Self>) -> IoGuardTicket {
        self.inflight.fetch_add(1, Ordering::Relaxed);
        IoGuardTicket(self.clone())
    }

    /// Waits until `inflight` reaches zero or `timeout` elapses, whichever
    /// is first. Uses the register-then-recheck pattern so a drain that
    /// completes between the check and the wait is never missed.
    pub async fn wait_drained(&self, timeout: Duration) {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            if self.inflight.load(Ordering::Relaxed) == 0 {
                return;
            }
            let notified = self.drained.notified();
            if self.inflight.load(Ordering::Relaxed) == 0 {
                return;
            }
            tokio::select! {
                _ = notified => {}
                _ = tokio::time::sleep_until(deadline) => return,
            }
        }
    }
}

struct IoGuardTicket(Arc<IoGuard>);

impl Drop for IoGuardTicket {
    fn drop(&mut self) {
        if self.0.inflight.fetch_sub(1, Ordering::Relaxed) == 1 {
            self.0.drained.notify_waiters();
        }
    }
}

/// Same as a bare `tokio::task::spawn_blocking`, except it returns `None`
/// instead of starting `f` at all while I/O is paused (imminent suspend on
/// Linux; always `false` elsewhere), and it counts as in-flight for the
/// entire duration of `f` itself - not just until the caller awaits the
/// returned `JoinHandle` - so fire-and-forget callers that never await the
/// handle are still tracked correctly.
pub fn guarded_spawn_blocking<F, T>(
    guard: &Arc<IoGuard>,
    f: F,
) -> Option<tokio::task::JoinHandle<T>>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    if guard.is_paused() {
        return None;
    }
    let ticket = guard.begin();
    Some(tokio::task::spawn_blocking(move || {
        let result = f();
        drop(ticket);
        result
    }))
}
