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

//! EXIF `Orientation` rotate-in-place - the Viewer's Rotate Left/Right
//! actions (see `commands::rotate_asset`). A deliberate, narrow exception to
//! this codebase's usual rule of never touching an asset's original file -
//! every other local edit here (rating/description/develop settings) goes
//! to a `.xmp`/`.pp3`/`.arp` *sidecar* instead, see `paths.rs`. `Orientation`
//! is a single EXIF IFD tag, not pixel data, so rewriting it with
//! `exiftool -Orientation#=N -overwrite_original` is a lossless, no-
//! recompress metadata edit - the same "safe tag to rewrite in place"
//! property that makes lossless-JPEG-rotation tools (jhead, exiftool's own
//! rotate recipes) safe, and it applies the same way across JPEG/TIFF and
//! the RAW containers this codebase already trusts `exiftool` to read/write
//! metadata on elsewhere (see `exiftool.rs`).

use std::path::Path;

use crate::exiftool;

/// Collapses one of the 8 standard EXIF `Orientation` values to one of the 4
/// that carry no mirroring (`1` Normal, `3` Rotate180, `6` Rotate90Cw, `8`
/// Rotate270Cw). A mirrored source (`2`/`4`/`5`/`7`, rare in practice - about
/// the only real-world source is a horizontally-flipped scan) is treated as
/// its un-mirrored equivalent before rotating, since this feature has no
/// separate "flip" action of its own to preserve the mirror through a
/// rotation composition. Anything else unrecognized also falls back to `1`.
fn normalize(value: u16) -> u16 {
    match value {
        2 => 1,
        4 => 3,
        5 => 6,
        7 => 8,
        1 | 3 | 6 | 8 => value,
        _ => 1,
    }
}

/// Rotates one 90-degree step, clockwise or counter-clockwise, from any
/// existing `Orientation` value.
pub fn rotate_orientation(current: u16, clockwise: bool) -> u16 {
    const CYCLE: [u16; 4] = [1, 6, 3, 8]; // Normal -> Rotate90Cw -> Rotate180 -> Rotate270Cw -> Normal
    let idx = CYCLE.iter().position(|&v| v == normalize(current)).unwrap_or(0);
    let next = if clockwise { (idx + 1) % 4 } else { (idx + 3) % 4 };
    CYCLE[next]
}

/// Reads the current numeric `Orientation` tag, or `1` (Normal) if the file
/// has none set or the tag can't be parsed - matches how browsers/Immich
/// itself treat a missing tag. `-s -s -s` is exiftool's own idiom for "just
/// the bare value, no tag name/formatting" (each repetition strips one more
/// layer of the default `Tag Name : Value` output).
async fn read_orientation(exiftool_path: &str, path: &Path) -> Result<u16, String> {
    let args = vec![
        "-Orientation".to_string(),
        "-n".to_string(),
        "-s".to_string(),
        "-s".to_string(),
        "-s".to_string(),
        path.to_string_lossy().into_owned(),
    ];
    let stdout = exiftool::run_exiftool_capture_stdout(exiftool_path, &args).await?;
    Ok(stdout.trim().parse().unwrap_or(1))
}

/// Reads the current orientation, rotates it one step, and writes the result
/// back - returns the new value so the caller has something concrete to
/// report without a second read. `-Orientation#=N` (the `#` suffix) assigns
/// the raw numeric tag value directly rather than a print-converted string
/// like "Rotate 90 CW".
pub async fn rotate_in_place(exiftool_path: &str, path: &Path, clockwise: bool) -> Result<u16, String> {
    let current = read_orientation(exiftool_path, path).await?;
    let next = rotate_orientation(current, clockwise);
    let args = vec![
        format!("-Orientation#={next}"),
        "-overwrite_original".to_string(),
        path.to_string_lossy().into_owned(),
    ];
    exiftool::run_exiftool(exiftool_path, &args).await?;
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotates_clockwise_through_the_four_states() {
        assert_eq!(rotate_orientation(1, true), 6);
        assert_eq!(rotate_orientation(6, true), 3);
        assert_eq!(rotate_orientation(3, true), 8);
        assert_eq!(rotate_orientation(8, true), 1);
    }

    #[test]
    fn rotates_counterclockwise_through_the_four_states() {
        assert_eq!(rotate_orientation(1, false), 8);
        assert_eq!(rotate_orientation(8, false), 3);
        assert_eq!(rotate_orientation(3, false), 6);
        assert_eq!(rotate_orientation(6, false), 1);
    }

    #[test]
    fn normalizes_a_mirrored_or_unknown_value_before_rotating() {
        assert_eq!(rotate_orientation(2, true), 6); // mirrored-normal treated as Normal
        assert_eq!(rotate_orientation(4, true), 8); // mirrored-180 treated as 180
        assert_eq!(rotate_orientation(0, true), 6); // unrecognized treated as Normal
        assert_eq!(rotate_orientation(9, false), 8); // unrecognized treated as Normal
    }

    #[test]
    fn a_full_lap_returns_to_the_start() {
        let mut v = 1u16;
        for _ in 0..4 {
            v = rotate_orientation(v, true);
        }
        assert_eq!(v, 1);
    }
}
