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
