use std::fs;
use std::path::{Path, PathBuf};

use crate::config::{LibraryConfig, RawConverterKind};
use crate::{embedded, xmp};

/// Resolves an asset's server-side `original_path` (e.g.
/// "library/admin/2024/09/IMG_1234.CR2" for an External Library asset, or
/// "upload/library/admin/2024/09/IMG_1.jpg" for one uploaded directly via
/// phone/web) to the real local filesystem path BrightTable can read/write, by
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
/// inherent limit of this naming convention, not something BrightTable can
/// disambiguate either.
pub fn xmp_sidecar_path_replaced(original: &Path) -> PathBuf {
    original.with_extension("xmp")
}

pub fn pp3_sidecar_path(original: &Path) -> PathBuf {
    append_ext(original, "pp3")
}

/// ART's own develop-adjustment sidecar (distinct from the `.xmp` it also
/// writes for rating/description, per `xmp_sidecar_path_replaced`'s doc
/// comment) - append-form: `IMG_1234.CR2` -> `IMG_1234.CR2.arp`.
pub fn arp_sidecar_path(original: &Path) -> PathBuf {
    append_ext(original, "arp")
}

/// ART is *confirmed* (manual testing, see `xmp_sidecar_path_replaced`'s doc
/// comment) to replace the extension outright for its `.xmp`, rather than
/// appending to it - since `.arp` is that same tool's own sidecar format,
/// it's a real possibility it follows the identical replace-extension
/// convention rather than `.pp3`'s append form, and there's no equivalent
/// manual confirmation on file for `.arp` specifically yet. Both forms are
/// checked (`find_processing_sidecar`), same precedence idiom as
/// `xmp_sidecar_path`/`xmp_sidecar_path_replaced`, rather than assuming one.
pub fn arp_sidecar_path_replaced(original: &Path) -> PathBuf {
    original.with_extension("arp")
}

pub fn pp3_sidecar_path_replaced(original: &Path) -> PathBuf {
    original.with_extension("pp3")
}

/// Which RAW-editor develop-adjustment sidecar exists for an asset, for the
/// Copy/Paste Image Processing feature - deliberately just ART (`.arp`) and
/// RawTherapee (`.pp3`), not darktable's `.xmp`-embedded history, since that
/// shares a file with rating/description (owned by Copy/Paste Metadata
/// instead) and would need a surgical merge rather than a plain copy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessingKind {
    Arp,
    Pp3,
}

/// Which of the two sidecar-naming conventions (append vs. replace-extension,
/// see `xmp_sidecar_path`/`xmp_sidecar_path_replaced`) a given real file on
/// disk actually used - carried alongside `ProcessingKind` so a paste can
/// write the destination in the *same* form the source install actually
/// produces, rather than guessing a fixed default that might be wrong for
/// this user's actual tool (see `find_processing_sidecar`'s doc comment).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SidecarForm {
    Append,
    Replaced,
}

impl ProcessingKind {
    /// Computes a destination path for this kind, mirroring `form` - the
    /// naming convention actually observed on the *source* side by
    /// `find_processing_sidecar` - rather than a hardcoded guess. If the
    /// target install's convention genuinely differs from the source's,
    /// this can still land in the "wrong" spot for that install; there's no
    /// way to know a target's own convention before it has ever had a
    /// sidecar of its own, so mirroring the one real data point available
    /// (the source) is the best available default.
    pub fn sidecar_path_with_form(self, original: &Path, form: SidecarForm) -> PathBuf {
        match (self, form) {
            (ProcessingKind::Arp, SidecarForm::Append) => arp_sidecar_path(original),
            (ProcessingKind::Arp, SidecarForm::Replaced) => arp_sidecar_path_replaced(original),
            (ProcessingKind::Pp3, SidecarForm::Append) => pp3_sidecar_path(original),
            (ProcessingKind::Pp3, SidecarForm::Replaced) => pp3_sidecar_path_replaced(original),
        }
    }
}

