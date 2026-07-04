use tauri::{AppHandle, State};

use crate::config::{self, AppConfig, LibraryConfig};
use crate::immich::models::{AssetSummary, ConnectionStatus, TimeBucketInfo};
use crate::immich::ImmichClient;
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
pub async fn delete_assets(state: State<'_, AppState>, ids: Vec<String>) -> Result<(), String> {
    let cfg = state.library_config();
    if cfg.read_only {
        return Err(
            "Read-only mode is on — turn it off in Preferences → Library to allow deletes"
                .into(),
        );
    }

    let requested = ids.len() as u32;
    {
        let mut deleted = state.session_deleted.lock().unwrap();
        if *deleted + requested > cfg.max_delete_per_session {
            return Err(format!(
                "This would exceed your per-session delete cap ({} of {} already used, cap {})",
                *deleted, *deleted + requested, cfg.max_delete_per_session
            ));
        }
        *deleted += requested;
    }

    let client = ImmichClient::from_config(&cfg, state.http.clone())?;
    if let Err(e) = client.delete_assets(&ids, false).await {
        // Roll back the reservation - the delete didn't actually happen.
        let mut deleted = state.session_deleted.lock().unwrap();
        *deleted = deleted.saturating_sub(requested);
        return Err(e);
    }
    Ok(())
}
