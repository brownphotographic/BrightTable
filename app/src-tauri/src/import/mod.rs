//! SD-card/disk import: scan a source folder, dedupe against a local
//! history cache, copy new files into the configured External Library
//! root under a fixed date-based naming scheme, then nudge Immich to
//! discover them. See the plan file for the full design.

pub mod capture_time;
mod hash;
pub mod history;
pub mod library_match;
pub mod naming;
pub mod queue;
pub mod scan;

pub use library_match::{find_matching_library, LibraryMatch};
pub use naming::FolderDepth;
pub use queue::{ImportJob, ImportQueue};
pub use scan::{hash_groups, scan_source, ScannedGroup};
