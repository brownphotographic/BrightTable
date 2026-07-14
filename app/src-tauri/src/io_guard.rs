//! Shared, cross-platform signal that lets any part of the app pause
//! *starting* new blocking filesystem I/O (NFS-backed sidecar/thumbnail
//! reads and writes) and track how many such calls are currently running.
//!
//! On Linux this is driven by `suspend_guard` (systemd-logind's sleep
//! inhibitor) so ImmAture can stop starting new NFS-touching work right
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

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Notify;

pub struct IoGuard {
    paused: AtomicBool,
    inflight: AtomicUsize,
    drained: Notify,
}

impl IoGuard {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            paused: AtomicBool::new(false),
            inflight: AtomicUsize::new(0),
            drained: Notify::new(),
        })
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
