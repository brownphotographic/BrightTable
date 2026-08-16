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

//! Watches the folder an asset was sent to an external RAW/photo editor from,
//! for a round-trip output file showing up next to it - e.g. sending
//! "20260712_17-32-14-1.DNG" out and the editor later saving
//! "20260712_17-32-14-1_converted.JPG" back into the same folder. Registered
//! from `commands::launch_editor` right after the editor is spawned.
//!
//! Deliberately dumb, same "Rust = transport, TS = business logic" split as
//! the rest of this app (see `smartStack.ts` owning all stack-grouping
//! logic while Rust only proxies raw `/stacks` calls): this module only
//! detects that *some* new file settled into a watched folder and reports it
//! - it has no idea whether that file's name actually matches the user's
//! Smart Stack version-string pattern. That match, plus the whole Immich
//! scan/poll/create-stack sequence, happens entirely on the frontend once it
//! receives the "round-trip-file-detected" event this module emits, reusing
//! commands (`scan_immich_library`, `get_folder_assets`, `create_stack`) that
//! already exist for other reasons.
//!
//! Built on `notify-debouncer-mini` rather than raw `notify`: an editor
//! writing a file produces a burst of Create/Modify events, not one - the
//! debouncer coalesces those into a single event once the burst goes quiet
//! for `DEBOUNCE_TIMEOUT`, which is what "settled" means here.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, DebouncedEventKind, Debouncer};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

/// How long a watched path must go quiet before it's treated as "done being
/// written" - see the module doc comment. Long enough to ride out a burst of
/// Create+Modify events from one save, short enough that "immediately show
/// it in the timeline" still feels immediate.
const DEBOUNCE_TIMEOUT: Duration = Duration::from_secs(2);

/// A registered watch that's never matched anything is dropped after this
/// long, and its folder unwatched if nothing else references it - bounds
/// resource use for an editor session the user never brings a result back
/// from (or cancels out of).
const PENDING_MAX_AGE: Duration = Duration::from_secs(3 * 60 * 60);

/// How often the background task sweeps for expired pending entries.
const SWEEP_INTERVAL: Duration = Duration::from_secs(10 * 60);

/// Extensions/patterns that are never a real round-trip *output* - sidecar
/// writes (`.xmp`/`.pp3`/`.arp`), and common editor/OS temp-file leftovers
/// that can transiently appear in the same folder mid-save. Filtered out
/// before ever bothering the frontend with them.
const JUNK_EXTENSIONS: &[&str] = &["xmp", "pp3", "arp", "tmp", "part", "crdownload", "swp"];

struct PendingEntry {
    original_asset_id: String,
    original_file_name: String,
    /// Immich-side (not local) parent folder of the original asset's
    /// `original_path` - computed once at registration time so the
    /// background task never needs its own local->Immich path-inversion
    /// logic (see `paths::resolve_local_path` for the forward direction).
    original_immich_folder: String,
    local_path: PathBuf,
    registered_at: Instant,
}

pub struct RoundTripWatcher {
    /// `None` if the platform watcher backend failed to initialize (rare -
    /// e.g. an exhausted inotify instance limit) - `register` then just
    /// reports that watching isn't available rather than the whole app
    /// failing to start, since this feature is advisory only.
    debouncer: Mutex<Option<Debouncer<RecommendedWatcher>>>,
    pending: Mutex<HashMap<PathBuf, Vec<PendingEntry>>>,
}

impl RoundTripWatcher {
    pub fn new() -> (Arc<Self>, mpsc::UnboundedReceiver<Vec<PathBuf>>) {
        let (tx, rx) = mpsc::unbounded_channel::<Vec<PathBuf>>();
        // Runs on notify's own background thread, not the async runtime -
        // `send` on an unbounded channel is non-blocking, same bridge
        // pattern `import::queue`/`edit_queue` use from their own sync
        // contexts.
        let debouncer = new_debouncer(DEBOUNCE_TIMEOUT, move |res: DebounceEventResult| {
            let Ok(events) = res else { return };
            let settled: Vec<PathBuf> = events
                .into_iter()
                .filter(|e| e.kind == DebouncedEventKind::Any)
                .map(|e| e.path)
                .collect();
            if !settled.is_empty() {
                let _ = tx.send(settled);
            }
        });
        let debouncer = match debouncer {
            Ok(d) => Some(d),
            Err(e) => {
                log::warn!("Round-trip file watcher unavailable: {e}");
                None
            }
        };
        (
            Arc::new(Self {
                debouncer: Mutex::new(debouncer),
                pending: Mutex::new(HashMap::new()),
            }),
            rx,
        )
    }

