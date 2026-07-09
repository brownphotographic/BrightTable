use std::fs;
use std::path::{Path, PathBuf};

use crate::config::LibraryConfig;
use crate::{embedded, xmp};

/// Resolves an asset's server-side `original_path` (e.g.
/// "library/admin/2024/09/IMG_1234.CR2" for an External Library asset, or
/// "upload/library/admin/2024/09/IMG_1.jpg" for one uploaded directly via
/// phone/web) to the real local filesystem path ImmAture can read/write, by
/// substituting whichever of the two configured server-root prefixes
/// matches: the External Library mapping (`immich_root`/`local_root`)
/// first, then the Immich-internal-upload mapping
/// (`uploaded_immich_root`/`uploaded_local_root`). Returns `None` if neither
/// mapping is configured, or the path matches neither prefix - callers
/// treat `None` as "skip this asset", never as an error, since most users
/// will only ever configure one of the two mappings, sometimes neither.
pub fn resolve_local_path(original_path: &str, lib: &LibraryConfig) -> Option<PathBuf> {
    resolve_with_prefix(original_path, &lib.immich_root, &lib.local_root)
        .or_else(|| resolve_with_prefix(original_path, &lib.uploaded_immich_root, &lib.uploaded_local_root))
}

fn resolve_with_prefix(original_path: &str, immich_prefix: &str, local_prefix: &str) -> Option<PathBuf> {
    let immich_prefix = immich_prefix.trim().trim_end_matches('/');
    let local_prefix = local_prefix.trim().trim_end_matches('/');
    if immich_prefix.is_empty() || local_prefix.is_empty() {
        return None;
    }
    let rest = original_path.strip_prefix(immich_prefix)?;
    // Require a path-separator boundary, not just a string prefix - otherwise
    // an immich_prefix of "/data/lib" would falsely match a sibling
    // directory like "/data/library2/..." that merely starts the same way.
    let rest = if rest.is_empty() { rest } else { rest.strip_prefix('/')? };
    Some(PathBuf::from(local_prefix).join(rest))
}

/// Sidecar naming convention used by digiKam/darktable, and by RawTherapee/
/// ART for their own `.pp3`/`.arp` develop-settings files: `<full original
/// filename>.<ext>`, appended rather than swapping the original extension -
/// "IMG_1234.CR2" -> "IMG_1234.CR2.xmp".
fn append_ext(p: &Path, ext: &str) -> PathBuf {
    let mut s = p.as_os_str().to_os_string();
    s.push(".");
    s.push(ext);
    PathBuf::from(s)
}

pub fn xmp_sidecar_path(original: &Path) -> PathBuf {
    append_ext(original, "xmp")
}

/// ART (confirmed against a real ART-written sidecar during manual testing -
/// `20260103_14-56-24.DNG` -> `20260103_14-56-24.xmp`) and some RT installs
/// instead name their `.xmp` by *replacing* the original extension outright,
/// the same convention Adobe Bridge/Lightroom use. Both forms are checked
/// when reading (see `read_asset_metadata`), since either can be in play
/// depending on which tool last touched a given asset. Ambiguous when two
/// originals share a basename with different extensions (e.g. a camera's
/// `.DNG` + its embedded `.JPG` both present as separate Immich assets) -
/// both would resolve to the same replaced-extension sidecar, which is an
/// inherent limit of this naming convention, not something ImmAture can
/// disambiguate either.
pub fn xmp_sidecar_path_replaced(original: &Path) -> PathBuf {
    original.with_extension("xmp")
}

pub fn pp3_sidecar_path(original: &Path) -> PathBuf {
    append_ext(original, "pp3")
}

/// RawTherapee stores its own star rating as `Rank=N` inside the `.pp3`
/// sidecar's `[General]` section, separately from any `.xmp` - whether a
/// given RT install *also* writes/syncs an `.xmp` copy depends on its own
/// metadata-sync setting, which ImmAture has no way to know, so both sources
/// are checked (see `read_asset_metadata` below). Range is `-1..=5`: `-1` is
/// RT's own "rejected" marker, which now maps directly onto Immich's
/// `rating: -1`. Section-scoped (only reads `Rank=` while inside `[General]`)
/// so an unrelated same-named key elsewhere in the file can't be mistaken
/// for it.
pub fn read_pp3_rank(path: &Path) -> Option<i32> {
    let v = read_pp3_key(path, "General", "Rank=")?;
    let n: i32 = v.trim().parse().ok()?;
    (-1..=5).contains(&n).then_some(n)
}

