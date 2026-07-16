mod apps;
mod commands;
mod config;
mod edit_queue;
mod embedded;
mod immich;
mod import;
mod io_guard;
mod paths;
mod processing_queue;
mod protocol;
mod round_trip;
mod state;
#[cfg(target_os = "linux")]
mod suspend_guard;
mod thumb_cache;
mod xmp;

use state::AppState;
use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            let cfg = config::load(app.handle());
            let (edit_queue, edit_queue_rx) = edit_queue::EditQueue::new();
            // Always the OS app-config dir, independent of a user-chosen
            // `settings_folder` override - it's a dedupe cache, not a
            // setting, and shouldn't quietly go missing just because the
            // user later points config.json somewhere else.
            let history_path = app
                .path()
                .app_config_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("."))
                .join("import_history.json");
            let (import_queue, import_queue_rx) = import::ImportQueue::new(history_path);
            let max_concurrent_import_jobs = cfg.import.max_concurrent_jobs;
            let (round_trip, round_trip_rx) = round_trip::RoundTripWatcher::new();
            let (processing_queue, processing_queue_rx) = processing_queue::ProcessingQueue::new();
            app.manage(AppState::new(cfg, edit_queue, import_queue, round_trip.clone(), processing_queue));

            tauri::async_runtime::spawn(edit_queue::run(app.handle().clone(), edit_queue_rx));
            tauri::async_runtime::spawn(import::queue::run(app.handle().clone(), import_queue_rx, max_concurrent_import_jobs));
            tauri::async_runtime::spawn(round_trip::run(app.handle().clone(), round_trip, round_trip_rx));
            tauri::async_runtime::spawn(processing_queue::run(app.handle().clone(), processing_queue_rx));

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
        // architecture: everything else about either queue is advisory/
        // polled (see edit_queue.rs/import/queue.rs), but a hard window
        // close can't be a silent data-loss risk, so this intercepts it and
        // lets the frontend warn (not hard-block - "Quit anyway" calls
        // commands::force_quit) whenever a job is still in flight in
        // either queue. Combined into one count: an in-flight import copy
        // is no less worth warning about than an in-flight metadata edit,
        // and the frontend's dialog doesn't need to distinguish which
        // queue the count came from to do its job.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<AppState>();
                let pending =
                    state.edit_queue.pending_count() + state.import_queue.pending_count() + state.processing_queue.pending_count();
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
            commands::set_asset_capture_date,
            commands::delete_stack,
            commands::check_sidecar_metadata,
            commands::get_folder_paths,
            commands::get_folder_assets,
            commands::save_import_settings,
            commands::list_removable_volumes,
            commands::scan_import_source,
            commands::start_import,
            commands::get_import_queue_status,
            commands::clear_completed_import_jobs,
            commands::scan_immich_library,
            commands::get_memory_usage,
            commands::get_edit_queue_status,
            commands::clear_completed_edit_jobs,
            commands::paste_image_processing,
            commands::get_processing_queue_status,
            commands::clear_completed_processing_jobs,
            commands::force_quit,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
