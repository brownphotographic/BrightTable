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

/// Whether this `.xmp` text carries a darktable develop-history stack - the
/// signal `paths::find_darktable_history_sidecar` uses to decide "does this
/// asset have darktable edits to roundtrip" instead of a plain
/// `.exists()` check, since darktable stores its history *inside* the same
/// `.xmp` file `read_rating`/`read_description`/`patch_or_create` already
/// own for rating/description rather than a dedicated sidecar the way ART's
/// `.arp`/RawTherapee's `.pp3` do. darktable writes this as a
/// `darktable:history_end="N"` attribute on `rdf:Description` alongside a
/// `<darktable:history>` sequence element holding the actual stack - a plain
/// substring check on either is enough for a yes/no presence answer (no need
/// to parse the stack itself, unlike a real read/patch). Read-only: never
/// touches the file, so it can't interfere with `patch_or_create`'s
/// rating/description-only writes.
pub fn has_darktable_history(text: &str) -> bool {
    text.contains("darktable:history")
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

/// The darktable XMP namespace URI, declared as `xmlns:darktable="..."` on
/// `rdf:Description` in every real darktable-written `.xmp` - needed by
/// `apply_darktable_island` so a target `.xmp` that has no darktable content
/// yet (e.g. one this app itself seeded via `new_packet()` for
/// rating/description only) still declares the prefix once darktable
/// attributes/elements are pasted onto it, rather than leaving it
/// undeclared. Expected value, not yet independently confirmed against a
/// real darktable-written file - flagged pending the user's own live test,
/// same posture as `darktable.rs`'s own module doc.
const DARKTABLE_XMLNS: &str = "http://darktable.sf.net/xmp/1.0/";

/// Everything darktable-namespaced captured off one `rdf:Description` - every
/// `darktable:`-prefixed attribute and child element, as an opaque unit
/// meant to travel together from a Copy/Paste Image Processing source onto a
/// target's own `.xmp` (`extract_darktable_island`/`apply_darktable_island`/
/// `paste_darktable_island`). Deliberately generic rather than a fixed field
/// list (just `history`/`history_end`, say) - darktable's real XMP output
/// isn't fully confirmed here (mask data, `iop_order`, etc. may also need to
/// travel), so capturing "everything under the darktable: prefix" is robust
/// to fields not yet seen in a real sample, at the cost of not knowing in
/// advance exactly what's in here.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DarktableIsland {
    attrs: Vec<(String, String)>,
    elements: Vec<String>,
}

/// (name, raw value, byte span of the whole `name="value"` token including
/// quotes) for every `darktable:`-prefixed attribute found in
/// `text[desc_start..tag_close]` (the span `find_tag_close` returns for
/// `rdf:Description`'s opening tag), in document order. Shared by
/// `extract_darktable_attrs` (wants the name/value pairs) and
/// `strip_darktable_island` (wants the spans to excise) so the tokenizing
/// logic - quote-aware, same character-walk idiom `find_tag_close` already
/// uses - only exists once.
fn darktable_attr_spans(text: &str, desc_start: usize, tag_close: usize) -> Vec<(String, String, std::ops::Range<usize>)> {
    let bytes = text.as_bytes();
    let mut spans = Vec::new();
    let mut i = desc_start + "<rdf:Description".len();
    while i < tag_close {
        while i < tag_close && (bytes[i] as char).is_whitespace() {
            i += 1;
        }
        if i >= tag_close {
            break;
        }
        let name_start = i;
        while i < tag_close && bytes[i] != b'=' && !(bytes[i] as char).is_whitespace() {
            i += 1;
        }
        let name_end = i;
        if name_end == name_start {
            // A stray '/' or similar - not a real attribute name; skip it.
            i += 1;
            continue;
        }
        while i < tag_close && (bytes[i] as char).is_whitespace() {
            i += 1;
        }
        if i >= tag_close || bytes[i] != b'=' {
            break; // malformed - no '=' where expected, bail rather than misparse
        }
        i += 1;
        while i < tag_close && (bytes[i] as char).is_whitespace() {
            i += 1;
        }
        if i >= tag_close || (bytes[i] != b'"' && bytes[i] != b'\'') {
            break; // malformed - no quoted value where expected
        }
        let quote = bytes[i];
        i += 1;
        let value_start = i;
        while i < tag_close && bytes[i] != quote {
            i += 1;
        }
        let value_end = i;
        let token_end = (value_end + 1).min(tag_close);
        let name = &text[name_start..name_end];
        if name.starts_with("darktable:") {
            spans.push((name.to_string(), text[value_start..value_end].to_string(), name_start..token_end));
        }
        i = token_end;
    }
    spans
}