/// RawTherapee's `.pp3` `[IPTC]` section stores `Caption` (and `Keywords`,
/// unused here) as a glib key-file string list - semicolon-separated,
/// literal semicolons escaped as `\;` - even though RT only ever writes one
/// caption value through its own UI. Confirmed against RT's own
/// `procparams.cc` (`iptc_keys` table + `set_string_list`/`get_string_list`),
/// not just documentation, since the exact key name/format isn't otherwise
/// obvious from the pp3 spec alone.
pub fn read_pp3_iptc_caption(path: &Path) -> Option<String> {
    let raw = read_pp3_key(path, "IPTC", "Caption=")?;
    let first = first_list_item(&raw);
    let trimmed = first.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// Glib key-file list values are `;`-separated with literal `;`/`\` escaped
/// as `\;`/`\\` - this pulls out just the first item, unescaped, which is
/// all RT's own UI ever actually writes into `Caption` even though the
/// underlying format supports a full list.
fn first_list_item(s: &str) -> String {
    let mut out = String::new();
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                if let Some(next) = chars.next() {
                    out.push(next);
                }
            }
            ';' => break,
            _ => out.push(c),
        }
    }
    out
}

fn read_pp3_key(path: &Path, section: &str, key_prefix: &str) -> Option<String> {
    let text = fs::read_to_string(path).ok()?;
    let mut in_section = false;
    for line in text.lines() {
        let line = line.trim();
        if let Some(s) = line.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
            in_section = s.eq_ignore_ascii_case(section);
            continue;
        }
        if in_section {
            if let Some(v) = line.strip_prefix(key_prefix) {
                return Some(v.to_string());
            }
        }
    }
    None
}

/// One asset's synced-relevant metadata, resolved from whichever of its
/// local sidecar/embedded sources actually has a value - see
/// `read_asset_metadata` for the precedence order.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct DetectedMetadata {
    pub rating: Option<i32>,
    pub description: Option<String>,
}

