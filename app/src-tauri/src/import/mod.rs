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