    /// Registers `local_path`'s containing folder to be watched for a
    /// round-trip output next to it. Replaces any existing pending entry for
    /// the same `original_asset_id` (re-launching the editor on the same
    /// asset shouldn't accumulate stale entries). Errors here are always
    /// advisory - see `commands::launch_editor`, which never fails the
    /// launch itself over this.
    pub fn register(
        &self,
        original_asset_id: String,
        original_file_name: String,
        original_path: &str,
        local_path: &Path,
    ) -> Result<(), String> {
        let folder = local_path
            .parent()
            .ok_or_else(|| format!("{} has no parent directory", local_path.display()))?
            .to_path_buf();
        let original_immich_folder = match original_path.rfind('/') {
            Some(i) => original_path[..i].to_string(),
            None => String::new(),
        };

        let mut pending = self.pending.lock().unwrap();
        if !pending.contains_key(&folder) {
            let mut debouncer = self.debouncer.lock().unwrap();
            let Some(debouncer) = debouncer.as_mut() else {
                return Err("Round-trip file watching isn't available on this system".into());
            };
            debouncer
                .watcher()
                .watch(&folder, RecursiveMode::NonRecursive)
                .map_err(|e| format!("Couldn't watch {}: {e}", folder.display()))?;
        }
        let entries = pending.entry(folder).or_default();
        entries.retain(|e| e.original_asset_id != original_asset_id);
        entries.push(PendingEntry {
            original_asset_id,
            original_file_name,
            original_immich_folder,
            local_path: local_path.to_path_buf(),
            registered_at: Instant::now(),
        });
        Ok(())
    }

    fn sweep_expired(&self) {
        self.sweep_expired_at(Instant::now());
    }

