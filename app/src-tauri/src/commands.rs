use std::collections::HashMap;
use tauri::{AppHandle, State};

use crate::config::{self, AppConfig, LibraryConfig, SmartStackSettings};
use crate::immich::models::{AssetSummary, ConnectionStatus, StackInfo, TimeBucketInfo};
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

#[tauri::command]
pub async fn update_asset_metadata(
    state: State<'_, AppState>,
    ids: Vec<String>,
    rating: Option<i32>,
    is_favorite: Option<bool>,
    description: Option<String>,
) -> Result<(), String> {
    let cfg = state.library_config();
    if cfg.read_only {
        return Err(
            "Read-only mode is on — turn it off in Preferences → Library to allow edits".into(),
        );
    }
    if ids.len() as u32 > cfg.max_writes_per_batch {
        return Err(format!(
            "This would edit {} assets at once, over your cap of {} per action",
            ids.len(),
            cfg.max_writes_per_batch
        ));
    }

    let client = ImmichClient::from_config(&cfg, state.http.clone())?;
    let mut succeeded = 0u32;
    for id in &ids {
        if let Err(e) = client
            .update_asset(id, rating, is_favorite, description.as_deref())
            .await
        {
            return Err(format!(
                "{e} ({succeeded} of {} updated before this failure)",
                ids.len()
            ));
        }
        succeeded += 1;
    }
    Ok(())
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