/// Resolves whichever processing sidecar actually exists on disk for an
/// asset, and which naming form it used. If more than one candidate exists
/// (e.g. the user tried both tools, or both naming forms are present for the
/// same tool) the most recently *modified* one wins, falling back to `.arp`
/// before `.pp3` and append-form before replaced-form (this function's
/// original, mtime-blind priority order) only to break an exact mtime tie.
///
/// Picking by mtime instead of a fixed priority is deliberate, not
/// cosmetic: `sidecar_path_with_form` already means Paste Image Processing
/// can write a destination sidecar in a *different* form than a later
/// direct Tweak from that same ART/RawTherapee install uses (e.g. a paste
/// lands `IMG_1234.CR2.arp` - append form - and a later Tweak on that same
/// original writes `IMG_1234.arp` - replaced form, if that's what this
/// user's ART build actually does). With the old fixed-priority order,
/// append-form `.arp` always won regardless of which one was actually
/// written most recently, so once both forms existed for one original, Copy
/// Image Processing would silently and permanently keep reading the older
/// one - found live: "Copy Image Processing" pulling a stale prior edit
/// after a fresh Tweak RAW Roundtrip, with no way to fix it short of
/// deleting the stale file by hand.
pub fn find_processing_sidecar(original: &Path) -> Option<(PathBuf, ProcessingKind, SidecarForm)> {
    let candidates = [
        (arp_sidecar_path(original), ProcessingKind::Arp, SidecarForm::Append),
        (arp_sidecar_path_replaced(original), ProcessingKind::Arp, SidecarForm::Replaced),
        (pp3_sidecar_path(original), ProcessingKind::Pp3, SidecarForm::Append),
        (pp3_sidecar_path_replaced(original), ProcessingKind::Pp3, SidecarForm::Replaced),
    ];
    candidates
        .into_iter()
        .enumerate()
        .filter_map(|(priority, (path, kind, form))| {
            let modified = fs::metadata(&path).and_then(|m| m.modified()).ok()?;
            // Reverse(priority) so that on an exact mtime tie, the lowest
            // original-priority index (Arp/Append first) wins - same
            // tie-break the old fixed order always gave.
            Some((modified, std::cmp::Reverse(priority), path, kind, form))
        })
        .max_by_key(|(modified, rev_priority, ..)| (*modified, *rev_priority))
        .map(|(_, _, path, kind, form)| (path, kind, form))
}

/// One tool's develop-adjustment settings found on a source asset, for
/// Copy/Paste Image Processing's multi-tool paste (`find_all_processing_sources`)
/// - unlike `find_processing_sidecar`'s single "winner" answer, every
/// present tool gets its own entry here, since Paste applies "one for each"
/// tool the source actually has settings from, not just the most-recently-
/// modified one. `Sidecar` covers ART/RawTherapee's own dedicated files (a
/// plain copy is always safe - see `processing_queue::atomic_copy_sidecar`);
/// `DarkTable` instead only carries the `.xmp` path to read from, since its
/// content can't be blindly copied onto a target's own `.xmp` without
/// clobbering that file's rating/description (see `xmp::paste_darktable_island`,
/// which does the actual surgical merge at apply time).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProcessingSource {
    Sidecar { path: PathBuf, kind: ProcessingKind, form: SidecarForm },
    DarkTable { xmp_path: PathBuf },
}

impl ProcessingSource {
    /// Which tool this source represents, for per-job labeling
    /// (`processing_queue::ProcessingJob::tool`) - mirrors the
    /// `RawConverterKind` wire format the RAW CLI roundtrip feature already
    /// established, so the Activity panel can reuse the same label map for
    /// both features' job rows.
    pub fn tool(&self) -> RawConverterKind {
        match self {
            ProcessingSource::Sidecar { kind: ProcessingKind::Arp, .. } => RawConverterKind::Art,
            ProcessingSource::Sidecar { kind: ProcessingKind::Pp3, .. } => RawConverterKind::RawTherapee,
            ProcessingSource::DarkTable { .. } => RawConverterKind::DarkTable,
        }
    }
}

