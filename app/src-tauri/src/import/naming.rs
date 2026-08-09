//! Destination path assembly: the fixed `yyyymmdd_hh-mm-ss` filename
//! pattern under an optional `yyyy/yyyy_mm` folder hierarchy, with
//! same-second collisions suffixed `-1`/`-2`/… A collision is resolved once
//! per *group*, not per file - a RAW+JPEG pair must keep sharing one
//! destination basename even when that basename collides with something
//! else; suffixing each member independently would silently break the
//! pairing this whole feature exists to preserve.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::capture_time::CaptureTime;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FolderDepth {
    Flat,
    YearMonth,
}

pub fn dest_dir(local_root: &Path, depth: FolderDepth, capture_time: &CaptureTime) -> PathBuf {
    match depth {
        FolderDepth::Flat => local_root.to_path_buf(),
        FolderDepth::YearMonth => local_root.join(capture_time.year_str()).join(capture_time.year_month_str()),
    }
}

/// Lazily-populated per-directory listing cache, one per `enqueue()` call
/// (see `queue.rs`). `resolve_stem` runs once per group, and groups very
/// commonly share the same destination directory - under Year/Month depth,
/// *every* file captured in the same month lands in one folder - so without
/// this, resolving N groups' stems in the same folder meant N separate
/// `fs::read_dir` calls against what can be a real, possibly large,
/// NFS-backed directory: re-listing the exact same contents over and over.
/// Found live: a 382-file batch (all one month) did 382 full directory
/// listings in a row, each a real network round trip, which felt exactly
/// like a hang even though it was technically making progress - nothing
/// appears in the Activity panel until the whole `enqueue()` batch
/// finishes, since jobs aren't pushed onto the queue until this returns.
pub struct StemCache {
    listed: HashMap<PathBuf, HashSet<String>>,
}

impl StemCache {
    pub fn new() -> Self {
        Self { listed: HashMap::new() }
    }

    fn stems_in(&mut self, dir: &Path) -> &HashSet<String> {
        self.listed.entry(dir.to_path_buf()).or_insert_with(|| list_stems(dir))
    }
}

impl Default for StemCache {
    fn default() -> Self {
        Self::new()
    }
}

fn list_stems(dir: &Path) -> HashSet<String> {
    let Ok(entries) = fs::read_dir(dir) else { return HashSet::new() };
    entries.flatten().filter_map(|e| e.path().file_stem().and_then(|s| s.to_str()).map(str::to_string)).collect()
}

/// Picks a filename stem that's free both on disk (any extension - a
/// same-named file already there is still a collision regardless of its
/// own extension) and within the rest of this same import batch
/// (`used_in_batch`, keyed by the full `dest_dir` join so two different
/// destination directories can't falsely collide with each other).
pub fn resolve_stem(cache: &mut StemCache, dest_dir: &Path, base_stem: &str, used_in_batch: &mut HashSet<PathBuf>) -> String {
    let on_disk = cache.stems_in(dest_dir);
    let mut candidate = base_stem.to_string();
    let mut suffix = 1;
    loop {
        let key = dest_dir.join(&candidate);
        if !used_in_batch.contains(&key) && !on_disk.contains(&candidate) {
            used_in_batch.insert(key);
            return candidate;
        }
        candidate = format!("{base_stem}-{suffix}");
        suffix += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs as stdfs;

    fn ct() -> CaptureTime {
        CaptureTime { year: 2026, month: 6, day: 21, hour: 8, minute: 23, second: 13 }
    }

    #[test]
    fn dest_dir_flat_is_just_the_local_root() {
        let root = Path::new("/mnt/lib");
        assert_eq!(dest_dir(root, FolderDepth::Flat, &ct()), PathBuf::from("/mnt/lib"));
    }

    #[test]
    fn dest_dir_year_month_nests_by_year_then_year_month() {
        let root = Path::new("/mnt/lib");
        assert_eq!(dest_dir(root, FolderDepth::YearMonth, &ct()), PathBuf::from("/mnt/lib/2026/2026_06"));
    }

    #[test]
    fn resolve_stem_returns_base_stem_when_free() {
        let dir = std::env::temp_dir().join(format!("brighttable-test-naming-free-{}", std::process::id()));
        stdfs::create_dir_all(&dir).unwrap();
        let mut used = HashSet::new();
        let mut cache = StemCache::new();
        assert_eq!(resolve_stem(&mut cache, &dir, "20260621_08-23-13", &mut used), "20260621_08-23-13");
        let _ = stdfs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_stem_suffixes_on_disk_collision_regardless_of_extension() {
        let dir = std::env::temp_dir().join(format!("brighttable-test-naming-disk-{}", std::process::id()));
        stdfs::create_dir_all(&dir).unwrap();
        stdfs::write(dir.join("20260621_08-23-13.CR3"), b"").unwrap();
        let mut used = HashSet::new();
        let mut cache = StemCache::new();
        assert_eq!(resolve_stem(&mut cache, &dir, "20260621_08-23-13", &mut used), "20260621_08-23-13-1");
        let _ = stdfs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_stem_suffixes_on_in_batch_collision_and_increments() {
        let dir = std::env::temp_dir().join(format!("brighttable-test-naming-batch-{}", std::process::id()));
        stdfs::create_dir_all(&dir).unwrap();
        let mut used = HashSet::new();
        let mut cache = StemCache::new();
        assert_eq!(resolve_stem(&mut cache, &dir, "same-second", &mut used), "same-second");
        assert_eq!(resolve_stem(&mut cache, &dir, "same-second", &mut used), "same-second-1");
        assert_eq!(resolve_stem(&mut cache, &dir, "same-second", &mut used), "same-second-2");
        let _ = stdfs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_stem_does_not_cross_contaminate_different_dest_dirs() {
        let base = std::env::temp_dir().join(format!("brighttable-test-naming-cross-{}", std::process::id()));
        let dir_a = base.join("a");
        let dir_b = base.join("b");
        stdfs::create_dir_all(&dir_a).unwrap();
        stdfs::create_dir_all(&dir_b).unwrap();
        let mut used = HashSet::new();
        let mut cache = StemCache::new();
        assert_eq!(resolve_stem(&mut cache, &dir_a, "same-stem", &mut used), "same-stem");
        assert_eq!(resolve_stem(&mut cache, &dir_b, "same-stem", &mut used), "same-stem");
        let _ = stdfs::remove_dir_all(&base);
    }

    #[test]
    fn resolve_stem_reuses_the_cached_listing_instead_of_rereading_the_directory() {
        let dir = std::env::temp_dir().join(format!("brighttable-test-naming-cache-{}", std::process::id()));
        stdfs::create_dir_all(&dir).unwrap();
        let mut used = HashSet::new();
        let mut cache = StemCache::new();
        // First call populates the cache from an empty directory.
        resolve_stem(&mut cache, &dir, "a", &mut used);
        // A file written to disk *after* the cache was populated is
        // invisible to a second call against the same directory - proof
        // the listing was cached rather than re-read. If it re-read, this
        // would collide and return "b-1" instead.
        stdfs::write(dir.join("b.CR3"), b"").unwrap();
        assert_eq!(resolve_stem(&mut cache, &dir, "b", &mut used), "b");
        let _ = stdfs::remove_dir_all(&dir);
    }
}
