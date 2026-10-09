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

//! Change Lens - the pure half: which tags get written where, the
//! description's "Lens: …" note, and the `.pp3`/`.arp` `[LensProfile]`
//! patch. The I/O lives in `edit_queue.rs`'s lens job.
//!
//! Where each consumer actually reads lens info from - confirmed live
//! (October 2026) against copies of real Leica M10-R DNGs, RawTherapee 5.13,
//! ART, Exiv2 0.28 (what darktable uses) and Immich's own
//! `metadata.service.ts`:
//!
//! | write                          | Immich | RT  | ART | darktable |
//! |--------------------------------|--------|-----|-----|-----------|
//! | XMP sidecar, uncoded original  | yes    | no  | no  | no        |
//! | XMP sidecar, coded original    | **no** | no  | no  | no        |
//! | existing `.pp3`/`.arp` lfmanual| -      | yes | yes | -         |
//! | original rewritten (ExifIFD)   | yes    | yes | yes | yes       |
//!
//! - None of RT/ART/darktable reads lens tags from an XMP sidecar - all three
//!   go through Exiv2 on the RAW itself (`Exiv2::lensName`, which for Leica
//!   lands on `Exif.Photo.LensModel` since it has no Leica makernote keys).
//! - Immich merges `{...originalTags, ...sidecarTags}` but resolves
//!   `lensModel = LensID ?? LensType ?? LensSpec ?? LensModel`. exiftool's
//!   Composite `LensID` is derived from the original's `LensModel` on coded
//!   files, and a sidecar only yields a Composite `LensID` for some naming
//!   patterns - so a sidecar can't reliably override a coded lens in Immich.
//!   Replace on a coded asset therefore needs the original written; the
//!   Change Lens dialog says so and offers it per edit.
//! - A partial `.pp3` *is* accepted by `rawtherapee-cli -s`, but BrightTable's
//!   own round trip runs `-s` alone whenever a sidecar exists (neutral
//!   values underneath), so creating a lens-only profile would flatten that
//!   image's next round trip - only existing profiles are ever patched.

use crate::config::LensSpec;
use crate::xmp::XmpProp;

const NS_EXIF: &str = "http://ns.adobe.com/exif/1.0/";
const NS_EXIF_EX: &str = "http://cipa.jp/exif/1.0/";
const NS_AUX: &str = "http://ns.adobe.com/exif/1.0/aux/";
/// BrightTable's own namespace - only used to remember the lens a file
/// carried before its first Change Lens, so it can still be shown/restored.
pub const NS_BRIGHTTABLE: &str = "https://github.com/brownphotographic/BrightTable/ns/1.0/";

/// What one Change Lens edit applies to every target - see
/// `commands::change_asset_lens`.
#[derive(Debug, Clone, PartialEq)]
pub struct LensChange {
    pub lens: LensSpec,
    /// Write the lens tags (Replace) - `false` for Keep + note, which only
    /// touches the description.
    pub apply_lens: bool,
    pub add_note: bool,
    /// As-shot focal length - required for a zoom (the dialog enforces it),
    /// defaults to the prime's own focal length.
    pub focal_length: Option<f32>,
    /// As-shot aperture, if the user knows it - manual lenses record none.
    pub f_number: Option<f32>,
    pub write_original: bool,
    pub note_prefix: String,
    /// The lens the description note names, when it differs from `lens` -
    /// e.g. Replace with the lensfun lens whose profile is close enough, but
    /// note the lens actually used. None = note `lens` itself.
    pub note_lens_model: Option<String>,
}

impl LensChange {
    /// What the `Lens: …` note says.
    pub fn note_model(&self) -> &str {
        self.note_lens_model.as_deref().map(str::trim).filter(|m| !m.is_empty()).unwrap_or(&self.lens.model)
    }


