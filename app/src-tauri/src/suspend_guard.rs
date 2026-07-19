//! Linux-only: cooperates with systemd-logind's suspend flow via the
//! "sleep" delay inhibitor + `PrepareForSleep` signal (the same idiom
//! NetworkManager and gnome-keyring use) so ImmAture gets a few seconds'
//! warning before the machine actually suspends. During that window it
//! stops *starting* new `spawn_blocking` calls that touch the
//! (possibly-NFS-backed) originals/sidecar mount, via `io_guard::IoGuard`,
//! and gives already in-flight ones a bounded chance to finish before
//! releasing the inhibitor.
//!
//! This is a *complementary* mitigation, not the fix. It narrows the window
//! in which a filesystem call can get caught mid-flight when the NFS
//! server drops out during/after suspend, but it cannot rescue a thread
//! already blocked inside the kernel in `D` state by the time this signal
//! fires - nothing in userspace can. The actual guarantee against a hung
//! suspend is the systemd-sleep `pre` hook
//! (`/etc/systemd/system-sleep/immature-nfs-unmount`), which force-unmounts
//! the `hard` NFS mount before suspend, actively aborting any in-flight RPC
//! so the blocked thread returns an error and `freeze_processes()` can
//! complete. See requirements.md 7.19.

use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use zbus::zvariant::OwnedFd;
use zbus::Connection;

use crate::io_guard::IoGuard;

/// Comfortably under logind's default `InhibitDelayMaxSec` of 5s.
const DRAIN_TIMEOUT: Duration = Duration::from_secs(3);

#[zbus::proxy(
    default_service = "org.freedesktop.login1",
    default_path = "/org/freedesktop/login1",
    interface = "org.freedesktop.login1.Manager"
)]
trait LoginManager {
    fn inhibit(&self, what: &str, who: &str, why: &str, mode: &str) -> zbus::Result<OwnedFd>;

    #[zbus(signal)]
    fn prepare_for_sleep(&self, start: bool) -> zbus::Result<()>;
}

/// The part of the sleep/wake reaction that doesn't depend on D-Bus at all
/// - pausing/resuming the shared `IoGuard` and (on pause) waiting for
/// in-flight I/O to drain. Split out from `run` so it's unit-testable
/// without a live logind connection (see the `tests` module below; a real
/// `PrepareForSleep` signal can't be simulated from userspace - it's a
/// sender-filtered signal, not a callable method, confirmed while
/// designing this).
async fn on_prepare_for_sleep(start: bool, guard: &IoGuard) {
    if start {
        log::info!("suspend_guard: suspend imminent, pausing new sidecar/thumbnail I/O");
        guard.set_paused(true);
        guard.wait_drained(DRAIN_TIMEOUT).await;
    } else {
        log::info!("suspend_guard: resumed, resuming sidecar/thumbnail I/O");
        guard.set_paused(false);
    }
}

pub async fn run(guard: Arc<IoGuard>) {
    let Ok(connection) = Connection::system().await else {
        log::warn!("suspend_guard: no system D-Bus, suspend-safety inhibitor disabled");
        return;
    };
    let Ok(proxy) = LoginManagerProxy::new(&connection).await else {
        log::warn!("suspend_guard: logind not reachable, suspend-safety inhibitor disabled");
        return;
    };
    let Ok(mut signals) = proxy.receive_prepare_for_sleep().await else {
        log::warn!("suspend_guard: failed to subscribe to PrepareForSleep");
        return;
    };

    let mut inhibitor = acquire_inhibitor(&proxy).await;

    while let Some(signal) = signals.next().await {
        let Ok(args) = signal.args() else { continue };
        let start = *args.start();
        on_prepare_for_sleep(start, &guard).await;
        if start {
            inhibitor = None; // drop the fd -> releases the delay lock, suspend proceeds
        } else {
            inhibitor = acquire_inhibitor(&proxy).await; // re-arm for the next cycle
        }
    }
    let _ = inhibitor; // keep alive until here
}

async fn acquire_inhibitor(proxy: &LoginManagerProxy<'_>) -> Option<OwnedFd> {
    match proxy
        .inhibit(
            "sleep",
            "ImmAture",
            "Finish in-flight sidecar/thumbnail I/O before suspend",
            "delay",
        )
        .await
    {
        Ok(fd) => Some(fd),
        Err(e) => {
            log::warn!("suspend_guard: failed to acquire sleep inhibitor: {e}");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::io_guard::guarded_spawn_blocking;
    use std::time::Duration as StdDuration;

    #[tokio::test]
    async fn pause_sets_flag() {
        let guard = IoGuard::new(crate::io_guard::DEFAULT_MAX_CONCURRENT_METADATA_SCANS);
        assert!(!guard.is_paused());
        on_prepare_for_sleep(true, &guard).await;
        assert!(guard.is_paused());
    }

    #[tokio::test]
    async fn resume_clears_flag() {
        let guard = IoGuard::new(crate::io_guard::DEFAULT_MAX_CONCURRENT_METADATA_SCANS);
        guard.set_paused(true);
        on_prepare_for_sleep(false, &guard).await;
        assert!(!guard.is_paused());
    }

    #[tokio::test]
    async fn pause_waits_for_inflight_work_to_drain() {
        let guard = IoGuard::new(crate::io_guard::DEFAULT_MAX_CONCURRENT_METADATA_SCANS);
        let handle = guarded_spawn_blocking(&guard, || {
            std::thread::sleep(StdDuration::from_millis(50));
        })
        .expect("not paused yet, should start");

        on_prepare_for_sleep(true, &guard).await;

        // wait_drained returned - the in-flight ticket must already be gone.
        assert!(handle.is_finished());
        handle.await.unwrap();
    }

    #[tokio::test]
    async fn paused_guard_refuses_new_work() {
        let guard = IoGuard::new(crate::io_guard::DEFAULT_MAX_CONCURRENT_METADATA_SCANS);
        on_prepare_for_sleep(true, &guard).await;
        assert!(guarded_spawn_blocking(&guard, || 1).is_none());
    }
}
