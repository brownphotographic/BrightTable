use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Manager};

static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

fn ext_for_content_type(ct: &str) -> &'static str {
    match ct {
        "image/webp" => "webp",
        "image/png" => "png",
        _ => "jpg",
    }
}

fn mime_for_ext(ext: &str) -> &'static str {
    match ext {
        "webp" => "image/webp",
        "png" => "image/png",
        _ => "image/jpeg",
    }
}

fn cache_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_cache_dir().ok().map(|d| d.join("thumbnails"))
}

/// Assumes asset ids are unique per Immich instance (true in practice - they're
/// UUIDs); switching to a different server could theoretically collide, but the
/// odds are negligible and out of scope for this cache's first pass.
pub fn read(app: &AppHandle, asset_id: &str, size: &str) -> Option<(Vec<u8>, String)> {
    let dir = cache_dir(app)?;
    for ext in ["jpg", "webp", "png"] {
        let path = dir.join(format!("{asset_id}_{size}.{ext}"));
        if let Ok(bytes) = fs::read(&path) {
            return Some((bytes, mime_for_ext(ext).to_string()));
        }
    }
    None
}

/// Best-effort write - failures are silently ignored since the thumbnail has
/// already been returned to the webview either way; a missed cache write just
/// means we fetch again next time.
///
/// Concurrent requests for the same (unfinished) asset+size are possible - e.g.
/// switching views doesn't cancel an in-flight fetch, so returning to it can
/// start a second one. Each writer gets its own uniquely-named tmp file (never
/// shared) so two concurrent writes can never truncate/corrupt each other; the
/// final `rename` is atomic, so whichever finishes last just wins with equally
/// valid content.
pub fn write(app: &AppHandle, asset_id: &str, size: &str, content_type: &str, bytes: &[u8]) {
    let Some(dir) = cache_dir(app) else { return };
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let ext = ext_for_content_type(content_type);
    let final_path = dir.join(format!("{asset_id}_{size}.{ext}"));
    let unique = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp_path = dir.join(format!(
        "{asset_id}_{size}.{ext}.tmp.{}.{unique}",
        std::process::id()
    ));
    if fs::write(&tmp_path, bytes).is_ok() {
        let _ = fs::rename(&tmp_path, &final_path);
    } else {
        let _ = fs::remove_file(&tmp_path);
    }
}
