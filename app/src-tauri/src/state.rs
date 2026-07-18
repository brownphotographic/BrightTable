use crate::art_queue::ArtQueue;
use crate::config::AppConfig;
use crate::edit_queue::EditQueue;
use crate::import::ImportQueue;
use crate::io_guard::IoGuard;
use crate::processing_queue::ProcessingQueue;
use crate::round_trip::RoundTripWatcher;
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
    /// Watches a round-trip asset's folder for the editor's output file -
    /// see `round_trip.rs`. Registered from `commands::launch_editor`; its
    /// background task is spawned once from `lib.rs`'s `.setup()`, same
    /// pattern as `edit_queue`/`import_queue`. Never touched by the ART CLI
    /// round trip - both its variants know their export filename
    /// synchronously, so they have no need to register with this watcher.
    pub round_trip: Arc<RoundTripWatcher>,
    /// Background Paste Image Processing sidecar-copy queue - see
    /// `processing_queue.rs`. Same "spawned once from `.setup()`" pattern as
    /// `edit_queue`/`import_queue`.
    pub processing_queue: Arc<ProcessingQueue>,
    /// Background Headless RAW Roundtrip queue (ART CLI round trip Variant 2) -
    /// see `art_queue.rs`. Same "spawned once from `.setup()`" pattern as
    /// the other background queues.
    pub art_queue: Arc<ArtQueue>,
}

impl AppState {
    pub fn new(
        config: AppConfig,
        edit_queue: Arc<EditQueue>,
        import_queue: Arc<ImportQueue>,
        round_trip: Arc<RoundTripWatcher>,
        processing_queue: Arc<ProcessingQueue>,
        art_queue: Arc<ArtQueue>,
    ) -> Self {
        Self {
            config: Mutex::new(config),
            http: reqwest::Client::new(),
            io_guard: IoGuard::new(),
            edit_queue,
            import_queue,
            round_trip,
            processing_queue,
            art_queue,
        }
    }

    pub fn library_config(&self) -> crate::config::LibraryConfig {
        self.config.lock().unwrap().library.clone()
    }
}
