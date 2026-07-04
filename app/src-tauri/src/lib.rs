mod commands;
mod config;
mod immich;
mod protocol;
mod state;
mod thumb_cache;

use state::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            let cfg = config::load(app.handle());
            app.manage(AppState::new(cfg));
            Ok(())
        })
        .register_asynchronous_uri_scheme_protocol(protocol::SCHEME, |ctx, request, responder| {
            protocol::handle(ctx.app_handle(), request, responder);
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_config,
            commands::save_library_config,
            commands::test_connection,
            commands::get_timeline_buckets,
            commands::get_timeline_bucket_assets,
            commands::delete_assets,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
