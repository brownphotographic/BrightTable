use crate::config::AppConfig;
use crate::edit_queue::EditQueue;
use crate::import::ImportQueue;
use crate::io_guard::IoGuard;
use std::sync::{Arc, Mutex};

pub struct AppState {
    pub config: Mutex<AppConfig>,
    /// Shared, connection-pooling HTTP client. Reused across every request
    /// (including per-thumbnail fetches) instead of paying a fresh TCP/TLS
    /// handshake per call - this is what makes the Photos grid load fast.
    pub http: reqwest::Client,
    /// Lets `suspend_guard` (Linux only) pause new NFS-touching blocking
    /// I/O around a system suspend. Inert everywhere else - see
    /// `io_guard.rs`.
    pub io_guard: Arc<IoGuard>,
    /// Background rating/favorite/description edit queue - see
    /// `edit_queue.rs`. Its drain worker is spawned once, separately, from
    /// `lib.rs`'s `.setup()`.
    pub edit_queue: Arc<EditQueue>,
    /// Background SD-card/disk import copy queue - see
    /// `import/queue.rs`. Same "spawned once from `.setup()`" pattern as
    /// `edit_queue`.
    pub import_queue: Arc<ImportQueue>,
}

impl AppState {
    pub fn new(config: AppConfig, edit_queue: Arc<EditQueue>, import_queue: Arc<ImportQueue>) -> Self {
        Self {
            config: Mutex::new(config),
            http: reqwest::Client::new(),
            io_guard: IoGuard::new(),
            edit_queue,
            import_queue,
        }
    }

    pub fn library_config(&self) -> crate::config::LibraryConfig {
        self.config.lock().unwrap().library.clone()
    }
}
