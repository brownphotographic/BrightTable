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

//! Change Time - the pure half: which date/time tags get written where.
//! The I/O lives in `edit_queue.rs`'s time job.
//!
//! All of the time-zone math (camera clock zone, taken-in zone, clock
//! correction, DST) happens in the frontend (`lib/timeZones.ts`), so the
//! dialog's preview is exactly what's written - each target arrives here as
//! a finished wall-clock time plus its UTC offset.
//!
//! Where each consumer reads the capture time from:
//! - Immich merges `{...originalTags, ...sidecarTags}`, so the sidecar's
//!   `exif:DateTimeOriginal` (with its offset) wins over the original's -
//!   unlike lens tags, no Composite tag gets in the way. The job also PUTs
//!   `dateTimeOriginal` so Immich updates at once rather than on its next
//!   metadata refresh.
//! - RawTherapee, ART and darktable read the date from the RAW itself (Exiv2),
//!   never from an XMP sidecar - same as lens tags - so their exports keep the
//!   camera's date unless the original is written.
//!
//! Not yet confirmed live (October 2026): whether Immich's own sidecar write
//! after the PUT (when its library is writable) ever disagrees with ours - it
//! writes the same `DateTimeOriginal` value, so it shouldn't.

use crate::lens_edit::NS_BRIGHTTABLE;
use crate::xmp::XmpProp;

const NS_EXIF: &str = "http://ns.adobe.com/exif/1.0/";
const NS_XMP: &str = "http://ns.adobe.com/xap/1.0/";
const NS_PHOTOSHOP: &str = "http://ns.adobe.com/photoshop/1.0/";

/// One target's new capture time - see `commands::change_asset_time`.
#[derive(Debug, Clone, PartialEq)]
pub struct TimeChange {
    /// Wall-clock time where the photo was taken, `YYYY-MM-DDTHH:MM:SS`.
    pub local: String,
    /// That moment's UTC offset there, `+02:00` / `-05:00` / `+05:45`.
    pub offset: String,
    /// The IANA zone the user picked (`Europe/Paris`), when they picked one
    /// rather than a fixed offset - remembered so the dialog can offer it
    /// again next time.
    pub zone_name: Option<String>,
    pub write_original: bool,
}

impl TimeChange {
    /// Checks the shape of `local`/`offset` - they come straight from the
    /// frontend and end up in exiftool argv and XMP.
    pub fn validate(&self) -> Result<(), String> {
        parse_local(&self.local).ok_or_else(|| format!("Not a valid date and time: {}", self.local))?;
        parse_offset(&self.offset).ok_or_else(|| format!("Not a valid UTC offset: {}", self.offset))?;
        Ok(())
    }

    /// `2026-06-01T09:12:00+02:00` - XMP's date form, and what Immich's
    /// `PUT /assets` takes as `dateTimeOriginal`.
    pub fn iso(&self) -> String {
        format!("{}{}", self.local, self.offset)
    }

    /// `2026:06:01 09:12:00` - EXIF's own date form, for exiftool.
    pub fn exif_datetime(&self) -> String {
        self.local.replacen('-', ":", 2).replacen('T', " ", 1)
    }
}

/// `YYYY-MM-DDTHH:MM:SS` -> its six numbers, range-checked.
fn parse_local(s: &str) -> Option<[u32; 6]> {
    let b = s.as_bytes();
    if b.len() != 19 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let num = |r: std::ops::Range<usize>| s.get(r).filter(|p| p.bytes().all(|c| c.is_ascii_digit())).and_then(|p| p.parse::<u32>().ok());
    let v = [num(0..4)?, num(5..7)?, num(8..10)?, num(11..13)?, num(14..16)?, num(17..19)?];
    let ok = (1..=12).contains(&v[1]) && (1..=31).contains(&v[2]) && v[3] < 24 && v[4] < 60 && v[5] < 60;
    ok.then_some(v)
}

/// `+05:45` -> minutes east of UTC, within the real-world -12:00..+14:00.
fn parse_offset(s: &str) -> Option<i32> {
    let b = s.as_bytes();
    if b.len() != 6 || !(b[0] == b'+' || b[0] == b'-') || b[3] != b':' {
        return None;
    }
    let h: i32 = s.get(1..3).filter(|p| p.bytes().all(|c| c.is_ascii_digit()))?.parse().ok()?;
    let m: i32 = s.get(4..6).filter(|p| p.bytes().all(|c| c.is_ascii_digit()))?.parse().ok()?;
    if m >= 60 {
        return None;
    }
    let mins = if b[0] == b'-' { -(h * 60 + m) } else { h * 60 + m };
    (-12 * 60..=14 * 60).contains(&mins).then_some(mins)
}

fn prop(prefix: &'static str, ns_uri: &'static str, name: &'static str, value: String) -> XmpProp {
    XmpProp { prefix, ns_uri, name, value }
}

/// The sidecar half - what Immich reads on its next metadata refresh.
pub fn sidecar_props(change: &TimeChange) -> Vec<XmpProp> {
    let iso = change.iso();
    let mut props = vec![
        prop("exif", NS_EXIF, "DateTimeOriginal", iso.clone()),
        prop("xmp", NS_XMP, "CreateDate", iso.clone()),
        prop("photoshop", NS_PHOTOSHOP, "DateCreated", iso),
    ];
    if let Some(zone) = change.zone_name.as_deref().map(str::trim).filter(|z| !z.is_empty()) {
        props.push(prop("brighttable", NS_BRIGHTTABLE, "TimeZone", zone.to_string()));
    }
    props
}