    pub fn effective_focal_length(&self) -> Option<f32> {
        self.focal_length
            .filter(|f| *f > 0.0)
            .or_else(|| (self.lens.focal_min > 0.0 && self.lens.focal_min == self.lens.focal_max).then_some(self.lens.focal_min))
    }
}

/// `50` -> `"50/1"`, `35.5` -> `"355/10"` - XMP's EXIF rationals.
fn rational(v: f32) -> String {
    if (v - v.round()).abs() < 1e-4 {
        format!("{}/1", v.round() as i64)
    } else {
        format!("{}/100", (v * 100.0).round() as i64)
    }
}

/// Plain decimal without a trailing `.0`, for exiftool's print-converted
/// input (`-FocalLength=50`, `-LensInfo=24 70 2.8 2.8`).
fn decimal(v: f32) -> String {
    let rounded = (v * 100.0).round() / 100.0;
    if rounded.fract() == 0.0 {
        format!("{}", rounded as i64)
    } else {
        format!("{rounded}")
    }
}

/// f-number -> APEX aperture value (`2 * log2(N)`), as an XMP rational -
/// `MaxApertureValue` is stored as APEX, not as an f-number.
fn apex_rational(f_number: f32) -> String {
    let apex = 2.0 * f64::from(f_number).log2();
    format!("{}/100000", (apex * 100_000.0).round() as i64)
}

/// `LensInfo`'s four values (min focal, max focal, widest aperture at min
/// focal, widest at max focal), or `None` when the spec doesn't know its
/// own range (a free-text custom lens with blank numbers).
fn lens_info(lens: &LensSpec) -> Option<[f32; 4]> {
    if lens.focal_min <= 0.0 || lens.aperture_max <= 0.0 {
        return None;
    }
    let fmax = if lens.focal_max >= lens.focal_min { lens.focal_max } else { lens.focal_min };
    let tele = lens.aperture_max_tele.filter(|a| *a > 0.0).unwrap_or(lens.aperture_max);
    Some([lens.focal_min, fmax, lens.aperture_max, tele])
}

fn prop(prefix: &'static str, ns_uri: &'static str, name: &'static str, value: String) -> XmpProp {
    XmpProp { prefix, ns_uri, name, value }
}

/// The sidecar half of a Replace - what Immich picks up on its next
/// metadata refresh (for an uncoded original; see the module doc for why a
/// coded one still needs the original written).
pub fn sidecar_props(change: &LensChange, crop_factor: Option<f32>) -> Vec<XmpProp> {
    if !change.apply_lens {
        return Vec::new();
    }
    let lens = &change.lens;
    let mut props = vec![
        prop("exifEX", NS_EXIF_EX, "LensModel", lens.model.clone()),
        prop("aux", NS_AUX, "Lens", lens.model.clone()),
    ];
    if !lens.maker.trim().is_empty() {
        props.push(prop("exifEX", NS_EXIF_EX, "LensMake", lens.maker.clone()));
    }
    if let Some(info) = lens_info(lens) {
        props.push(prop("aux", NS_AUX, "LensInfo", info.iter().map(|v| rational(*v)).collect::<Vec<_>>().join(" ")));
        props.push(prop("exif", NS_EXIF, "MaxApertureValue", apex_rational(info[2])));
    }
    if let Some(focal) = change.effective_focal_length() {
        props.push(prop("exif", NS_EXIF, "FocalLength", rational(focal)));
        if let Some(crop) = crop_factor.filter(|c| *c > 0.0) {
            props.push(prop("exif", NS_EXIF, "FocalLengthIn35mmFilm", format!("{}", (focal * crop).round() as i64)));
        }
    }
    if let Some(f) = change.f_number.filter(|f| *f > 0.0) {
        props.push(prop("exif", NS_EXIF, "FNumber", rational(f)));
        props.push(prop("exif", NS_EXIF, "ApertureValue", apex_rational(f)));
    }
    props
}

