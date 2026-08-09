use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::apps::{self, AppChoice};
use crate::art_queue::{self, ArtJob, ArtJobStatus, ArtQueue};
use crate::cli_process;
use crate::config::{self, AppConfig, ApplicationsConfig, ImportSettings, LibraryConfig, RawConverterKind, SharingConfig, SmartStackSettings, WindowControlsPosition};
use crate::edit_queue::EditJob;
use crate::export_naming;
use crate::export_queue::{self, ExportDelivery, ExportFormat, ExportJob, ExportTarget, FlickrAlbumChoice, RenditionOptions};
use crate::exiftool::MetadataPolicy;
use crate::flickr::{self, FlickrPrivacy};
use crate::immich::models::{
    AlbumDetail, AlbumSummary, AssetSummary, ConnectionStatus, PersonDetail, PersonSummary,
    StackInfo, TagDetail, TagSummary, TimeBucketInfo,
};
use crate::immich::ImmichClient;
use crate::import::{self, FolderDepth, ImportJob, ScannedGroup};
use crate::io_guard;
use crate::paths;
use crate::print;
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
pub fn save_window_controls_position(
    app: AppHandle,
    state: State<AppState>,
    position: WindowControlsPosition,
) -> Result<AppConfig, String> {
    let mut guard = state.config.lock().unwrap();
    guard.window_controls_position = position;
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
/// later does to the file is outside BrightTable's own write path.
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
    let client = ImmichClient::from_config(&cfg, state.http.clone(), &state.auto_resolution).await?;
    client.test_connection().await
}

#[tauri::command]
pub async fn get_timeline_buckets(state: State<'_, AppState>) -> Result<Vec<TimeBucketInfo>, String> {
    let cfg = state.library_config();
    let client = ImmichClient::from_config(&cfg, state.http.clone(), &state.auto_resolution).await?;
    client.get_time_buckets().await
}

#[tauri::command]
pub async fn get_timeline_bucket_assets(
    state: State<'_, AppState>,
    time_bucket: String,
) -> Result<Vec<AssetSummary>, String> {
    let cfg = state.library_config();
    let client = ImmichClient::from_config(&cfg, state.http.clone(), &state.auto_resolution).await?;
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

    let client = ImmichClient::from_config(&cfg, state.http.clone(), &state.auto_resolution).await?;
    client.delete_assets(&ids, permanent).await
}

#[tauri::command]
pub async fn get_trashed_assets(state: State<'_, AppState>) -> Result<Vec<AssetSummary>, String> {
    let cfg = state.library_config();
    let client = ImmichClient::from_config(&cfg, state.http.clone(), &state.auto_resolution).await?;
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

    let client = ImmichClient::from_config(&cfg, state.http.clone(), &state.auto_resolution).await?;
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

    let client = ImmichClient::from_config(&cfg, state.http.clone(), &state.auto_resolution).await?;
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

/// Enqueues **Paste Image Processing** - applying every tool's
/// develop-adjustment settings `source_original_path` has (ART `.arp`,
/// RawTherapee `.pp3`, and/or darktable's `.xmp`-embedded history, see
/// `paths::find_all_processing_sources`) onto every target, "one for each"
/// tool the source actually has settings from. Distinct from
/// `update_asset_metadata`/**Paste Metadata**: this touches no Immich field
/// at all, only local sidecar/`.xmp` files, via the separate
/// `ProcessingQueue` (`processing_queue.rs`) rather than `EditQueue` (though
/// the two now share a lock for the darktable case - see `AssetLocks`).
///
/// Same `read_only`/`max_writes_per_batch` gate as every other write, plus
/// one more check specific to this command: the source must actually have
/// *something* to paste, checked synchronously up front so a source with
/// nothing at all is a real error, not N queued jobs doomed to fail. The
/// returned job id count is `targets.len() * sources.len()`, not
/// `targets.len()` - one job per (target, tool) pair.
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
    let sources = paths::find_all_processing_sources(&source_local_path);
    if sources.is_empty() {
        return Err("No RAW-editor processing sidecar or darktable history found for the source asset".into());
    }
    Ok(state.processing_queue.enqueue(&cfg, &sources, &targets))
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

/// Resolves `file_name`/`smart_stack.suffix` down to the export path the
/// active converter's CLI should write - shared by `launch_raw_cli_round_trip`
/// (one target) and `batch_raw_cli_round_trip` (many, via its own
/// `guarded_spawn_blocking` closure). Not `#[tauri::command]` itself - pure
/// enough to call directly from inside an already-blocking closure without
/// another layer of `spawn_blocking`.
fn resolve_round_trip_export_path(
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
    let export_path = export_naming::next_export_path(&dir, base, &core, "jpg")
        .map_err(|e| format!("Couldn't claim an export filename for {file_name}: {e}"))?;
    Ok((local_path, export_path))
}

/// Bounds how long resolving a RAW CLI round trip's export path (a real disk
/// scan for the first free collision-numbered filename, see
/// `export_naming::next_export_path`) will wait before giving up - same
/// "don't hang forever on an unreachable NFS/network mount" reasoning as
/// `IMPORT_ENQUEUE_TIMEOUT`, which this mirrors in both budget and shape.
const ROUND_TRIP_EXPORT_PATH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// What `launch_raw_cli_round_trip` resolves to - either the export was
/// handed off to the background (`ApplySidecar` found a sidecar the editor
/// wrote from the user's edit, so the converter's CLI is now running under
/// `job_id` on the same `ArtQueue` board Variant 2 uses - the frontend tracks
/// it via `useArtJobReconciliation`/`ingestRoundTripExport` exactly like a
/// Variant 2 job, rather than waiting on this call), or the editor closed
/// with no sidecar ever written (no edit made/saved), in which case the
/// frontend is expected to show a choice - "use the default profile anyway"
/// (`finish_raw_cli_round_trip_with_default_profile`) or "cancel"
/// (`cancel_raw_cli_round_trip`) - rather than the command erroring outright.
/// `raw_path`/`export_path` are already-resolved, ready to hand straight back
/// to either follow-up command with no further path resolution.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ArtRoundTripOutcome {
    // The container-level `rename_all` above only renames the variant tags
    // ("processing"/"noSidecar") - it does NOT cascade into a struct
    // variant's own fields, so each variant needs its own `rename_all` too,
    // or these fields serialize as their bare snake_case Rust names
    // (`job_id`, not `jobId`). Confirmed live: without this, the frontend's
    // `ArtRoundTripOutcome.jobId` read `undefined` off the real `job_id` key,
    // so `useNoSidecarChoice`'s `resolve()` returned `undefined` for every
    // Variant 1 (Tweak RAW Roundtrip) launch - the exact bug this fixes -
    // `trackJobs([undefined])` never matched the job's real id, so it ran to
    // completion (visibly, in the Activity panel) but never got stacked or
    // had its rating carried over, with nothing to show why.
    #[serde(rename_all = "camelCase")]
    Processing { job_id: u64 },
    #[serde(rename_all = "camelCase")]
    NoSidecar { job_id: u64, raw_path: String, export_path: String },
}