/// Resolves a single `ProcessingKind`'s own winning form (append vs.
/// replaced) on disk - the same mtime tie-break `find_processing_sidecar`
/// uses across all four candidates, scoped down to just the two forms of one
/// kind, so `find_all_processing_sources` can ask "does *this* kind have
/// anything" independently per kind rather than picking one global winner
/// across both kinds the way `find_processing_sidecar` does.
/// `find_processing_sidecar` itself is left untouched rather than
/// rewritten in terms of this - its own tests pin its exact global tie-break
/// behavior, and there's no need to risk that for a function this one
/// doesn't call.
fn resolve_kind_sidecar(original: &Path, kind: ProcessingKind) -> Option<(PathBuf, SidecarForm)> {
    let candidates = [
        (kind.sidecar_path_with_form(original, SidecarForm::Append), SidecarForm::Append),
        (kind.sidecar_path_with_form(original, SidecarForm::Replaced), SidecarForm::Replaced),
    ];
    candidates
        .into_iter()
        .enumerate()
        .filter_map(|(priority, (path, form))| {
            let modified = fs::metadata(&path).and_then(|m| m.modified()).ok()?;
            // Reverse(priority) so Append (priority 0) wins an exact mtime
            // tie, same tie-break `find_processing_sidecar` gives Append
            // over Replaced.
            Some((modified, std::cmp::Reverse(priority), path, form))
        })
        .max_by_key(|(modified, rev_priority, ..)| (*modified, *rev_priority))
        .map(|(_, _, path, form)| (path, form))
}

/// Resolves *every* tool's develop-adjustment settings present on `original`,
/// not just the single most-recent one `find_processing_sidecar` picks - an
/// asset with both an ART `.arp` and darktable history gets two entries
/// here, not one. `find_processing_sidecar` is unchanged and kept for its
/// own single-winner caller (`has_round_trip_sidecar`'s ART/RawTherapee arm,
/// RAW CLI roundtrip), which legitimately only cares about the currently
/// *active* converter, not "everything present."
pub fn find_all_processing_sources(original: &Path) -> Vec<ProcessingSource> {
    let mut sources = Vec::new();
    for kind in [ProcessingKind::Arp, ProcessingKind::Pp3] {
        if let Some((path, form)) = resolve_kind_sidecar(original, kind) {
            sources.push(ProcessingSource::Sidecar { path, kind, form });
        }
    }
    if let Some(xmp_path) = find_darktable_history_sidecar(original) {
        sources.push(ProcessingSource::DarkTable { xmp_path });
    }
    sources
}

/// darktable's counterpart to `find_processing_sidecar` - but unlike ART's
/// `.arp`/RawTherapee's `.pp3`, darktable has no dedicated develop-adjustment
/// sidecar of its own: its history stack lives inside the same `.xmp` file
/// `xmp_sidecar_path`/`xmp_sidecar_path_replaced` already resolve for
/// rating/description. A plain "does an `.xmp` exist" check would therefore
/// false-positive on every asset that merely has a rating/description
/// written by this app (or digiKam/ART/RawTherapee's own metadata sync) but
/// no darktable edits at all - so each candidate is actually read and
/// checked via `xmp::has_darktable_history`, only returning a path once real
/// history is confirmed present. Checks the append-form path first, same
/// precedence `xmp_write_path`/`read_asset_metadata` already use, since
/// there's no separate mtime-priority signal the way `find_processing_sidecar`
/// has across four candidates - here it's the same one file under two
/// possible names, never both at once in practice.
pub fn find_darktable_history_sidecar(original: &Path) -> Option<PathBuf> {
    for candidate in [xmp_sidecar_path(original), xmp_sidecar_path_replaced(original)] {
        if let Ok(text) = fs::read_to_string(&candidate) {
            if xmp::has_darktable_history(&text) {
                return Some(candidate);
            }
        }
    }
    None
}

/// Tool-aware "does this asset have edits to roundtrip" check - the one place
/// `commands.rs`'s Variant 1/Variant 2 handlers decide this, so neither can
/// drift into checking the wrong sidecar convention for the active converter
/// (see `find_processing_sidecar` vs. `find_darktable_history_sidecar`'s own
/// doc comments for why the two need genuinely different logic, not just a
/// different file extension).
pub fn has_round_trip_sidecar(tool: RawConverterKind, original: &Path) -> bool {
    match tool {
        RawConverterKind::Art | RawConverterKind::RawTherapee => find_processing_sidecar(original).is_some(),
        RawConverterKind::DarkTable => find_darktable_history_sidecar(original).is_some(),
    }
}