/// The lens the file carried before BrightTable first changed it - written
/// only when the sidecar doesn't already remember one, so a second Change
/// Lens never overwrites the true original with the first edit's value.
pub fn original_lens_prop(current_lens_model: &str) -> Option<XmpProp> {
    let current = current_lens_model.trim();
    (!current.is_empty()).then(|| prop("brighttable", NS_BRIGHTTABLE, "OriginalLensModel", current.to_string()))
}

/// exiftool argv that rewrites the original's ExifIFD lens tags in place.
/// Values go through exiftool's print conversion (`-MaxApertureValue=2` is
/// an f-number, which exiftool converts to APEX itself - confirmed live).
/// `camera_make` decides makernote extras: Leica bodies keep their own
/// metered aperture estimate in `Leica:FNumber`, which exiftool (and so
/// Immich) prefers over `ExifIFD:FNumber` - confirmed live on an M10-R DNG.
pub fn original_write_args(change: &LensChange, crop_factor: Option<f32>, keep_backup: bool, camera_make: &str, target: &std::path::Path) -> Vec<String> {
    let lens = &change.lens;
    let mut args = vec![format!("-ExifIFD:LensModel={}", lens.model), format!("-ExifIFD:LensMake={}", lens.maker)];
    if let Some(info) = lens_info(lens) {
        args.push(format!("-ExifIFD:LensInfo={}", info.iter().map(|v| decimal(*v)).collect::<Vec<_>>().join(" ")));
        args.push(format!("-ExifIFD:MaxApertureValue={}", decimal(info[2])));
    }
    if let Some(focal) = change.effective_focal_length() {
        args.push(format!("-ExifIFD:FocalLength={}", decimal(focal)));
        if let Some(crop) = crop_factor.filter(|c| *c > 0.0) {
            args.push(format!("-ExifIFD:FocalLengthIn35mmFormat={}", (focal * crop).round() as i64));
        }
    }
    if let Some(f) = change.f_number.filter(|f| *f > 0.0) {
        args.push(format!("-ExifIFD:FNumber={}", decimal(f)));
        args.push(format!("-ExifIFD:ApertureValue={}", decimal(f)));
        if camera_make.to_lowercase().contains("leica") {
            args.push(format!("-Leica:FNumber={}", decimal(f)));
        }
    }
    if !keep_backup {
        args.push("-overwrite_original".to_string());
    }
    args.push(target.to_string_lossy().to_string());
    args
}

/// exiftool argv for the post-write readback: what exiftool (and therefore
/// Immich, which resolves `LensID` first) now reports for the original.
pub fn readback_args(target: &std::path::Path) -> Vec<String> {
    vec!["-s3".to_string(), "-LensID".to_string(), "-LensModel".to_string(), target.to_string_lossy().to_string()]
}

/// Compares the readback against the lens just written - `Some(warning)`
/// when Immich will still show something else (e.g. an older Leica whose
/// makernote `LensType` drives exiftool's Composite `LensID`).
pub fn readback_warning(readback_stdout: &str, written_model: &str) -> Option<String> {
    // `-s3 -LensID -LensModel` prints bare values in that order, skipping
    // any tag that's absent - so the first line is LensID when exiftool can
    // derive one, else LensModel itself.
    let lens_id = readback_stdout.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    if lens_id.is_empty() || lens_id.eq_ignore_ascii_case(written_model) {
        return None;
    }
    Some(format!(
        "The original now says \"{written_model}\", but exiftool still identifies the lens as \"{lens_id}\" (from the camera's makernote) - Immich will keep showing that name."
    ))
}