/// Variant 1 of the RAW CLI round trip (see the feature plan): hooks into the
/// existing "Tweak RAW Roundtrip" action once a RAW converter CLI is
/// configured and active (`applications.active_raw_cli()` resolves to a
/// path). Opens the RAW editor itself as its own dedicated process
/// (`apps::launch_app_and_wait` - see its own doc comment for why a shared
/// `-R` instance isn't used) and awaits the user finishing their edit there,
/// then - once a sidecar confirms there's something to export - hands the
/// actual CLI run off to a background task and returns immediately, rather
/// than awaiting it too. This is what lets the frontend re-enable "Tweak RAW
/// Roundtrip" for another asset as soon as this one's export is under way,
/// instead of blocking until the CLI finishes: found live (for ART) that with
/// the whole run awaited inline, the button stayed disabled for the full
/// multi-second CLI pass even though the user was already done interacting
/// with the editor itself. The backgrounded task is tracked on the same
/// `ArtQueue` board Variant 2's worker uses (`set_status`/`set_progress`/
/// `finish`), and the frontend reconciles its completion the same way it does
/// a Variant 2 job (`useArtJobReconciliation` + `ingestRoundTripExport`)
/// rather than getting the export filename back directly from this call.
///
/// Gated **upfront**, before the editor even opens - read-only mode blocks
/// this command entirely rather than just failing at the final export step,
/// since unlike the generic (non-CLI-driven) editor flow, this one really
/// does write a new file to disk itself.
///
/// `id` only needs to be good enough to label/thumbnail the board row for
/// `ActivityIndicator`/`ActivityPanel` (`start_manual`).
#[tauri::command]
pub async fn launch_raw_cli_round_trip(
    state: State<'_, AppState>,
    id: String,
    original_path: Option<String>,
    file_name: String,
    file_extension: String,
    raw_editor: AppChoice,
) -> Result<ArtRoundTripOutcome, String> {
    let (cfg, applications, suffix_pattern) = {
        let guard = state.config.lock().unwrap();
        (guard.library.clone(), guard.applications.clone(), guard.smart_stack.suffix.clone())
    };
    if cfg.read_only {
        return Err("Read-only mode is on — turn it off in Preferences → Library to use RAW Roundtrip".into());
    }
    let (tool, cli_path) = applications.active_raw_cli()?;
    let cli_path = cli_path.to_string();
    let exiftool_path = applications.exiftool_path.clone();
    if 1 > cfg.max_writes_per_batch {
        return Err(format!("Your cap of {} per action doesn't allow any writes", cfg.max_writes_per_batch));
    }
    let original_path = original_path.ok_or("This asset has no server-side path to resolve")?;
    let local_path = paths::resolve_local_path(&original_path, &cfg).ok_or(
        "No local path mapping configured for this asset — set up External Library mapping in Preferences → Library",
    )?;

    let art_queue = state.art_queue.clone();
    let job_id = art_queue.start_manual(id, tool);

    let setup: Result<(PathBuf, PathBuf, bool), String> = async {
        apps::launch_app_and_wait(&raw_editor, &local_path).await?;

        let cfg_for_scan = cfg.clone();
        let file_name_for_scan = file_name.clone();
        let file_extension_for_scan = file_extension.clone();
        let suffix_for_scan = suffix_pattern.clone();
        // Checks for an existing sidecar in the same blocking closure as
        // path resolution, rather than a separate `guarded_spawn_blocking`
        // hop afterward - both touch the same (possibly NFS-backed) mount.
        // Checked here, before ever running the CLI in `ApplySidecar` mode
        // (`-s`), rather than parsing the CLI's own "no sidecar" stderr after
        // the fact - lets the frontend offer a real choice (default profile
        // vs. cancel) instead of just erroring, and avoids a wasted CLI
        // invocation.
        let Some(handle) = io_guard::guarded_spawn_blocking(&state.io_guard, move || {
            let (raw_path, export_path) =
                resolve_round_trip_export_path(&original_path, &file_name_for_scan, &file_extension_for_scan, &cfg_for_scan, &suffix_for_scan)?;
            let has_sidecar = paths::has_round_trip_sidecar(tool, &raw_path);
            Ok::<_, String>((raw_path, export_path, has_sidecar))
        }) else {
            return Err("Skipped: system is about to suspend, try again after it wakes".to_string());
        };
        match tokio::time::timeout(ROUND_TRIP_EXPORT_PATH_TIMEOUT, handle).await {
            Ok(join_result) => join_result.map_err(|e| e.to_string())?,
            Err(_) => Err(format!(
                "Timed out after {}s resolving the export path — check your library's local mount is actually connected/reachable",
                ROUND_TRIP_EXPORT_PATH_TIMEOUT.as_secs()
            )),
        }
    }
    .await;

    let (raw_path, export_path, has_sidecar) = match setup {
        Ok(v) => v,
        Err(e) => {
            // No export path was ever claimed on this branch (the failure is
            // either before path resolution ran, or path resolution itself
            // failing) - nothing on disk to clean up, just settle the row.
            art_queue.finish(job_id, ArtJobStatus::Failed, None, Some(e.clone()));
            return Err(e);
        }
    };

    // The reserved export path placeholder is deliberately left in place
    // (not cleaned up here) - both follow-up commands reuse it.
    if !has_sidecar {
        return Ok(ArtRoundTripOutcome::NoSidecar {
            job_id,
            raw_path: raw_path.to_string_lossy().to_string(),
            export_path: export_path.to_string_lossy().to_string(),
        });
    }

    // From here on, the actual CLI run happens in the background - this
    // command returns as soon as it's kicked off, rather than waiting for it
    // to finish, so "Tweak RAW Roundtrip" can be pressed again for a
    // different asset right away. Mirrors `art_queue::run`'s Variant 2
    // worker almost exactly (acquire the shared permit, re-check cancel,
    // run, finish), just spawned directly here instead of drained off `tx`.
    let queue_for_job = art_queue.clone();
    tauri::async_runtime::spawn(async move {
        // Shares Variant 2's concurrency cap (`ArtQueue::acquire_permit`) -
        // confirmed live (for ART) that without this, an interactive round
        // trip running alongside an already-full batch queue stacks a 3rd
        // concurrent full-resolution CLI process on top of the other two,
        // which is enough to push a memory-constrained machine into swap
        // thrashing (see `art_queue.rs`'s `semaphore` doc comment). Stays
        // Pending ("Queued" in the UI) while waiting on a slot, same as
        // Variant 2's worker, only flipping to Running once the CLI actually
        // starts.
        let _permit = queue_for_job.acquire_permit().await;
        // Re-checked here (not just at `request_cancel` time) since a cancel
        // can land while this job was still queued behind the semaphore -
        // see `art_queue.rs::run`'s identical check for Variant 2.
        let cancel_rx = queue_for_job.cancel_receiver(job_id).unwrap_or_else(|| tokio::sync::watch::channel(false).1);
        if *cancel_rx.borrow() {
            let _ = std::fs::remove_file(&export_path);
            queue_for_job.finish(job_id, ArtJobStatus::Failed, None, Some(cli_process::CANCELLED_BY_USER.to_string()));
            return;
        }
        queue_for_job.set_status(job_id, ArtJobStatus::Running);

        let progress_queue = queue_for_job.clone();
        let run = art_queue::run_round_trip_cli(
            tool,
            &cli_path,
            &exiftool_path,
            &raw_path,
            &export_path,
            cli_process::SidecarCliMode::ApplySidecar,
            move |percent| progress_queue.set_progress(job_id, percent),
            cancel_rx,
        );
        let result = match tokio::time::timeout(cli_process::RAW_CLI_RUN_TIMEOUT, run).await {
            Ok(result) => result,
            Err(_) => Err(format!(
                "Timed out after {}s running the RAW converter CLI — it may still be processing in the background",
                cli_process::RAW_CLI_RUN_TIMEOUT.as_secs()
            )),
        };
        match result {
            Ok(()) => queue_progress_to_done(&queue_for_job, job_id, &export_path),
            Err(e) => {
                let _ = std::fs::remove_file(&export_path);
                queue_for_job.finish(job_id, ArtJobStatus::Failed, None, Some(e));
            }
        }
    });

    Ok(ArtRoundTripOutcome::Processing { job_id })
}

/// Second half of Variant 1's no-sidecar choice (see `ArtRoundTripOutcome`) -
/// the user picked "use the default processing profile" instead of
/// cancelling. Takes the exact `raw_path`/`export_path` `launch_raw_cli_round_trip`
/// already resolved (and claimed) rather than re-resolving them, since the
/// editor isn't reopened here - there's nothing new on disk to look for a
/// sidecar against. Same "kick off the CLI in the background and return
/// immediately" shape as `launch_raw_cli_round_trip`'s own sidecar path (see
/// its doc comment) - the frontend already has `job_id` from the `NoSidecar`
/// outcome, so it tracks completion via `useArtJobReconciliation` the same
/// way rather than getting an export filename back from this call.
#[tauri::command]
pub fn finish_raw_cli_round_trip_with_default_profile(
    state: State<AppState>,
    job_id: u64,
    raw_path: String,
    export_path: String,
) {
    let (tool, cli_path, exiftool_path) = {
        let cfg = state.config.lock().unwrap();
        // Re-resolves the active converter rather than trusting a value
        // threaded through from `launch_raw_cli_round_trip` - Preferences
        // could theoretically change between the two calls, and this is the
        // one call already reading `state.config` fresh anyway. Falls back
        // to `Art`/empty on an error here only in the pathological case the
        // active converter changed since the no-sidecar dialog opened; the
        // CLI invocation below still fails cleanly if that leaves `cli_path`
        // empty.
        let (tool, cli_path) = cfg.applications.active_raw_cli().unwrap_or((RawConverterKind::Art, ""));
        (tool, cli_path.to_string(), cfg.applications.exiftool_path.clone())
    };
    let art_queue = state.art_queue.clone();
    let raw_path = PathBuf::from(raw_path);
    let export_path = PathBuf::from(export_path);

    tauri::async_runtime::spawn(async move {
        let _permit = art_queue.acquire_permit().await;
        let cancel_rx = art_queue.cancel_receiver(job_id).unwrap_or_else(|| tokio::sync::watch::channel(false).1);
        if *cancel_rx.borrow() {
            let _ = std::fs::remove_file(&export_path);
            art_queue.finish(job_id, ArtJobStatus::Failed, None, Some(cli_process::CANCELLED_BY_USER.to_string()));
            return;
        }
        art_queue.set_status(job_id, ArtJobStatus::Running);

        let progress_queue = art_queue.clone();
        // For ART, goes through the same Exiv2-crash fallback as Variant 1's
        // sidecar path and Variant 2's worker (`run_art_cli_with_metadata_fallback`)
        // rather than a plain retry - ART's own `-d` default profile carries
        // the identical `Mode=1` a real sidecar does (see
        // `MINIMAL_METADATA_OFF_PROFILE`'s doc comment), so a RAW that
        // crashes ART-cli's Exiv2 read crashes here just as reliably as it
        // does with a saved sidecar, and blind retries alone never recover
        // from that for a file where the crash is deterministic rather than
        // the racy case those retries are actually good for.
        let run = art_queue::run_round_trip_cli(
            tool,
            &cli_path,
            &exiftool_path,
            &raw_path,
            &export_path,
            cli_process::SidecarCliMode::DefaultOnly,
            move |percent| progress_queue.set_progress(job_id, percent),
            cancel_rx,
        );
        let result = match tokio::time::timeout(cli_process::RAW_CLI_RUN_TIMEOUT, run).await {
            Ok(result) => result,
            Err(_) => Err(format!(
                "Timed out after {}s running the RAW converter CLI — it may still be processing in the background",
                cli_process::RAW_CLI_RUN_TIMEOUT.as_secs()
            )),
        };
        match result {
            Ok(()) => {
                queue_progress_to_done(&art_queue, job_id, &export_path);
            }
            Err(e) => {
                let _ = std::fs::remove_file(&export_path);
                art_queue.finish(job_id, ArtJobStatus::Failed, None, Some(e));
            }
        }
    });
}

