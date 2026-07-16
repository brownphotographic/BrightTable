use std::collections::HashMap;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::apps::{self, AppChoice};
use crate::config::{self, AppConfig, ApplicationsConfig, ImportSettings, LibraryConfig, SmartStackSettings};
use crate::edit_queue::EditJob;
use crate::immich::models::{AssetSummary, ConnectionStatus, StackInfo, TimeBucketInfo};
use crate::immich::ImmichClient;
use crate::import::{self, FolderDepth, ImportJob, ScannedGroup};
use crate::io_guard;
use crate::paths;
use crate::state::AppState;

#[tauri::command]
pub fn get_config(state: State<AppState>) -> AppConfig {
    state.config.lock().unwrap().clone()
}

#[tauri::command]
pub fn save_library_config(
    app: AppHandle,
    state: State<AppState>,
    cfg: LibraryConfig,
) -> Result<AppConfig, String> {
    let mut guard = state.config.lock().unwrap();
    guard.library = cfg;
    config::save(&app, &guard)?;
    Ok(guard.clone())
}

#[tauri::command]
pub fn save_shortcuts(
    app: AppHandle,
    state: State<AppState>,
    shortcuts: HashMap<String, String>,
) -> Result<AppConfig, String> {
    let mut guard = state.config.lock().unwrap();
    guard.shortcuts = shortcuts;
    config::save(&app, &guard)?;
    Ok(guard.clone())
}

#[tauri::command]
pub fn save_smart_stack_settings(
    app: AppHandle,
    state: State<AppState>,
    settings: SmartStackSettings,
) -> Result<AppConfig, String> {
    let mut guard = state.config.lock().unwrap();
    guard.smart_stack = settings;
    config::save(&app, &guard)?;
    Ok(guard.clone())
}

#[tauri::command]
pub fn set_raw_overrides(
    app: AppHandle,
    state: State<AppState>,
    asset_ids: Vec<String>,
    is_raw: bool,
) -> Result<AppConfig, String> {
    let mut guard = state.config.lock().unwrap();
    for id in asset_ids {
        if is_raw {
            guard.raw_overrides.insert(id);
        } else {
            guard.raw_overrides.remove(&id);
        }
    }
    config::save(&app, &guard)?;
    Ok(guard.clone())
}

#[tauri::command]
pub fn save_applications_config(
    app: AppHandle,
    state: State<AppState>,
    cfg: ApplicationsConfig,
) -> Result<AppConfig, String> {
    let mut guard = state.config.lock().unwrap();
    guard.applications = cfg;
    config::save(&app, &guard)?;
    Ok(guard.clone())
}

/// Best-effort scan of installed native/Flatpak/Snap apps for the app
/// picker (see `apps.rs`) - never errors, an empty list just means nothing
/// was found on this system.
#[tauri::command]
pub fn list_installed_apps() -> Vec<AppChoice> {
    apps::detect_installed_apps()
}

