//! Recursively scans an SD-card/disk source folder for importable photo/
//! video files and groups them by original basename - a camera's RAW+JPEG
//! pair (`IMG_0001.CR3` + `IMG_0001.JPG`) is exactly one group, so both end
//! up sharing one destination basename (different extensions) once
//! imported.
//!
//! Grouping is scoped to `(parent_dir, basename)`, deliberately *not* a
//! flat basename match across the whole scan the way `smartStack.ts`'s Name
//! mode groups already-imported Immich assets (which have globally unique
//! ids/paths). A raw filesystem scan has no such guarantee - a reused SD
//! card can easily have `100CANON/IMG_0001.CR3` and `101CANON/IMG_0001.CR3`
//! as two completely unrelated files that happen to share a basename.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

use super::capture_time::{self, CaptureTime};

const RAW_EXTENSIONS: &[&str] = &["ARW", "CR2", "CR3", "NEF", "DNG", "RAF", "ORF", "RW2", "PEF", "SRW", "X3F"];
const OTHER_IMAGE_EXTENSIONS: &[&str] = &["JPG", "JPEG", "HEIC", "HEIF", "PNG", "TIF", "TIFF"];
// SD cards from real cameras always mix video in alongside stills, and
// Immich treats video as first-class - included by default (see the plan's
// judgment call log for the reasoning, revisit if unwanted).
const VIDEO_EXTENSIONS: &[&str] = &["MP4", "MOV", "AVI", "MTS", "M4V", "3GP"];

pub fn is_raw_extension(ext: &str) -> bool {
    RAW_EXTENSIONS.contains(&ext)
}