/// Shared by `launch_raw_cli_round_trip`'s and
/// `finish_raw_cli_round_trip_with_default_profile`'s background tasks - both
/// finish a job the same way once the converter CLI actually succeeds.
fn queue_progress_to_done(art_queue: &ArtQueue, job_id: u64, export_path: &std::path::Path) {
    art_queue.set_progress(job_id, 100);
    let export_file_name = export_path.file_name().and_then(|n| n.to_str()).map(str::to_string);
    art_queue.finish(job_id, ArtJobStatus::Done, export_file_name, None);
}

/// The other half of Variant 1's no-sidecar choice - the user picked "cancel"
/// instead of exporting with the default profile. Releases the empty
/// placeholder `launch_raw_cli_round_trip` claimed (see
/// `export_naming::next_export_path`) and marks the queue row `Failed` with a
/// clear "cancelled" message rather than leaving it `Pending` forever.
#[tauri::command]
pub fn cancel_raw_cli_round_trip(state: State<AppState>, job_id: u64, export_path: String) {
    let _ = std::fs::remove_file(&export_path);
    state.art_queue.finish(job_id, ArtJobStatus::Failed, None, Some("Cancelled — no edits were saved for this photo".to_string()));
}

/// General-purpose cancel for any still-`Pending`/`Running` row on
/// `ArtQueue`'s board - the Activity panel's "Cancel Selected" bulk action,
/// covering both Headless RAW Roundtrip's own queue and a Variant 1
/// interactive round trip (tracked on the same board via `start_manual`).
/// Unlike `cancel_raw_cli_round_trip` above (which only ever applies to a job
/// paused mid-flow waiting on the no-sidecar choice, before the CLI has run
/// at all), this can reach a job that's already `Running` - it requests
/// cancellation via `ArtQueue::request_cancel` and returns immediately;
/// the job's own worker/command task does the actual finishing once it
/// notices (see `cli_process::run_cli_with_progress`'s cancellation branch).
/// Returns `false` if `job_id` was already done or never existed - not an
/// error, since by the time a bulk "Cancel Selected" click reaches the
/// backend the job may well have finished on its own in the meantime.
#[tauri::command]
pub fn cancel_raw_cli_job(state: State<AppState>, job_id: u64) -> bool {
    state.art_queue.request_cancel(job_id)
}

/// One Headless RAW Roundtrip target - mirrors `MetadataEditTarget` plus the
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

/// Variant 2 of the RAW CLI round trip: fully headless, applies each asset's
/// own sidecar (if any) over the active converter's default profile and
/// exports every target in the background via `ArtQueue`, returning
/// immediately with the assigned job ids (same "enqueue and let the frontend
/// poll" shape as `start_import`/`paste_image_processing`). Every target's
/// local/export path is resolved up front, inside one `guarded_spawn_blocking`
/// closure (mirrors `scan_import_source`'s "resolve everything, then enqueue
/// synchronously" shape) - a target that can't be resolved fails the whole
/// call rather than silently dropping just that one asset, so the confirm
/// dialog's count always matches what's actually queued. Also resolves each
/// target's own `has_sidecar` here (one more `paths::has_round_trip_sidecar`
/// check, tool-aware per `active_raw_converter`, alongside the path
/// resolution, same blocking closure) so `art_queue::run` can pick `-d -S`
/// (`SidecarCliMode::DefaultThenSidecarOverride`) for a target that has one
/// and plain `-d` (`SidecarCliMode::DefaultOnly`) for one that doesn't -
/// confirmed live for ART that `-S` actually errors ("no sidecar procparams
/// found") rather than falling back when there's no sidecar to layer, so
/// leaving every target on `-d -S` unconditionally would fail exactly the
/// assets the no-sidecar prompt's "export with default profile" choice was
/// supposed to rescue.
#[tauri::command]
pub async fn batch_raw_cli_round_trip(state: State<'_, AppState>, targets: Vec<ArtRoundTripTarget>) -> Result<Vec<u64>, String> {
    let (cfg, applications, suffix_pattern) = {
        let guard = state.config.lock().unwrap();
        (guard.library.clone(), guard.applications.clone(), guard.smart_stack.suffix.clone())
    };
    if cfg.read_only {
        return Err("Read-only mode is on — turn it off in Preferences → Library to use Headless RAW Roundtrip".into());
    }
    let (tool, cli_path) = applications.active_raw_cli()?;
    let cli_path = cli_path.to_string();
    if targets.len() as u32 > cfg.max_writes_per_batch {
        return Err(format!(
            "This would roundtrip {} assets at once, over your cap of {} per action",
            targets.len(),
            cfg.max_writes_per_batch
        ));
    }

    let art_queue = state.art_queue.clone();
    let cli_path_for_worker = cli_path.clone();
    let Some(handle) = io_guard::guarded_spawn_blocking(&state.io_guard, move || -> Result<Vec<u64>, String> {
        let mut resolved: Vec<(String, PathBuf, PathBuf, bool)> = Vec::with_capacity(targets.len());
        let resolve_result: Result<(), String> = (|| {
            for t in &targets {
                let original_path = t.original_path.as_deref().ok_or_else(|| format!("{} has no server-side path to resolve", t.file_name))?;
                let (raw_path, export_path) = resolve_round_trip_export_path(original_path, &t.file_name, &t.file_extension, &cfg, &suffix_pattern)?;
                // Resolved up front, same as `launch_raw_cli_round_trip`'s
                // own `has_sidecar` check - lets `art_queue::run` pick `-d -S`
                // vs. plain `-d` per target (see `QueuedArtWork::has_sidecar`'s
                // doc comment for why that distinction actually matters).
                let has_sidecar = paths::has_round_trip_sidecar(tool, &raw_path);
                resolved.push((t.id.clone(), raw_path, export_path, has_sidecar));
            }
            Ok(())
        })();
        if let Err(e) = resolve_result {
            // Release every filename this batch already claimed (see
            // export_naming::next_export_path's atomic `create_new`) before
            // bailing on a later target's failure, so those earlier targets
            // don't leave empty placeholder files in the library for Immich
            // to later pick up as new (blank) assets.
            for (_, _, export_path, _) in &resolved {
                let _ = std::fs::remove_file(export_path);
            }
            return Err(e);
        }
        Ok(art_queue.enqueue(tool, &cli_path_for_worker, resolved))
    }) else {
        return Err("Skipped: system is about to suspend, try again after it wakes".to_string());
    };
    match tokio::time::timeout(ROUND_TRIP_EXPORT_PATH_TIMEOUT, handle).await {
        Ok(join_result) => join_result.map_err(|e| e.to_string())?,
        Err(_) => Err(format!(
            "Timed out after {}s resolving export paths — check your library's local mount is actually connected/reachable",
            ROUND_TRIP_EXPORT_PATH_TIMEOUT.as_secs()
        )),
    }
}

/// Poll target for the RAW CLI queue's advisory activity panel, same shape as
/// `get_processing_queue_status`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtQueueStatus {
    pub jobs: Vec<ArtJob>,
    pub pending_count: usize,
}

