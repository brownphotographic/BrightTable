use tauri::{http, Manager, UriSchemeResponder};

use crate::immich::ImmichClient;
use crate::io_guard;
use crate::state::AppState;
use crate::thumb_cache;

pub const SCHEME: &str = "immich-thumb";

/// Handles `immich-thumb://thumbnail/{asset_id}?size=preview|thumbnail|original`
/// requests from the webview by proxying an authenticated fetch to the
/// configured Immich server. The API key never reaches the webview's JS or
/// network tab this way - only this URI ever shows up in devtools.
///
/// `size=original` is handled separately from `preview`/`thumbnail`: those two
/// are Immich's own `/assets/{id}/thumbnail?size=` renditions, but there's no
/// such thing as an "original" thumbnail size - it's routed to
/// `/assets/{id}/original` instead (see `get_original_bytes`). The frontend
/// only ever requests it for the Viewer's zoom/loupe, and only for formats it
/// has already confirmed a webview can decode (see `isOriginalZoomable` in
/// filters.ts) - this handler doesn't re-check that itself.
pub fn handle(
    app: &tauri::AppHandle,
    request: http::Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app_state = app.state::<AppState>();
    let cfg = app_state.library_config();
    let http = app_state.http.clone();
    let io_guard = app_state.io_guard.clone();
    let auto_resolution = app_state.auto_resolution.clone();

    let uri = request.uri().clone();
    let asset_id = uri
        .path()
        .trim_start_matches('/')
        .split('/')
        .last()
        .unwrap_or("")
        .to_string();
    let size = uri
        .query()
        .and_then(|q| {
            url::form_urlencoded::parse(q.as_bytes())
                .find(|(k, _)| k == "size")
                .map(|(_, v)| v.to_string())
        })
        .unwrap_or_else(|| "preview".to_string());

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // fs reads/writes are blocking syscalls - running them directly on an
        // async task would steal one of Tokio's few worker threads for the
        // duration. With only a handful of workers, a burst of simultaneous
        // thumbnail requests (a whole grid scrolling into view at once) would
        // then queue up behind each other even on cache HITS, which is exactly
        // the "choppy" lag this was causing. spawn_blocking runs them on
        // Tokio's separate, much larger blocking-thread pool instead.
        let (app2, id2, size2) = (app.clone(), asset_id.clone(), size.clone());
        let cached = match io_guard::guarded_spawn_blocking(&io_guard, move || {
            thumb_cache::read(&app2, &id2, &size2)
        }) {
            Some(handle) => handle.await.unwrap_or(None),
            // Suspend imminent - treat as a cache miss, same as any other
            // miss; falls through to the network fetch below.
            None => None,
        };
        if let Some((bytes, content_type)) = cached {
            let response = http::Response::builder()
                .status(200)
                .header("Content-Type", content_type)
                .header("Cache-Control", "public, max-age=31536000, immutable")
                .body(bytes)
                .unwrap();
            responder.respond(response);
            return;
        }

        let result = async {
            let client = ImmichClient::from_config(&cfg, http, &auto_resolution).await?;
            if size == "original" {
                client.get_original_bytes(&asset_id).await
            } else {
                client.get_thumbnail_bytes(&asset_id, &size).await
            }
        }
        .await;

        let response = match result {
            Ok((bytes, content_type)) => {
                let (app3, id3, size3, ct3, bytes3) = (
                    app.clone(),
                    asset_id.clone(),
                    size.clone(),
                    content_type.clone(),
                    bytes.clone(),
                );
                io_guard::guarded_spawn_blocking(&io_guard, move || {
                    thumb_cache::write(&app3, &id3, &size3, &ct3, &bytes3)
                });
                http::Response::builder()
                    .status(200)
                    .header("Content-Type", content_type)
                    .header("Cache-Control", "public, max-age=31536000, immutable")
                    .body(bytes)
                    .unwrap()
            }
            Err(e) => {
                log::warn!("thumbnail fetch failed for {asset_id} (size={size}): {e}");
                http::Response::builder()
                    .status(502)
                    .header("Content-Type", "text/plain")
                    .header("Cache-Control", "no-store")
                    .body(e.into_bytes())
                    .unwrap()
            }
        };
        responder.respond(response);
    });
}
