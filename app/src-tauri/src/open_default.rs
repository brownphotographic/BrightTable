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

//! **Open in Video Player**: hands a video off to whatever the desktop's
//! default handler for it is, instead of relying on this app's own embedded
//! WebView `<video>` element.
//!
//! That embedded playback goes through WebKitGTK's bundled GStreamer
//! pipeline, which - unlike every dedicated video app on the system - runs
//! inside an AppImage whose GStreamer plugin discovery is fragile (see the
//! AppImage build's `apprun-hooks` env patch) and, even once that's fixed,
//! still renders inside a sandboxed WebProcess. Rather than keep chasing
//! packaging issues to make in-app playback as reliable as the system's own
//! video player, this just launches that player directly - same as
//! double-clicking the file in a file manager would.

use std::path::Path;
use std::process::Command;

#[cfg(target_os = "linux")]
pub fn open(path: &Path) -> Result<(), String> {
    Command::new("xdg-open").arg(path).spawn().map_err(|e| format!("Couldn't open a video player: {e}"))?;
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn open(path: &Path) -> Result<(), String> {
    Command::new("open").arg(path).spawn().map_err(|e| format!("Couldn't open a video player: {e}"))?;
    Ok(())
}

#[cfg(target_os = "windows")]
pub fn open(path: &Path) -> Result<(), String> {
    // The empty "" argument is `start`'s window-title placeholder - without
    // it, `start` treats a quoted path as the title instead of the target.
    Command::new("cmd")
        .args([std::ffi::OsStr::new("/C"), std::ffi::OsStr::new("start"), std::ffi::OsStr::new(""), path.as_os_str()])
        .spawn()
        .map_err(|e| format!("Couldn't open a video player: {e}"))?;
    Ok(())
}