#[tauri::command]
pub fn get_raw_cli_queue_status(state: State<AppState>) -> ArtQueueStatus {
    ArtQueueStatus { jobs: state.art_queue.snapshot(), pending_count: state.art_queue.pending_count() }
}

#[tauri::command]
pub fn clear_completed_raw_cli_jobs(state: State<AppState>) {
    state.art_queue.clear_completed();
}

/// **Show in File Manager** - resolves an asset's server-side path to its
/// local mount and asks the desktop to reveal it (see `reveal.rs`). The
/// existence check runs through `guarded_spawn_blocking` like every other
/// real disk touch on the (possibly NFS-backed) library mount; the actual
/// reveal itself is a cheap D-Bus call or process spawn, not blocking I/O, so
/// it runs directly on the async command.
#[tauri::command]
pub async fn reveal_in_file_manager(state: State<'_, AppState>, original_path: String) -> Result<(), String> {
    let cfg = state.library_config();
    let local_path = paths::resolve_local_path(&original_path, &cfg)
        .ok_or("No local path mapping configured for this asset — set up External Library mapping in Preferences → Library")?;
    let exists_path = local_path.clone();
    let Some(handle) = io_guard::guarded_spawn_blocking(&state.io_guard, move || exists_path.exists()) else {
        return Err("Skipped: system is about to suspend, try again after it wakes".to_string());
    };
    let exists = handle.await.map_err(|e| e.to_string())?;
    if !exists {
        return Err(format!("File not found on disk: {}", local_path.display()));
    }
    crate::reveal::reveal(&local_path).await
}

/// **Open in Video Player** - resolves an asset's server-side path to its
/// local mount and hands it to the desktop's default video handler (see
/// `open_default.rs`) rather than this app's own embedded WebView player.
/// Same existence-check shape as `reveal_in_file_manager`.
#[tauri::command]
pub async fn open_video_externally(state: State<'_, AppState>, original_path: String) -> Result<(), String> {
    let cfg = state.library_config();
    let local_path = paths::resolve_local_path(&original_path, &cfg)
        .ok_or("No local path mapping configured for this asset — set up External Library mapping in Preferences → Library")?;
    let exists_path = local_path.clone();
    let Some(handle) = io_guard::guarded_spawn_blocking(&state.io_guard, move || exists_path.exists()) else {
        return Err("Skipped: system is about to suspend, try again after it wakes".to_string());
    };
    let exists = handle.await.map_err(|e| e.to_string())?;
    if !exists {
        return Err(format!("File not found on disk: {}", local_path.display()));
    }
    crate::open_default::open(&local_path)
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

    let client = ImmichClient::from_config(&cfg, state.http.clone(), &state.auto_resolution).await?;
    client.create_stack(&ids).await
}

#[tauri::command]
pub async fn get_stack(state: State<'_, AppState>, stack_id: String) -> Result<StackInfo, String> {
    let cfg = state.library_config();
    let client = ImmichClient::from_config(&cfg, state.http.clone(), &state.auto_resolution).await?;
    client.get_stack(&stack_id).await
}

#[tauri::command]
pub async fn list_stacks(state: State<'_, AppState>) -> Result<Vec<StackInfo>, String> {
    let cfg = state.library_config();
    let client = ImmichClient::from_config(&cfg, state.http.clone(), &state.auto_resolution).await?;
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

    let client = ImmichClient::from_config(&cfg, state.http.clone(), &state.auto_resolution).await?;
    client.update_stack_primary(&stack_id, &asset_id).await
}

/// Nudges Immich into generating a thumbnail for an asset right away - see
/// `ImmichClient::regenerate_thumbnail`'s doc comment for why this is needed
/// at all (assets discovered via a Library scan, which every round-trip
/// export is, don't reliably get this job auto-queued the way a normal
/// upload does). Called from `roundTrip.ts`'s `ingestRoundTripExport` right
/// after a round-trip export's asset is found; not gated on read-only mode
/// since it doesn't touch anything on disk or any user-visible field, just
/// asks Immich to do work it should already be doing on its own.
#[tauri::command]
pub async fn regenerate_asset_thumbnail(state: State<'_, AppState>, asset_id: String) -> Result<(), String> {
    let cfg = state.library_config();
    let client = ImmichClient::from_config(&cfg, state.http.clone(), &state.auto_resolution).await?;
    client.regenerate_thumbnail(&asset_id).await
}

/// The Viewer's Rotate Left/Right action. A deliberate, narrow exception to
/// this codebase's usual rule of only ever writing to an asset's `.xmp`/
/// `.pp3`/`.arp` *sidecar*, never its original (see `paths.rs`) - see
/// `rotate::rotate_in_place`'s doc comment for why rewriting just the EXIF
/// `Orientation` tag in place is safe to do. Same read-only gate as every
/// other local write here; unlike rating/description this has no sidecar
/// fallback; an asset with no local path mapping configured simply can't be
/// rotated. Returns the new numeric orientation value (1/3/6/8) - not
/// currently used for anything beyond logging/testing, since the frontend
/// relies on a plain cache-bust + Immich thumbnail regen rather than trying
/// to predict the visual rotation itself.
#[tauri::command]
pub async fn rotate_asset(
    state: State<'_, AppState>,
    original_path: Option<String>,
    clockwise: bool,
) -> Result<u16, String> {
    let cfg = state.library_config();
    if cfg.read_only {
        return Err("Read-only mode is on — turn it off in Preferences → Library to rotate photos".into());
    }
    let original_path = original_path.ok_or_else(|| "No file path available for this asset".to_string())?;
    let local_path = paths::resolve_local_path(&original_path, &cfg).ok_or_else(|| {
        "No local library path configured for this asset — set up \"Originals on Disk\" in Preferences → Library to enable rotation".to_string()
    })?;

    let exiftool_path = state.config.lock().unwrap().applications.exiftool_path.clone();
    if exiftool_path.trim().is_empty() {
        return Err("Configure exiftool in Preferences → Applications to enable rotation".into());
    }

    crate::rotate::rotate_in_place(&exiftool_path, &local_path, clockwise).await
}