/// Resolves rating and description independently, each via its own
/// precedence chain, from an asset's real local file:
/// 1. `.xmp` sidecar - tried under both naming conventions (the
///    append-extension form digiKam/darktable use, then the
///    replace-extension form ART/some RT installs use; see
///    `xmp_sidecar_path`/`xmp_sidecar_path_replaced`) via
///    `xmp::read_rating`/`read_description`; a `digiKam:PickLabel` of
///    "rejected" also counts as a rating of `-1` if `xmp:Rating` itself
///    isn't present
/// 2. metadata embedded directly in the file (JPEG/TIFF only - RAW files
///    always go through a sidecar instead, regardless of tool)
/// 3. format-specific fallback: RawTherapee's `.pp3` `Rank=`/`[IPTC]
///    Caption=` for rating/description respectively
///
/// Never errors - a missing file or unparseable content at any step just
/// means that source has nothing to offer, not a failure.
pub fn read_asset_metadata(original: &Path) -> DetectedMetadata {
    let xmp_text = fs::read_to_string(xmp_sidecar_path(original))
        .ok()
        .or_else(|| fs::read_to_string(xmp_sidecar_path_replaced(original)).ok());
    let embedded_xmp_text = embedded::find_embedded_xmp(original);

    let rating = xmp_text
        .as_deref()
        .and_then(|t| xmp::read_rating(t).or_else(|| xmp::read_pick_label_rejected(t).then_some(-1)))
        .or_else(|| embedded_xmp_text.as_deref().and_then(xmp::read_rating))
        .or_else(|| read_pp3_rank(&pp3_sidecar_path(original)));

    let description = xmp_text
        .as_deref()
        .and_then(xmp::read_description)
        .or_else(|| embedded_xmp_text.as_deref().and_then(xmp::read_description))
        .or_else(|| embedded::find_embedded_iptc_caption(original))
        .or_else(|| read_pp3_iptc_caption(&pp3_sidecar_path(original)));

    DetectedMetadata { rating, description }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_external_library_path() {
        let mut lib = LibraryConfig::default();
        lib.immich_root = "/photos".into();
        lib.local_root = "/mnt/nfs/Rob/Images".into();
        assert_eq!(
            resolve_local_path("/photos/2026/06/IMG_1.dng", &lib),
            Some(PathBuf::from("/mnt/nfs/Rob/Images/2026/06/IMG_1.dng"))
        );
    }

    #[test]
    fn resolves_uploaded_path_when_external_does_not_match() {
        let mut lib = LibraryConfig::default();
        lib.immich_root = "/photos".into();
        lib.local_root = "/mnt/nfs/Rob/Images".into();
        lib.uploaded_immich_root = "upload/library/admin".into();
        lib.uploaded_local_root = "/mnt/nfs/Rob/Immich_Uploaded".into();
        assert_eq!(
            resolve_local_path("upload/library/admin/2024/09/IMG_1.jpg", &lib),
            Some(PathBuf::from("/mnt/nfs/Rob/Immich_Uploaded/2024/09/IMG_1.jpg"))
        );
    }

    #[test]
    fn rejects_sibling_prefix_that_merely_starts_the_same_way() {
        let mut lib = LibraryConfig::default();
        lib.immich_root = "/data/lib".into();
        lib.local_root = "/mnt/lib".into();
        assert_eq!(resolve_local_path("/data/library2/img.dng", &lib), None);
    }

    #[test]
    fn none_when_unconfigured_or_unmatched() {
        let lib = LibraryConfig::default();
        assert_eq!(resolve_local_path("/photos/img.dng", &lib), None);
    }

    #[test]
    fn reads_pp3_rank_including_rejected() {
        let dir = std::env::temp_dir().join(format!("immature-test-pp3-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();

        let pp3 = dir.join("img.CR2.pp3");
        fs::write(
            &pp3,
            "[Version]\nAppVersion=5.9\n\n[General]\nRank=4\nColorLabel=0\n\n[Exposure]\nRank=99\n",
        )
        .unwrap();
        assert_eq!(read_pp3_rank(&pp3), Some(4));

        let rejected = dir.join("rejected.CR2.pp3");
        fs::write(&rejected, "[General]\nRank=-1\n").unwrap();
        assert_eq!(read_pp3_rank(&rejected), Some(-1));

        assert_eq!(read_pp3_rank(&dir.join("missing.pp3")), None);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn reads_pp3_iptc_caption_scoped_to_section() {
        let dir = std::env::temp_dir().join(format!("immature-test-pp3-iptc-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();

        let pp3 = dir.join("img.CR2.pp3");
        fs::write(
            &pp3,
            "[General]\nCaption=not this one;\n\n[IPTC]\nCaption=Sunset over the bay\\; nice evening;\nKeywords=sunset;bay;\n",
        )
        .unwrap();
        assert_eq!(read_pp3_iptc_caption(&pp3), Some("Sunset over the bay; nice evening".into()));

        assert_eq!(read_pp3_iptc_caption(&dir.join("missing.pp3")), None);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn asset_metadata_precedence_xmp_then_pp3() {
        let dir = std::env::temp_dir().join(format!("immature-test-meta-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();

        let original = dir.join("img.CR2");
        fs::write(pp3_sidecar_path(&original), "[General]\nRank=2\n\n[IPTC]\nCaption=From pp3;\n").unwrap();
        assert_eq!(
            read_asset_metadata(&original),
            DetectedMetadata { rating: Some(2), description: Some("From pp3".into()) }
        );

        fs::write(
            xmp_sidecar_path(&original),
            r#"<rdf:Description xmp:Rating="5"><dc:description><rdf:Alt><rdf:li xml:lang="x-default">From xmp</rdf:li></rdf:Alt></dc:description></rdf:Description>"#,
        )
        .unwrap();
        assert_eq!(
            read_asset_metadata(&original),
            DetectedMetadata { rating: Some(5), description: Some("From xmp".into()) }
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn asset_metadata_pick_label_rejected_without_explicit_rating() {
        let dir = std::env::temp_dir().join(format!("immature-test-meta-pick-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();

        let original = dir.join("img.CR2");
        fs::write(xmp_sidecar_path(&original), r#"<rdf:Description digiKam:PickLabel="1"/>"#).unwrap();
        assert_eq!(read_asset_metadata(&original).rating, Some(-1));

        let _ = fs::remove_dir_all(&dir);
    }

    // Regression test for a real bug found during manual testing: ART names
    // its `.xmp` sidecar by replacing the original extension outright
    // ("20260103_14-56-24.DNG" -> "20260103_14-56-24.xmp"), not by appending
    // to the full filename like digiKam/darktable do - `read_asset_metadata`
    // silently found nothing at all for such an asset until both naming
    // conventions were checked.
    #[test]
    fn asset_metadata_finds_extension_replaced_xmp() {
        let dir = std::env::temp_dir().join(format!("immature-test-meta-art-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();

        let original = dir.join("20260103_14-56-24.DNG");
        fs::write(xmp_sidecar_path_replaced(&original), r#"<rdf:Description xmp:Rating="3"/>"#).unwrap();
        assert_eq!(read_asset_metadata(&original).rating, Some(3));

        let _ = fs::remove_dir_all(&dir);
    }
}