/// The capture time the file carried before BrightTable first changed it -
/// written only when the sidecar doesn't already remember one, so a second
/// Change Time never overwrites the true original with the first edit's.
pub fn original_time_prop(current: &str) -> Option<XmpProp> {
    let current = current.trim();
    (!current.is_empty()).then(|| prop("brighttable", NS_BRIGHTTABLE, "OriginalDateTimeOriginal", current.to_string()))
}

/// exiftool argv that rewrites the original's EXIF capture time and offsets
/// in place. `OffsetTime` (ModifyDate's offset) is left alone - ModifyDate
/// itself isn't changed.
pub fn original_write_args(change: &TimeChange, keep_backup: bool, target: &std::path::Path) -> Vec<String> {
    let dt = change.exif_datetime();
    let mut args = vec![
        format!("-EXIF:DateTimeOriginal={dt}"),
        format!("-EXIF:CreateDate={dt}"),
        format!("-EXIF:OffsetTimeOriginal={}", change.offset),
        format!("-EXIF:OffsetTimeDigitized={}", change.offset),
    ];
    if !keep_backup {
        args.push("-overwrite_original".to_string());
    }
    args.push(target.to_string_lossy().to_string());
    args
}

/// exiftool argv for the post-write readback.
pub fn readback_args(target: &std::path::Path) -> Vec<String> {
    vec!["-s3".to_string(), "-EXIF:DateTimeOriginal".to_string(), target.to_string_lossy().to_string()]
}

/// `Some(warning)` when the original doesn't now carry the time just written.
pub fn readback_warning(readback_stdout: &str, change: &TimeChange) -> Option<String> {
    let found = readback_stdout.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    let expected = change.exif_datetime();
    // exiftool may append sub-seconds or an offset depending on the format.
    if found.starts_with(&expected) {
        return None;
    }
    Some(format!("The original was rewritten, but exiftool now reads its capture time as \"{found}\" rather than \"{expected}\"."))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn change() -> TimeChange {
        TimeChange { local: "2026-06-01T09:12:00".into(), offset: "+02:00".into(), zone_name: Some("Europe/Paris".into()), write_original: false }
    }

    fn value<'a>(props: &'a [XmpProp], name: &str) -> Option<&'a str> {
        props.iter().find(|p| p.name == name).map(|p| p.value.as_str())
    }

    #[test]
    fn formats_iso_and_exif_forms() {
        let c = change();
        assert_eq!(c.iso(), "2026-06-01T09:12:00+02:00");
        assert_eq!(c.exif_datetime(), "2026:06:01 09:12:00");
    }

    #[test]
    fn validates_local_time_and_offset() {
        assert!(change().validate().is_ok());
        let bad = |local: &str, offset: &str| TimeChange { local: local.into(), offset: offset.into(), ..change() }.validate().is_err();
        assert!(bad("2026-06-01 09:12:00", "+02:00"));
        assert!(bad("2026-13-01T09:12:00", "+02:00"));
        assert!(bad("2026-06-01T24:00:00", "+02:00"));
        assert!(bad("2026-06-01T09:12:00\" -o /tmp/x", "+02:00"));
        assert!(bad("2026-06-01T09:12:00", "+2:00"));
        assert!(bad("2026-06-01T09:12:00", "+15:00"));
        assert!(bad("2026-06-01T09:12:00", "-12:30"));
        assert!(!bad("2026-06-01T09:12:00", "+05:45"));
        assert!(!bad("2026-06-01T09:12:00", "+14:00"));
        assert!(!bad("2026-06-01T09:12:00", "-12:00"));
    }

    #[test]
    fn sidecar_props_cover_every_date_field() {
        let props = sidecar_props(&change());
        assert_eq!(value(&props, "DateTimeOriginal"), Some("2026-06-01T09:12:00+02:00"));
        assert_eq!(value(&props, "CreateDate"), Some("2026-06-01T09:12:00+02:00"));
        assert_eq!(value(&props, "DateCreated"), Some("2026-06-01T09:12:00+02:00"));
        assert_eq!(value(&props, "TimeZone"), Some("Europe/Paris"));
    }

    #[test]
    fn fixed_offset_writes_no_zone_name() {
        let props = sidecar_props(&TimeChange { zone_name: None, ..change() });
        assert_eq!(value(&props, "TimeZone"), None);
        assert_eq!(props.len(), 3);
    }

    #[test]
    fn original_args_rewrite_exif_and_respect_backup_choice() {
        let args = original_write_args(&change(), true, Path::new("/raw/x.DNG"));
        assert_eq!(
            args,
            vec![
                "-EXIF:DateTimeOriginal=2026:06:01 09:12:00",
                "-EXIF:CreateDate=2026:06:01 09:12:00",
                "-EXIF:OffsetTimeOriginal=+02:00",
                "-EXIF:OffsetTimeDigitized=+02:00",
                "/raw/x.DNG",
            ]
        );
        assert!(original_write_args(&change(), false, Path::new("/raw/x.DNG")).contains(&"-overwrite_original".to_string()));
    }

    #[test]
    fn readback_warns_only_when_the_time_differs() {
        assert_eq!(readback_warning("2026:06:01 09:12:00\n", &change()), None);
        assert_eq!(readback_warning("2026:06:01 09:12:00.45+02:00\n", &change()), None);
        assert!(readback_warning("2026:06:01 03:10:00\n", &change()).unwrap().contains("03:10:00"));
    }

    #[test]
    fn original_time_prop_skips_blank() {
        assert_eq!(original_time_prop(" "), None);
        assert_eq!(original_time_prop("2026-06-01T03:10:00-04:00").unwrap().value, "2026-06-01T03:10:00-04:00");
    }
}