/// Evicts every cached rendition of one asset from BrightTable's own on-disk
/// thumbnail cache (see `thumb_cache.rs`) - called by the frontend right
/// after `rotate_asset` succeeds, so a stale pre-rotation thumbnail isn't
/// served back out of this cache while Immich's own server-side thumbnail
/// regen is still catching up.
#[tauri::command]
pub fn evict_thumb_cache_for_asset(app: AppHandle, asset_id: String) {
    crate::thumb_cache::evict_asset(&app, &asset_id);
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
    let client = ImmichClient::from_config(&cfg, state.http.clone(), &state.auto_resolution).await?;
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

    let client = ImmichClient::from_config(&cfg, state.http.clone(), &state.auto_resolution).await?;
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
pub async fn list_albums(state: State<'_, AppState>) -> Result<Vec<AlbumSummary>, String> {
    let cfg = state.library_config();
    let client = ImmichClient::from_config(&cfg, state.http.clone(), &state.auto_resolution).await?;
    client.list_albums().await
}

#[tauri::command]
pub async fn get_album(state: State<'_, AppState>, album_id: String) -> Result<AlbumDetail, String> {
    let cfg = state.library_config();
    let client = ImmichClient::from_config(&cfg, state.http.clone(), &state.auto_resolution).await?;
    client.get_album(&album_id).await
}

#[tauri::command]
pub async fn create_album(
    state: State<'_, AppState>,
    name: String,
    asset_ids: Vec<String>,
) -> Result<AlbumDetail, String> {
    let cfg = state.library_config();
    if cfg.read_only {
        return Err(
            "Read-only mode is on — turn it off in Preferences → Library to create an album".into(),
        );
    }
    if asset_ids.len() as u32 > cfg.max_writes_per_batch {
        return Err(format!(
            "This would add {} assets at once, over your cap of {} per action",
            asset_ids.len(),
            cfg.max_writes_per_batch
        ));
    }
    let client = ImmichClient::from_config(&cfg, state.http.clone(), &state.auto_resolution).await?;
    client.create_album(&name, &asset_ids).await
}

#[tauri::command]
pub async fn rename_album(state: State<'_, AppState>, album_id: String, name: String) -> Result<(), String> {
    let cfg = state.library_config();
    if cfg.read_only {
        return Err(
            "Read-only mode is on — turn it off in Preferences → Library to rename an album".into(),
        );
    }
    let client = ImmichClient::from_config(&cfg, state.http.clone(), &state.auto_resolution).await?;
    client.rename_album(&album_id, &name).await
}

#[tauri::command]
pub async fn delete_album(state: State<'_, AppState>, album_id: String) -> Result<(), String> {
    let cfg = state.library_config();
    if cfg.read_only {
        return Err(
            "Read-only mode is on — turn it off in Preferences → Library to delete an album".into(),
        );
    }
    let client = ImmichClient::from_config(&cfg, state.http.clone(), &state.auto_resolution).await?;
    client.delete_album(&album_id).await
}

#[tauri::command]
pub async fn add_assets_to_album(
    state: State<'_, AppState>,
    album_id: String,
    asset_ids: Vec<String>,
) -> Result<(), String> {
    let cfg = state.library_config();
    if cfg.read_only {
        return Err(
            "Read-only mode is on — turn it off in Preferences → Library to add to an album".into(),
        );
    }
    if asset_ids.len() as u32 > cfg.max_writes_per_batch {
        return Err(format!(
            "This would add {} assets at once, over your cap of {} per action",
            asset_ids.len(),
            cfg.max_writes_per_batch
        ));
    }
    let client = ImmichClient::from_config(&cfg, state.http.clone(), &state.auto_resolution).await?;
    client.add_assets_to_album(&album_id, &asset_ids).await
}

#[tauri::command]
pub async fn remove_assets_from_album(
    state: State<'_, AppState>,
    album_id: String,
    asset_ids: Vec<String>,
) -> Result<(), String> {
    let cfg = state.library_config();
    if cfg.read_only {
        return Err(
            "Read-only mode is on — turn it off in Preferences → Library to remove from an album".into(),
        );
    }
    if asset_ids.len() as u32 > cfg.max_writes_per_batch {
        return Err(format!(
            "This would remove {} assets at once, over your cap of {} per action",
            asset_ids.len(),
            cfg.max_writes_per_batch
        ));
    }
    let client = ImmichClient::from_config(&cfg, state.http.clone(), &state.auto_resolution).await?;
    client.remove_assets_from_album(&album_id, &asset_ids).await
}

#[tauri::command]
pub async fn list_people(state: State<'_, AppState>) -> Result<Vec<PersonSummary>, String> {
    let cfg = state.library_config();
    let client = ImmichClient::from_config(&cfg, state.http.clone(), &state.auto_resolution).await?;
    client.list_people().await
}

#[tauri::command]
pub async fn get_person(state: State<'_, AppState>, person_id: String) -> Result<PersonDetail, String> {
    let cfg = state.library_config();
    let client = ImmichClient::from_config(&cfg, state.http.clone(), &state.auto_resolution).await?;
    client.get_person(&person_id).await
}

#[tauri::command]
pub async fn rename_person(state: State<'_, AppState>, person_id: String, name: String) -> Result<(), String> {
    let cfg = state.library_config();
    if cfg.read_only {
        return Err(
            "Read-only mode is on — turn it off in Preferences → Library to rename a person".into(),
        );
    }
    let client = ImmichClient::from_config(&cfg, state.http.clone(), &state.auto_resolution).await?;
    client.rename_person(&person_id, &name).await
}

#[tauri::command]
pub async fn list_tags(state: State<'_, AppState>) -> Result<Vec<TagSummary>, String> {
    let cfg = state.library_config();
    let client = ImmichClient::from_config(&cfg, state.http.clone(), &state.auto_resolution).await?;
    client.list_tags().await
}

#[tauri::command]
pub async fn get_tag(state: State<'_, AppState>, tag_id: String) -> Result<TagDetail, String> {
    let cfg = state.library_config();
    let client = ImmichClient::from_config(&cfg, state.http.clone(), &state.auto_resolution).await?;
    client.get_tag(&tag_id).await
}

#[tauri::command]
pub async fn create_tag(
    state: State<'_, AppState>,
    name: String,
    color: Option<String>,
) -> Result<TagSummary, String> {
    let cfg = state.library_config();
    if cfg.read_only {
        return Err(
            "Read-only mode is on — turn it off in Preferences → Library to create a tag".into(),
        );
    }
    let client = ImmichClient::from_config(&cfg, state.http.clone(), &state.auto_resolution).await?;
    client.create_tag(&name, color.as_deref()).await
}

#[tauri::command]
pub async fn delete_tag(state: State<'_, AppState>, tag_id: String) -> Result<(), String> {
    let cfg = state.library_config();
    if cfg.read_only {
        return Err(
            "Read-only mode is on — turn it off in Preferences → Library to delete a tag".into(),
        );
    }
    let client = ImmichClient::from_config(&cfg, state.http.clone(), &state.auto_resolution).await?;
    client.delete_tag(&tag_id).await
}

#[tauri::command]
pub async fn tag_assets(
    state: State<'_, AppState>,
    tag_id: String,
    asset_ids: Vec<String>,
) -> Result<(), String> {
    let cfg = state.library_config();
    if cfg.read_only {
        return Err(
            "Read-only mode is on — turn it off in Preferences → Library to tag photos".into(),
        );
    }
    if asset_ids.len() as u32 > cfg.max_writes_per_batch {
        return Err(format!(
            "This would tag {} assets at once, over your cap of {} per action",
            asset_ids.len(),
            cfg.max_writes_per_batch
        ));
    }
    let client = ImmichClient::from_config(&cfg, state.http.clone(), &state.auto_resolution).await?;
    client.tag_assets(&tag_id, &asset_ids).await
}

#[tauri::command]
pub async fn untag_assets(
    state: State<'_, AppState>,
    tag_id: String,
    asset_ids: Vec<String>,
) -> Result<(), String> {
    let cfg = state.library_config();
    if cfg.read_only {
        return Err(
            "Read-only mode is on — turn it off in Preferences → Library to untag photos".into(),
        );
    }
    if asset_ids.len() as u32 > cfg.max_writes_per_batch {
        return Err(format!(
            "This would untag {} assets at once, over your cap of {} per action",
            asset_ids.len(),
            cfg.max_writes_per_batch
        ));
    }
    let client = ImmichClient::from_config(&cfg, state.http.clone(), &state.auto_resolution).await?;
    client.untag_assets(&tag_id, &asset_ids).await
}

#[tauri::command]
pub async fn search_assets(state: State<'_, AppState>, query: String) -> Result<Vec<AssetSummary>, String> {
    let cfg = state.library_config();
    let client = ImmichClient::from_config(&cfg, state.http.clone(), &state.auto_resolution).await?;
    client.search_smart(&query).await
}

#[tauri::command]
pub async fn get_asset(state: State<'_, AppState>, asset_id: String) -> Result<AssetSummary, String> {
    let cfg = state.library_config();
    let client = ImmichClient::from_config(&cfg, state.http.clone(), &state.auto_resolution).await?;
    client.get_asset(&asset_id).await
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

/// Bounds how long `scan_import_source`/`check_import_duplicates`/
/// `start_import` will wait on their blocking work before giving up and
/// returning an error - all three touch a user-chosen source/destination
/// folder that can be an unreachable NFS/network mount, which can otherwise
/// hang the underlying blocking task forever (found live: the Import
/// dialog's "Scanning…"/"Starting…" button never resolving, with the OS
/// eventually reporting the app itself as not responding). The abandoned
/// task still leaks a blocking-pool thread on timeout, but the command
/// itself returns promptly either way.
///
/// Different budgets: `scan_import_source` itself is now cheap (a
/// directory walk plus an EXIF-header read per file, no hashing - see
/// `scan.rs`), but `check_import_duplicates` hashes every file it's given
/// (up to ~4MB each, see `hash.rs`), which for a large date-range selection
/// over a slow USB2 reader can legitimately take minutes even when nothing's
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

fn summarize(groups: Vec<ScannedGroup>) -> ImportScanSummary {
    let already_imported_count = groups.iter().filter(|g| g.already_imported).count();
    let paired_count = groups.iter().filter(|g| g.files.len() > 1).count();
    let total_files = groups.iter().map(|g| g.files.len()).sum();
    ImportScanSummary {
        new_count: groups.len() - already_imported_count,
        already_imported_count,
        paired_count,
        total_files,
        groups,
    }
}

/// Scans the chosen source folder - a directory walk plus, per file, a
/// cheap stat and an EXIF-header-only read for capture time (see
/// `capture_time.rs`). Deliberately does **not** hash anything yet, so
/// `alreadyImportedCount` is always 0 here - real dedupe checking happens
/// in `check_import_duplicates`, run only over whatever subset (typically a
/// user-narrowed date range) is actually about to be imported. Splitting
/// this out is what makes the "date range first, hash second" flow fast:
/// hashing every file on a full card up front (the old, single-step
/// behavior) meant paying the slow part even for the 95% of files the user
/// only wanted to skip past.
///
/// Runs through `io_guard::guarded_spawn_blocking`, not directly on the
/// calling task - even without hashing, a full recursive directory walk
/// plus an EXIF read of every file it finds is real blocking work for a
/// card with thousands of files. Without this, that work ran straight on
/// the async runtime's worker thread, starving the IPC channel long enough
/// that the OS reported the whole app as not responding - a real bug found
/// live, not a hypothetical.
#[tauri::command]
pub async fn scan_import_source(state: State<'_, AppState>, source_path: String) -> Result<ImportScanSummary, String> {
    let source_display = source_path.clone();
    let Some(handle) = io_guard::guarded_spawn_blocking(&state.io_guard, move || -> Result<ImportScanSummary, String> {
        let groups = import::scan_source(std::path::Path::new(&source_path))?;
        Ok(summarize(groups))
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

/// The other half of `scan_import_source`: hashes every file in the given
/// groups (skipping any that already have a hash - see `hash_groups`) and
/// marks which are already fully imported, checked against the queue's own
/// in-memory dedupe cache (not a fresh disk read of `import_history.json` -
/// the queue may hold very recent completions not yet flushed there, see
/// `queue.rs`'s debounced save). Meant to be called with a subset of a
/// prior `scan_import_source` result - typically whatever the user's date
/// range narrowed down to - not the full scan, so the expensive part only
/// runs over files actually in play. Returns the same groups back with
/// `partialHash`/`alreadyImported` now filled in, so `start_import` doesn't
/// need a second scan/hash pass over what could be a slow card reader.
#[tauri::command]
pub async fn check_import_duplicates(state: State<'_, AppState>, groups: Vec<ScannedGroup>) -> Result<ImportScanSummary, String> {
    let queue = state.import_queue.clone();
    let Some(handle) = io_guard::guarded_spawn_blocking(&state.io_guard, move || -> ImportScanSummary {
        let mut groups = groups;
        import::hash_groups(&mut groups);
        queue.mark_already_imported(&mut groups);
        summarize(groups)
    }) else {
        return Err("Skipped: system is about to suspend, try again after it wakes".to_string());
    };
    match tokio::time::timeout(IMPORT_SCAN_TIMEOUT, handle).await {
        Ok(join_result) => Ok(join_result.map_err(|e| e.to_string())?),
        Err(_) => Err(format!(
            "Timed out after {}s checking for duplicates — check the source is actually connected/reachable",
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
    let client = ImmichClient::from_config(&cfg, state.http.clone(), &state.auto_resolution).await?;
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
    let client = ImmichClient::from_config(&cfg, state.http.clone(), &state.auto_resolution).await?;
    client.get_unique_folder_paths().await
}

/// GET /view/folder?path=X - direct-child assets of one exact real folder.
#[tauri::command]
pub async fn get_folder_assets(state: State<'_, AppState>, path: String) -> Result<Vec<AssetSummary>, String> {
    let cfg = state.library_config();
    let client = ImmichClient::from_config(&cfg, state.http.clone(), &state.auto_resolution).await?;
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
    /// sidecar (`.arp`/`.pp3`) *or* darktable `.xmp`-embedded history on disk
    /// - piggybacked onto this same already-running per-bucket scan so **Copy
    /// Image Processing** can be enabled/disabled without a separate round
    /// trip per tile. Independent of `rating`/`description`: a result can
    /// carry `true` here with both of those `None` (metadata already in
    /// sync, but a processing sidecar still exists) - the frontend must not
    /// conflate this with the unsynced-metadata badge. Kept as a plain
    /// boolean (rather than folded into `processing_sidecar_tools` below)
    /// since most of its many call sites only ever need "does anything
    /// exist," not which tool.
    pub has_processing_sidecar: bool,
    /// Which tools specifically (`ProcessingSource::tool` for every entry
    /// `paths::find_all_processing_sources` finds) - a sibling of
    /// `has_processing_sidecar` above rather than a replacement, added only
    /// for **Copy Image Processing** to remember at copy time which tools'
    /// settings it's about to capture (for the paste confirm dialog's
    /// wording) - see `lib/clipboard.tsx`'s `CopiedProcessingSource.tools`.
    pub processing_sidecar_tools: Vec<RawConverterKind>,
}

/// Read-only, best-effort batch check - "no sidecar/embedded metadata" is
/// the overwhelmingly common outcome for most assets, not a failure, so
/// per-asset misses just don't appear in the result rather than erroring.
/// Only a structural precondition (no local path mapping configured at all)
/// short-circuits with a real error, to avoid doing N pointless resolve
/// attempts per bucket fetch when this feature isn't set up yet.
///
/// Also reports `processing_sidecar_tools` per asset (see
/// `MetadataSyncResult`) so **Copy Image Processing**'s enablement can
/// piggyback on this same scan instead of a separate per-tile round trip -
/// unrelated to the rating/description sync this command otherwise exists
/// for.
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
///
/// Called once per timeline bucket/folder as it loads, with no queue of its
/// own - `io_guard.acquire_metadata_scan_permit()` below is what actually
/// bounds how many of these run at once (see its own doc comment for why:
/// confirmed live that an unbounded burst of these across a large library
/// saturated the NFS mount for minutes). Acquired before `guarded_spawn_blocking`
/// so a caller waiting on a full semaphore doesn't also count as one more
/// `io_guard`-tracked in-flight call the whole time it's merely queued.
#[tauri::command]
pub async fn check_sidecar_metadata(
    state: State<'_, AppState>,
    queries: Vec<MetadataSyncQuery>,
) -> Result<Vec<MetadataSyncResult>, String> {
    let cfg = state.library_config();
    if cfg.immich_root.trim().is_empty() && cfg.uploaded_immich_root.trim().is_empty() {
        return Err("No local path mapping configured".into());
    }
    let _permit = state.io_guard.acquire_metadata_scan_permit().await;
    let Some(handle) = io_guard::guarded_spawn_blocking(&state.io_guard, move || {
        queries
            .into_iter()
            .filter_map(|q| {
                let local = paths::resolve_local_path(q.original_path.as_deref()?, &cfg)?;
                let detected = paths::read_asset_metadata(&local);
                let current_description = q.current_description.filter(|s| !s.trim().is_empty());
                let rating = detected.rating.filter(|r| Some(*r) != q.current_rating);
                let description = detected.description.filter(|d| Some(d) != current_description.as_ref());
                let processing_sidecar_tools: Vec<RawConverterKind> =
                    paths::find_all_processing_sources(&local).iter().map(|s| s.tool()).collect();
                let has_processing_sidecar = !processing_sidecar_tools.is_empty();
                (rating.is_some() || description.is_some() || has_processing_sidecar).then_some(MetadataSyncResult {
                    asset_id: q.asset_id,
                    rating,
                    description,
                    has_processing_sidecar,
                    processing_sidecar_tools,
                })
            })
            .collect::<Vec<_>>()
    }) else {
        // Suspend imminent - same "nothing detected this round" shape
        // callers already treat as a normal per-query outcome.
        return Ok(Vec::new());
    };
    // Bounded the same way as `batch_raw_cli_round_trip`'s own export-path
    // scan (`ROUND_TRIP_EXPORT_PATH_TIMEOUT`) - without this, a stat() stuck
    // on an unreachable NFS mount left this `await` pending forever. Confirmed
    // live: that hung `confirmBatchArtRoundTrip`'s dialog indefinitely with
    // Cancel disabled the whole time, since `ConfirmDialog` only re-enables
    // Cancel once its `onConfirm` promise settles one way or the other.
    // Every frontend caller already `.catch()`s this call and falls back to
    // "nothing detected this round", so erroring out here on timeout is safe.
    match tokio::time::timeout(ROUND_TRIP_EXPORT_PATH_TIMEOUT, handle).await {
        Ok(join_result) => join_result.map_err(|e| e.to_string()),
        Err(_) => Err(format!(
            "Timed out after {}s checking for sidecars — check your library's local mount is actually connected/reachable",
            ROUND_TRIP_EXPORT_PATH_TIMEOUT.as_secs()
        )),
    }
}

/// Current process's resident memory and CPU load, for the Sidebar's rolling
/// resource chart - a lightweight live readout, not a profiler. `cpu_percent`
/// is normalized to 0-100 of total system capacity (raw `Process::cpu_usage`
/// is 100 per core); `ram_percent` is RSS as a fraction of total system RAM.
/// Reuses `AppState::resource_monitor`'s `System` across calls, since
/// `Process::cpu_usage()` needs a previous sample to diff against - a fresh
/// `System` every call would always read 0.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceUsage {
    pub rss_bytes: u64,
    pub ram_percent: f32,
    pub cpu_percent: f32,
}

#[tauri::command]
pub fn get_resource_usage(state: State<AppState>) -> ResourceUsage {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate};
    let pid = sysinfo::get_current_pid().unwrap_or(Pid::from(0));
    let mut sys = state.resource_monitor.lock().unwrap();
    sys.refresh_memory();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        false,
        ProcessRefreshKind::nothing().with_memory().with_cpu(),
    );
    let process = sys.process(pid);
    let rss_bytes = process.map(|p| p.memory()).unwrap_or(0);
    let raw_cpu = process.map(|p| p.cpu_usage()).unwrap_or(0.0);
    let cpu_percent = raw_cpu / state.num_cpus as f32;
    let total_bytes = sys.total_memory();
    let ram_percent = if total_bytes > 0 {
        rss_bytes as f32 / total_bytes as f32 * 100.0
    } else {
        0.0
    };
    ResourceUsage { rss_bytes, ram_percent, cpu_percent }
}

/// Preferences → Configuration's "Thumbnail Cache" panel - reports the
/// on-disk cache's location/size so the user has some visibility into a
/// folder that otherwise silently grows forever in the background.
#[tauri::command]
pub async fn get_thumb_cache_info(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<crate::thumb_cache::ThumbCacheStats, String> {
    let Some(handle) = io_guard::guarded_spawn_blocking(&state.io_guard, move || crate::thumb_cache::stats(&app))
    else {
        return Err("Skipped: system is about to suspend, try again after it wakes".to_string());
    };
    handle.await.map_err(|e| e.to_string())
}

/// Wipes the on-disk thumbnail cache. Fully recoverable - every entry just
/// gets refetched from the server the next time its thumbnail is viewed.
#[tauri::command]
pub async fn clear_thumb_cache(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<crate::thumb_cache::ThumbCacheStats, String> {
    let app2 = app.clone();
    let Some(handle) = io_guard::guarded_spawn_blocking(&state.io_guard, move || {
        crate::thumb_cache::clear(&app2)?;
        Ok::<_, std::io::Error>(crate::thumb_cache::stats(&app2))
    }) else {
        return Err("Skipped: system is about to suspend, try again after it wakes".to_string());
    };
    handle.await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------
// Sharing & Export (Export to Folder / Export to Flickr) - see
// `export_queue.rs`/`flickr.rs` for the background queue and OAuth client
// these commands drive.
// ---------------------------------------------------------------------

#[tauri::command]
pub fn save_sharing_config(app: AppHandle, state: State<AppState>, cfg: SharingConfig) -> Result<AppConfig, String> {
    let mut guard = state.config.lock().unwrap();
    guard.sharing = cfg;
    config::save(&app, &guard)?;
    Ok(guard.clone())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlickrBeginAuthResult {
    pub authorize_url: String,
    pub oauth_token: String,
    pub oauth_token_secret: String,
}

/// First two legs of the wizard (`FlickrSetupDialog.tsx`'s Step 0 -> Step 1):
/// gets a request token, then hands back the URL to open in the system
/// browser. Doesn't touch `config.json` yet - the frontend holds the request
/// token pair in memory until `flickr_complete_auth` succeeds, mirroring how
/// the request token is genuinely worthless without a verifier anyway.
#[tauri::command]
pub async fn flickr_begin_auth(state: State<'_, AppState>, api_key: String, api_secret: String) -> Result<FlickrBeginAuthResult, String> {
    if api_key.trim().is_empty() || api_secret.trim().is_empty() {
        return Err("Enter your API key and shared secret".to_string());
    }
    let (oauth_token, oauth_token_secret) = flickr::request_token(&state.http, &api_key, &api_secret).await?;
    let authorize_url = flickr::authorize_url(&oauth_token);
    Ok(FlickrBeginAuthResult { authorize_url, oauth_token, oauth_token_secret })
}

/// Final leg (Step 2 -> Step 3): exchanges the request token + the
/// verification code the user pasted back in for a real access token, then
/// persists the whole connected `FlickrConfig` (credentials + access token +
/// account) to `config.json`.
#[tauri::command]
pub async fn flickr_complete_auth(
    app: AppHandle,
    state: State<'_, AppState>,
    api_key: String,
    api_secret: String,
    oauth_token: String,
    oauth_token_secret: String,
    verifier: String,
) -> Result<AppConfig, String> {
    let auth = flickr::access_token(&state.http, &api_key, &api_secret, &oauth_token, &oauth_token_secret, &verifier).await?;
    let mut guard = state.config.lock().unwrap();
    guard.sharing.flickr.api_key = api_key;
    guard.sharing.flickr.api_secret = api_secret;
    guard.sharing.flickr.oauth_token = auth.oauth_token;
    guard.sharing.flickr.oauth_token_secret = auth.oauth_token_secret;
    guard.sharing.flickr.user_nsid = auth.user_nsid;
    guard.sharing.flickr.username = auth.username;
    guard.sharing.flickr.connected = true;
    config::save(&app, &guard)?;
    Ok(guard.clone())
}

#[tauri::command]
pub fn flickr_disconnect(app: AppHandle, state: State<AppState>) -> Result<AppConfig, String> {
    let mut guard = state.config.lock().unwrap();
    guard.sharing.flickr = Default::default();
    config::save(&app, &guard)?;
    Ok(guard.clone())
}

#[tauri::command]
pub async fn flickr_list_albums(state: State<'_, AppState>) -> Result<Vec<flickr::FlickrAlbum>, String> {
    let flickr_cfg = state.config.lock().unwrap().sharing.flickr.clone();
    if !flickr_cfg.connected {
        return Err("Flickr isn't connected — go to Preferences → Sharing to set it up".to_string());
    }
    flickr::list_albums(&state.http, &flickr_cfg).await
}

/// One asset to export - mirrors `ArtRoundTripTarget`, the same shape the
/// frontend already builds for the ART CLI round trip.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportAssetTarget {
    pub id: String,
    pub original_path: Option<String>,
    pub file_name: String,
    pub file_extension: String,
    /// Whether this asset is RAW - computed by the frontend's `isRawAsset()`
    /// rather than re-derived here from `file_extension` alone, since only
    /// the frontend knows about a per-asset `isRawOverride` exception
    /// (`app/src/lib/rawOverrides.tsx`) that this command has no visibility
    /// into. Only changes behavior for `format: 'jpeg'`, where `true` routes
    /// through a headless `ART-cli` conversion instead of Immich's `preview`
    /// rendition - see `export_queue::resolve_rendition`.
    pub is_raw: bool,
    /// Whether this asset is a video (frontend's `asset.type === 'VIDEO'`).
    /// There's no JPEG rendition of a video, so `true` here always delivers
    /// the true original file regardless of the chosen `format` - see
    /// `export_queue::resolve_rendition`.
    pub is_video: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderExportOptions {
    pub destination: String,
    pub format: ExportFormat,
    pub size_px: Option<u32>,
    pub quality: u8,
    pub metadata: MetadataPolicy,
}

/// Whether the chosen format/metadata-policy combination needs `exiftool` at
/// all - `format`/`metadata` are single options for the whole dialog/batch
/// (not per-asset, unlike RAW conversion's per-asset `ART-cli` need), so this
/// is checked once up front rather than per job. Two combinations need no
/// `exiftool` call regardless of whether it's configured: `Original` +
/// `Keep` (the exported bytes already are the untouched original) and
/// `Jpeg` + `StripAll` (the `image`-crate re-encode in `encode_jpeg_rendition`
/// already drops all metadata as a side effect - see
/// `export_queue::apply_metadata_policy`'s identical reasoning).
fn needs_exiftool(format: ExportFormat, metadata: MetadataPolicy) -> bool {
    !matches!((format, metadata), (ExportFormat::Original, MetadataPolicy::Keep) | (ExportFormat::Jpeg, MetadataPolicy::StripAll))
}

const EXIFTOOL_NOT_CONFIGURED: &str =
    "Configure exiftool in Preferences → Applications to use this metadata option (or choose \"Strip all metadata\", which needs no configuration)";

/// Export to Folder: writes a rendition of every target asset into
/// `options.destination`, one `ExportJob` per asset. Deliberately skips the
/// read-only gate (same reasoning as `launch_editor`: this touches no
/// Immich data at all, only reads it) but keeps the `max_writes_per_batch`
/// cap, as a sane guard against an accidental "export the whole library"
/// click hammering disk/network all at once.
#[tauri::command]
pub async fn export_to_folder(state: State<'_, AppState>, assets: Vec<ExportAssetTarget>, options: FolderExportOptions) -> Result<Vec<u64>, String> {
    let cfg = state.library_config();
    if assets.len() as u32 > cfg.max_writes_per_batch {
        return Err(format!("This would export {} assets at once, over your cap of {} per action", assets.len(), cfg.max_writes_per_batch));
    }
    if options.destination.trim().is_empty() {
        return Err("Choose a destination folder".to_string());
    }
    if needs_exiftool(options.format, options.metadata) && state.config.lock().unwrap().applications.exiftool_path.trim().is_empty() {
        return Err(EXIFTOOL_NOT_CONFIGURED.to_string());
    }
    let destination = PathBuf::from(options.destination);
    let quality = options.quality.clamp(1, 100);
    let size_px = match options.format {
        ExportFormat::Original => None,
        ExportFormat::Jpeg => options.size_px,
    };

    let targets: Vec<ExportTarget> = assets
        .into_iter()
        .map(|a| ExportTarget {
            asset_id: a.id,
            original_path: a.original_path,
            file_name: a.file_name,
            file_extension: a.file_extension,
            is_raw: a.is_raw,
            is_video: a.is_video,
            rendition: RenditionOptions { format: options.format, size_px, quality, metadata: options.metadata },
            delivery: ExportDelivery::Folder { destination: destination.clone() },
        })
        .collect();
    Ok(state.export_queue.enqueue(targets))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum FlickrAlbumSelection {
    None,
    Existing { id: String },
    New { title: String },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlickrExportOptions {
    pub album: FlickrAlbumSelection,
    pub privacy: FlickrPrivacy,
    pub format: ExportFormat,
    pub size_px: Option<u32>,
    pub quality: u8,
    pub metadata: MetadataPolicy,
}

/// Export to Flickr (Share to Flickr…): uploads every target asset, one
/// `ExportJob` each, then links each into the chosen album - see
/// `export_queue::FlickrAlbumChoice::New`'s doc comment for how a brand-new
/// album's id is agreed on across the whole batch. Each photo's Flickr title
/// defaults to its filename's base (no extension), mirroring the filename
/// the same asset would get in an Export to Folder.
#[tauri::command]
pub async fn export_to_flickr(state: State<'_, AppState>, assets: Vec<ExportAssetTarget>, options: FlickrExportOptions) -> Result<Vec<u64>, String> {
    let cfg = state.library_config();
    if assets.len() as u32 > cfg.max_writes_per_batch {
        return Err(format!("This would share {} assets at once, over your cap of {} per action", assets.len(), cfg.max_writes_per_batch));
    }
    if !state.config.lock().unwrap().sharing.flickr.connected {
        return Err("Flickr isn't connected — go to Preferences → Sharing to set it up".to_string());
    }
    if needs_exiftool(options.format, options.metadata) && state.config.lock().unwrap().applications.exiftool_path.trim().is_empty() {
        return Err(EXIFTOOL_NOT_CONFIGURED.to_string());
    }
    let quality = options.quality.clamp(1, 100);
    let size_px = match options.format {
        ExportFormat::Original => None,
        ExportFormat::Jpeg => options.size_px,
    };
    let album = match options.album {
        FlickrAlbumSelection::None => FlickrAlbumChoice::None,
        FlickrAlbumSelection::Existing { id } => FlickrAlbumChoice::Existing(id),
        FlickrAlbumSelection::New { title } => FlickrAlbumChoice::New { title, cell: Arc::new(tokio::sync::Mutex::new(None)) },
    };

    let targets: Vec<ExportTarget> = assets
        .into_iter()
        .map(|a| {
            let title = export_naming::base_name(&a.file_name, &a.file_extension).to_string();
            ExportTarget {
                asset_id: a.id,
                original_path: a.original_path,
                file_name: a.file_name,
                file_extension: a.file_extension,
                is_raw: a.is_raw,
                is_video: a.is_video,
                rendition: RenditionOptions { format: options.format, size_px, quality, metadata: options.metadata },
                delivery: ExportDelivery::Flickr { title, privacy: options.privacy, album: album.clone() },
            }
        })
        .collect();
    Ok(state.export_queue.enqueue(targets))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportQueueStatus {
    pub jobs: Vec<ExportJob>,
    pub pending_count: usize,
}

#[tauri::command]
pub fn get_export_queue_status(state: State<AppState>) -> ExportQueueStatus {
    ExportQueueStatus { jobs: state.export_queue.snapshot(), pending_count: state.export_queue.pending_count() }
}

#[tauri::command]
pub fn cancel_export_job(state: State<AppState>, job_id: u64) -> bool {
    state.export_queue.request_cancel(job_id)
}

#[tauri::command]
pub fn clear_completed_export_jobs(state: State<AppState>) {
    state.export_queue.clear_completed();
}

/// Real OS printer enumeration (see `print.rs`'s module doc comment for the
/// CUPS-CLI-shelling approach and its Linux/macOS-only scope).
#[tauri::command]
pub async fn list_printers() -> Vec<print::Printer> {
    print::list_printers().await
}

/// Prints a single (non-RAW) asset. Single-asset only - no batch/multi-select
/// printing in v1, matching the design mockup's own `printTargetAsset()`
/// scope. RAW assets are rejected outright: unlike Export to Folder, there's
/// no ART-cli conversion path for Print at all, so `asset.is_raw` (trusted
/// from the frontend's `isRawAsset()`, same shape as `ExportAssetTarget`) is
/// a hard error here rather than a routing decision - the frontend's entry
/// points (menu item, context menu, Viewer button) are expected to keep this
/// from being reachable in the common case; this is defense in depth.
#[tauri::command]
pub async fn print_asset(state: State<'_, AppState>, asset: print::PrintAssetTarget, options: print::PrintOptions) -> Result<(), String> {
    if asset.is_raw {
        return Err("RAW photos can't be printed yet — open the edited version or export a JPEG first".to_string());
    }
    let copies = options.copies.clamp(1, 99);
    let options = print::PrintOptions { copies, ..options };

    let cfg = state.library_config();
    let (bytes, _filename) = {
        let immich = ImmichClient::from_config(&cfg, state.http.clone(), &state.auto_resolution).await?;
        export_queue::fetch_true_original(&immich, &cfg, &asset.id, &asset.original_path, &asset.file_name).await?
    };

    let paper_w = options.paper_width_in;
    let paper_h = options.paper_height_in;
    let image_w = options.image_width_in;
    let image_h = options.image_height_in;
    let dpi = options.dpi;
    let fit_mode = options.fit_mode;
    let composited = tokio::task::spawn_blocking(move || print::composite_for_print(&bytes, paper_w, paper_h, image_w, image_h, dpi, fit_mode))
        .await
        .map_err(|e| e.to_string())??;

    submit_composited_print(composited, &asset.id, &options).await
}

/// Prints the synthetic calibration target from `print::generate_test_pattern`
/// with the given printer/paper/dpi/orientation/fit-mode options - same
/// `submit_composited_print` tail as `print_asset`, just skipping the
/// Immich fetch and routing through `composite_test_pattern_for_print`
/// instead. Lets a placement/scale bug be diagnosed against a known,
/// EXIF-free reference image rather than a specific photo.
#[tauri::command]
pub async fn print_test_pattern(options: print::PrintOptions) -> Result<(), String> {
    let copies = options.copies.clamp(1, 99);
    let options = print::PrintOptions { copies, ..options };
    let opts_for_compositing = options.clone();
    let composited = tokio::task::spawn_blocking(move || print::composite_test_pattern_for_print(&opts_for_compositing)).await.map_err(|e| e.to_string())??;
    submit_composited_print(composited, "test-pattern", &options).await
}

/// Shared tail of `print_asset`/`print_test_pattern`: write the already-
/// composited JPEG to a temp file, hand it to `lp` via `submit_print_job`,
/// then clean up regardless of whether submission succeeded.
async fn submit_composited_print(composited: Vec<u8>, id_for_tempfile: &str, options: &print::PrintOptions) -> Result<(), String> {
    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let temp_path = std::env::temp_dir().join(format!("brighttable-print-{id_for_tempfile}-{ts}.pdf"));
    let write_path = temp_path.clone();
    tokio::task::spawn_blocking(move || std::fs::write(&write_path, &composited))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("Could not write temporary print file: {e}"))?;

    let result = print::submit_print_job(&temp_path, options).await;
    let cleanup_path = temp_path.clone();
    let _ = tokio::task::spawn_blocking(move || std::fs::remove_file(&cleanup_path)).await;
    result
}

#[cfg(test)]
mod export_metadata_tests {
    use super::*;

    // The only two combinations that need no `exiftool` at all - see
    // `needs_exiftool`'s own doc comment for why.
    #[test]
    fn needs_exiftool_is_false_for_original_keep_and_jpeg_strip_all() {
        assert!(!needs_exiftool(ExportFormat::Original, MetadataPolicy::Keep));
        assert!(!needs_exiftool(ExportFormat::Jpeg, MetadataPolicy::StripAll));
    }

    #[test]
    fn needs_exiftool_is_true_for_every_other_combination() {
        assert!(needs_exiftool(ExportFormat::Original, MetadataPolicy::RemoveGps));
        assert!(needs_exiftool(ExportFormat::Original, MetadataPolicy::StripAll));
        assert!(needs_exiftool(ExportFormat::Jpeg, MetadataPolicy::Keep));
        assert!(needs_exiftool(ExportFormat::Jpeg, MetadataPolicy::RemoveGps));
    }
}
