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

//! Pure filename-generation logic for the ART CLI round trip
//! (`commands::launch_raw_cli_round_trip`/`batch_raw_cli_round_trip`) - mirrors
//! `smartStack.ts`'s naming helpers exactly, since BrightTable itself invokes
//! `ART-cli` and controls the output filename deterministically (rather than
//! discovering it after the fact via `round_trip.rs`'s file watcher), and the
//! name it picks must still match Smart Stack's own Version-mode pattern
//! (`matchesVersionSuffix`/`buildVersionRegex`) or a round-tripped export
//! would silently fail to auto-stack with its RAW original.
//!
//! There's no shared Rust/TS test runner to verify cross-language agreement
//! automatically - the exact `"*converted*"` + `"IMG_0001.DNG"` ->
//! `"IMG_0001_converted-1.jpg"` case is covered by a unit test here, and
//! should be cross-checked by hand against `smartStack.ts` during manual
//! testing.

use std::fs::OpenOptions;
use std::io;
use std::path::{Path, PathBuf};

/// Strips `*` wildcards from a Smart Stack suffix pattern (e.g.
/// `"*converted*"`) down to its literal core text (`"converted"`), for use in
/// a generated export's filename. Multiple literal segments (e.g.
/// `"*conv*erted*"`) are joined together; falls back to `"converted"` (the
/// suffix pattern's own default core) if nothing literal survives, e.g. a
/// pattern of `"*"` alone.
pub fn suffix_core(pattern: &str) -> String {
    let core: String = pattern.split('*').filter(|s| !s.is_empty()).collect::<Vec<_>>().join("");
    if core.trim().is_empty() {
        "converted".to_string()
    } else {
        core
    }
}

/// Mirrors `smartStack.ts`'s `baseName()` precisely: strips exactly
/// `.{file_extension}` (case-insensitive) off the end of `file_name`, or
/// falls back to "everything before the last dot" if that suffix doesn't
/// match - so a base name that itself contains a dot isn't mangled.
pub fn base_name<'a>(file_name: &'a str, file_extension: &str) -> &'a str {
    if !file_extension.is_empty() {
        let suffix = format!(".{}", file_extension.to_lowercase());
        if file_name.to_lowercase().ends_with(&suffix) && file_name.len() > suffix.len() {
            return &file_name[..file_name.len() - suffix.len()];
        }
    }
    match file_name.rfind('.') {
        Some(idx) if idx > 0 => &file_name[..idx],
        _ => file_name,
    }
}

