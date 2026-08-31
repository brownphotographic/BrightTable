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

mod apps;
mod art;
mod art_queue;
mod asset_locks;
mod cli_process;
mod commands;
mod config;
mod darktable;
mod edit_queue;
mod embedded;
mod export_naming;
mod export_queue;
mod exiftool;
mod flatpak;
mod flickr;
mod immich;
mod import;
mod io_guard;
mod open_default;
mod paths;
mod print;
mod processing_queue;
mod protocol;
mod rawtherapee;
mod reveal;
mod rotate;
mod round_trip;
mod secure_store;
mod stack_queue;
mod state;
#[cfg(target_os = "linux")]
mod suspend_guard;
mod thumb_cache;
mod xmp;

use state::AppState;
use tauri::{Emitter, Manager};

/// Renames `old` to `new` in place, but only if `new` doesn't already exist
/// and `old` does - a no-op once the migration has happened once, and a
/// no-op for fresh installs that never had `old` in the first place.
/// Best-effort: a failed rename (e.g. cross-device) is logged and otherwise
/// ignored rather than treated as fatal, since worst case is a fresh
/// `new` gets created later with no history rather than the app failing to
/// start.
fn migrate_legacy_dir(old: &std::path::Path, new: &std::path::Path, what: &str) {
    if new.exists() || !old.exists() {
        return;
    }
    match std::fs::rename(old, new) {
        Ok(()) => log::info!("migrated legacy {what} dir {old:?} -> {new:?}"),
        Err(e) => log::warn!("failed to migrate legacy {what} dir {old:?} -> {new:?}: {e}"),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            // One-time migration from the app's former identity ("ImmAture",
            // identifier `com.immature.desktop`) to "BrightTable" - renames
            // the old OS app-config dir in place if the new one doesn't
            // exist yet, so upgrading users keep their config.json instead
            // of silently falling back to defaults.
            if let (Ok(new_config_dir), Ok(base_config_dir)) =
                (app.path().app_config_dir(), app.path().config_dir())
            {
                migrate_legacy_dir(
                    &base_config_dir.join("com.immature.desktop"),
                    &new_config_dir,
                    "app-config",
                );
            }
            // `settingsFolder`/`shareVault` live inside config.json, but the
            // vault has to be opened before `config::load` can read it for
            // real - `resolve_early_config` peeks just those two fields via
            // the same pointer-stub chain `load` follows below, so the vault
            // (opened on a background thread - see below) can be opened from
            // the right place once it's ready.
            let (settings_folder, share_vault) = config::resolve_early_config(app.handle());
            let vault_dir: Option<std::path::PathBuf> = if share_vault { settings_folder } else { None };
            // Loaded without the vault for now (see the vault's own opening
            // below for why) - any secret fields (Immich API key, Flickr
            // tokens) come from whatever config.json itself currently holds
            // for them in the meantime: blank/stale once they've migrated
            // into the vault, same as this app's pre-vault behavior. Once the
            // background open below finishes it overlays the real values
            // onto `AppState`'s config directly and emits `vault-ready`, which
            // `LibraryStatusProvider` on the frontend listens for to re-check
            // the connection rather than staying stuck on a stale failure.
            let cfg = config::load(app.handle(), None);
            // Shared between EditQueue and ProcessingQueue - see
            // `asset_locks.rs`'s own doc comment for why the two queues need
            // to serialize against each other now, not just against
            // themselves.
            let asset_locks = asset_locks::AssetLocks::new();
            let (edit_queue, edit_queue_rx) = edit_queue::EditQueue::new(asset_locks.clone());
            // Lives under the External Library's own local mount (a hidden
            // `.brighttable` subdir), not the OS app-config dir - the whole
            // point of the dedupe cache is "have I already imported this
            // file", and for anyone running BrightTable from more than one
            // computer against the same shared library (NFS/SMB), that
            // question only has one right answer if every machine reads and
            // writes the same file. An app-config-dir-local cache silently
            // can't see imports done from a different machine, even though
            // they're sitting right there in the shared library. Falls back
            // to the OS app-config dir if no local mount is configured yet
            // (first run, before Preferences → Library is set up).
            let history_path = if cfg.library.local_root.trim().is_empty() {
                app.path()
                    .app_config_dir()
                    .unwrap_or_else(|_| std::path::PathBuf::from("."))
                    .join("import_history.json")
            } else {
                let library_root = std::path::PathBuf::from(cfg.library.local_root.trim());
                // Same migration as the app-config dir above, but for the
                // dedupe cache that lives on the shared library mount under
                // the old `.immature` name.
                migrate_legacy_dir(
                    &library_root.join(".immature"),
                    &library_root.join(".brighttable"),
                    "library dedupe-cache",
                );
                library_root.join(".brighttable").join("import_history.json")
            };
            let (import_queue, import_queue_rx) = import::ImportQueue::new(history_path);
            let max_concurrent_import_jobs = cfg.import.max_concurrent_jobs;
            let (round_trip, round_trip_rx) = round_trip::RoundTripWatcher::new();
            let (processing_queue, processing_queue_rx) = processing_queue::ProcessingQueue::new(asset_locks.clone());
            let (art_queue, art_queue_rx) = art_queue::ArtQueue::new();
            let (export_queue, export_queue_rx) = export_queue::ExportQueue::new();
            let (stack_queue, stack_queue_rx) = stack_queue::StackQueue::new();
            // Starts empty - filled in by the background thread below once
            // the vault finishes opening, and swapped for a freshly-reopened
            // one later if `config::set_settings_folder`/`set_share_vault`
            // moves it - see `AppState::secret_vault`'s own doc comment for
            // why this needs to be replaceable rather than write-once.
            let secret_vault: std::sync::Arc<std::sync::RwLock<Option<secure_store::SecretVault>>> =
                std::sync::Arc::new(std::sync::RwLock::new(None));
            app.manage(AppState::new(cfg, secret_vault.clone(), edit_queue, import_queue, round_trip.clone(), processing_queue, art_queue, export_queue, stack_queue));

            // Stronghold's snapshot decrypt is fast now (see
            // `secure_store::use_low_encrypt_work_factor`), but a vault
            // written before that fix still pays its old, much-worse cost
            // the one time it gets migrated - and running even the fast
            // path synchronously here would block this whole closure's
            // return, which blocks the window's first paint and the event
            // loop's first pump. That's what originally tripped the
            // desktop's own "not responding" watchdog in a debug build
            // (confirmed via `gdb`: the main thread was sitting in exactly
            // this call, then moved on once it finished) before either fix
            // existed. Opened on its own thread instead, so the window
            // shows up and stays responsive immediately regardless - see
            // `cfg`'s own comment above for what happens to secret fields
            // in the meantime.
            {
                let app_handle = app.handle().clone();
                let target_vault = secret_vault;
                std::thread::spawn(move || {
                    let Ok(vault) = secure_store::SecretVault::open(&app_handle, vault_dir.as_deref()) else {
                        return;
                    };
                    let state = app_handle.state::<AppState>();
                    {
                        let mut guard = state.config.lock().unwrap();
                        if vault.read_into(&mut guard) {
                            let _ = config::save(&app_handle, &guard, Some(&vault));
                        }
                    }
                    *target_vault.write().unwrap() = Some(vault);
                    let _ = app_handle.emit("vault-ready", ());
                });
            }

            tauri::async_runtime::spawn(edit_queue::run(app.handle().clone(), edit_queue_rx));
            tauri::async_runtime::spawn(import::queue::run(app.handle().clone(), import_queue_rx, max_concurrent_import_jobs));
            tauri::async_runtime::spawn(round_trip::run(app.handle().clone(), round_trip, round_trip_rx));
            tauri::async_runtime::spawn(processing_queue::run(app.handle().clone(), processing_queue_rx));
            tauri::async_runtime::spawn(art_queue::run(app.handle().clone(), art_queue_rx));
            tauri::async_runtime::spawn(export_queue::run(app.handle().clone(), export_queue_rx));
            tauri::async_runtime::spawn(stack_queue::run(app.handle().clone(), stack_queue_rx));

            #[cfg(target_os = "linux")]
            {
                let io_guard = app.state::<AppState>().io_guard.clone();
                tauri::async_runtime::spawn(async move {
                    suspend_guard::run(io_guard).await;
                });
            }

            // WebKitGTK defaults to WEBKIT_CACHE_MODEL_WEB_BROWSER, which is
            // tuned for a multi-tab browser and keeps every distinct
            // resource it has ever decoded (here, every `immich-thumb://`
            // thumbnail this session) in its in-memory resource cache rather
            // than releasing it once the corresponding <img> leaves the DOM.
            // This is a single-window, single-origin app that never
            // benefits from that model - DOCUMENT_VIEWER is WebKit's most
            // conservative cache model and is what actually let the content
            // process's RSS come back down after scrolling through a large
            // library instead of monotonically climbing all session.
            #[cfg(target_os = "linux")]
            {
                if let Some(webview) = app.get_webview_window("main") {
                    let _ = webview.with_webview(|pw| {
                        use webkit2gtk::{WebContextExt, WebViewExt};
                        if let Some(ctx) = pw.inner().context() {
                            ctx.set_cache_model(webkit2gtk::CacheModel::DocumentViewer);
                        }
                    });
                }
            }

            Ok(())
        })
        // The one deliberate, narrow use of a Tauri event in this
        // architecture: everything else about any of these queues is
        // advisory/polled (see edit_queue.rs/import/queue.rs/
        // stack_queue.rs), but a hard window close can't be a silent
        // data-loss risk, so this intercepts it and lets the frontend warn
        // (not hard-block - "Quit anyway" calls commands::force_quit)
        // whenever a job is still in flight in any of them. Combined into
        // one count: an in-flight import copy
        // is no less worth warning about than an in-flight metadata edit,
        // and the frontend's dialog doesn't need to distinguish which
        // queue the count came from to do its job.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<AppState>();
                let pending = state.edit_queue.pending_count()
                    + state.import_queue.pending_count()
                    + state.processing_queue.pending_count()
                    + state.art_queue.pending_count()
                    + state.export_queue.pending_count()
                    + state.stack_queue.pending_count();
                if pending > 0 {
                    api.prevent_close();
                    let _ = window.emit("queue-close-blocked", pending);
                }
            }
        })
        .register_asynchronous_uri_scheme_protocol(protocol::SCHEME, |ctx, request, responder| {
            protocol::handle(ctx.app_handle(), request, responder);
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_config,
            commands::save_library_config,
            commands::save_shortcuts,
            commands::save_smart_stack_settings,
            commands::save_window_controls_position,
            commands::save_theme_mode,
            commands::save_grid_loupe_large,
            commands::save_settings_folder,
            commands::save_share_vault,
            commands::save_applications_config,
            commands::list_installed_apps,
            commands::launch_editor,
            commands::set_raw_overrides,
            commands::test_connection,
            commands::get_timeline_buckets,
            commands::get_timeline_bucket_assets,
            commands::delete_assets,
            commands::update_asset_metadata,
            commands::get_trashed_assets,
            commands::restore_assets,
            commands::empty_trash,
            commands::create_stack,
            commands::get_stack,
            commands::list_stacks,
            commands::set_stack_pick,
            commands::enqueue_stack_dissolve,
            commands::enqueue_stack_create,
            commands::get_stack_queue_status,
            commands::clear_completed_stack_jobs,
            commands::set_asset_capture_date,
            commands::regenerate_asset_thumbnail,
            commands::rotate_asset,
            commands::evict_thumb_cache_for_asset,
            commands::delete_stack,
            commands::list_albums,
            commands::get_album,
            commands::create_album,
            commands::rename_album,
            commands::delete_album,
            commands::add_assets_to_album,
            commands::remove_assets_from_album,
            commands::list_people,
            commands::get_person,
            commands::rename_person,
            commands::list_tags,
            commands::get_tag,
            commands::create_tag,
            commands::delete_tag,
            commands::tag_assets,
            commands::untag_assets,
            commands::search_assets,
            commands::search_assets_by_filename,
            commands::get_asset,
            commands::check_sidecar_metadata,
            commands::get_folder_paths,
            commands::get_folder_assets,
            commands::save_import_settings,
            commands::list_removable_volumes,
            commands::scan_import_source,
            commands::check_import_duplicates,
            commands::start_import,
            commands::get_import_queue_status,
            commands::clear_completed_import_jobs,
            commands::scan_immich_library,
            commands::get_resource_usage,
            commands::get_thumb_cache_info,
            commands::clear_thumb_cache,
            commands::get_edit_queue_status,
            commands::clear_completed_edit_jobs,
            commands::paste_image_processing,
            commands::get_processing_queue_status,
            commands::clear_completed_processing_jobs,
            commands::launch_raw_cli_round_trip,
            commands::finish_raw_cli_round_trip_with_default_profile,
            commands::cancel_raw_cli_round_trip,
            commands::cancel_raw_cli_job,
            commands::batch_raw_cli_round_trip,
            commands::get_raw_cli_queue_status,
            commands::clear_completed_raw_cli_jobs,
            commands::reveal_in_file_manager,
            commands::open_video_externally,
            commands::force_quit,
            commands::save_sharing_config,
            commands::flickr_begin_auth,
            commands::flickr_complete_auth,
            commands::flickr_disconnect,
            commands::flickr_list_albums,
            commands::export_to_folder,
            commands::export_to_flickr,
            commands::get_export_queue_status,
            commands::cancel_export_job,
            commands::clear_completed_export_jobs,
            commands::list_printers,
            commands::print_asset,
            commands::print_test_pattern,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