fn extract_darktable_attrs(text: &str, desc_start: usize, tag_close: usize) -> Vec<(String, String)> {
    darktable_attr_spans(text, desc_start, tag_close).into_iter().map(|(name, value, _)| (name, value)).collect()
}

/// Byte spans of every direct-child `<darktable:...>` element within
/// `text[body_start..body_end]` (the space between `rdf:Description`'s
/// opening tag and its `</rdf:Description>`), in document order. Each
/// element's own extent is found via `find_tag_close` (self-closing) or the
/// first matching `</name>` (open/close - darktable's own fields don't nest
/// a same-named tag inside itself, same assumption `read_description`
/// already makes for `dc:description`). Stops at the first element it can't
/// cleanly bound (malformed input) rather than guessing - whatever was found
/// before that point is still returned.
fn darktable_element_spans(text: &str, body_start: usize, body_end: usize) -> Vec<std::ops::Range<usize>> {
    let mut spans = Vec::new();
    let mut i = body_start;
    while i < body_end {
        let Some(rel) = text[i..body_end].find("<darktable:") else { break };
        let start = i + rel;
        let name_start = start + 1;
        let Some(name_end_off) = text[name_start..].find(|c: char| c.is_whitespace() || c == '>' || c == '/') else { break };
        let name_end = name_start + name_end_off;
        let tag_name = &text[name_start..name_end];
        let (close, self_closing) = find_tag_close(text, start);
        let element_end = if self_closing {
            close + 2
        } else {
            let close_tag = format!("</{tag_name}>");
            match text[close + 1..].find(&close_tag) {
                Some(rel2) => close + 1 + rel2 + close_tag.len(),
                None => break,
            }
        };
        spans.push(start..element_end);
        i = element_end;
    }
    spans
}

fn extract_darktable_elements(text: &str, body_start: usize, body_end: usize) -> Vec<String> {
    darktable_element_spans(text, body_start, body_end).into_iter().map(|r| text[r].to_string()).collect()
}

/// Captures `text`'s darktable island (see `DarktableIsland`'s own doc
/// comment) - `None` if `text` has no `rdf:Description` at all, or nothing
/// darktable-namespaced on it. Callers should already have confirmed
/// presence via `has_darktable_history` before relying on `Some` here (e.g.
/// `paths::find_darktable_history_sidecar`), but this stays a plain `Option`
/// rather than assuming that always holds - the source file could have
/// changed between that check and this actually running.
pub fn extract_darktable_island(text: &str) -> Option<DarktableIsland> {
    let desc_start = text.find("<rdf:Description")?;
    let (tag_close, self_closing) = find_tag_close(text, desc_start);
    let attrs = extract_darktable_attrs(text, desc_start, tag_close);
    let elements = if self_closing {
        Vec::new()
    } else {
        let body_start = tag_close + 1;
        let body_end = text[body_start..].find("</rdf:Description>").map(|i| body_start + i).unwrap_or(text.len());
        extract_darktable_elements(text, body_start, body_end)
    };
    if attrs.is_empty() && elements.is_empty() { None } else { Some(DarktableIsland { attrs, elements }) }
}

