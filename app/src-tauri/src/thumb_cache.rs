use serde::Serialize;
use std::fs;
use std::io;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Manager};

static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbCacheStats {
    pub dir: PathBuf,
    pub size_bytes: u64,
    pub file_count: u64,
}

// Immich's own `preview`/`thumbnail` renditions are always transcoded
// server-side to jpeg/webp/png, so those three used to be the only cases that
// mattered here. `size=original` (see protocol.rs) streams the untouched
// source file instead, which can legitimately be gif/bmp/avif too - mapping
// one of those to the "jpg" fallback would cache it under the wrong
// extension and, on a later cache hit, serve it back with a lying
// Content-Type that the webview can't decode against the real bytes.
fn ext_for_content_type(ct: &str) -> &'static str {
    match ct {
        "image/webp" => "webp",
        "image/png" => "png",
        "image/gif" => "gif",
        "image/bmp" => "bmp",
        "image/avif" => "avif",
        _ => "jpg",
    }
}

fn mime_for_ext(ext: &str) -> &'static str {
    match ext {
        "webp" => "image/webp",
        "png" => "image/png",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
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
    for ext in ["jpg", "webp", "png", "gif", "bmp", "avif"] {
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

/// Walks the cache dir to report its total size/file count for Preferences.
/// A missing dir (nothing cached yet) isn't an error - it just reports zero,
/// with `dir` still populated so the UI can show where it *would* live.
pub fn stats(app: &AppHandle) -> ThumbCacheStats {
    let dir = cache_dir(app).unwrap_or_default();
    let mut size_bytes = 0u64;
    let mut file_count = 0u64;
    for entry in walkdir::WalkDir::new(&dir).into_iter().filter_map(|e| e.ok()) {
        if entry.file_type().is_file() {
            size_bytes += entry.metadata().map(|m| m.len()).unwrap_or(0);
            file_count += 1;
        }
    }
    ThumbCacheStats { dir, size_bytes, file_count }
}

/// Wipes the whole cache dir. Safe against `write()`'s concurrent-writer
/// pattern: each writer owns a uniquely-named tmp file, so a clear racing a
/// write can at worst delete that one writer's tmp/final file out from under
/// it - never corrupt a file - and the affected thumbnail just gets
/// refetched on its next request, same as any other cache miss.
pub fn clear(app: &AppHandle) -> io::Result<()> {
    let Some(dir) = cache_dir(app) else {
        return Err(io::Error::other("Could not resolve the thumbnail cache directory"));
    };
    match fs::remove_dir_all(&dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}
