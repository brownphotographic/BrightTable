// Format-agnostic XMP **text** field read/patch helpers - operate on an XML
// string regardless of where it came from (a `.xmp` sidecar file, or an XMP
// packet extracted from inside a JPEG/TIFF by `embedded.rs`). Deliberately
// hand-rolled scans rather than a real XML parser: this only ever needs a
// handful of fixed fields across a handful of known tools (digiKam,
// darktable, RawTherapee, ART), not general XMP support.

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
}
