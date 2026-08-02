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
    // Only ever sent by an HTML5 <video> element (the Viewer's `<video
    // src="immich-thumb://…?size=original">` for a VIDEO asset) - seeking
    // past what's already buffered issues one of these to fetch just that
    // slice instead of re-downloading the whole file. Every other consumer
    // (grid/viewer <img> tags) never sends it, so `respond_media` below is a
    // no-op passthrough for them.
    let range_header = request
        .headers()
        .get(http::header::RANGE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);

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
            responder.respond(respond_media(bytes, content_type, range_header.as_deref()));
            return;
        }

        // Only the `original` fetch is worth timing on its own - it's the
        // one whose size varies wildly (a multi-GB video vs. a few-MB
        // photo), so it's the one where "is this just a big slow download or
        // is it actually stuck" is a real question worth being able to
        // answer from the dev console instead of guessing.
        let fetch_started = std::time::Instant::now();
        if size == "original" {
            log::info!("original fetch starting for {asset_id}");
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
        if size == "original" {
            match &result {
                Ok((bytes, _)) => log::info!("original fetch for {asset_id} done: {} bytes in {:?}", bytes.len(), fetch_started.elapsed()),
                Err(e) => log::info!("original fetch for {asset_id} failed after {:?}: {e}", fetch_started.elapsed()),
            }
        }

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
                respond_media(bytes, content_type, range_header.as_deref())
            }
            Err(e) => {
                log::warn!("thumbnail fetch failed for {asset_id} (size={size}): {e}");
                http::Response::builder()
                    .status(502)
                    .header("Content-Type", "text/plain")
                    .header("Access-Control-Allow-Origin", "*")
                    .header("Cache-Control", "no-store")
                    .body(e.into_bytes())
                    .unwrap()
            }
        };
        responder.respond(response);
    });
}

/// Builds the success response for a fully-resolved `bytes` payload,
/// honoring a `Range: bytes=start-end` request header (RFC 7233, single
/// range only - the only form an HTML5 `<video>` element ever sends) with a
/// `206 Partial Content` slice instead of the whole body. Used for both a
/// cache hit and a freshly-fetched-then-cached response - `bytes` is already
/// the complete file in memory either way (there's no partial upstream fetch
/// here, just a partial *response*), so a video's first play still needs the
/// whole file downloaded once, but the browser's own seek/scrub requests
/// against the now-cached bytes are served instantly without re-sending
/// everything before it.
///
/// Always carries `Access-Control-Allow-Origin: *` - an `<img>`/`<video
/// poster>` load isn't CORS-checked at all, but a script-initiated
/// `fetch()`/`XMLHttpRequest` (the Viewer's video-blob fetch, see
/// `Viewer.tsx`'s `videoUrl` effect) is, and without this header WebKit
/// silently refuses to hand the response back to JS even though the request
/// itself succeeds - the request completes at the network level but the
/// calling script sees a generic "Load failed"/network-error with no other
/// indication of what actually went wrong. `immich-thumb://` is never
/// reachable by anything outside this app anyway (it's not a real network
/// origin), so there's no meaningful cross-origin exposure to restrict here.
fn respond_media(bytes: Vec<u8>, content_type: String, range_header: Option<&str>) -> http::Response<Vec<u8>> {
    let total = bytes.len();
    let range = range_header.and_then(|h| parse_range(h, total));
    match range {
        Some((start, end)) if start <= end && end < total => {
            let slice = bytes[start..=end].to_vec();
            http::Response::builder()
                .status(206)
                .header("Content-Type", content_type)
                .header("Accept-Ranges", "bytes")
                .header("Access-Control-Allow-Origin", "*")
                .header("Content-Range", format!("bytes {start}-{end}/{total}"))
                .header("Cache-Control", "public, max-age=31536000, immutable")
                .body(slice)
                .unwrap()
        }
        _ => http::Response::builder()
            .status(200)
            .header("Content-Type", content_type)
            .header("Accept-Ranges", "bytes")
            .header("Access-Control-Allow-Origin", "*")
            .header("Cache-Control", "public, max-age=31536000, immutable")
            .body(bytes)
            .unwrap(),
    }
}

/// Parses a `Range: bytes=start-end` header into an inclusive `(start, end)`
/// byte range, clamped to `total`. Supports the three forms browsers
/// actually send: `bytes=START-END`, `bytes=START-` (to end of file), and
/// `bytes=-SUFFIXLEN` (last N bytes) - a malformed or multi-range header
/// (e.g. `bytes=0-10,20-30`) falls through to `None`, which `respond_media`
/// treats as "send the whole thing" rather than erroring.
fn parse_range(header: &str, total: usize) -> Option<(usize, usize)> {
    let spec = header.strip_prefix("bytes=")?;
    if spec.contains(',') || total == 0 {
        return None;
    }
    let (start_s, end_s) = spec.split_once('-')?;
    if start_s.is_empty() {
        let suffix_len: usize = end_s.parse().ok()?;
        let start = total.saturating_sub(suffix_len);
        return Some((start, total - 1));
    }
    let start: usize = start_s.parse().ok()?;
    let end = if end_s.is_empty() { total - 1 } else { end_s.parse::<usize>().ok()?.min(total - 1) };
    Some((start, end))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_bounded_range() {
        assert_eq!(parse_range("bytes=0-99", 1000), Some((0, 99)));
    }

    #[test]
    fn parses_an_open_ended_range() {
        assert_eq!(parse_range("bytes=500-", 1000), Some((500, 999)));
    }

    #[test]
    fn parses_a_suffix_range() {
        assert_eq!(parse_range("bytes=-100", 1000), Some((900, 999)));
    }

    #[test]
    fn clamps_an_end_past_the_file() {
        assert_eq!(parse_range("bytes=0-99999", 1000), Some((0, 999)));
    }

    #[test]
    fn rejects_a_multi_range_header() {
        assert_eq!(parse_range("bytes=0-10,20-30", 1000), None);
    }

    #[test]
    fn rejects_a_malformed_header() {
        assert_eq!(parse_range("not-a-range", 1000), None);
    }
}