/// Puts `<prefix><lens name>` on its own line at the end of `description`,
/// replacing an earlier line with the same prefix instead of stacking a
/// second one - so re-running Change Lens (or changing your mind about
/// which lens it was) never duplicates the note.
pub fn upsert_lens_note(description: &str, prefix: &str, lens_name: &str) -> String {
    let note = format!("{prefix}{lens_name}");
    let prefix_trimmed = prefix.trim();
    let mut lines: Vec<&str> = description
        .lines()
        .filter(|l| prefix_trimmed.is_empty() || !l.trim_start().starts_with(prefix_trimmed))
        .collect();
    while lines.last().is_some_and(|l| l.trim().is_empty()) {
        lines.pop();
    }
    if lines.is_empty() {
        note
    } else {
        format!("{}\n{note}", lines.join("\n"))
    }
}

/// Which converter a profile belongs to - ART's `.arp` also carries an
/// `[Exif] Lens=` override (the lens name ART writes into exported files).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProfileKind {
    Pp3,
    Arp,
}

/// Sets `[LensProfile]` to lensfun manual mode with the chosen lens, keeping
/// every other line byte-identical - same plain line-scanning approach (and
/// for the same reason: flat `[Section]`/`key=value`, no nesting) as
/// `art::patch_metadata_mode_off`. Adds the section (and, for ART, the
/// `[Exif]` section) when missing. The camera make/model are the asset's
/// own EXIF strings - lensfun matches those case-insensitively against its
/// camera list (`LEICA M10-R` vs lensfun's `Leica M10-R`).
pub fn patch_lens_profile(profile: &str, kind: ProfileKind, camera_make: &str, camera_model: &str, lens_model: &str) -> String {
    let lens_keys: [(&str, String); 4] = [
        ("LcMode", "lfmanual".to_string()),
        ("LFCameraMake", camera_make.to_string()),
        ("LFCameraModel", camera_model.to_string()),
        ("LFLens", lens_model.to_string()),
    ];
    let mut out = set_section_keys(profile, "LensProfile", &lens_keys);
    if kind == ProfileKind::Arp {
        out = set_section_keys(&out, "Exif", &[("Lens", lens_model.to_string())]);
    }
    out
}

fn set_section_keys(profile: &str, section: &str, keys: &[(&str, String)]) -> String {
    let header = format!("[{section}]");
    let mut out: Vec<String> = Vec::new();
    let mut in_section = false;
    let mut seen_section = false;
    let mut written = vec![false; keys.len()];

    let flush_missing = |out: &mut Vec<String>, written: &mut Vec<bool>| {
        // Insert before any trailing blank lines so the section stays
        // visually grouped.
        let mut insert_at = out.len();
        while insert_at > 0 && out[insert_at - 1].trim().is_empty() {
            insert_at -= 1;
        }
        for (i, (k, v)) in keys.iter().enumerate() {
            if !written[i] {
                out.insert(insert_at, format!("{k}={v}"));
                insert_at += 1;
                written[i] = true;
            }
        }
    };

    for line in profile.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            if in_section {
                flush_missing(&mut out, &mut written);
            }
            in_section = trimmed.eq_ignore_ascii_case(&header);
            seen_section |= in_section;
            out.push(line.to_string());
            continue;
        }
        if in_section {
            if let Some((i, (k, v))) = keys.iter().enumerate().find(|(_, (k, _))| trimmed.split_once('=').is_some_and(|(lk, _)| lk.trim() == *k)) {
                out.push(format!("{k}={v}"));
                written[i] = true;
                continue;
            }
        }
        out.push(line.to_string());
    }
    if in_section {
        flush_missing(&mut out, &mut written);
    }
    if !seen_section {
        if out.last().is_some_and(|l| !l.trim().is_empty()) {
            out.push(String::new());
        }
        out.push(header);
        for (k, v) in keys {
            out.push(format!("{k}={v}"));
        }
        out.push(String::new());
    }
    let mut joined = out.join("\n");
    joined.push('\n');
    joined
}

/// How much of an original to read before trying its EXIF. A JPEG's APP1
/// and a TIFF-based RAW's IFDs almost always sit in the first few hundred
/// KB; only when they don't is the whole file read.
const LENS_MAKE_PREFIX_BYTES: u64 = 1024 * 1024;
/// Past this, a whole-file fallback read isn't worth it for one panel row.
const LENS_MAKE_MAX_FULL_READ_BYTES: u64 = 200 * 1024 * 1024;