fn is_importable_extension(ext: &str) -> bool {
    RAW_EXTENSIONS.contains(&ext) || OTHER_IMAGE_EXTENSIONS.contains(&ext) || VIDEO_EXTENSIONS.contains(&ext)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedFile {
    pub source_path: String,
    /// Uppercase, no leading dot.
    pub extension: String,
    pub size_bytes: u64,
    /// Empty straight out of `scan_source` - computing this means actually
    /// reading up to 4MB of every file, which over a slow card reader or a
    /// big card is the dominant cost of a scan. Deliberately deferred out
    /// of the initial (cheap) directory walk so the UI can show capture
    /// dates and let the user narrow to a date range *before* paying that
    /// cost - see `hash_groups` below, run only over whatever subset the
    /// user actually wants to check/import.
    pub partial_hash: String,
    pub capture_time: CaptureTime,
    pub capture_time_is_exif: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedGroup {
    /// Original basename (no extension) - for display only, never used to
    /// build the destination name (that's always derived from
    /// `capture_time`).
    pub basename: String,
    pub files: Vec<ScannedFile>,
    pub capture_time: CaptureTime,
    /// Set by `history::mark_already_imported` after this scan returns -
    /// always `false` straight out of `scan_source`, since that has no
    /// access to the persisted dedupe cache (kept as a separate, easily
    /// mockable step rather than threading history through the scan/hash
    /// logic itself).
    pub already_imported: bool,
}

/// Best-effort: an individual file that fails to open/stat/hash is skipped
/// rather than failing the whole scan (matches `apps.rs`'s detection
/// philosophy) - a bad sector or permissions oddity on one file on a large
/// card shouldn't block importing everything else. Only the top-level
/// directory itself not being readable is a real error.
pub fn scan_source(dir: &Path) -> Result<Vec<ScannedGroup>, String> {
    if !dir.is_dir() {
        return Err(format!("{} is not a directory", dir.display()));
    }

    let mut groups: HashMap<(PathBuf, String), Vec<ScannedFile>> = HashMap::new();
    for entry in WalkDir::new(dir).into_iter().filter_map(Result::ok) {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let Some(scanned) = scan_one_file(path) else { continue };
        let Some(parent) = path.parent() else { continue };
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else { continue };
        groups.entry((parent.to_path_buf(), stem.to_string())).or_default().push(scanned);
    }

    let mut result: Vec<ScannedGroup> = groups
        .into_iter()
        .map(|((_, basename), mut files)| {
            files.sort_by(|a, b| a.source_path.cmp(&b.source_path));
            let capture_time = capture_time::best_capture_time(&files);
            ScannedGroup { basename, files, capture_time, already_imported: false }
        })
        .collect();
    // Deterministic order for tests/UI - by the first (alphabetically
    // earliest) member's source path.
    result.sort_by(|a, b| a.files[0].source_path.cmp(&b.files[0].source_path));
    Ok(result)
}

fn scan_one_file(path: &Path) -> Option<ScannedFile> {
    let ext = path.extension().and_then(|e| e.to_str())?.to_uppercase();
    if !is_importable_extension(&ext) {
        return None;
    }
    let metadata = path.metadata().ok()?;
    let (capture_time, capture_time_is_exif) = capture_time::file_capture_time(path);
    Some(ScannedFile {
        source_path: path.to_string_lossy().to_string(),
        extension: ext,
        size_bytes: metadata.len(),
        partial_hash: String::new(),
        capture_time,
        capture_time_is_exif,
    })
}

/// Fills in `partial_hash` for every file in `groups` that doesn't already
/// have one - the deferred other half of `scan_one_file`. Meant to run only
/// over whatever subset (e.g. a user-narrowed date range) is actually about
/// to be checked/imported, not the full scan. Best-effort like the rest of
/// this module: a file that fails to hash (bad sector, permissions, card
/// pulled mid-scan) is left with an empty hash rather than aborting the
/// whole batch - it just won't dedupe-match anything, same as if it were
/// genuinely new.
pub fn hash_groups(groups: &mut [ScannedGroup]) {
    for group in groups.iter_mut() {
        for file in group.files.iter_mut() {
            if file.partial_hash.is_empty() {
                if let Ok(hash) = super::hash::partial_hash(Path::new(&file.source_path)) {
                    file.partial_hash = hash;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("immature-test-scan-{name}-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn groups_raw_and_jpeg_by_shared_basename() {
        let dir = tmp_dir("pair");
        fs::write(dir.join("IMG_0001.CR3"), b"raw bytes").unwrap();
        fs::write(dir.join("IMG_0001.JPG"), b"jpeg bytes").unwrap();

        let groups = scan_source(&dir).unwrap();
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].files.len(), 2);
        assert_eq!(groups[0].basename, "IMG_0001");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn does_not_merge_same_basename_across_different_source_directories() {
        let dir = tmp_dir("reused-card");
        let a = dir.join("100CANON");
        let b = dir.join("101CANON");
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        fs::write(a.join("IMG_0001.CR3"), b"first roll").unwrap();
        fs::write(b.join("IMG_0001.CR3"), b"second roll, unrelated").unwrap();

        let groups = scan_source(&dir).unwrap();
        assert_eq!(groups.len(), 2, "same basename in different directories must stay separate groups");
        assert!(groups.iter().all(|g| g.files.len() == 1));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn skips_non_importable_extensions() {
        let dir = tmp_dir("skip");
        fs::write(dir.join("readme.txt"), b"not a photo").unwrap();
        fs::write(dir.join("IMG_0002.JPG"), b"a real photo").unwrap();

        let groups = scan_source(&dir).unwrap();
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].basename, "IMG_0002");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn recurses_into_subdirectories() {
        let dir = tmp_dir("nested");
        let sub = dir.join("DCIM").join("100CANON");
        fs::create_dir_all(&sub).unwrap();
        fs::write(sub.join("IMG_0003.NEF"), b"raw in a nested dir").unwrap();

        let groups = scan_source(&dir).unwrap();
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].basename, "IMG_0003");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn errors_on_missing_source_directory() {
        let missing = std::env::temp_dir().join("immature-test-scan-does-not-exist");
        let _ = fs::remove_dir_all(&missing);
        assert!(scan_source(&missing).is_err());
    }

    #[test]
    fn scan_source_leaves_partial_hash_empty() {
        let dir = tmp_dir("no-hash-yet");
        fs::write(dir.join("IMG_0004.JPG"), b"not hashed at scan time").unwrap();

        let groups = scan_source(&dir).unwrap();
        assert_eq!(groups[0].files[0].partial_hash, "", "hashing is deferred to hash_groups, not done during scan_source");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn hash_groups_fills_in_partial_hash() {
        let dir = tmp_dir("hash-groups");
        fs::write(dir.join("IMG_0005.JPG"), b"hash me now").unwrap();

        let mut groups = scan_source(&dir).unwrap();
        hash_groups(&mut groups);
        assert!(!groups[0].files[0].partial_hash.is_empty());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn hash_groups_does_not_rehash_a_file_that_already_has_one() {
        let dir = tmp_dir("hash-groups-idempotent");
        fs::write(dir.join("IMG_0006.JPG"), b"already hashed").unwrap();

        let mut groups = scan_source(&dir).unwrap();
        groups[0].files[0].partial_hash = "pretend-precomputed".into();
        hash_groups(&mut groups);
        assert_eq!(groups[0].files[0].partial_hash, "pretend-precomputed");

        let _ = fs::remove_dir_all(&dir);
    }
}