    /// Split out from `sweep_expired` so tests can exercise real expiry
    /// without needing to wait real wall-clock hours - `Instant` arithmetic
    /// (`registered_at + PENDING_MAX_AGE`) doesn't require any time to
    /// actually pass.
    fn sweep_expired_at(&self, now: Instant) {
        let mut pending = self.pending.lock().unwrap();
        let mut emptied_folders = Vec::new();
        pending.retain(|folder, entries| {
            entries.retain(|e| now.duration_since(e.registered_at) < PENDING_MAX_AGE);
            if entries.is_empty() {
                emptied_folders.push(folder.clone());
                false
            } else {
                true
            }
        });
        drop(pending);
        if emptied_folders.is_empty() {
            return;
        }
        let mut debouncer = self.debouncer.lock().unwrap();
        if let Some(debouncer) = debouncer.as_mut() {
            for folder in emptied_folders {
                let _ = debouncer.watcher().unwatch(&folder);
            }
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RoundTripCandidate {
    original_asset_id: String,
    original_file_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RoundTripFileDetected {
    candidates: Vec<RoundTripCandidate>,
    new_file_name: String,
    folder_immich_path: String,
}

/// Never a genuine round-trip output - see `JUNK_EXTENSIONS`'s doc comment.
/// Dotfiles are excluded too (many editors/tools stage a hidden temp file
/// before the real save).
fn is_junk_path(path: &Path) -> bool {
    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
        if name.starts_with('.') {
            return true;
        }
    }
    match path.extension().and_then(|e| e.to_str()) {
        Some(ext) => JUNK_EXTENSIONS.iter().any(|j| j.eq_ignore_ascii_case(ext)),
        None => false,
    }
}

/// The background task - spawned once from `lib.rs`'s `.setup()`, same
/// pattern as `edit_queue::run`/`import::queue::run`. Also runs the periodic
/// expiry sweep on its own timer rather than a second spawned task, since
/// there's nothing else this task needs to do between settled-file batches.
pub async fn run(app: AppHandle, watcher: Arc<RoundTripWatcher>, mut rx: mpsc::UnboundedReceiver<Vec<PathBuf>>) {
    let mut sweep = tokio::time::interval(SWEEP_INTERVAL);
    sweep.tick().await; // first tick fires immediately - skip it, nothing to sweep yet

    loop {
        tokio::select! {
            batch = rx.recv() => {
                let Some(paths) = batch else { break };
                for path in &paths {
                    handle_settled_path(&app, &watcher, path);
                }
            }
            _ = sweep.tick() => {
                watcher.sweep_expired();
            }
        }
    }
}

fn handle_settled_path(app: &AppHandle, watcher: &RoundTripWatcher, path: &Path) {
    if is_junk_path(path) || !path.is_file() {
        return;
    }
    let Some(folder) = path.parent() else { return };
    let Some(new_file_name) = path.file_name().and_then(|n| n.to_str()) else { return };

    let pending = watcher.pending.lock().unwrap();
    let Some(entries) = pending.get(folder) else { return };
    // Every entry for a given (local) folder shares the same Immich-side
    // folder, since the local<->Immich mapping is a fixed prefix
    // substitution (see `paths::resolve_local_path`) - safe to read it off
    // any one entry.
    let Some(folder_immich_path) = entries.first().map(|e| e.original_immich_folder.clone()) else {
        return;
    };
    let candidates: Vec<RoundTripCandidate> = entries
        .iter()
        .filter(|e| e.local_path.as_path() != path)
        .map(|e| RoundTripCandidate {
            original_asset_id: e.original_asset_id.clone(),
            original_file_name: e.original_file_name.clone(),
        })
        .collect();
    drop(pending);

    if candidates.is_empty() {
        return;
    }

    let _ = app.emit(
        "round-trip-file-detected",
        RoundTripFileDetected { candidates, new_file_name: new_file_name.to_string(), folder_immich_path },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("brighttable-test-roundtrip-{label}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn junk_extensions_and_dotfiles_are_filtered() {
        assert!(is_junk_path(Path::new("/x/IMG_1.xmp")));
        assert!(is_junk_path(Path::new("/x/IMG_1.CR2.pp3")));
        assert!(is_junk_path(Path::new("/x/.IMG_1_converted.jpg")));
        assert!(is_junk_path(Path::new("/x/download.crdownload")));
        assert!(!is_junk_path(Path::new("/x/IMG_1_converted.JPG")));
        assert!(!is_junk_path(Path::new("/x/IMG_1.dng")));
    }

    #[test]
    fn register_replaces_existing_entry_for_the_same_asset_but_keeps_others() {
        let dir = tmp_dir("register");
        let (watcher, _rx) = RoundTripWatcher::new();

        watcher
            .register("asset-1".into(), "IMG_1.DNG".into(), "library/2026/06/IMG_1.DNG", &dir.join("IMG_1.DNG"))
            .unwrap();
        watcher
            .register("asset-2".into(), "IMG_2.DNG".into(), "library/2026/06/IMG_2.DNG", &dir.join("IMG_2.DNG"))
            .unwrap();
        // Re-registering asset-1 (e.g. the user re-launched the editor on it)
        // must replace, not duplicate.
        watcher
            .register("asset-1".into(), "IMG_1.DNG".into(), "library/2026/06/IMG_1.DNG", &dir.join("IMG_1.DNG"))
            .unwrap();

        let pending = watcher.pending.lock().unwrap();
        let entries = pending.get(&dir).expect("folder should be registered");
        assert_eq!(entries.len(), 2, "expected asset-1 (replaced once) and asset-2, not a duplicate");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sweep_expired_drops_only_stale_entries_and_unwatches_emptied_folders() {
        let dir = tmp_dir("sweep");
        let (watcher, _rx) = RoundTripWatcher::new();
        watcher
            .register("asset-old".into(), "IMG_OLD.DNG".into(), "library/2026/06/IMG_OLD.DNG", &dir.join("IMG_OLD.DNG"))
            .unwrap();

        let long_after = Instant::now() + PENDING_MAX_AGE + Duration::from_secs(1);
        watcher.sweep_expired_at(long_after);

        assert!(watcher.pending.lock().unwrap().is_empty(), "expired entry (and its now-empty folder) should be gone");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sweep_expired_at_keeps_fresh_entries() {
        let dir = tmp_dir("sweep-fresh");
        let (watcher, _rx) = RoundTripWatcher::new();
        watcher
            .register("asset-fresh".into(), "IMG_FRESH.DNG".into(), "library/2026/06/IMG_FRESH.DNG", &dir.join("IMG_FRESH.DNG"))
            .unwrap();

        watcher.sweep_expired_at(Instant::now());

        assert_eq!(watcher.pending.lock().unwrap().get(&dir).map(|e| e.len()), Some(1));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