/// The lens maker for the Metadata panel's Lens Manufacturer row - Immich
/// doesn't carry a lens make at all, so it's read from local files: the XMP
/// sidecar's `exifEX:LensMake` (what Change Lens writes) when that sidecar
/// names the same lens Immich shows (`lens_model`, or any if it shows
/// none), else the original's own EXIF `LensMake`. None when neither has one.
pub fn read_lens_make(original: &std::path::Path, lens_model: Option<&str>) -> Option<String> {
    let shown = lens_model.map(str::trim).filter(|m| !m.is_empty());
    for sidecar in [crate::paths::xmp_sidecar_path(original), crate::paths::xmp_sidecar_path_replaced(original)] {
        let Ok(text) = std::fs::read_to_string(&sidecar) else { continue };
        if let Some(make) = sidecar_lens_make(&text, shown) {
            return Some(make);
        }
    }
    original_lens_make(original)
}

fn sidecar_lens_make(text: &str, shown_lens: Option<&str>) -> Option<String> {
    let make = crate::xmp::read_simple_property(text, "exifEX", "LensMake").filter(|m| !m.trim().is_empty())?;
    let model = crate::xmp::read_simple_property(text, "exifEX", "LensModel");
    match (shown_lens, model) {
        (Some(shown), Some(model)) if !model.trim().eq_ignore_ascii_case(shown) => None,
        _ => Some(make.trim().to_string()),
    }
}

fn original_lens_make(original: &std::path::Path) -> Option<String> {
    use std::io::Read;
    let mut file = std::fs::File::open(original).ok()?;
    let mut prefix = Vec::new();
    (&mut file).take(LENS_MAKE_PREFIX_BYTES).read_to_end(&mut prefix).ok()?;
    if let Some(make) = lens_make_from_bytes(&prefix) {
        return Some(make);
    }
    let len = file.metadata().ok()?.len();
    if len <= prefix.len() as u64 || len > LENS_MAKE_MAX_FULL_READ_BYTES {
        return None;
    }
    let mut all = prefix;
    file.read_to_end(&mut all).ok()?;
    lens_make_from_bytes(&all)
}

fn lens_make_from_bytes(bytes: &[u8]) -> Option<String> {
    let exif = exif::Reader::new().read_from_container(&mut std::io::Cursor::new(bytes)).ok()?;
    let field = exif.get_field(exif::Tag::LensMake, exif::In::PRIMARY)?;
    let exif::Value::Ascii(parts) = &field.value else { return None };
    let make = String::from_utf8_lossy(parts.first()?).trim_matches(|c: char| c == '\0' || c.is_whitespace()).to_string();
    (!make.is_empty()).then_some(make)
}

#[cfg(test)]
mod tests {
    #[test]
    fn note_names_its_own_lens_when_given_one() {
        let mut c = change(summicron());
        assert_eq!(c.note_model(), c.lens.model);
        c.note_lens_model = Some("Planar T* 2/50 ZM".into());
        assert_eq!(c.note_model(), "Planar T* 2/50 ZM");
        c.note_lens_model = Some("  ".into());
        assert_eq!(c.note_model(), c.lens.model);
    }

