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

/// Prefix for the hidden in-progress file a round-trip export is written to
/// before being renamed into place - see `next_export_path`.
const PARTIAL_PREFIX: &str = ".brighttable-partial-";

/// The hidden sibling an export is actually written to while it's in
/// progress: `"{dir}/.brighttable-partial-{name}"`. It keeps the real
/// extension on purpose: `ART-cli` swaps out whatever extension `-o` is given
/// for its own (confirmed live, `x.jpg.tmp` became `x.jpg.jpg`), and exiftool
/// picks the format from the extension, so the name has to stay `*.jpg`. The
/// leading dot is what keeps Immich's library scan away from it.
pub fn partial_path(export_path: &Path) -> PathBuf {
    let name = export_path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    export_path.with_file_name(format!("{PARTIAL_PREFIX}{name}"))
}

/// Drops the claim `next_export_path` made for `export_path` (its hidden
/// `partial_path` file), for a caller whose export failed or was cancelled.
/// Never touches `export_path` itself, which only exists once an export has
/// fully finished.
pub fn release_claim(export_path: impl AsRef<Path>) {
    let _ = std::fs::remove_file(partial_path(export_path.as_ref()));
}

/// Moves a finished export from its hidden `partial_path` to `export_path`
/// in a single rename (same directory, so atomic), so Immich only ever sees
/// the complete file with its metadata already written.
pub fn publish_partial(export_path: &Path) -> io::Result<()> {
    std::fs::rename(partial_path(export_path), export_path)
}

/// Builds `"{dir}/{base}_{core}-{n}.{ext}"`, scanning disk for the first free
/// `n` starting at 1 and atomically *claiming* it - always numbered, never a
/// bare filename, so round-tripping the same original twice never silently
/// overwrites the first export.
///
/// The claim is the hidden `partial_path` sibling, created with `create_new`,
/// not the real filename. The converter writes into that hidden file and
/// `publish_partial` renames it into place only once the export and its
/// metadata are complete. Claiming the real name with an empty placeholder
/// (the original design) left a 0-byte JPEG in the library for the whole
/// export, which Immich could index as a metadata-less asset. A number counts
/// as taken if either the real file or another export's claim exists.
///
/// The atomic claim matters: the converter doesn't run until well after this
/// returns (for Variant 2, every target in a batch is resolved up front), so a
/// plain `.exists()` check would let two round trips resolved around the same
/// time pick the *same* number and write the same path concurrently. Callers
/// that end up not producing an export (a later error, a timeout) must call
/// `release_claim`.
pub fn next_export_path(dir: &Path, base: &str, core: &str, ext: &str) -> io::Result<PathBuf> {
    let mut n: u32 = 1;
    loop {
        let candidate = dir.join(format!("{base}_{core}-{n}.{ext}"));
        if candidate.exists() {
            n += 1;
            continue;
        }
        match OpenOptions::new().write(true).create_new(true).open(partial_path(&candidate)) {
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
        // Claimed via the hidden partial file, never an empty placeholder
        // at the real name that Immich could index.
        assert!(!first.exists());
        assert!(dir.join(".brighttable-partial-IMG_1_converted-1.jpg").exists());
        let second = next_export_path(&dir, "IMG_1", "converted", "jpg").unwrap();
        assert_eq!(second, dir.join("IMG_1_converted-2.jpg"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn publish_partial_moves_the_finished_export_into_place() {
        let dir = tmp_dir("publish");
        let path = next_export_path(&dir, "IMG_1", "converted", "jpg").unwrap();
        std::fs::write(partial_path(&path), b"jpeg").unwrap();
        publish_partial(&path).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"jpeg");
        assert!(!partial_path(&path).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn release_claim_frees_the_number_for_the_next_export() {
        let dir = tmp_dir("release");
        let path = next_export_path(&dir, "IMG_1", "converted", "jpg").unwrap();
        release_claim(&path);
        assert_eq!(next_export_path(&dir, "IMG_1", "converted", "jpg").unwrap(), path);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
