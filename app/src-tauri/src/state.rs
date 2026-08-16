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

use crate::art_queue::ArtQueue;
use crate::config::{AppConfig, AutoResolution};
use crate::edit_queue::EditQueue;
use crate::export_queue::ExportQueue;
use crate::import::ImportQueue;
use crate::io_guard::IoGuard;
use crate::processing_queue::ProcessingQueue;
use crate::round_trip::RoundTripWatcher;
use crate::secure_store::SecretVault;
use std::sync::{Arc, Mutex};
use sysinfo::System;

pub struct AppState {
    pub config: Mutex<AppConfig>,
    /// The encrypted Stronghold vault backing the Immich/Flickr credential
    /// fields inside `config` - see `secure_store.rs`. Opened once here
    /// (not per `config::load`/`save` call) since each open/commit is a
    /// fixed ~1s cost in a release build (Stronghold's snapshot
    /// encryption), not something to pay repeatedly across a session.
    /// `None` if opening it failed (e.g. no writable app-local-data dir) -
    /// `config::load`/`save` both degrade to config.json-only in that case,
    /// same as before this vault existed.
    pub secret_vault: Option<SecretVault>,
    /// Shared, connection-pooling HTTP client. Reused across every request
    /// (including per-thumbnail fetches) instead of paying a fresh TCP/TLS
    /// handshake per call - this is what makes the Photos grid load fast.
    pub http: reqwest::Client,
    /// Cached outcome of the last `ConnMode::Auto` LAN-reachability probe -
    /// see `immich::resolve_connection`/`config::AutoResolution`. Shared
    /// (`Arc`) so background workers (edit/export queues, the thumbnail
    /// protocol handler) that only hold a cloned handle rather than the
    /// whole `AppState` can still read/refresh it.
    pub auto_resolution: Arc<Mutex<Option<AutoResolution>>>,
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
    /// Background Export to Folder / Export to Flickr queue - see
    /// `export_queue.rs`. Same "spawned once from `.setup()`" pattern as
    /// the other background queues.
    pub export_queue: Arc<ExportQueue>,
    /// Kept alive across polls (rather than a fresh `System` per call) so
    /// `Process::cpu_usage()` has a previous sample to diff against - see
    /// `commands::get_resource_usage`.
    pub resource_monitor: Mutex<System>,
    /// Logical CPU count, sampled once at startup - normalizes
    /// `Process::cpu_usage()` (100 = one core) down to 0-100 of total
    /// system capacity for `get_resource_usage`.
    pub num_cpus: usize,
}

impl AppState {
    pub fn new(
        config: AppConfig,
        secret_vault: Option<SecretVault>,
        edit_queue: Arc<EditQueue>,
        import_queue: Arc<ImportQueue>,
        round_trip: Arc<RoundTripWatcher>,
        processing_queue: Arc<ProcessingQueue>,
        art_queue: Arc<ArtQueue>,
        export_queue: Arc<ExportQueue>,
    ) -> Self {
        // Captured before `config` moves into the `Mutex` below - same "read
        // once at startup to size a semaphore" contract as
        // `import::queue::run`'s own `max_concurrent_jobs` parameter (see
        // `LibraryConfig::max_concurrent_metadata_scans`'s doc comment).
        let max_concurrent_metadata_scans = config.library.max_concurrent_metadata_scans;
        Self {
            config: Mutex::new(config),
            secret_vault,
            http: reqwest::Client::new(),
            auto_resolution: Arc::new(Mutex::new(None)),
            io_guard: IoGuard::new(max_concurrent_metadata_scans),
            edit_queue,
            import_queue,
            round_trip,
            processing_queue,
            art_queue,
            export_queue,
            resource_monitor: Mutex::new(System::new()),
            num_cpus: std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1),
        }
    }

    pub fn library_config(&self) -> crate::config::LibraryConfig {
        self.config.lock().unwrap().library.clone()
    }
}
