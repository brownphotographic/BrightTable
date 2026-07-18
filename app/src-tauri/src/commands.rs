use std::collections::HashMap;
use std::path::PathBuf;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::apps::{self, AppChoice};
use crate::art;
use crate::art_queue::ArtJob;
use crate::config::{self, AppConfig, ApplicationsConfig, ImportSettings, LibraryConfig, SmartStackSettings};
use crate::edit_queue::EditJob;
use crate::export_naming;
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

/// Resolves `file_name`/`smart_stack.suffix` down to the export path
/// `ART-cli` should write - shared by `launch_art_round_trip` (one target) and
/// `batch_art_round_trip` (many, via its own `guarded_spawn_blocking`
/// closure). Not `#[tauri::command]` itself - pure enough to call directly
/// from inside an already-blocking closure without another layer of
/// `spawn_blocking`.
fn resolve_art_export_path(
    original_path: &str,
    file_name: &str,
    file_extension: &str,
    cfg: &LibraryConfig,
    suffix_pattern: &str,
) -> Result<(PathBuf, PathBuf), String> {
    let local_path = paths::resolve_local_path(original_path, cfg).ok_or_else(|| {
        format!("No local path mapping configured for {file_name} — set up External Library mapping in Preferences → Library")
    })?;
    let dir = local_path.parent().ok_or_else(|| format!("{file_name} has no parent directory"))?.to_path_buf();
    let base = export_naming::base_name(file_name, file_extension);
    let core = export_naming::suffix_core(suffix_pattern);
    let export_path = export_naming::next_export_path(&dir, base, &core, "jpg");
    Ok((local_path, export_path))
}

/// Bounds how long resolving an ART round trip's export path (a real disk
/// scan for the first free collision-numbered filename, see
/// `export_naming::next_export_path`) will wait before giving up - same
/// "don't hang forever on an unreachable NFS/network mount" reasoning as
/// `IMPORT_ENQUEUE_TIMEOUT`, which this mirrors in both budget and shape.
const ART_EXPORT_PATH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// Tauri event emitted with a `u8` (0-100) payload as `ART-cli`'s own
/// `--progress` output arrives, for Variant 1 only - Variant 2's per-job
/// progress already has a home on `ArtJob::progress_percent`/`ArtQueueStatus`
/// (polled, no event needed), but Variant 1 is a single awaited `invoke`
/// call with no polled job to attach a percentage to, so an event is the only
/// way to get it to the frontend before the call itself resolves. Only one
/// Variant 1 export can ever be in flight at a time (its triggering button
/// disables itself while busy - see Viewer.tsx's `artBusy`/SelectionBar's
/// `rawEditorBusy`), so this carries no asset id to disambiguate.
const ART_ROUND_TRIP_PROGRESS_EVENT: &str = "art-round-trip-progress";

/// Variant 1 of the ART CLI round trip (see the feature plan): hooks into the
/// existing "Open in RAW Editor" action when ART round-trip is configured
/// (`applications.art_cli_path` non-empty). Opens ART itself as its own
/// dedicated process (`apps::launch_app_and_wait` - see its own doc comment
/// for why a shared `-R` instance isn't used) and awaits the user finishing
/// their edit there, then runs `ART-cli` to produce the export
/// deterministically - no dependency on the user manually exporting inside
/// ART's own GUI, and no dependency on `round_trip.rs`'s passive file
/// watcher, since this command already knows the export's filename as its
/// own return value.
///
/// Gated **upfront**, before ART even opens - read-only mode blocks this
/// command entirely rather than just failing at the final export step, since
/// unlike the generic (non-ART) editor flow, this one really does write a
/// new file to disk itself.
#[tauri::command]
pub async fn launch_art_round_trip(
    app: AppHandle,
    state: State<'_, AppState>,
    original_path: Option<String>,
    file_name: String,
    file_extension: String,
    raw_editor: AppChoice,
) -> Result<String, String> {
    let (cfg, art_cli_path, suffix_pattern) = {
        let guard = state.config.lock().unwrap();
        (guard.library.clone(), guard.applications.art_cli_path.clone(), guard.smart_stack.suffix.clone())
    };
    if cfg.read_only {
        return Err("Read-only mode is on — turn it off in Preferences → Library to use ART Round Trip".into());
    }
    if art_cli_path.trim().is_empty() {
        return Err("No ART-cli path configured — set one in Preferences → Applications".into());
    }
    if 1 > cfg.max_writes_per_batch {
        return Err(format!("Your cap of {} per action doesn't allow any writes", cfg.max_writes_per_batch));
    }
    let original_path = original_path.ok_or("This asset has no server-side path to resolve")?;
    let local_path = paths::resolve_local_path(&original_path, &cfg).ok_or(
        "No local path mapping configured for this asset — set up External Library mapping in Preferences → Library",
    )?;

    apps::launch_app_and_wait(&raw_editor, &local_path).await?;

    let cfg_for_scan = cfg.clone();
    let file_name_for_scan = file_name.clone();
    let file_extension_for_scan = file_extension.clone();
    let suffix_for_scan = suffix_pattern.clone();
    let Some(handle) = io_guard::guarded_spawn_blocking(&state.io_guard, move || {
        resolve_art_export_path(&original_path, &file_name_for_scan, &file_extension_for_scan, &cfg_for_scan, &suffix_for_scan)
    }) else {
        return Err("Skipped: system is about to suspend, try again after it wakes".to_string());
    };
    let (raw_path, export_path) = match tokio::time::timeout(ART_EXPORT_PATH_TIMEOUT, handle).await {
        Ok(join_result) => join_result.map_err(|e| e.to_string())??,
        Err(_) => {
            return Err(format!(
                "Timed out after {}s resolving the export path — check your library's local mount is actually connected/reachable",
                ART_EXPORT_PATH_TIMEOUT.as_secs()
            ))
        }
    };

    let args = art::build_art_cli_args(art::ArtCliMode::ApplySidecar, &export_path, &raw_path);
    let progress_app = app.clone();
    let run = art::run_art_cli_with_progress(&art_cli_path, &args, move |percent| {
        let _ = progress_app.emit(ART_ROUND_TRIP_PROGRESS_EVENT, percent);
    });
    match tokio::time::timeout(art::ART_CLI_RUN_TIMEOUT, run).await {
        Ok(result) => result?,
        Err(_) => {
            return Err(format!(
                "Timed out after {}s running ART-cli — it may still be processing in the background",
                art::ART_CLI_RUN_TIMEOUT.as_secs()
            ))
        }
    }

    export_path
        .file_name()
        .and_then(|n| n.to_str())
        .map(str::to_string)
        .ok_or_else(|| "Couldn't determine the export file's name".to_string())
}