/// Which `.xmp` path a write should target: whichever naming convention
/// already has a file on disk (append-form checked first, same precedence
/// `read_asset_metadata` uses), or the append-form default if neither exists
/// yet - matching digiKam/darktable's own convention for a file BrightTable is
/// authoring itself.
pub fn xmp_write_path(original: &Path) -> PathBuf {
    let append_form = xmp_sidecar_path(original);
    if append_form.exists() {
        return append_form;
    }
    let replaced_form = xmp_sidecar_path_replaced(original);
    if replaced_form.exists() {
        return replaced_form;
    }
    append_form
}

/// RawTherapee stores its own star rating as `Rank=N` inside the `.pp3`
/// sidecar's `[General]` section, separately from any `.xmp` - whether a
/// given RT install *also* writes/syncs an `.xmp` copy depends on its own
/// metadata-sync setting, which BrightTable has no way to know, so both sources
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
        let dir = std::env::temp_dir().join(format!("brighttable-test-pp3-{}", std::process::id()));
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
        let dir = std::env::temp_dir().join(format!("brighttable-test-pp3-iptc-{}", std::process::id()));
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
        let dir = std::env::temp_dir().join(format!("brighttable-test-meta-{}", std::process::id()));
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
        let dir = std::env::temp_dir().join(format!("brighttable-test-meta-pick-{}", std::process::id()));
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
    fn xmp_write_path_prefers_whichever_form_exists() {
        let dir = std::env::temp_dir().join(format!("brighttable-test-write-path-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();

        let original = dir.join("neither-exists.DNG");
        assert_eq!(xmp_write_path(&original), xmp_sidecar_path(&original));

        let replaced_only = dir.join("replaced-only.DNG");
        fs::write(xmp_sidecar_path_replaced(&replaced_only), "").unwrap();
        assert_eq!(xmp_write_path(&replaced_only), xmp_sidecar_path_replaced(&replaced_only));

        let both = dir.join("both.DNG");
        fs::write(xmp_sidecar_path_replaced(&both), "").unwrap();
        fs::write(xmp_sidecar_path(&both), "").unwrap();
        assert_eq!(xmp_write_path(&both), xmp_sidecar_path(&both));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn find_processing_sidecar_none_when_neither_exists() {
        let dir = std::env::temp_dir().join(format!("brighttable-test-proc-none-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();

        let original = dir.join("img.CR2");
        assert_eq!(find_processing_sidecar(&original), None);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn find_processing_sidecar_finds_pp3_when_only_pp3_exists() {
        let dir = std::env::temp_dir().join(format!("brighttable-test-proc-pp3-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();

        let original = dir.join("img.CR2");
        fs::write(pp3_sidecar_path(&original), "[General]\nRank=3\n").unwrap();
        assert_eq!(
            find_processing_sidecar(&original),
            Some((pp3_sidecar_path(&original), ProcessingKind::Pp3, SidecarForm::Append))
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn find_processing_sidecar_prefers_arp_when_both_exist() {
        let dir = std::env::temp_dir().join(format!("brighttable-test-proc-both-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();

        let original = dir.join("img.CR2");
        fs::write(pp3_sidecar_path(&original), "[General]\nRank=3\n").unwrap();
        fs::write(arp_sidecar_path(&original), "1\n").unwrap();
        assert_eq!(
            find_processing_sidecar(&original),
            Some((arp_sidecar_path(&original), ProcessingKind::Arp, SidecarForm::Append))
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn find_processing_sidecar_finds_replaced_extension_form() {
        let dir = std::env::temp_dir().join(format!("brighttable-test-proc-replaced-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();

        // ART is confirmed to replace the extension outright for its `.xmp`
        // (see xmp_sidecar_path_replaced's doc comment) - this is the same
        // real-world possibility for `.arp`, which motivated adding this form
        // at all.
        let original = dir.join("20260103_14-56-24.DNG");
        fs::write(arp_sidecar_path_replaced(&original), "1\n").unwrap();
        assert_eq!(
            find_processing_sidecar(&original),
            Some((arp_sidecar_path_replaced(&original), ProcessingKind::Arp, SidecarForm::Replaced))
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn find_processing_sidecar_prefers_the_more_recently_modified_form() {
        let dir = std::env::temp_dir().join(format!("brighttable-test-proc-recency-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();

        // Simulates a paste landing an append-form `.arp` (old, fixed
        // priority order would always prefer this one), followed by a real
        // Tweak from this install writing the replaced-extension form -
        // that later write should win even though append-form still ranks
        // higher in the tie-break order.
        let original = dir.join("img.CR2");
        let older = arp_sidecar_path(&original);
        let newer = arp_sidecar_path_replaced(&original);
        fs::write(&older, "old\n").unwrap();
        let past = std::time::SystemTime::now() - std::time::Duration::from_secs(120);
        fs::File::open(&older).unwrap().set_modified(past).unwrap();
        fs::write(&newer, "new\n").unwrap();

        assert_eq!(find_processing_sidecar(&original), Some((newer, ProcessingKind::Arp, SidecarForm::Replaced)));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn sidecar_path_with_form_mirrors_the_source_forms_naming() {
        let dir = std::env::temp_dir().join(format!("brighttable-test-proc-mirror-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();

        let target = dir.join("target.CR2");
        assert_eq!(
            ProcessingKind::Arp.sidecar_path_with_form(&target, SidecarForm::Replaced),
            arp_sidecar_path_replaced(&target)
        );
        assert_eq!(
            ProcessingKind::Arp.sidecar_path_with_form(&target, SidecarForm::Append),
            arp_sidecar_path(&target)
        );
        assert_eq!(
            ProcessingKind::Pp3.sidecar_path_with_form(&target, SidecarForm::Replaced),
            pp3_sidecar_path_replaced(&target)
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn asset_metadata_finds_extension_replaced_xmp() {
        let dir = std::env::temp_dir().join(format!("brighttable-test-meta-art-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();

        let original = dir.join("20260103_14-56-24.DNG");
        fs::write(xmp_sidecar_path_replaced(&original), r#"<rdf:Description xmp:Rating="3"/>"#).unwrap();
        assert_eq!(read_asset_metadata(&original).rating, Some(3));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn find_darktable_history_sidecar_none_when_xmp_has_no_history() {
        let dir = std::env::temp_dir().join(format!("brighttable-test-dt-none-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();

        let original = dir.join("img.CR2");
        // An .xmp exists (e.g. written by this app for rating/description)
        // but carries no darktable edits - must not be mistaken for one.
        fs::write(xmp_sidecar_path(&original), r#"<rdf:Description xmp:Rating="3"/>"#).unwrap();
        assert_eq!(find_darktable_history_sidecar(&original), None);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn find_darktable_history_sidecar_finds_append_form_with_history() {
        let dir = std::env::temp_dir().join(format!("brighttable-test-dt-append-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();

        let original = dir.join("img.CR2");
        fs::write(xmp_sidecar_path(&original), r#"<rdf:Description darktable:history_end="3"><darktable:history/></rdf:Description>"#).unwrap();
        assert_eq!(find_darktable_history_sidecar(&original), Some(xmp_sidecar_path(&original)));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn find_darktable_history_sidecar_finds_replaced_extension_form() {
        let dir = std::env::temp_dir().join(format!("brighttable-test-dt-replaced-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();

        let original = dir.join("20260103_14-56-24.DNG");
        fs::write(xmp_sidecar_path_replaced(&original), r#"<rdf:Description darktable:history_end="1"><darktable:history/></rdf:Description>"#).unwrap();
        assert_eq!(find_darktable_history_sidecar(&original), Some(xmp_sidecar_path_replaced(&original)));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn has_round_trip_sidecar_dispatches_by_tool() {
        let dir = std::env::temp_dir().join(format!("brighttable-test-hrts-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();

        let art_original = dir.join("art.CR2");
        fs::write(arp_sidecar_path(&art_original), "1\n").unwrap();
        assert!(has_round_trip_sidecar(RawConverterKind::Art, &art_original));
        assert!(!has_round_trip_sidecar(RawConverterKind::DarkTable, &art_original));

        let dt_original = dir.join("dt.CR2");
        fs::write(xmp_sidecar_path(&dt_original), r#"<rdf:Description darktable:history_end="2"><darktable:history/></rdf:Description>"#).unwrap();
        assert!(has_round_trip_sidecar(RawConverterKind::DarkTable, &dt_original));
        assert!(!has_round_trip_sidecar(RawConverterKind::RawTherapee, &dt_original));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn find_all_processing_sources_is_empty_when_nothing_exists() {
        let dir = std::env::temp_dir().join(format!("brighttable-test-allsrc-none-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();

        let original = dir.join("img.CR2");
        assert_eq!(find_all_processing_sources(&original), vec![]);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn find_all_processing_sources_finds_a_single_kind() {
        let dir = std::env::temp_dir().join(format!("brighttable-test-allsrc-one-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();

        let original = dir.join("img.CR2");
        fs::write(pp3_sidecar_path(&original), "[General]\nRank=3\n").unwrap();
        assert_eq!(
            find_all_processing_sources(&original),
            vec![ProcessingSource::Sidecar { path: pp3_sidecar_path(&original), kind: ProcessingKind::Pp3, form: SidecarForm::Append }]
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn find_all_processing_sources_finds_all_three_tools_at_once() {
        let dir = std::env::temp_dir().join(format!("brighttable-test-allsrc-three-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();

        let original = dir.join("img.CR2");
        fs::write(arp_sidecar_path(&original), "1\n").unwrap();
        fs::write(pp3_sidecar_path(&original), "[General]\nRank=3\n").unwrap();
        fs::write(xmp_sidecar_path(&original), r#"<rdf:Description darktable:history_end="2"><darktable:history/></rdf:Description>"#).unwrap();

        let sources = find_all_processing_sources(&original);
        assert_eq!(sources.len(), 3, "{sources:?}");
        assert!(sources.contains(&ProcessingSource::Sidecar { path: arp_sidecar_path(&original), kind: ProcessingKind::Arp, form: SidecarForm::Append }));
        assert!(sources.contains(&ProcessingSource::Sidecar { path: pp3_sidecar_path(&original), kind: ProcessingKind::Pp3, form: SidecarForm::Append }));
        assert!(sources.contains(&ProcessingSource::DarkTable { xmp_path: xmp_sidecar_path(&original) }));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn find_all_processing_sources_ignores_an_xmp_with_no_darktable_history() {
        let dir = std::env::temp_dir().join(format!("brighttable-test-allsrc-noxmp-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();

        let original = dir.join("img.CR2");
        fs::write(arp_sidecar_path(&original), "1\n").unwrap();
        // Rating/description only, no darktable edits - must not surface a
        // spurious DarkTable source.
        fs::write(xmp_sidecar_path(&original), r#"<rdf:Description xmp:Rating="3"/>"#).unwrap();

        let sources = find_all_processing_sources(&original);
        assert_eq!(sources, vec![ProcessingSource::Sidecar { path: arp_sidecar_path(&original), kind: ProcessingKind::Arp, form: SidecarForm::Append }]);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn find_all_processing_sources_picks_each_kinds_own_winning_form_independently() {
        let dir = std::env::temp_dir().join(format!("brighttable-test-allsrc-forms-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();

        let original = dir.join("img.CR2");
        // Arp: only the replaced form exists.
        fs::write(arp_sidecar_path_replaced(&original), "1\n").unwrap();
        // Pp3: only the append form exists.
        fs::write(pp3_sidecar_path(&original), "[General]\nRank=3\n").unwrap();

        let sources = find_all_processing_sources(&original);
        assert_eq!(sources.len(), 2, "{sources:?}");
        assert!(sources.contains(&ProcessingSource::Sidecar {
            path: arp_sidecar_path_replaced(&original),
            kind: ProcessingKind::Arp,
            form: SidecarForm::Replaced
        }));
        assert!(sources.contains(&ProcessingSource::Sidecar { path: pp3_sidecar_path(&original), kind: ProcessingKind::Pp3, form: SidecarForm::Append }));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn processing_source_tool_maps_each_variant() {
        let original = Path::new("/x/img.CR2");
        assert_eq!(
            ProcessingSource::Sidecar { path: original.to_path_buf(), kind: ProcessingKind::Arp, form: SidecarForm::Append }.tool(),
            RawConverterKind::Art
        );
        assert_eq!(
            ProcessingSource::Sidecar { path: original.to_path_buf(), kind: ProcessingKind::Pp3, form: SidecarForm::Append }.tool(),
            RawConverterKind::RawTherapee
        );
        assert_eq!(ProcessingSource::DarkTable { xmp_path: original.to_path_buf() }.tool(), RawConverterKind::DarkTable);
    }
}