/// Builds `"{dir}/{base}_{core}-{n}.{ext}"`, scanning disk for the first free
/// `n` starting at 1 and atomically *claiming* it (`create_new`, not just an
/// existence check) - always numbered, never a bare filename, so
/// round-tripping the same original twice never silently overwrites the
/// first export.
///
/// The atomic claim matters: `ART-cli` itself doesn't run until well after
/// this returns (for Variant 2, every target in a batch is resolved up front,
/// before any export starts; even for Variant 1 the export can take minutes -
/// see `art::ART_CLI_RUN_TIMEOUT`'s doc comment), so a plain `.exists()`
/// check leaves a wide window where two round trips resolved around the same
/// time - most commonly two assets in one batch that share a source
/// directory/filename - could both compute the *same* "first free" number and
/// then have two `ART-cli` processes write that same path concurrently,
/// corrupting whichever file lands there. Claiming the name here (as an empty
/// file) the instant it's chosen closes that window - `ART-cli` is always run
/// with `-Y` (overwrite without prompt, see `art::build_art_cli_args`), so
/// writing into an already-claimed empty file is expected, not a conflict.
/// Callers that end up not writing anything to a claimed path (a later error,
/// a timeout) are expected to remove the leftover empty file themselves - see
/// `art_queue.rs`'s worker and `commands::launch_raw_cli_round_trip`'s cleanup on
/// their own error paths.
pub fn next_export_path(dir: &Path, base: &str, core: &str, ext: &str) -> io::Result<PathBuf> {
    let mut n: u32 = 1;
    loop {
        let candidate = dir.join(format!("{base}_{core}-{n}.{ext}"));
        match OpenOptions::new().write(true).create_new(true).open(&candidate) {
            Ok(_) => return Ok(candidate),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => n += 1,
            Err(e) => return Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("brighttable-test-export-naming-{label}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn suffix_core_strips_wildcards() {
        assert_eq!(suffix_core("*converted*"), "converted");
        assert_eq!(suffix_core("converted"), "converted");
        assert_eq!(suffix_core("* - converted"), " - converted");
    }

    #[test]
    fn suffix_core_falls_back_to_converted_when_nothing_literal_survives() {
        assert_eq!(suffix_core("*"), "converted");
        assert_eq!(suffix_core(""), "converted");
        assert_eq!(suffix_core("   "), "converted");
    }

    #[test]
    fn base_name_strips_known_extension_case_insensitively() {
        assert_eq!(base_name("IMG_0001.DNG", "DNG"), "IMG_0001");
        assert_eq!(base_name("IMG_0001.dng", "DNG"), "IMG_0001");
        assert_eq!(base_name("IMG_0001.DNG", "dng"), "IMG_0001");
    }

    #[test]
    fn base_name_falls_back_to_last_dot_split_when_extension_does_not_match() {
        assert_eq!(base_name("IMG_0001.CR2", "DNG"), "IMG_0001");
        assert_eq!(base_name("no_extension_field", ""), "no_extension_field");
    }

    #[test]
    fn base_name_preserves_dots_inside_the_base_itself() {
        assert_eq!(base_name("v1.2_IMG.DNG", "DNG"), "v1.2_IMG");
    }

    // The exact case called out in the ART round-trip plan - must agree with
    // smartStack.ts's baseName()/buildVersionRegex() for the default "*converted*"
    // suffix, or a generated export silently fails to auto-stack with its RAW
    // original.
    #[test]
    fn matches_the_default_converted_suffix_naming_case() {
        let base = base_name("IMG_0001.DNG", "DNG");
        let core = suffix_core("*converted*");
        let dir = tmp_dir("default-case");
        let path = next_export_path(&dir, base, &core, "jpg").unwrap();
        assert_eq!(path.file_name().and_then(|n| n.to_str()), Some("IMG_0001_converted-1.jpg"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn next_export_path_starts_at_one_and_is_always_numbered() {
        let dir = tmp_dir("numbered");
        let path = next_export_path(&dir, "IMG_1", "converted", "jpg").unwrap();
        assert_eq!(path, dir.join("IMG_1_converted-1.jpg"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn next_export_path_finds_the_first_free_number_on_collision() {
        let dir = tmp_dir("collision");
        std::fs::write(dir.join("IMG_1_converted-1.jpg"), b"x").unwrap();
        std::fs::write(dir.join("IMG_1_converted-2.jpg"), b"x").unwrap();
        let path = next_export_path(&dir, "IMG_1", "converted", "jpg").unwrap();
        assert_eq!(path, dir.join("IMG_1_converted-3.jpg"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn next_export_path_actually_claims_the_name_it_returns() {
        // The regression case for the "blank export" bug: without an atomic
        // claim, two calls resolved before either file is actually written
        // would both return "-1" - claiming it here means a second,
        // concurrent call sees it as taken and moves on to "-2".
        let dir = tmp_dir("claims");
        let first = next_export_path(&dir, "IMG_1", "converted", "jpg").unwrap();
        assert_eq!(first, dir.join("IMG_1_converted-1.jpg"));
        assert!(first.exists());
        let second = next_export_path(&dir, "IMG_1", "converted", "jpg").unwrap();
        assert_eq!(second, dir.join("IMG_1_converted-2.jpg"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
