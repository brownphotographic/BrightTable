//! **Show in File Manager**: reveals (and where the desktop supports it,
//! selects/highlights) an asset's local file in the OS file manager.
//!
//! Linux goes through the freedesktop `org.freedesktop.FileManager1`
//! `ShowItems` D-Bus method (same `zbus`-proxy idiom as
//! `suspend_guard.rs`'s logind proxy) - this is what actually selects the
//! file inside Nautilus/Dolphin/Nemo/etc. rather than merely opening its
//! containing folder. Not every desktop ships a service that registers this
//! interface (minimal window managers, some Wayland compositors with no
//! bundled file manager), so a failed D-Bus call falls back to `xdg-open` on
//! the parent directory - no selection, but the folder still opens.

use std::path::Path;
use std::process::Command;

#[cfg(target_os = "linux")]
#[zbus::proxy(
    default_service = "org.freedesktop.FileManager1",
    default_path = "/org/freedesktop/FileManager1",
    interface = "org.freedesktop.FileManager1"
)]
trait FileManager1 {
    fn show_items(&self, uris: Vec<&str>, startup_id: &str) -> zbus::Result<()>;
}

#[cfg(target_os = "linux")]
pub async fn reveal(path: &Path) -> Result<(), String> {
    if let Ok(uri) = url::Url::from_file_path(path) {
        if let Ok(connection) = zbus::Connection::session().await {
            if let Ok(proxy) = FileManager1Proxy::new(&connection).await {
                if proxy.show_items(vec![uri.as_str()], "").await.is_ok() {
                    return Ok(());
                }
            }
        }
    }
    let parent = path.parent().unwrap_or(path);
    Command::new("xdg-open").arg(parent).spawn().map_err(|e| format!("Couldn't open a file manager: {e}"))?;
    Ok(())
}

#[cfg(target_os = "macos")]
pub async fn reveal(path: &Path) -> Result<(), String> {
    Command::new("open").arg("-R").arg(path).spawn().map_err(|e| format!("Couldn't open Finder: {e}"))?;
    Ok(())
}

#[cfg(target_os = "windows")]
pub async fn reveal(path: &Path) -> Result<(), String> {
    // Must stay one argument glued to the path with no space after the comma
    // - that's how `explorer /select,<path>` expects it; a separate arg or an
    // inserted space stops it from selecting the file.
    let mut arg = std::ffi::OsString::from("/select,");
    arg.push(path.as_os_str());
    Command::new("explorer").arg(arg).spawn().map_err(|e| format!("Couldn't open Explorer: {e}"))?;
    Ok(())
}