    #[test]
    fn sidecar_lens_make_only_when_it_names_the_shown_lens() {
        let xmp = r#"<rdf:Description exifEX:LensMake="Carl Zeiss" exifEX:LensModel="Planar T* 2/50 ZM"/>"#;
        assert_eq!(sidecar_lens_make(xmp, Some("Planar T* 2/50 ZM")).as_deref(), Some("Carl Zeiss"));
        assert_eq!(sidecar_lens_make(xmp, Some("planar t* 2/50 zm")).as_deref(), Some("Carl Zeiss"));
        assert_eq!(sidecar_lens_make(xmp, None).as_deref(), Some("Carl Zeiss"));
        // Immich still shows the camera's coded lens - the sidecar's maker
        // belongs to a different lens.
        assert_eq!(sidecar_lens_make(xmp, Some("Summicron-M 1:2/50")), None);
        assert_eq!(sidecar_lens_make(r#"<x exifEX:LensModel="A"/>"#, Some("A")), None);
    }

    // Manual check against real files: BT_LENS_MAKE_FILES="a.jpg:b.DNG"
    // cargo test --lib real_files_lens_make -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_files_lens_make() {
        for f in std::env::var("BT_LENS_MAKE_FILES").unwrap_or_default().split(':').filter(|f| !f.is_empty()) {
            println!("{f} => {:?}", read_lens_make(std::path::Path::new(f), None));
        }
    }

    #[test]
    fn lens_make_from_bytes_ignores_non_exif_input() {
        assert_eq!(lens_make_from_bytes(b"not an image"), None);
        assert_eq!(original_lens_make(std::path::Path::new("/nonexistent/brighttable-test.jpg")), None);
    }

    use super::*;
    use std::path::Path;

    fn summicron() -> LensSpec {
        LensSpec {
            maker: "Leica Camera AG".into(),
            model: "Summicron-M 1:2/50".into(),
            mount: Some("Leica M".into()),
            focal_min: 50.0,
            focal_max: 50.0,
            aperture_max: 2.0,
            aperture_max_tele: None,
        }
    }

    fn change(lens: LensSpec) -> LensChange {
        LensChange {
            note_lens_model: None,
            lens,
            apply_lens: true,
            add_note: false,
            focal_length: None,
            f_number: None,
            write_original: false,
            note_prefix: "Lens: ".into(),
        }
    }

    fn value<'a>(props: &'a [XmpProp], name: &str) -> Option<&'a str> {
        props.iter().find(|p| p.name == name).map(|p| p.value.as_str())
    }

    #[test]
    fn prime_sidecar_props_cover_every_lens_field() {
        let props = sidecar_props(&change(summicron()), Some(1.0));
        assert_eq!(value(&props, "LensModel"), Some("Summicron-M 1:2/50"));
        assert_eq!(value(&props, "Lens"), Some("Summicron-M 1:2/50"));
        assert_eq!(value(&props, "LensMake"), Some("Leica Camera AG"));
        assert_eq!(value(&props, "LensInfo"), Some("50/1 50/1 2/1 2/1"));
        assert_eq!(value(&props, "FocalLength"), Some("50/1"));
        assert_eq!(value(&props, "FocalLengthIn35mmFilm"), Some("50"));
        // f/2 -> APEX 2.0
        assert_eq!(value(&props, "MaxApertureValue"), Some("200000/100000"));
        assert_eq!(value(&props, "FNumber"), None);
    }

    #[test]
    fn zoom_uses_as_shot_focal_and_crop_factor() {
        let zoom = LensSpec {
            maker: "Canon".into(),
            model: "Canon EF 70-300mm f/4-5.6 IS USM".into(),
            mount: None,
            focal_min: 70.0,
            focal_max: 300.0,
            aperture_max: 4.0,
            aperture_max_tele: Some(5.6),
        };
        let mut c = change(zoom.clone());
        assert_eq!(c.effective_focal_length(), None, "a zoom has no implied focal length");
        c.focal_length = Some(135.0);
        c.f_number = Some(8.0);
        let props = sidecar_props(&c, Some(1.6));
        assert_eq!(value(&props, "FocalLength"), Some("135/1"));
        assert_eq!(value(&props, "FocalLengthIn35mmFilm"), Some("216"));
        assert_eq!(value(&props, "LensInfo"), Some("70/1 300/1 4/1 560/100"));
        assert_eq!(value(&props, "FNumber"), Some("8/1"));
    }

    #[test]
    fn free_text_lens_without_specs_writes_only_names() {
        let custom = LensSpec { maker: String::new(), model: "Jupiter-8 50/2 (1958)".into(), ..Default::default() };
        let props = sidecar_props(&change(custom), None);
        let names: Vec<_> = props.iter().map(|p| p.name).collect();
        assert_eq!(names, vec!["LensModel", "Lens"]);
    }

    #[test]
    fn keep_and_note_writes_no_lens_tags() {
        let mut c = change(summicron());
        c.apply_lens = false;
        assert!(sidecar_props(&c, Some(1.0)).is_empty());
    }

    #[test]
    fn original_args_rewrite_exif_ifd_and_respect_backup_choice() {
        let args = original_write_args(&change(summicron()), Some(1.0), true, "Leica Camera AG", Path::new("/raw/x.DNG"));
        assert_eq!(
            args,
            vec![
                "-ExifIFD:LensModel=Summicron-M 1:2/50",
                "-ExifIFD:LensMake=Leica Camera AG",
                "-ExifIFD:LensInfo=50 50 2 2",
                "-ExifIFD:MaxApertureValue=2",
                "-ExifIFD:FocalLength=50",
                "-ExifIFD:FocalLengthIn35mmFormat=50",
                "/raw/x.DNG",
            ]
        );
        let no_backup = original_write_args(&change(summicron()), None, false, "Canon", Path::new("/raw/x.DNG"));
        assert!(no_backup.contains(&"-overwrite_original".to_string()));
        assert!(!no_backup.iter().any(|a| a.starts_with("-ExifIFD:FocalLengthIn35mmFormat")));
    }

    #[test]
    fn as_shot_aperture_also_overrides_leica_makernote_estimate() {
        let mut c = change(summicron());
        c.f_number = Some(5.6);
        let leica = original_write_args(&c, None, true, "Leica Camera AG", Path::new("/raw/x.DNG"));
        assert!(leica.contains(&"-ExifIFD:FNumber=5.6".to_string()));
        assert!(leica.contains(&"-ExifIFD:ApertureValue=5.6".to_string()));
        assert!(leica.contains(&"-Leica:FNumber=5.6".to_string()));
        let sony = original_write_args(&c, None, true, "SONY", Path::new("/raw/x.ARW"));
        assert!(!sony.iter().any(|a| a.starts_with("-Leica:")));
    }

    #[test]
    fn decimal_and_rational_formatting() {
        assert_eq!(decimal(2.8), "2.8");
        assert_eq!(decimal(50.0), "50");
        assert_eq!(rational(35.5), "3550/100");
        assert_eq!(rational(1.4), "140/100");
    }

    #[test]
    fn readback_warns_only_when_lens_id_disagrees() {
        assert_eq!(readback_warning("Planar T* 2/50 ZM\nPlanar T* 2/50 ZM\n", "Planar T* 2/50 ZM"), None);
        assert_eq!(readback_warning("", "Planar T* 2/50 ZM"), None);
        let w = readback_warning("Summicron-M 50mm f/2 (IV, V)\nPlanar T* 2/50 ZM\n", "Planar T* 2/50 ZM").unwrap();
        assert!(w.contains("Summicron-M 50mm f/2 (IV, V)"));
    }

    #[test]
    fn lens_note_appends_on_its_own_line() {
        assert_eq!(upsert_lens_note("", "Lens: ", "Planar T* 2/50 ZM"), "Lens: Planar T* 2/50 ZM");
        assert_eq!(upsert_lens_note("Sunset over the canal", "Lens: ", "Planar T* 2/50 ZM"), "Sunset over the canal\nLens: Planar T* 2/50 ZM");
    }

    #[test]
    fn lens_note_replaces_previous_note_instead_of_duplicating() {
        let once = upsert_lens_note("Sunset\n", "Lens: ", "Planar T* 2/50 ZM");
        let twice = upsert_lens_note(&once, "Lens: ", "Sonnar T* 1.5/50 ZM");
        assert_eq!(twice, "Sunset\nLens: Sonnar T* 1.5/50 ZM");
        assert_eq!(upsert_lens_note(&twice, "Lens: ", "Sonnar T* 1.5/50 ZM"), twice, "idempotent");
    }

    #[test]
    fn lens_note_keeps_other_lines_mentioning_lenses() {
        let d = "Shot with a borrowed lens\nLens: old\nSecond paragraph";
        assert_eq!(upsert_lens_note(d, "Lens: ", "new"), "Shot with a borrowed lens\nSecond paragraph\nLens: new");
    }

    const ART_PROFILE: &str = "[Version]\nAppVersion=1.26.7\n\n[Distortion]\nAmount=0\n\n[LensProfile]\nLcMode=lfauto\nLCPFile=\nUseDistortion=true\nUseVignette=false\nUseCA=true\nLFCameraMake=\nLFCameraModel=\nLFLens=\n\n[Perspective]\nEnabled=false\n\n[Exif]\nLens=\n\n[Spot Removal]\nEnabled=false\n";

    #[test]
    fn patches_existing_lens_profile_and_leaves_other_lines_alone() {
        let out = patch_lens_profile(ART_PROFILE, ProfileKind::Arp, "Leica Camera AG", "LEICA M10-R", "Summicron-M 1:2/50");
        assert!(out.contains("[LensProfile]\nLcMode=lfmanual\nLCPFile=\nUseDistortion=true\nUseVignette=false\nUseCA=true\nLFCameraMake=Leica Camera AG\nLFCameraModel=LEICA M10-R\nLFLens=Summicron-M 1:2/50\n\n[Perspective]"));
        assert!(out.contains("[Exif]\nLens=Summicron-M 1:2/50\n"));
        // Everything outside the two sections is untouched.
        assert!(out.starts_with("[Version]\nAppVersion=1.26.7\n\n[Distortion]\nAmount=0\n\n"));
        assert!(out.ends_with("[Spot Removal]\nEnabled=false\n"));
    }

    #[test]
    fn pp3_patch_does_not_add_art_exif_section() {
        let out = patch_lens_profile("[Version]\nVersion=351\n\n[LensProfile]\nLcMode=none\n", ProfileKind::Pp3, "Leica Camera AG", "LEICA M10-R", "Summicron-M 1:2/50");
        assert_eq!(out, "[Version]\nVersion=351\n\n[LensProfile]\nLcMode=lfmanual\nLFCameraMake=Leica Camera AG\nLFCameraModel=LEICA M10-R\nLFLens=Summicron-M 1:2/50\n");
    }

    #[test]
    fn adds_lens_profile_section_when_missing() {
        let out = patch_lens_profile("[Version]\nVersion=351\n", ProfileKind::Pp3, "Leica Camera AG", "LEICA M10-R", "Summicron-M 1:2/50");
        assert_eq!(out, "[Version]\nVersion=351\n\n[LensProfile]\nLcMode=lfmanual\nLFCameraMake=Leica Camera AG\nLFCameraModel=LEICA M10-R\nLFLens=Summicron-M 1:2/50\n\n");
    }

    #[test]
    fn patching_twice_is_stable() {
        let once = patch_lens_profile(ART_PROFILE, ProfileKind::Arp, "Leica Camera AG", "LEICA M10-R", "Summicron-M 1:2/50");
        let twice = patch_lens_profile(&once, ProfileKind::Arp, "Leica Camera AG", "LEICA M10-R", "Summicron-M 1:2/50");
        assert_eq!(once, twice);
    }

    #[test]
    fn original_lens_prop_skips_blank_lens() {
        assert_eq!(original_lens_prop("  "), None);
        assert_eq!(original_lens_prop("Summicron-M 1:2/50").unwrap().value, "Summicron-M 1:2/50");
    }
}
