// Format-agnostic XMP **text** field read/patch helpers - operate on an XML
// string regardless of where it came from (a `.xmp` sidecar file, or an XMP
// packet extracted from inside a JPEG/TIFF by `embedded.rs`). Deliberately
// hand-rolled scans rather than a real XML parser: this only ever needs a
// handful of fixed fields across a handful of known tools (digiKam,
// darktable, RawTherapee, ART), not general XMP support.

use std::fs;
use std::path::Path;

/// `xmp:Rating` - tolerates both the attribute form (`xmp:Rating="3"`,
/// written by digiKam/ART) and the element form (`<xmp:Rating>3</xmp:Rating>`,
/// written by darktable). Range is `-1..=5`: `-1` is the standard XMP
/// "rejected" convention (also used by RawTherapee/ART), which Immich's own
/// `rating` field now accepts directly. Returns `None` for anything missing/
/// out of range/unparseable - never errors, since "no rating here" is the
/// overwhelmingly common case.
pub fn read_rating(text: &str) -> Option<i32> {
    let raw = find_between(text, "xmp:Rating=\"", "\"").or_else(|| find_between(text, "<xmp:Rating>", "</xmp:Rating>"))?;
    let n: i32 = raw.trim().parse().ok()?;
    (-1..=5).contains(&n).then_some(n)
}

/// `digiKam:PickLabel` - digiKam's culling flag (`0` none, `1` rejected, `2`
/// pending, `3` accepted). Only the rejected case maps to anything Immich can
/// represent (`rating: -1`), so this only ever answers "is it rejected?"
/// rather than returning the raw label value.
pub fn read_pick_label_rejected(text: &str) -> bool {
    let raw = find_between(text, "digiKam:PickLabel=\"", "\"").or_else(|| find_between(text, "<digiKam:PickLabel>", "</digiKam:PickLabel>"));
    raw.map(|v| v.trim() == "1").unwrap_or(false)
}

/// `dc:description` - always a language-alternative structure
/// (`<dc:description><rdf:Alt><rdf:li xml:lang="x-default">TEXT</rdf:li></rdf:Alt></dc:description>`),
/// never a bare attribute - this pulls the first `rdf:li`'s text out of
/// whichever `dc:description` block exists, ignoring the `xml:lang`
/// attribute, and unescapes the handful of XML entities a caption might
/// contain.
pub fn read_description(text: &str) -> Option<String> {
    let block = find_between(text, "<dc:description", "</dc:description>")?;
    let after_li_start = &block[block.find("<rdf:li")?..];
    let li_open_end = after_li_start.find('>')?;
    let inner = &after_li_start[li_open_end + 1..];
    let raw = &inner[..inner.find("</rdf:li>")?];
    Some(unescape_xml(raw))
}

fn find_between<'a>(text: &'a str, start: &str, end: &str) -> Option<&'a str> {
    let after = &text[text.find(start)? + start.len()..];
    Some(&after[..after.find(end)?])
}