/// Removes every `darktable:`-prefixed attribute/element `text`'s
/// `rdf:Description` already has, leaving everything else - rating,
/// description, any other tool's data, an existing `xmlns:darktable`
/// declaration - untouched. The first half of `apply_darktable_island`'s
/// "replace, don't accumulate" contract: a target that already had its own
/// darktable history must end up with only the *pasted* history, not both
/// stacked together.
fn strip_darktable_island(text: &str) -> String {
    let Some(desc_start) = text.find("<rdf:Description") else {
        return text.to_string();
    };
    let (tag_close, self_closing) = find_tag_close(text, desc_start);

    let mut result = text.to_string();
    for (_, _, span) in darktable_attr_spans(text, desc_start, tag_close).into_iter().rev() {
        result.replace_range(span, "");
    }
    if self_closing {
        return result;
    }

    // Attribute removal only ever shortens text strictly before the body, so
    // re-resolving the tag close against `result` is required before
    // scanning for element spans (their offsets shifted), but `desc_start`
    // itself is unaffected (it's before any attribute span too).
    let (new_tag_close, _) = find_tag_close(&result, desc_start);
    let body_start = new_tag_close + 1;
    let body_end = result[body_start..].find("</rdf:Description>").map(|i| body_start + i).unwrap_or(result.len());
    for span in darktable_element_spans(&result, body_start, body_end).into_iter().rev() {
        result.replace_range(span, "");
    }
    result
}

/// Replaces whatever darktable content `text`'s `rdf:Description` already
/// has with `island`'s (strip-then-insert, via `strip_darktable_island`),
/// adding an `xmlns:darktable` declaration first if none exists yet. Mirrors
/// `patch_description_field`'s self-closing-tag-to-open/close conversion
/// when there are elements to insert but the tag currently has no body.
pub fn apply_darktable_island(text: &str, island: &DarktableIsland) -> String {
    let stripped = strip_darktable_island(text);
    let Some(desc_start) = stripped.find("<rdf:Description") else {
        return stripped;
    };
    let (tag_close, self_closing) = find_tag_close(&stripped, desc_start);

    let mut attrs_str = String::new();
    if !stripped.contains("xmlns:darktable=") {
        attrs_str.push_str(&format!(" xmlns:darktable=\"{DARKTABLE_XMLNS}\""));
    }
    for (name, value) in &island.attrs {
        attrs_str.push_str(&format!(" {name}=\"{value}\""));
    }
    let elements_str: String = island.elements.concat();

    if self_closing {
        if elements_str.is_empty() {
            format!("{}{}{}", &stripped[..tag_close], attrs_str, &stripped[tag_close..])
        } else {
            format!("{}{}>{}</rdf:Description>{}", &stripped[..tag_close], attrs_str, elements_str, &stripped[tag_close + 2..])
        }
    } else {
        let with_attrs = format!("{}{}{}", &stripped[..tag_close], attrs_str, &stripped[tag_close..]);
        let insert_at = tag_close + attrs_str.len() + 1;
        format!("{}{}{}", &with_attrs[..insert_at], elements_str, &with_attrs[insert_at..])
    }
}