/// Launches the chosen editor on an asset's resolved local path. Unlike
/// every other mutating command in this file, this deliberately skips the
/// read-only/max-writes-per-batch gate: it spawns a third-party process and
/// touches no Immich data and no file itself - whatever that external app
/// later does to the file is outside ImmAture's own write path.
///
/// `original_asset_id`/`original_file_name` are only used to register a
/// round-trip watch on the asset's folder (see `round_trip.rs`) - when
/// present, once the editor saves a matching output file back into that
/// folder, the frontend can pick it up and auto-stack it without the user
/// hitting Refresh Timeline. Registration is best-effort: a failure here
/// (e.g. no watcher backend available) never fails the launch itself, since
/// the launch already succeeded and watching is purely advisory.
#[tauri::command]
pub fn launch_editor(
    state: State<AppState>,
    original_path: Option<String>,
    app_choice: AppChoice,
    original_asset_id: Option<String>,
    original_file_name: Option<String>,
) -> Result<(), String> {
    let cfg = state.library_config();
    let original_path = original_path.ok_or("This asset has no server-side path to resolve")?;
    let local_path = paths::resolve_local_path(&original_path, &cfg).ok_or(
        "No local path mapping configured for this asset — set up External Library mapping in Preferences → Library",
    )?;
    apps::launch_app(&app_choice, &local_path)?;

    if let (Some(asset_id), Some(file_name)) = (original_asset_id, original_file_name) {
        if let Err(e) = state.round_trip.register(asset_id, file_name, &original_path, &local_path) {
            log::warn!("Couldn't register round-trip watch: {e}");
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn test_connection(
    state: State<'_, AppState>,
    cfg: LibraryConfig,
) -> Result<ConnectionStatus, String> {
    let client = ImmichClient::from_config(&cfg, state.http.clone())?;
    client.test_connection().await
}

#[tauri::command]
pub async fn get_timeline_buckets(state: State<'_, AppState>) -> Result<Vec<TimeBucketInfo>, String> {
    let cfg = state.library_config();
    let client = ImmichClient::from_config(&cfg, state.http.clone())?;
    client.get_time_buckets().await
}

#[tauri::command]
pub async fn get_timeline_bucket_assets(
    state: State<'_, AppState>,
    time_bucket: String,
) -> Result<Vec<AssetSummary>, String> {
    let cfg = state.library_config();
    let client = ImmichClient::from_config(&cfg, state.http.clone())?;
    client.get_time_bucket_assets(&time_bucket).await
}

#[tauri::command]
pub async fn delete_assets(
    state: State<'_, AppState>,
    ids: Vec<String>,
    permanent: bool,
) -> Result<(), String> {
    let cfg = state.library_config();
    if cfg.read_only {
        return Err(
            "Read-only mode is on — turn it off in Preferences → Library to allow deletes"
                .into(),
        );
    }
    if ids.len() as u32 > cfg.max_writes_per_batch {
        return Err(format!(
            "This would delete {} assets at once, over your cap of {} per action",
            ids.len(),
            cfg.max_writes_per_batch
        ));
    }

    let client = ImmichClient::from_config(&cfg, state.http.clone())?;
    client.delete_assets(&ids, permanent).await
}

#[tauri::command]
pub async fn get_trashed_assets(state: State<'_, AppState>) -> Result<Vec<AssetSummary>, String> {
    let cfg = state.library_config();
    let client = ImmichClient::from_config(&cfg, state.http.clone())?;
    client.get_trashed_assets().await
}

#[tauri::command]
pub async fn restore_assets(state: State<'_, AppState>, ids: Vec<String>) -> Result<(), String> {
    let cfg = state.library_config();
    if cfg.read_only {
        return Err(
            "Read-only mode is on — turn it off in Preferences → Library to allow restoring"
                .into(),
        );
    }
    if ids.len() as u32 > cfg.max_writes_per_batch {
        return Err(format!(
            "This would restore {} assets at once, over your cap of {} per action",
            ids.len(),
            cfg.max_writes_per_batch
        ));
    }

    let client = ImmichClient::from_config(&cfg, state.http.clone())?;
    client.restore_assets(&ids).await
}

#[tauri::command]
pub async fn empty_trash(state: State<'_, AppState>) -> Result<(), String> {
    let cfg = state.library_config();
    if cfg.read_only {
        return Err(
            "Read-only mode is on — turn it off in Preferences → Library to empty the trash"
                .into(),
        );
    }

    let client = ImmichClient::from_config(&cfg, state.http.clone())?;
    // "Empty trash" affects everything currently trashed, not a caller-chosen
    // list of ids - checking the cap here means it still means something
    // rather than being silently bypassed by this one action.
    let trashed = client.get_trashed_assets().await?;
    if trashed.len() as u32 > cfg.max_writes_per_batch {
        return Err(format!(
            "This would permanently delete {} trashed assets at once, over your cap of {} per action",
            trashed.len(),
            cfg.max_writes_per_batch
        ));
    }

    client.empty_trash().await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataEditTarget {
    pub id: String,
    pub original_path: Option<String>,
}

/// Enqueues rating/favorite/description edits for a batch of assets onto the
/// background `EditQueue` (see `edit_queue.rs` for the full writeup of why -
/// XMP sidecar writes over the NFS/Tailscale mount can take minutes to drain
/// during a burst, and this command no longer waits on any of that). This is
/// a plain sync fn: enqueueing is synchronous, so there's no `.await` point
/// left here at all. The frontend applies its own optimistic patch
/// immediately and correlates the returned job ids against the queue's
/// polled status to know when/whether each one actually settled.
#[tauri::command]
pub fn update_asset_metadata(
    state: State<AppState>,
    targets: Vec<MetadataEditTarget>,
    rating: Option<i32>,
    is_favorite: Option<bool>,
    description: Option<String>,
) -> Result<Vec<u64>, String> {
    let cfg = state.library_config();
    if cfg.read_only {
        return Err(
            "Read-only mode is on — turn it off in Preferences → Library to allow edits".into(),
        );
    }
    if targets.len() as u32 > cfg.max_writes_per_batch {
        return Err(format!(
            "This would edit {} assets at once, over your cap of {} per action",
            targets.len(),
            cfg.max_writes_per_batch
        ));
    }
    Ok(state.edit_queue.enqueue(&cfg, &targets, rating, is_favorite, description.as_deref()))
}

/// Poll target for the edit queue's advisory activity panel - the frontend's
/// correctness never depends on this, only what it displays while edits
/// drain in the background.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditQueueStatus {
    pub jobs: Vec<EditJob>,
    pub pending_count: usize,
}

#[tauri::command]
pub fn get_edit_queue_status(state: State<AppState>) -> EditQueueStatus {
    EditQueueStatus {
        jobs: state.edit_queue.snapshot(),
        pending_count: state.edit_queue.pending_count(),
    }
}

#[tauri::command]
pub fn clear_completed_edit_jobs(state: State<AppState>) {
    state.edit_queue.clear_completed();
}

/// Enqueues **Paste Image Processing** - copying `source_original_path`'s
/// RAW-editor develop-adjustment sidecar (ART `.arp` or RawTherapee `.pp3`,
/// see `paths::find_processing_sidecar`) wholesale onto every target.
/// Distinct from `update_asset_metadata`/**Paste Metadata**: this touches no
/// Immich field at all, only local sidecar files, via the separate
/// `ProcessingQueue` (`processing_queue.rs`) rather than `EditQueue`.
///
/// Same `read_only`/`max_writes_per_batch` gate as every other write, plus
/// one more check specific to this command: the source must actually have a
/// processing sidecar, checked synchronously up front so a source with
/// nothing to copy is a real error, not N queued jobs doomed to fail.
#[tauri::command]
pub fn paste_image_processing(
    state: State<AppState>,
    source_original_path: String,
    targets: Vec<MetadataEditTarget>,
) -> Result<Vec<u64>, String> {
    let cfg = state.library_config();
    if cfg.read_only {
        return Err(
            "Read-only mode is on — turn it off in Preferences → Library to paste image processing".into(),
        );
    }
    if targets.len() as u32 > cfg.max_writes_per_batch {
        return Err(format!(
            "This would paste onto {} assets at once, over your cap of {} per action",
            targets.len(),
            cfg.max_writes_per_batch
        ));
    }
    let source_local_path = paths::resolve_local_path(&source_original_path, &cfg)
        .ok_or("Couldn't resolve a local path for the source asset")?;
    let (source_path, source_kind, source_form) = paths::find_processing_sidecar(&source_local_path)
        .ok_or("No RAW-editor processing sidecar (.arp/.pp3) found for the source asset")?;
    Ok(state.processing_queue.enqueue(&cfg, source_path, source_kind, source_form, &targets))
}

/// Poll target for the processing queue's advisory activity panel, same
/// shape as `get_edit_queue_status`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessingQueueStatus {
    pub jobs: Vec<crate::processing_queue::ProcessingJob>,
    pub pending_count: usize,
}

#[tauri::command]
pub fn get_processing_queue_status(state: State<AppState>) -> ProcessingQueueStatus {
    ProcessingQueueStatus {
        jobs: state.processing_queue.snapshot(),
        pending_count: state.processing_queue.pending_count(),
    }
}

#[tauri::command]
pub fn clear_completed_processing_jobs(state: State<AppState>) {
    state.processing_queue.clear_completed();
}

/// Bypasses the `CloseRequested` interception in `lib.rs` - what the
/// frontend's "Quit anyway" button calls after being warned that edits are
/// still syncing.
#[tauri::command]
pub fn force_quit(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
pub async fn create_stack(state: State<'_, AppState>, ids: Vec<String>) -> Result<StackInfo, String> {
    let cfg = state.library_config();
    if cfg.read_only {
        return Err(
            "Read-only mode is on — turn it off in Preferences → Library to create a stack".into(),
        );
    }
    if ids.len() as u32 > cfg.max_writes_per_batch {
        return Err(format!(
            "This would stack {} assets at once, over your cap of {} per action",
            ids.len(),
            cfg.max_writes_per_batch
        ));
    }

    let client = ImmichClient::from_config(&cfg, state.http.clone())?;
    client.create_stack(&ids).await
}

#[tauri::command]
pub async fn get_stack(state: State<'_, AppState>, stack_id: String) -> Result<StackInfo, String> {
    let cfg = state.library_config();
    let client = ImmichClient::from_config(&cfg, state.http.clone())?;
    client.get_stack(&stack_id).await
}

#[tauri::command]
pub async fn list_stacks(state: State<'_, AppState>) -> Result<Vec<StackInfo>, String> {
    let cfg = state.library_config();
    let client = ImmichClient::from_config(&cfg, state.http.clone())?;
    client.list_stacks().await
}

#[tauri::command]
pub async fn set_stack_pick(
    state: State<'_, AppState>,
    stack_id: String,
    asset_id: String,
) -> Result<(), String> {
    let cfg = state.library_config();
    if cfg.read_only {
        return Err(
            "Read-only mode is on — turn it off in Preferences → Library to change the stack pick"
                .into(),
        );
    }
    if 1 > cfg.max_writes_per_batch {
        return Err(format!(
            "Your cap of {} per action doesn't allow any writes",
            cfg.max_writes_per_batch
        ));
    }

    let client = ImmichClient::from_config(&cfg, state.http.clone())?;
    client.update_stack_primary(&stack_id, &asset_id).await
}

/// Corrects an asset's indexed capture date - used by the round-trip watcher
/// (PhotosBrowser.tsx's 'round-trip-file-detected' listener) right after it
/// discovers an editor's output file: that file often carries no EXIF
/// DateTimeOriginal of its own (many editors don't copy it over into an
/// exported JPEG), so Immich falls back to indexing it under "now" instead
/// of the original's real capture time. Not routed through the edit queue -
/// unlike rating/favorite/description, capture date isn't a sidecar-tracked
/// field, so there's no XMP write to pair it with.
#[tauri::command]
pub async fn set_asset_capture_date(
    state: State<'_, AppState>,
    asset_id: String,
    date_time_original: String,
) -> Result<(), String> {
    let cfg = state.library_config();
    if cfg.read_only {
        return Err(
            "Read-only mode is on — turn it off in Preferences → Library to correct the capture date".into(),
        );
    }
    let client = ImmichClient::from_config(&cfg, state.http.clone())?;
    client.update_asset(&asset_id, None, None, None, Some(&date_time_original)).await
}

#[tauri::command]
pub async fn delete_stack(state: State<'_, AppState>, stack_id: String) -> Result<(), String> {
    let cfg = state.library_config();
    if cfg.read_only {
        return Err(
            "Read-only mode is on — turn it off in Preferences → Library to unstack".into(),
        );
    }

    let client = ImmichClient::from_config(&cfg, state.http.clone())?;
    // Unstacking has no caller-supplied id list of its own (just a stack id) -
    // fetch the stack first so the cap still means something, same pattern as
    // empty_trash checking the live trashed count before proceeding.
    let stack = client.get_stack(&stack_id).await?;
    if stack.assets.len() as u32 > cfg.max_writes_per_batch {
        return Err(format!(
            "This would unstack {} assets at once, over your cap of {} per action",
            stack.assets.len(),
            cfg.max_writes_per_batch
        ));
    }

    client.delete_stack(&stack_id).await
}

#[tauri::command]
pub fn save_import_settings(
    app: AppHandle,
    state: State<AppState>,
    settings: ImportSettings,
) -> Result<AppConfig, String> {
    let mut guard = state.config.lock().unwrap();
    guard.import = settings;
    config::save(&app, &guard)?;
    Ok(guard.clone())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovableVolume {
    pub name: String,
    pub mount_point: String,
}

/// Quick-pick list above the plain folder-browse fallback in the Import
/// dialog - best-effort, never errors; an empty list just falls back to
/// manual browsing.
#[tauri::command]
pub fn list_removable_volumes() -> Vec<RemovableVolume> {
    use sysinfo::Disks;
    Disks::new_with_refreshed_list()
        .iter()
        .filter(|d| d.is_removable())
        .map(|d| RemovableVolume {
            name: d.name().to_string_lossy().to_string(),
            mount_point: d.mount_point().to_string_lossy().to_string(),
        })
        .collect()
}

/// Bounds how long `scan_import_source`/`start_import` will wait on their
/// blocking work before giving up and returning an error - both touch a
/// user-chosen source/destination folder that can be an unreachable NFS/
/// network mount, which can otherwise hang the underlying blocking task
/// forever (found live: the Import dialog's "Scanning…"/"Starting…" button
/// never resolving, with the OS eventually reporting the app itself as not
/// responding). The abandoned task still leaks a blocking-pool thread on
/// timeout, but the command itself returns promptly either way.
///
/// Two different budgets: scanning hashes every file it finds (up to ~4MB
/// each, see `hash.rs`), which for a real card with thousands of files over
/// a slow USB2 reader can legitimately take minutes even when nothing's
/// wrong - generous, matching `queue::COPY_TIMEOUT`'s order of magnitude.
/// Enqueueing only does cheap metadata operations (directory listings for
/// collision checks), so a much shorter budget is enough to still be
/// generous over a *working* NFS mount while failing fast on a dead one.
const IMPORT_SCAN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(600);
const IMPORT_ENQUEUE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportScanSummary {
    pub groups: Vec<ScannedGroup>,
    pub new_count: usize,
    pub already_imported_count: usize,
    pub paired_count: usize,
    pub total_files: usize,
}

/// Scans the chosen source folder and marks which groups are already fully
/// imported, checked against the queue's own in-memory dedupe cache (not a
/// fresh disk read of `import_history.json` - the queue may hold very
/// recent completions not yet flushed there, see `queue.rs`'s debounced
/// save). Returns the full group plan (not just counts) so `start_import`
/// doesn't need a second scan/hash pass over what could be a slow card
/// reader.
///
/// Runs through `io_guard::guarded_spawn_blocking`, not directly on the
/// calling task - `import::scan_source` does a full recursive directory
/// walk plus a partial hash read of every file it finds, which for a real
/// SD card (hundreds of files) is real blocking work. Without this, that
/// work ran straight on the async runtime's worker thread, starving the
/// IPC channel long enough that the OS reported the whole app as "not
/// responding" - a real bug found live, not a hypothetical.
#[tauri::command]
pub async fn scan_import_source(state: State<'_, AppState>, source_path: String) -> Result<ImportScanSummary, String> {
    let queue = state.import_queue.clone();
    let source_display = source_path.clone();
    let Some(handle) = io_guard::guarded_spawn_blocking(&state.io_guard, move || -> Result<ImportScanSummary, String> {
        let mut groups = import::scan_source(std::path::Path::new(&source_path))?;
        queue.mark_already_imported(&mut groups);

        let already_imported_count = groups.iter().filter(|g| g.already_imported).count();
        let paired_count = groups.iter().filter(|g| g.files.len() > 1).count();
        let total_files = groups.iter().map(|g| g.files.len()).sum();
        Ok(ImportScanSummary {
            new_count: groups.len() - already_imported_count,
            already_imported_count,
            paired_count,
            total_files,
            groups,
        })
    }) else {
        return Err("Skipped: system is about to suspend, try again after it wakes".to_string());
    };
    match tokio::time::timeout(IMPORT_SCAN_TIMEOUT, handle).await {
        Ok(join_result) => join_result.map_err(|e| e.to_string())?,
        Err(_) => Err(format!(
            "Timed out after {}s scanning \"{source_display}\" — check it's actually connected/reachable",
            IMPORT_SCAN_TIMEOUT.as_secs()
        )),
    }
}

/// Enqueues the copy jobs for every not-already-imported group in `groups`
/// onto the background `ImportQueue`, and returns immediately with the
/// assigned job ids - mirrors `update_asset_metadata`'s "enqueue and let the
/// frontend poll" shape. Gated by `read_only` like every other write, but
/// deliberately **not** by `max_writes_per_batch`: that cap exists to catch
/// a fat-fingered bulk edit/delete of *existing* assets, and applying it
/// unmodified here would make importing an ordinary few-hundred-photo SD
/// card impossible without raising the same cap that protects everything
/// else - a real usability/safety trade-off, not an oversight.
///
/// Also runs through `guarded_spawn_blocking` - `enqueue`'s per-group
/// collision resolution (`naming::resolve_stem`) does its own disk reads,
/// same blocking-the-async-runtime risk as `scan_import_source` above.
#[tauri::command]
pub async fn start_import(
    state: State<'_, AppState>,
    groups: Vec<ScannedGroup>,
    folder_depth: FolderDepth,
) -> Result<Vec<u64>, String> {
    let cfg = state.library_config();
    if cfg.read_only {
        return Err(
            "Read-only mode is on — turn it off in Preferences → Library to import".into(),
        );
    }
    if cfg.local_root.trim().is_empty() {
        return Err(
            "No External Library local mount configured — set one in Preferences → Library first".into(),
        );
    }
    let queue = state.import_queue.clone();
    let local_root = std::path::PathBuf::from(cfg.local_root);
    let Some(handle) = io_guard::guarded_spawn_blocking(&state.io_guard, move || queue.enqueue(&local_root, folder_depth, &groups)) else {
        return Err("Skipped: system is about to suspend, try again after it wakes".to_string());
    };
    match tokio::time::timeout(IMPORT_ENQUEUE_TIMEOUT, handle).await {
        Ok(join_result) => join_result.map_err(|e| e.to_string()),
        Err(_) => Err(format!(
            "Timed out after {}s preparing the import — check your destination folder is actually connected/reachable",
            IMPORT_ENQUEUE_TIMEOUT.as_secs()
        )),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportQueueStatus {
    pub jobs: Vec<ImportJob>,
    pub pending_count: usize,
}

#[tauri::command]
pub fn get_import_queue_status(state: State<AppState>) -> ImportQueueStatus {
    ImportQueueStatus {
        jobs: state.import_queue.snapshot(),
        pending_count: state.import_queue.pending_count(),
    }
}

#[tauri::command]
pub fn clear_completed_import_jobs(state: State<AppState>) {
    state.import_queue.clear_completed();
}

/// Auto-matches the configured External Library `immich_root` against
/// `GET /libraries` and, if exactly one library claims that import path,
/// fires `POST /libraries/{id}/scan` so Immich discovers files an import
/// batch just copied onto disk without waiting on its own periodic scan
/// schedule. Called once per import batch by the frontend once it observes
/// (via polling) that every job in that batch has settled - not from
/// inside the copy queue itself, to keep that queue free of any Immich-API
/// coupling. A no-match/ambiguous result is a real error surfaced to the
/// user (the copy already succeeded either way; this only affects how
/// promptly the new files show up in Immich).
#[tauri::command]
pub async fn scan_immich_library(state: State<'_, AppState>) -> Result<(), String> {
    let cfg = state.library_config();
    let client = ImmichClient::from_config(&cfg, state.http.clone())?;
    let libraries = client.get_libraries().await?;
    match crate::import::find_matching_library(&libraries, &cfg.immich_root) {
        crate::import::LibraryMatch::Found(id) => client.scan_library(&id).await,
        crate::import::LibraryMatch::NoMatch => Err(
            "Couldn't find an Immich External Library matching your configured library path - the copied files are safe on disk, but you may need to trigger a Library Scan yourself in Immich".into(),
        ),
        crate::import::LibraryMatch::Ambiguous(ids) => Err(format!(
            "More than one Immich External Library claims your configured library path ({}) - the copied files are safe on disk, but you'll need to trigger a Library Scan yourself in Immich",
            ids.join(", ")
        )),
    }
}

/// GET /view/folder/unique-paths - the real server-side folder tree (see
/// `ImmichClient::get_unique_folder_paths`), not the capture-date buckets the
/// Photos/Trash views use. The frontend builds a tree out of these paths.
#[tauri::command]
pub async fn get_folder_paths(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let cfg = state.library_config();
    let client = ImmichClient::from_config(&cfg, state.http.clone())?;
    client.get_unique_folder_paths().await
}

/// GET /view/folder?path=X - direct-child assets of one exact real folder.
#[tauri::command]
pub async fn get_folder_assets(state: State<'_, AppState>, path: String) -> Result<Vec<AssetSummary>, String> {
    let cfg = state.library_config();
    let client = ImmichClient::from_config(&cfg, state.http.clone())?;
    client.get_folder_assets(&path).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataSyncQuery {
    pub asset_id: String,
    pub original_path: Option<String>,
    pub current_rating: Option<i32>,
    pub current_description: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataSyncResult {
    pub asset_id: String,
    pub rating: Option<i32>,
    pub description: Option<String>,
    /// Whether this asset currently has an ART/RawTherapee processing
    /// sidecar (`.arp`/`.pp3`) on disk - piggybacked onto this same
    /// already-running per-bucket scan so **Copy Image Processing** can be
    /// enabled/disabled without a separate round trip per tile. Independent
    /// of `rating`/`description`: a result can carry `true` here with both
    /// of those `None` (metadata already in sync, but a processing sidecar
    /// still exists) - the frontend must not conflate this with the
    /// unsynced-metadata badge.
    pub has_processing_sidecar: bool,
}

/// Read-only, best-effort batch check - "no sidecar/embedded metadata" is
/// the overwhelmingly common outcome for most assets, not a failure, so
/// per-asset misses just don't appear in the result rather than erroring.
/// Only a structural precondition (no local path mapping configured at all)
/// short-circuits with a real error, to avoid doing N pointless resolve
/// attempts per bucket fetch when this feature isn't set up yet.
///
/// Also reports `has_processing_sidecar` per asset (see `MetadataSyncResult`)
/// so **Copy Image Processing**'s enablement can piggyback on this same scan
/// instead of a separate per-tile round trip - unrelated to the rating/
/// description sync this command otherwise exists for.
///
/// The sidecar/embedded value wins, per field, whenever it differs from
/// whatever Immich currently has for that field - including when Immich has
/// none at all (a plain gap). This is deliberately not "gap-fill only": the
/// whole point of this feature is that digiKam/darktable/RT/ART are where
/// ratings and captions actually get set day to day, and Immich's copy is a
/// downstream mirror of that - so a rating changed in digiKam after Immich
/// last saw a value must still surface as unsynced, not just a first-time
/// gap. Immich is still never overwritten automatically - the user always
/// explicitly triggers the sync action.
#[tauri::command]
pub async fn check_sidecar_metadata(
    state: State<'_, AppState>,
    queries: Vec<MetadataSyncQuery>,
) -> Result<Vec<MetadataSyncResult>, String> {
    let cfg = state.library_config();
    if cfg.immich_root.trim().is_empty() && cfg.uploaded_immich_root.trim().is_empty() {
        return Err("No local path mapping configured".into());
    }
    let Some(handle) = io_guard::guarded_spawn_blocking(&state.io_guard, move || {
        queries
            .into_iter()
            .filter_map(|q| {
                let local = paths::resolve_local_path(q.original_path.as_deref()?, &cfg)?;
                let detected = paths::read_asset_metadata(&local);
                let current_description = q.current_description.filter(|s| !s.trim().is_empty());
                let rating = detected.rating.filter(|r| Some(*r) != q.current_rating);
                let description = detected.description.filter(|d| Some(d) != current_description.as_ref());
                let has_processing_sidecar = paths::find_processing_sidecar(&local).is_some();
                (rating.is_some() || description.is_some() || has_processing_sidecar).then_some(MetadataSyncResult {
                    asset_id: q.asset_id,
                    rating,
                    description,
                    has_processing_sidecar,
                })
            })
            .collect::<Vec<_>>()
    }) else {
        // Suspend imminent - same "nothing detected this round" shape
        // callers already treat as a normal per-query outcome.
        return Ok(Vec::new());
    };
    handle.await.map_err(|e| e.to_string())
}

/// Current process's resident-set size, in bytes - a lightweight diagnostic
/// readout for tracking the app's memory footprint over a session, not a
/// profiler. `sysinfo` requires a fresh-enough `System`/`refresh_process`
/// call each time; there's no cached instance to keep around, and this is
/// cheap enough (single-process, no full system scan) to just do inline.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryUsage {
    pub rss_bytes: u64,
}

#[tauri::command]
pub fn get_memory_usage() -> MemoryUsage {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
    let pid = sysinfo::get_current_pid().unwrap_or(Pid::from(0));
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        false,
        ProcessRefreshKind::nothing().with_memory(),
    );
    let rss_bytes = sys.process(pid).map(|p| p.memory()).unwrap_or(0);
    MemoryUsage { rss_bytes }
}
