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

//! The dedupe cache: "have I already imported this file before?" across
//! sessions, re-scans, and - critically - other computers sharing the same
//! library, keyed by content hash - Rapid Photo Downloader's own core
//! "don't re-copy the same file twice" feature. Persisted to its own JSON
//! file under the library's own local mount (see `lib.rs` for where that
//! path is resolved), not folded into `config.json` (which churns far less,
//! stays small, and is per-machine by design) and not left in the OS
//! app-config dir either - a per-machine cache can't see an import done
//! from a different computer pointed at the same shared library.

use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::scan::ScannedGroup;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRecord {
    pub source_path: String,
    pub dest_path: String,
    /// The original camera-assigned filename (e.g. `L1000563.DNG`) - just
    /// `source_path`'s last component, duplicated out here so anything
    /// wanting the "camera name → renamed-on-import name" pair (an audit
    /// trail: "what did BrightTable rename this shot to?") doesn't need to
    /// re-parse a full path. This is *not* the dedupe key - a reformatted
    /// or swapped SD card can legitimately reuse this exact name for a
    /// completely different photo later, which is exactly the case the
    /// content hash below (`key()`'s partial_hash) exists to catch; keying
    /// on name+size alone would silently skip that new photo as a false
    /// "already imported".
    pub original_filename: String,
    /// `dest_path`'s last component (the `yyyymmdd_hh-mm-ss.ext` name) -
    /// the other half of the pair above.
    pub converted_filename: String,
    pub size_bytes: u64,
    pub imported_at_ms: u64,
    /// Full-file BLAKE3 hash, computed as a byproduct of the copy itself
    /// (`hash::copy_with_hash`) - not used for the dedupe lookup (that's
    /// keyed on the cheaper partial hash, see `key()` above), but kept for
    /// a possible future "verify these still match what's on disk" check.
    pub full_hash: String,
}

/// Keyed by `"{partial_hash}:{size_bytes}"`, not the hash alone - the hash
/// only ever covers the first few MB of a file (`hash.rs`), so two
/// different files that happen to share that prefix but differ in total
/// size are not the same file.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct ImportHistory {
    records: HashMap<String, ImportRecord>,
}

fn key(hash: &str, size_bytes: u64) -> String {
    format!("{hash}:{size_bytes}")
}

impl ImportHistory {
    /// Never errors - a missing or corrupt history file just means an empty
    /// history, same "unwrap_or_default" idiom as `config::load`. Losing
    /// this file only risks re-copying already-imported files, never losing
    /// anything already on disk, so it doesn't need the atomic-write
    /// ceremony `xmp.rs`/`thumb_cache.rs` use for genuinely user-visible
    /// data.
    pub fn load(path: &Path) -> Self {
        fs::read_to_string(path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let raw = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        fs::write(path, raw).map_err(|e| e.to_string())
    }

    pub fn contains(&self, hash: &str, size_bytes: u64) -> bool {
        self.records.contains_key(&key(hash, size_bytes))
    }

    pub fn record(&mut self, hash: &str, size_bytes: u64, record: ImportRecord) {
        self.records.insert(key(hash, size_bytes), record);
    }

    // Only ever read by this module's own tests so far (asserting a
    // save/load round trip actually persisted N records) - kept `pub`
    // since it's a natural, cheap accessor for this struct, not dead API.
    #[allow(dead_code)]
    pub fn len(&self) -> usize {
        self.records.len()
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Marks each group `already_imported` only when *every* member already
/// has a matching history record. If just some members match (e.g. a
/// RAW+JPEG pair where only the JPEG half was imported in an earlier
/// session, possibly under a different destination name), the group is
/// left importable so the whole pair copies together again, rather than
/// trying to reconstruct a partial-match history lookup - a known,
/// deliberate v1 trade-off (see the plan file), not an oversight.
pub fn mark_already_imported(groups: &mut [ScannedGroup], history: &ImportHistory) {
    for group in groups.iter_mut() {
        group.already_imported = group.files.iter().all(|f| history.contains(&f.partial_hash, f.size_bytes));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::import::capture_time::CaptureTime;
    use crate::import::scan::ScannedFile;

    fn dummy_time() -> CaptureTime {
        CaptureTime { year: 2026, month: 1, day: 1, hour: 0, minute: 0, second: 0 }
    }

    fn dummy_record(dest: &str) -> ImportRecord {
        ImportRecord {
            source_path: "/sd/IMG.CR3".into(),
            dest_path: dest.into(),
            original_filename: "IMG.CR3".into(),
            converted_filename: Path::new(dest).file_name().unwrap().to_string_lossy().to_string(),
            size_bytes: 100,
            imported_at_ms: 0,
            full_hash: "dummy".into(),
        }
    }

    #[test]
    fn contains_is_false_for_unseen_hash() {
        let history = ImportHistory::default();
        assert!(!history.contains("abc", 100));
    }

    #[test]
    fn record_then_contains_round_trips() {
        let mut history = ImportHistory::default();
        history.record("abc", 100, dummy_record("/lib/2026/img.CR3"));
        assert!(history.contains("abc", 100));
        // Same hash, different size - the hash alone only covers a few MB,
        // so size must also match.
        assert!(!history.contains("abc", 200));
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = std::env::temp_dir().join(format!("brighttable-test-import-history-{}", std::process::id()));
        let path = dir.join("import_history.json");
        let mut history = ImportHistory::default();
        history.record("abc", 100, dummy_record("/lib/2026/img.CR3"));
        history.save(&path).unwrap();

        let loaded = ImportHistory::load(&path);
        assert!(loaded.contains("abc", 100));
        assert_eq!(loaded.len(), 1);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_of_missing_file_is_an_empty_history() {
        let missing = std::env::temp_dir().join("brighttable-test-import-history-missing.json");
        let _ = fs::remove_file(&missing);
        assert_eq!(ImportHistory::load(&missing).len(), 0);
    }

    fn scanned_file(hash: &str, size: u64) -> ScannedFile {
        ScannedFile {
            source_path: format!("/sd/{hash}.CR3"),
            extension: "CR3".into(),
            size_bytes: size,
            partial_hash: hash.into(),
            capture_time: dummy_time(),
            capture_time_is_exif: false,
        }
    }

    #[test]
    fn marks_group_already_imported_only_when_every_member_matches() {
        let mut history = ImportHistory::default();
        history.record("raw-hash", 100, dummy_record("/lib/2026/img.CR3"));

        let mut groups = vec![
            ScannedGroup {
                basename: "fully-seen".into(),
                files: vec![scanned_file("raw-hash", 100)],
                capture_time: dummy_time(),
                already_imported: false,
            },
            ScannedGroup {
                basename: "partially-seen".into(),
                files: vec![scanned_file("raw-hash", 100), scanned_file("jpeg-hash", 50)],
                capture_time: dummy_time(),
                already_imported: false,
            },
        ];

        mark_already_imported(&mut groups, &history);
        assert!(groups[0].already_imported, "every member matches - whole group already imported");
        assert!(!groups[1].already_imported, "only one member matches - group must still be copied");
    }
}