/// The orchestrating entry point `processing_queue.rs`'s worker calls for a
/// `ProcessingSource::DarkTable` job - mirrors `patch_or_create`'s
/// read-patch-write-atomic shape, just scoped to darktable's own field set
/// instead of rating/description. `source_text` is the *source* asset's
/// already-read `.xmp` content; `dest_path` is the *target*'s `.xmp` write
/// path (`paths::xmp_write_path`), read fresh here and seeded via
/// `new_packet()` if it doesn't exist yet - same "read whatever's there, or
/// start from a fresh packet" contract `patch_or_create` already has. Errors
/// if `source_text` no longer has anything darktable-namespaced to paste
/// (the source could have changed between `find_darktable_history_sidecar`
/// confirming presence and this actually running).
pub fn paste_darktable_island(source_text: &str, dest_path: &Path) -> Result<(), String> {
    let island = extract_darktable_island(source_text).ok_or("Source has no darktable history to paste")?;
    let dest_text = fs::read_to_string(dest_path).unwrap_or_else(|_| new_packet());
    let patched = apply_darktable_island(&dest_text, &island);
    write_atomic(dest_path, &patched)
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
    fn detects_darktable_history_presence() {
        assert!(has_darktable_history(r#"<rdf:Description darktable:history_end="3"><darktable:history/></rdf:Description>"#));
        assert!(has_darktable_history(r#"<rdf:Description darktable:history_end="0"/>"#));
        assert!(!has_darktable_history(r#"<rdf:Description xmp:Rating="3"/>"#));
        assert!(!has_darktable_history("no history here"));
    }

    #[test]
    fn reads_and_unescapes_description() {
        let xmp = r#"<dc:description><rdf:Alt><rdf:li xml:lang="x-default">Mom &amp; Dad&apos;s trip</rdf:li></rdf:Alt></dc:description>"#;
        assert_eq!(read_description(xmp), Some("Mom & Dad's trip".into()));
        assert_eq!(read_description("no description block"), None);
    }

    // Synthetic (not yet a real sample - flagged in DarktableIsland's own
    // doc comment) darktable-shaped .xmp: several darktable:*-prefixed
    // attributes, an open/close darktable:history element with nested
    // rdf:Seq/rdf:li content, a self-closing darktable:mask_history element,
    // and non-darktable data (xmp:Rating, dc:description, tiff:Make) that
    // must survive every extract/strip/apply pass byte-for-byte untouched.
    const SYNTHETIC_DARKTABLE_XMP: &str = r#"<rdf:Description rdf:about=""
   xmlns:darktable="http://darktable.sf.net/xmp/1.0/"
   xmlns:tiff="http://ns.adobe.com/tiff/1.0/"
   tiff:Make="Leica Camera AG"
   xmp:Rating="4"
   darktable:xmp_version="2"
   darktable:raw_params="0"
   darktable:auto_presets_applied="1"
   darktable:history_end="3">
  <darktable:history>
   <rdf:Seq>
    <rdf:li darktable:num="0" darktable:operation="exposure" darktable:enabled="1"/>
   </rdf:Seq>
  </darktable:history>
  <darktable:mask_history/>
  <dc:description><rdf:Alt><rdf:li xml:lang="x-default">A caption</rdf:li></rdf:Alt></dc:description>
 </rdf:Description>"#;

    #[test]
    fn extract_darktable_island_captures_all_attrs_and_elements() {
        let island = extract_darktable_island(SYNTHETIC_DARKTABLE_XMP).expect("fixture has darktable content");
        assert_eq!(
            island.attrs,
            vec![
                ("darktable:xmp_version".to_string(), "2".to_string()),
                ("darktable:raw_params".to_string(), "0".to_string()),
                ("darktable:auto_presets_applied".to_string(), "1".to_string()),
                ("darktable:history_end".to_string(), "3".to_string()),
            ]
        );
        assert_eq!(island.elements.len(), 2, "{island:?}");
        assert!(island.elements[0].starts_with("<darktable:history>"));
        assert!(island.elements[0].contains("darktable:operation=\"exposure\""));
        assert!(island.elements[0].ends_with("</darktable:history>"));
        assert_eq!(island.elements[1], "<darktable:mask_history/>");
    }

    #[test]
    fn extract_darktable_island_none_when_nothing_darktable_namespaced() {
        assert_eq!(extract_darktable_island(r#"<rdf:Description xmp:Rating="3"/>"#), None);
        assert_eq!(extract_darktable_island("no rdf:Description at all"), None);
    }

    #[test]
    fn extract_darktable_island_handles_self_closing_description() {
        let island = extract_darktable_island(r#"<rdf:Description darktable:history_end="0"/>"#).unwrap();
        assert_eq!(island.attrs, vec![("darktable:history_end".to_string(), "0".to_string())]);
        assert!(island.elements.is_empty());
    }

    #[test]
    fn strip_darktable_island_removes_darktable_content_and_keeps_everything_else() {
        let stripped = strip_darktable_island(SYNTHETIC_DARKTABLE_XMP);
        assert_eq!(extract_darktable_island(&stripped), None, "{stripped}");
        assert!(stripped.contains(r#"tiff:Make="Leica Camera AG""#));
        assert!(stripped.contains(r#"xmp:Rating="4""#));
        assert!(stripped.contains("A caption"));
        assert!(!stripped.contains("darktable:history_end"));
        assert!(!stripped.contains("<darktable:history>"));
        assert!(!stripped.contains("<darktable:mask_history/>"));
    }

    #[test]
    fn apply_darktable_island_inserts_onto_a_target_with_no_prior_darktable_content() {
        let island = extract_darktable_island(SYNTHETIC_DARKTABLE_XMP).unwrap();
        let target = r#"<rdf:Description rdf:about="" xmp:Rating="2"><dc:description><rdf:Alt><rdf:li xml:lang="x-default">target's own caption</rdf:li></rdf:Alt></dc:description></rdf:Description>"#;

        let applied = apply_darktable_island(target, &island);

        // The target's own rating/description survive untouched.
        assert_eq!(read_rating(&applied), Some(2));
        assert_eq!(read_description(&applied), Some("target's own caption".into()));
        // The namespace was declared since the target had none.
        assert!(applied.contains("xmlns:darktable=\"http://darktable.sf.net/xmp/1.0/\""));
        // The pasted island round-trips out again.
        let reextracted = extract_darktable_island(&applied).unwrap();
        assert_eq!(reextracted, island);
    }

    #[test]
    fn apply_darktable_island_replaces_rather_than_accumulates_on_a_target_with_its_own_history() {
        let island = extract_darktable_island(SYNTHETIC_DARKTABLE_XMP).unwrap();
        let target_with_its_own_history =
            r#"<rdf:Description rdf:about="" xmlns:darktable="http://darktable.sf.net/xmp/1.0/" darktable:history_end="99"><darktable:history><rdf:Seq><rdf:li darktable:num="0" darktable:operation="STALE"/></rdf:Seq></darktable:history></rdf:Description>"#;

        let applied = apply_darktable_island(target_with_its_own_history, &island);

        assert!(!applied.contains("STALE"), "{applied}");
        assert!(!applied.contains("history_end=\"99\""), "{applied}");
        let reextracted = extract_darktable_island(&applied).unwrap();
        assert_eq!(reextracted, island);
        // Exactly one xmlns:darktable declaration, not a duplicate.
        assert_eq!(applied.matches("xmlns:darktable=").count(), 1, "{applied}");
    }

    #[test]
    fn apply_darktable_island_converts_a_self_closing_target_description() {
        let island = extract_darktable_island(SYNTHETIC_DARKTABLE_XMP).unwrap();
        let target = r#"<rdf:Description rdf:about="" xmp:Rating="5"/>"#;

        let applied = apply_darktable_island(target, &island);

        assert_eq!(read_rating(&applied), Some(5));
        assert_eq!(extract_darktable_island(&applied), Some(island));
    }

    #[test]
    fn paste_darktable_island_round_trips_through_real_files() {
        let dir = std::env::temp_dir().join(format!("brighttable-test-xmp-dt-paste-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();

        let dest = dir.join("target.xmp");
        fs::write(&dest, r#"<rdf:Description rdf:about="" xmp:Rating="3"/>"#).unwrap();

        paste_darktable_island(SYNTHETIC_DARKTABLE_XMP, &dest).unwrap();

        let out = fs::read_to_string(&dest).unwrap();
        assert_eq!(read_rating(&out), Some(3), "target's own rating must survive: {out}");
        let island = extract_darktable_island(SYNTHETIC_DARKTABLE_XMP).unwrap();
        assert_eq!(extract_darktable_island(&out), Some(island));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn paste_darktable_island_creates_a_brand_new_file_when_dest_does_not_exist() {
        let dir = std::env::temp_dir().join(format!("brighttable-test-xmp-dt-new-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("brand-new.xmp");
        let _ = fs::remove_file(&dest);

        paste_darktable_island(SYNTHETIC_DARKTABLE_XMP, &dest).unwrap();

        let out = fs::read_to_string(&dest).unwrap();
        let island = extract_darktable_island(SYNTHETIC_DARKTABLE_XMP).unwrap();
        assert_eq!(extract_darktable_island(&out), Some(island));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn paste_darktable_island_errors_when_source_has_nothing_to_paste() {
        let dir = std::env::temp_dir().join(format!("brighttable-test-xmp-dt-empty-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("target.xmp");

        let result = paste_darktable_island(r#"<rdf:Description xmp:Rating="1"/>"#, &dest);
        assert!(result.is_err());

        let _ = fs::remove_dir_all(&dir);
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