fn unescape_xml(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

fn escape_xml(s: &str) -> String {
    // `&` first - otherwise the entities inserted by the other replacements
    // would themselves get re-escaped.
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Patches (or creates) the `.xmp` file at `path` with the given rating/
/// description, touching only those specific fields - every other byte
/// (darktable's edit-history stack, any tool's tags, other IPTC/EXIF fields)
/// is left exactly as it was. Writes atomically (unique tmp file + rename),
/// same pattern as `thumb_cache.rs`.
pub fn patch_or_create(path: &Path, rating: Option<i32>, description: Option<&str>) -> Result<(), String> {
    if rating.is_none() && description.is_none() {
        return Ok(());
    }
    let mut text = fs::read_to_string(path).unwrap_or_else(|_| new_packet());
    if let Some(r) = rating {
        text = patch_rating_field(&text, r);
    }
    if let Some(d) = description {
        text = patch_description_field(&text, d);
    }
    write_atomic(path, &text)
}

fn write_atomic(path: &Path, contents: &str) -> Result<(), String> {
    let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("sidecar.xmp");
    let tmp_path = path.with_file_name(format!("{file_name}.tmp.{}", std::process::id()));
    fs::write(&tmp_path, contents).map_err(|e| describe_io_error("write", &tmp_path, &e))?;
    fs::rename(&tmp_path, path).map_err(|e| {
        let _ = fs::remove_file(&tmp_path);
        describe_io_error("finalize", path, &e)
    })
}

/// Turns a raw `io::Error` from a sidecar write into a message that tells the
/// user what to actually do about it, for the two failure modes that show up
/// in practice on a networked library mount (permission errors from a host/
/// NFS UID mismatch, or a containing folder that's gone missing/unmounted) -
/// everything else falls back to the raw `Display` text, same as before.
fn describe_io_error(action: &str, path: &Path, e: &std::io::Error) -> String {
    match e.kind() {
        std::io::ErrorKind::PermissionDenied => format!(
            "Permission denied trying to {action} {} — BrightTable doesn't have write access to this location on the host filesystem. This is usually a filesystem/NFS permissions issue outside BrightTable; check the owning user/group of the containing folder.",
            path.display()
        ),
        std::io::ErrorKind::NotFound => format!(
            "Could not {action} {} — the containing folder appears to be missing (moved, renamed, or unmounted?).",
            path.display()
        ),
        _ => format!("Could not {action} {}: {e}", path.display()),
    }
}

/// A minimal, well-formed, self-authored Adobe XMP packet for a file that
/// has no `.xmp` sidecar yet - just enough structure (`rdf:Description` with
/// the `xmp`/`dc` namespaces declared) for `patch_rating_field`/
/// `patch_description_field` to insert into. Never used to overwrite an
/// existing file, only to seed a brand-new one.
fn new_packet() -> String {
    "<?xpacket begin=\"\u{feff}\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>\n\
<x:xmpmeta xmlns:x=\"adobe:ns:meta/\">\n\
 <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\n\
  <rdf:Description rdf:about=\"\"\n\
    xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\"\n\
    xmlns:dc=\"http://purl.org/dc/elements/1.1/\">\n\
  </rdf:Description>\n\
 </rdf:RDF>\n\
</x:xmpmeta>\n\
<?xpacket end=\"w\"?>\n"
        .to_string()
}

/// Scans forward from `tag_start` (the index of a tag's opening `<`) for the
/// `>` that closes its attribute list, tracking whether we're inside a
/// quoted attribute value so a `>` can never be mistaken for the tag's end
/// while it's part of an attribute's value. Returns the index of that `>`
/// (or, for a self-closing tag, the index of the `/` immediately before it -
/// the correct insertion point for a new attribute either way) plus whether
/// it was self-closing.
fn find_tag_close(text: &str, tag_start: usize) -> (usize, bool) {
    let bytes = text.as_bytes();
    let mut i = tag_start;
    let mut quote: Option<u8> = None;
    while i < bytes.len() {
        let c = bytes[i];
        match quote {
            Some(q) => {
                if c == q {
                    quote = None;
                }
            }
            None => match c {
                b'"' | b'\'' => quote = Some(c),
                b'>' => {
                    return if i > tag_start && bytes[i - 1] == b'/' { (i - 1, true) } else { (i, false) };
                }
                _ => {}
            },
        }
        i += 1;
    }
    (text.len(), false)
}

/// Replaces an existing `xmp:Rating` (attribute or element form) in place,
/// or - if neither form is present - inserts a new `xmp:Rating="N"`
/// attribute onto the `rdf:Description` opening tag. Returns `text`
/// unchanged if no `rdf:Description` element exists at all (shouldn't
/// happen for anything passed through `patch_or_create`, which always
/// starts from either a real sidecar or `new_packet()`).
fn patch_rating_field(text: &str, rating: i32) -> String {
    let Some(desc_start) = text.find("<rdf:Description") else {
        return text.to_string();
    };
    let (tag_close, _) = find_tag_close(text, desc_start);

    if let Some(rel) = text[desc_start..tag_close].find("xmp:Rating=\"") {
        let val_start = desc_start + rel + "xmp:Rating=\"".len();
        if let Some(end_rel) = text[val_start..].find('"') {
            let val_end = val_start + end_rel;
            return format!("{}{}{}", &text[..val_start], rating, &text[val_end..]);
        }
    }
    if let Some(el_start) = text.find("<xmp:Rating>") {
        let val_start = el_start + "<xmp:Rating>".len();
        if let Some(end_rel) = text[val_start..].find("</xmp:Rating>") {
            let val_end = val_start + end_rel;
            return format!("{}{}{}", &text[..val_start], rating, &text[val_end..]);
        }
    }

    let attr = format!(" xmp:Rating=\"{rating}\"");
    format!("{}{}{}", &text[..tag_close], attr, &text[tag_close..])
}

/// Replaces the first `rdf:li`'s text inside an existing `dc:description`
/// block in place, or - if no `dc:description` block exists - inserts a new
/// one as a child of `rdf:Description` (converting a self-closing
/// `rdf:Description` into an open/close pair first, if needed, to make room
/// for the child). `description` is XML-escaped before insertion. Returns
/// `text` unchanged if no `rdf:Description` element exists at all.
fn patch_description_field(text: &str, description: &str) -> String {
    let escaped = escape_xml(description);

    if let Some(block_start) = text.find("<dc:description") {
        if let Some(li_rel) = text[block_start..].find("<rdf:li") {
            let li_start = block_start + li_rel;
            if let Some(gt_rel) = text[li_start..].find('>') {
                let content_start = li_start + gt_rel + 1;
                if let Some(end_rel) = text[content_start..].find("</rdf:li>") {
                    let content_end = content_start + end_rel;
                    return format!("{}{}{}", &text[..content_start], escaped, &text[content_end..]);
                }
            }
        }
        return text.to_string();
    }

    let Some(desc_start) = text.find("<rdf:Description") else {
        return text.to_string();
    };
    let (tag_close, self_closing) = find_tag_close(text, desc_start);
    let block = format!("<dc:description><rdf:Alt><rdf:li xml:lang=\"x-default\">{escaped}</rdf:li></rdf:Alt></dc:description>");

    if self_closing {
        // `tag_close` is the index of the `/` in `/>` - close the opening
        // tag outright, insert the new child, then re-close the element.
        format!("{}>{}</rdf:Description>{}", &text[..tag_close], block, &text[tag_close + 2..])
    } else {
        let insert_at = tag_close + 1;
        format!("{}{}{}", &text[..insert_at], block, &text[insert_at..])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_attribute_and_element_rating_forms() {
        assert_eq!(read_rating(r#"<rdf:Description xmp:Rating="3"/>"#), Some(3));
        assert_eq!(read_rating("<xmp:Rating>4</xmp:Rating>"), Some(4));
        assert_eq!(read_rating("nothing here"), None);
    }

    #[test]
    fn rejected_rating_round_trips() {
        assert_eq!(read_rating(r#"xmp:Rating="-1""#), Some(-1));
        assert_eq!(read_rating(r#"xmp:Rating="-2""#), None);
        assert_eq!(read_rating(r#"xmp:Rating="6""#), None);
    }

    #[test]
    fn detects_pick_label_rejected_only() {
        assert!(read_pick_label_rejected(r#"digiKam:PickLabel="1""#));
        assert!(read_pick_label_rejected("<digiKam:PickLabel>1</digiKam:PickLabel>"));
        assert!(!read_pick_label_rejected(r#"digiKam:PickLabel="3""#));
        assert!(!read_pick_label_rejected("no pick label here"));
    }

    #[test]
    fn reads_and_unescapes_description() {
        let xmp = r#"<dc:description><rdf:Alt><rdf:li xml:lang="x-default">Mom &amp; Dad&apos;s trip</rdf:li></rdf:Alt></dc:description>"#;
        assert_eq!(read_description(xmp), Some("Mom & Dad's trip".into()));
        assert_eq!(read_description("no description block"), None);
    }

    fn temp_path(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("brighttable-test-xmp-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    #[test]
    fn patches_existing_attribute_rating_in_place() {
        let path = temp_path("attr-rating.xmp");
        fs::write(&path, r#"<rdf:Description rdf:about="" xmp:Rating="2" tiff:Make="Leica"><exif:ISOSpeedRatings/></rdf:Description>"#).unwrap();
        patch_or_create(&path, Some(4), None).unwrap();
        let out = fs::read_to_string(&path).unwrap();
        assert_eq!(read_rating(&out), Some(4));
        assert!(out.contains(r#"tiff:Make="Leica""#), "sibling attribute must survive: {out}");
        assert!(out.contains("<exif:ISOSpeedRatings/>"), "sibling child element must survive: {out}");
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn patches_existing_element_rating_in_place() {
        let path = temp_path("el-rating.xmp");
        fs::write(&path, "<rdf:Description rdf:about=\"\"><xmp:Rating>2</xmp:Rating><dc:subject>keep me</dc:subject></rdf:Description>").unwrap();
        patch_or_create(&path, Some(-1), None).unwrap();
        let out = fs::read_to_string(&path).unwrap();
        assert_eq!(read_rating(&out), Some(-1));
        assert!(out.contains("<dc:subject>keep me</dc:subject>"));
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn inserts_new_rating_attribute_when_absent() {
        let path = temp_path("no-rating.xmp");
        fs::write(&path, r#"<rdf:Description rdf:about="" tiff:Make="Leica"><exif:ISOSpeedRatings/></rdf:Description>"#).unwrap();
        patch_or_create(&path, Some(3), None).unwrap();
        let out = fs::read_to_string(&path).unwrap();
        assert_eq!(read_rating(&out), Some(3));
        assert!(out.contains(r#"tiff:Make="Leica""#));
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn inserts_new_rating_attribute_on_self_closing_description() {
        let path = temp_path("self-closing.xmp");
        fs::write(&path, r#"<rdf:Description rdf:about="" tiff:Make="Leica"/>"#).unwrap();
        patch_or_create(&path, Some(5), None).unwrap();
        let out = fs::read_to_string(&path).unwrap();
        assert_eq!(read_rating(&out), Some(5));
        assert!(out.contains(r#"tiff:Make="Leica""#));
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn patches_existing_description_block_in_place() {
        let path = temp_path("desc.xmp");
        fs::write(
            &path,
            r#"<rdf:Description rdf:about=""><dc:description><rdf:Alt><rdf:li xml:lang="x-default">old caption</rdf:li></rdf:Alt></dc:description></rdf:Description>"#,
        )
        .unwrap();
        patch_or_create(&path, None, Some("new caption")).unwrap();
        let out = fs::read_to_string(&path).unwrap();
        assert_eq!(read_description(&out), Some("new caption".into()));
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn inserts_new_description_block_when_absent() {
        let path = temp_path("no-desc.xmp");
        fs::write(&path, r#"<rdf:Description rdf:about="" xmp:Rating="3"></rdf:Description>"#).unwrap();
        patch_or_create(&path, None, Some("Mom & Dad's trip")).unwrap();
        let out = fs::read_to_string(&path).unwrap();
        assert_eq!(read_description(&out), Some("Mom & Dad's trip".into()));
        assert_eq!(read_rating(&out), Some(3));
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn inserts_new_description_block_on_self_closing_description() {
        let path = temp_path("no-desc-self-closing.xmp");
        fs::write(&path, r#"<rdf:Description rdf:about="" xmp:Rating="3"/>"#).unwrap();
        patch_or_create(&path, None, Some("caption")).unwrap();
        let out = fs::read_to_string(&path).unwrap();
        assert_eq!(read_description(&out), Some("caption".into()));
        assert_eq!(read_rating(&out), Some(3));
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn describe_io_error_classifies_known_kinds() {
        let permission = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        let msg = describe_io_error("write", Path::new("/mnt/nfs/foo.xmp"), &permission);
        assert!(msg.to_lowercase().contains("permission"), "{msg}");
        assert!(msg.contains("/mnt/nfs/foo.xmp"), "{msg}");

        let missing = std::io::Error::from(std::io::ErrorKind::NotFound);
        let msg = describe_io_error("write", Path::new("/mnt/nfs/foo.xmp"), &missing);
        assert!(msg.to_lowercase().contains("missing"), "{msg}");

        let other = std::io::Error::from(std::io::ErrorKind::AlreadyExists);
        let msg = describe_io_error("write", Path::new("/mnt/nfs/foo.xmp"), &other);
        assert!(msg.starts_with("Could not write /mnt/nfs/foo.xmp:"), "{msg}");
    }

    #[test]
    fn patch_or_create_reports_actionable_message_on_permission_denied() {
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!("brighttable-test-xmp-perm-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o555)).unwrap();

        let result = patch_or_create(&dir.join("locked.xmp"), Some(3), None);

        // Root bypasses DAC permission checks entirely, so this can legitimately
        // succeed when tests run as root (e.g. some CI containers) - only assert
        // the message shape when the OS actually refused the write.
        match result {
            Err(msg) => assert!(msg.to_lowercase().contains("permission"), "{msg}"),
            Ok(()) => eprintln!("skipping assertion: write succeeded, likely running as root"),
        }

        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn patch_or_create_reports_actionable_message_on_missing_directory() {
        let dir = std::env::temp_dir().join(format!("brighttable-test-xmp-missing-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);

        let result = patch_or_create(&dir.join("sub").join("f.xmp"), Some(3), None);

        let msg = result.expect_err("write into a nonexistent directory must fail");
        assert!(msg.to_lowercase().contains("missing"), "{msg}");
        assert!(!msg.to_lowercase().contains("permission"), "{msg}");
    }

    #[test]
    fn creates_new_file_from_scratch() {
        let path = temp_path("brand-new.xmp");
        let _ = fs::remove_file(&path);
        patch_or_create(&path, Some(4), Some("A caption")).unwrap();
        let out = fs::read_to_string(&path).unwrap();
        assert_eq!(read_rating(&out), Some(4));
        assert_eq!(read_description(&out), Some("A caption".into()));
        let _ = fs::remove_file(&path);
    }

    // Regression test using a real, unmodified Exiv2/digiKam-written sidecar
    // (captured from the user's own test library during manual verification
    // of this feature) - multi-line attribute list, nested child elements
    // (YCbCrSubSampling, ComponentsConfiguration, ISOSpeedRatings, Flash),
    // and an existing `xmp:Rating="3"` to patch. Every sibling attribute and
    // child element must survive byte-for-byte; only the rating changes.
    const REAL_DIGIKAM_XMP: &str = r#"<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="XMP Core 4.4.0-Exiv2">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:acdsee="http://ns.acdsee.com/iptc/1.0/"
    xmlns:MicrosoftPhoto="http://ns.microsoft.com/photo/1.0/"
    xmlns:tiff="http://ns.adobe.com/tiff/1.0/"
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:exif="http://ns.adobe.com/exif/1.0/"
    xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"
   acdsee:rating="3"
   MicrosoftPhoto:Rating="50"
   tiff:Orientation="1"
   tiff:YCbCrPositioning="2"
   tiff:XResolution="300/1"
   tiff:YResolution="300/1"
   tiff:ResolutionUnit="2"
   tiff:Make="Leica Camera AG"
   tiff:Model="LEICA M10-R"
   tiff:Software="30.22.11.52"
   xmp:Rating="3"
   xmp:CreateDate="2026-06-09T08:05:23"
   exif:ExifVersion="0230"
   exif:ColorSpace="1"
   exif:PixelXDimension="7840"
   exif:PixelYDimension="5184"
   exif:ExposureTime="1/125"
   exif:ExposureProgram="1"
   exif:ShutterSpeedValue="1792/256"
   exif:ApertureValue="800/100"
   exif:ExposureBiasValue="0/1000"
   exif:MaxApertureValue="511/256"
   exif:MeteringMode="4"
   exif:LightSource="0"
   exif:FocalLength="28/1"
   exif:FileSource="3"
   exif:SceneType="1"
   exif:CustomRendered="0"
   exif:ExposureMode="1"
   exif:WhiteBalance="0"
   exif:DigitalZoomRatio="0/1"
   exif:SceneCaptureType="0"
   exif:Contrast="0"
   exif:Saturation="0"
   exif:Sharpness="0"
   exif:ImageUniqueID="000000000055B2F56BFDBE640DFE9840"
   exif:GPSVersionID="2.3.0.0"
   photoshop:DateCreated="2026-06-09T08:05:23">
   <tiff:YCbCrSubSampling>
    <rdf:Seq>
     <rdf:li>2 1</rdf:li>
    </rdf:Seq>
   </tiff:YCbCrSubSampling>
   <exif:ComponentsConfiguration>
    <rdf:Seq>
     <rdf:li>1</rdf:li>
     <rdf:li>2</rdf:li>
     <rdf:li>3</rdf:li>
     <rdf:li>0</rdf:li>
    </rdf:Seq>
   </exif:ComponentsConfiguration>
   <exif:ISOSpeedRatings>
    <rdf:Seq>
     <rdf:li>100</rdf:li>
    </rdf:Seq>
   </exif:ISOSpeedRatings>
   <exif:Flash
    exif:Fired="False"
    exif:Return="0"
    exif:Mode="0"
    exif:Function="False"
    exif:RedEyeMode="False"/>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>
"#;

    #[test]
    fn patches_rating_in_real_digikam_sidecar_leaving_everything_else_untouched() {
        let patched = patch_rating_field(REAL_DIGIKAM_XMP, 4);
        assert_eq!(read_rating(&patched), Some(4));

        // Everything else - other attributes, all four child elements,
        // whitespace/layout - must be byte-for-byte identical. Only the
        // `xmp:Rating="3"` -> `xmp:Rating="4"` substitution should differ.
        let expected = REAL_DIGIKAM_XMP.replacen(r#"xmp:Rating="3""#, r#"xmp:Rating="4""#, 1);
        assert_eq!(patched, expected);

        // digiKam's own separate `acdsee:rating`/`MicrosoftPhoto:Rating`
        // mirrors are untouched - only the standard `xmp:Rating` BrightTable
        // reads/writes is patched.
        assert!(patched.contains(r#"acdsee:rating="3""#));
        assert!(patched.contains(r#"MicrosoftPhoto:Rating="50""#));
        assert!(patched.contains("<exif:ComponentsConfiguration>"));
        assert!(patched.contains(r#"exif:Fired="False""#));
    }

    #[test]
    fn inserts_description_into_real_digikam_sidecar_leaving_everything_else_untouched() {
        let patched = patch_description_field(REAL_DIGIKAM_XMP, "Test caption");
        assert_eq!(read_description(&patched), Some("Test caption".into()));
        assert_eq!(read_rating(&patched), Some(3));
        assert!(patched.contains(r#"tiff:Model="LEICA M10-R""#));
        assert!(patched.contains("<exif:ISOSpeedRatings>"));
    }

    #[test]
    fn escapes_description_special_characters() {
        let path = temp_path("escaped.xmp");
        let _ = fs::remove_file(&path);
        patch_or_create(&path, None, Some(r#"Mom & Dad's "trip" <home>"#)).unwrap();
        let raw = fs::read_to_string(&path).unwrap();
        assert!(raw.contains("Mom &amp; Dad&apos;s &quot;trip&quot; &lt;home&gt;") || raw.contains("Mom &amp; Dad's &quot;trip&quot; &lt;home&gt;"));
        assert_eq!(read_description(&raw), Some(r#"Mom & Dad's "trip" <home>"#.into()));
        let _ = fs::remove_file(&path);
    }
}