/// One Batch RAW Roundtrip target - mirrors `MetadataEditTarget` plus the
/// `file_name`/`file_extension` `export_naming::base_name` needs (which
/// `MetadataEditTarget` has no use for).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtRoundTripTarget {
    pub id: String,
    pub original_path: Option<String>,
    pub file_name: String,
    pub file_extension: String,
}

/// Variant 2 of the ART CLI round trip: fully headless, applies each asset's
/// own sidecar (if any) over the user's ART default profile
/// (`art::ArtCliMode::DefaultThenSidecarOverride`) and exports every target in
/// the background via `ArtQueue`, returning immediately with the assigned job
/// ids (same "enqueue and let the frontend poll" shape as
/// `start_import`/`paste_image_processing`). Every target's local/export path
/// is resolved up front, inside one `guarded_spawn_blocking` closure (mirrors
/// `scan_import_source`'s "resolve everything, then enqueue synchronously"
/// shape) - a target that can't be resolved fails the whole call rather than
/// silently dropping just that one asset, so the confirm dialog's count
/// always matches what's actually queued.
#[tauri::command]
pub async fn batch_art_round_trip(state: State<'_, AppState>, targets: Vec<ArtRoundTripTarget>) -> Result<Vec<u64>, String> {
    let (cfg, art_cli_path, suffix_pattern) = {
        let guard = state.config.lock().unwrap();
        (guard.library.clone(), guard.applications.art_cli_path.clone(), guard.smart_stack.suffix.clone())
    };
    if cfg.read_only {
        return Err("Read-only mode is on — turn it off in Preferences → Library to use Batch RAW Roundtrip".into());
    }
    if art_cli_path.trim().is_empty() {
        return Err("No ART-cli path configured — set one in Preferences → Applications".into());
    }
    if targets.len() as u32 > cfg.max_writes_per_batch {
        return Err(format!(
            "This would roundtrip {} assets at once, over your cap of {} per action",
            targets.len(),
            cfg.max_writes_per_batch
        ));
    }

    let art_queue = state.art_queue.clone();
    let art_cli_path_for_worker = art_cli_path.clone();
    let Some(handle) = io_guard::guarded_spawn_blocking(&state.io_guard, move || -> Result<Vec<u64>, String> {
        let mut resolved = Vec::with_capacity(targets.len());
        for t in &targets {
            let original_path = t.original_path.as_deref().ok_or_else(|| format!("{} has no server-side path to resolve", t.file_name))?;
            let (raw_path, export_path) = resolve_art_export_path(original_path, &t.file_name, &t.file_extension, &cfg, &suffix_pattern)?;
            resolved.push((t.id.clone(), raw_path, export_path));
        }
        Ok(art_queue.enqueue(&art_cli_path_for_worker, resolved))
    }) else {
        return Err("Skipped: system is about to suspend, try again after it wakes".to_string());
    };
    match tokio::time::timeout(ART_EXPORT_PATH_TIMEOUT, handle).await {
        Ok(join_result) => join_result.map_err(|e| e.to_string())?,
        Err(_) => Err(format!(
            "Timed out after {}s resolving export paths — check your library's local mount is actually connected/reachable",
            ART_EXPORT_PATH_TIMEOUT.as_secs()
        )),
    }
}

/// Poll target for the ART queue's advisory activity panel, same shape as
/// `get_processing_queue_status`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtQueueStatus {
    pub jobs: Vec<ArtJob>,
    pub pending_count: usize,
}

#[tauri::command]
pub fn get_art_queue_status(state: State<AppState>) -> ArtQueueStatus {
    ArtQueueStatus { jobs: state.art_queue.snapshot(), pending_count: state.art_queue.pending_count() }
}

#[tauri::command]
pub fn clear_completed_art_jobs(state: State<AppState>) {
    state.art_queue.clear_completed();
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
