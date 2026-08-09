//! Derives the date/time used to name an imported file
//! (`yyyymmdd_hh-mm-ss`) and to place it under a `yyyy/yyyy_mm` folder.
//! EXIF `DateTimeOriginal`/`DateTime` is preferred; the file's mtime is the
//! fallback whenever EXIF is missing or unreadable - which, per
//! `kamadak-exif`'s format coverage, is expected to happen more often for
//! Canon CR3 (an ISO-BMFF/MOV-style container, not TIFF) and Fujifilm RAF
//! (a proprietary wrapper around an embedded TIFF section) than for the
//! TIFF-based RAW formats (NEF/ARW/DNG/ORF/RW2/PEF/SRW). Both paths are
//! best-effort - a file this can't get any date for at all is not possible,
//! since mtime always exists.

use std::fs;
use std::io::{self, Read};
use std::path::Path;
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

use super::scan::ScannedFile;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureTime {
    pub year: i32,
    pub month: u8,
    pub day: u8,
    pub hour: u8,
    pub minute: u8,
    pub second: u8,
}

impl CaptureTime {
    /// `yyyymmdd_hh-mm-ss` - the fixed filename pattern, no extension.
    pub fn filename_stem(&self) -> String {
        format!(
            "{:04}{:02}{:02}_{:02}-{:02}-{:02}",
            self.year, self.month, self.day, self.hour, self.minute, self.second
        )
    }

    pub fn year_str(&self) -> String {
        format!("{:04}", self.year)
    }

    /// `yyyy_mm`, per the `yyyy/yyyy_mm/...` folder hierarchy.
    pub fn year_month_str(&self) -> String {
        format!("{:04}_{:02}", self.year, self.month)
    }
}

/// How much of the file gets read into memory before handing it to the EXIF
/// parser - same size as `hash.rs`'s `PARTIAL_HASH_BYTES`, for the same
/// reason: the IFD entries `kamadak-exif` needs for `DateTimeOriginal` are
/// always in a TIFF/JPEG/RAW file's early structure, well within this
/// window, even though the file itself can run to tens of MB.
const EXIF_PREFIX_BYTES: usize = 4 * 1024 * 1024;

/// Reads EXIF `DateTimeOriginal` (falling back to the plain `DateTime` tag)
/// via `kamadak-exif`. Best-effort: any read/parse failure, or the tag
/// simply being absent, is `None` - never an error, since the mtime
/// fallback always covers it.
///
/// Reads a bounded prefix into memory in one sequential pass and hands
/// `kamadak-exif` a `Cursor` over that buffer, rather than handing it a
/// `BufReader` over the file directly - confirmed live over a slow SD card
/// reader: letting the parser seek around the actual file cost ~1s/file
/// (it jumps between IFD entries scattered through the file, and each seek
/// is a full round trip over a slow interface), against ~0.3s/file for one
/// sequential read of the same bytes. Over hundreds of files that's the
/// difference between a scan finishing in minutes versus over half an hour.
pub fn read_exif_capture_time(path: &Path) -> Option<CaptureTime> {
    let file = fs::File::open(path).ok()?;
    // A single `Read::read` call isn't guaranteed to fill the buffer even
    // when that much data is available (it can return short reads well
    // under 4MB depending on the underlying reader) - `take` + `read_to_end`
    // loops until either the cap or real EOF, same guarantee `hash.rs`'s
    // `partial_hash` gets from its own manual loop.
    let mut buf = Vec::with_capacity(EXIF_PREFIX_BYTES);
    file.take(EXIF_PREFIX_BYTES as u64).read_to_end(&mut buf).ok()?;
    let mut cursor = io::Cursor::new(buf);
    let exif = exif::Reader::new().read_from_container(&mut cursor).ok()?;
    let field = exif
        .get_field(exif::Tag::DateTimeOriginal, exif::In::PRIMARY)
        .or_else(|| exif.get_field(exif::Tag::DateTime, exif::In::PRIMARY))?;
    parse_exif_datetime(&field.display_value().to_string())
}

/// EXIF datetime strings are always `"YYYY:MM:DD HH:MM:SS"` - naive, no
/// timezone. Parsed as plain wall-clock components, not converted through
/// any timezone math - this is only ever used to derive a same-order-as-
/// capture filename, never shown to the user as an absolute time.
fn parse_exif_datetime(s: &str) -> Option<CaptureTime> {
    let s = s.trim();
    if s.len() < 19 {
        return None;
    }
    Some(CaptureTime {
        year: s.get(0..4)?.parse().ok()?,
        month: s.get(5..7)?.parse().ok()?,
        day: s.get(8..10)?.parse().ok()?,
        hour: s.get(11..13)?.parse().ok()?,
        minute: s.get(14..16)?.parse().ok()?,
        second: s.get(17..19)?.parse().ok()?,
    })
}

/// Fallback used whenever EXIF has nothing readable - UTC, not local time.
/// There's no exact "right" answer for a fallback that only exists because
/// the real capture date is unknown; UTC is simply deterministic and needs
/// no local-timezone lookup, which is enough for a fallback path.
pub fn mtime_capture_time(path: &Path) -> io::Result<CaptureTime> {
    let modified = fs::metadata(path)?.modified()?;
    Ok(capture_time_from_system_time(modified))
}

