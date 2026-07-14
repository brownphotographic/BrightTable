//! Matches the configured External Library `immich_root` against Immich's
//! own `GET /libraries` response, so the import feature can trigger a
//! Library Scan (`ImmichClient::scan_library`) without the user manually
//! pasting a library id. Pure/testable - the actual `GET /libraries` call
//! lives in `immich/mod.rs`; re-resolved fresh each time a nudge is needed
//! rather than cached in config, so a later Immich-side library
//! reconfiguration can't leave a stale id behind.

use crate::immich::models::LibraryInfo;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LibraryMatch {
    Found(String),
    NoMatch,
    /// More than one library claims the exact same import path - possible
    /// with nested External Libraries. Surfaced as an error by the caller
    /// rather than guessing which one to scan.
    Ambiguous(Vec<String>),
}

/// `immich_root` is matched by exact equality (trailing slash tolerant)
/// against each library's `importPaths` entries, not a prefix/substring
/// match - Immich's own `importPaths` are already the literal roots it
/// scans, not deeper subpaths within them.
pub fn find_matching_library(libraries: &[LibraryInfo], immich_root: &str) -> LibraryMatch {
    let target = immich_root.trim().trim_end_matches('/');
    let matches: Vec<String> = libraries
        .iter()
        .filter(|lib| lib.import_paths.iter().any(|p| p.trim().trim_end_matches('/') == target))
        .map(|lib| lib.id.clone())
        .collect();
    match matches.len() {
        0 => LibraryMatch::NoMatch,
        1 => LibraryMatch::Found(matches[0].clone()),
        _ => LibraryMatch::Ambiguous(matches),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lib(id: &str, paths: &[&str]) -> LibraryInfo {
        LibraryInfo { id: id.to_string(), import_paths: paths.iter().map(|s| s.to_string()).collect() }
    }

    #[test]
    fn finds_exact_match() {
        let libs = vec![lib("lib-a", &["/photos"]), lib("lib-b", &["/videos"])];
        assert_eq!(find_matching_library(&libs, "/photos"), LibraryMatch::Found("lib-a".into()));
    }

    #[test]
    fn tolerates_trailing_slash_on_either_side() {
        let libs = vec![lib("lib-a", &["/photos/"])];
        assert_eq!(find_matching_library(&libs, "/photos"), LibraryMatch::Found("lib-a".into()));
        assert_eq!(find_matching_library(&libs, "/photos/"), LibraryMatch::Found("lib-a".into()));
    }

    #[test]
    fn no_match_when_nothing_shares_the_path() {
        let libs = vec![lib("lib-a", &["/photos"])];
        assert_eq!(find_matching_library(&libs, "/other"), LibraryMatch::NoMatch);
    }

    #[test]
    fn rejects_substring_prefix_match() {
        let libs = vec![lib("lib-a", &["/data/lib"])];
        assert_eq!(find_matching_library(&libs, "/data/library2"), LibraryMatch::NoMatch);
    }

    #[test]
    fn ambiguous_when_multiple_libraries_share_the_same_path() {
        let libs = vec![lib("lib-a", &["/photos"]), lib("lib-b", &["/photos"])];
        match find_matching_library(&libs, "/photos") {
            LibraryMatch::Ambiguous(mut ids) => {
                ids.sort();
                assert_eq!(ids, vec!["lib-a".to_string(), "lib-b".to_string()]);
            }
            other => panic!("expected Ambiguous, got {other:?}"),
        }
    }
}