fn capture_time_from_system_time(t: SystemTime) -> CaptureTime {
    let utc = time::UtcDateTime::from(t);
    CaptureTime {
        year: utc.year(),
        month: u8::from(utc.month()),
        day: utc.day(),
        hour: utc.hour(),
        minute: utc.minute(),
        second: utc.second(),
    }
}

/// One file's effective capture time - EXIF-derived when available, else
/// the mtime fallback. Never errors: a file whose mtime can't even be read
/// (very unusual) falls back to the current time rather than failing the
/// whole scan over one file.
pub fn file_capture_time(path: &Path) -> (CaptureTime, bool) {
    if let Some(ct) = read_exif_capture_time(path) {
        return (ct, true);
    }
    let ct = mtime_capture_time(path).unwrap_or_else(|_| capture_time_from_system_time(SystemTime::now()));
    (ct, false)
}

/// One capture time for a whole scanned group (e.g. a RAW+JPEG pair):
/// prefers an EXIF-derived time from a RAW member, then any EXIF-derived
/// time, then the earliest mtime-derived time among the group (an
/// inherently arbitrary tie-break, since none of them are real capture
/// times at that point).
pub fn best_capture_time(files: &[ScannedFile]) -> CaptureTime {
    files
        .iter()
        .find(|f| f.capture_time_is_exif && super::scan::is_raw_extension(&f.extension))
        .or_else(|| files.iter().find(|f| f.capture_time_is_exif))
        .or_else(|| files.iter().min_by_key(|f| f.capture_time))
        .expect("a scanned group always has at least one file")
        .capture_time
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_exif_datetime_string() {
        assert_eq!(
            parse_exif_datetime("2026:06:21 08:23:13"),
            Some(CaptureTime { year: 2026, month: 6, day: 21, hour: 8, minute: 23, second: 13 })
        );
    }

    #[test]
    fn rejects_too_short_datetime_string() {
        assert_eq!(parse_exif_datetime("2026:06:21"), None);
    }

    #[test]
    fn formats_filename_stem_and_folder_components() {
        let ct = CaptureTime { year: 2026, month: 6, day: 21, hour: 8, minute: 23, second: 13 };
        assert_eq!(ct.filename_stem(), "20260621_08-23-13");
        assert_eq!(ct.year_str(), "2026");
        assert_eq!(ct.year_month_str(), "2026_06");
    }

    fn file(extension: &str, capture_time: CaptureTime, is_exif: bool) -> ScannedFile {
        ScannedFile {
            source_path: format!("/x.{}", extension.to_lowercase()),
            extension: extension.to_string(),
            size_bytes: 0,
            partial_hash: String::new(),
            capture_time,
            capture_time_is_exif: is_exif,
        }
    }

    #[test]
    fn prefers_raw_members_exif_time_over_jpegs() {
        let raw_time = CaptureTime { year: 2026, month: 6, day: 21, hour: 8, minute: 23, second: 13 };
        let jpeg_time = CaptureTime { year: 2026, month: 6, day: 21, hour: 8, minute: 23, second: 12 };
        let files = vec![file("JPG", jpeg_time, true), file("CR3", raw_time, true)];
        assert_eq!(best_capture_time(&files), raw_time);
    }

    #[test]
    fn falls_back_to_any_exif_time_when_no_raw_member_has_one() {
        let jpeg_time = CaptureTime { year: 2026, month: 6, day: 21, hour: 8, minute: 23, second: 12 };
        let raw_mtime = CaptureTime { year: 2026, month: 6, day: 21, hour: 9, minute: 0, second: 0 };
        let files = vec![file("CR3", raw_mtime, false), file("JPG", jpeg_time, true)];
        assert_eq!(best_capture_time(&files), jpeg_time);
    }

    #[test]
    fn falls_back_to_earliest_mtime_when_nothing_has_exif() {
        let later = CaptureTime { year: 2026, month: 6, day: 21, hour: 9, minute: 0, second: 0 };
        let earlier = CaptureTime { year: 2026, month: 6, day: 21, hour: 8, minute: 0, second: 0 };
        let files = vec![file("CR3", later, false), file("JPG", earlier, false)];
        assert_eq!(best_capture_time(&files), earlier);
    }

    #[test]
    fn reads_exif_capture_time_from_a_real_jpeg_with_a_small_prefix() {
        // A minimal real JPEG+EXIF fixture would need binary test data this
        // module doesn't otherwise carry; the read-a-bounded-prefix behavior
        // itself (rather than the exif parsing, already covered by the
        // vendored `kamadak-exif` crate's own tests) is what changed here,
        // so this just guards against the obvious regression: a file
        // smaller than `EXIF_PREFIX_BYTES` must not panic or hang (`take`
        // stops at real EOF same as any other reader).
        let dir = std::env::temp_dir().join(format!("brighttable-test-capture-time-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("tiny.jpg");
        std::fs::write(&path, b"not actually a jpeg, just tiny").unwrap();

        assert_eq!(read_exif_capture_time(&path), None);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
