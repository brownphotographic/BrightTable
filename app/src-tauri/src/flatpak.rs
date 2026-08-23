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

//! Detects whether this process is running inside a Flatpak sandbox and, if
//! so, routes host-binary invocations through `flatpak-spawn --host` instead
//! of exec'ing them directly.
//!
//! The sandbox's own mount/library namespace doesn't have the host's shared
//! libraries, so a host binary resolved by path (e.g. an editor found via
//! `apps.rs`'s `.desktop`-file scan, or a bare `xdg-open`/`exiftool`/`lp`)
//! fails to even start if exec'd directly from inside - not a permissions
//! problem `--filesystem` grants can fix, since it's about which dynamic
//! linker and libs answer the exec, not file visibility. `flatpak-spawn` is
//! the sandbox's own D-Bus-backed escape hatch for this (talks to
//! `org.freedesktop.Flatpak` on the session bus - see the `--talk-name`
//! grant in the Flatpak manifest), and is present on `$PATH` inside every
//! Flatpak runtime for exactly this purpose.
//!
//! Every process this app spawns that isn't itself part of the sandboxed
//! bundle - editors (`apps.rs`), RAW-converter CLIs (`cli_process.rs`),
//! `exiftool` (`exiftool.rs`), CUPS CLI tools (`print.rs`), and `xdg-open`
//! (`open_default.rs`, `reveal.rs`'s fallback) - goes through
//! [`host_command`]/[`host_command_tokio`] instead of `Command::new`
//! directly, so the same code path works unmodified whether this build is
//! running as the AppImage (unsandboxed - `is_flatpak_sandboxed()` is false,
//! these are no-ops) or as the Flatpak.
//!
//! D-Bus calls (`reveal.rs`'s `FileManager1` proxy, `suspend_guard.rs`'s
//! `logind` proxy) don't go through here - they cross the sandbox boundary
//! over the bus itself (gated by their own `--talk-name`/
//! `--system-talk-name` manifest grants), not process exec, so wrapping them
//! would be both unnecessary and wrong (there's no host `zbus` binary to
//! spawn).

use std::process::Command as StdCommand;

/// Cheap to call repeatedly (a single stat, no caching) - this isn't a hot
/// path, and caching would need `std::sync::OnceLock` for zero benefit here.
pub fn is_flatpak_sandboxed() -> bool {
    std::path::Path::new("/.flatpak-info").exists()
}

/// Builds a [`std::process::Command`] that runs `program` - via
/// `flatpak-spawn --host` when sandboxed, or `program` directly otherwise.
/// Callers use this exactly like `Command::new`: `.args(...)`/`.spawn()` etc.
/// all still apply to the returned `Command`, since `--host <program>` is
/// just `flatpak-spawn`'s own leading argv, with the caller's `.args(...)`
/// appended after it unchanged.
pub fn host_command(program: &str) -> StdCommand {
    if is_flatpak_sandboxed() {
        let mut cmd = StdCommand::new("flatpak-spawn");
        cmd.arg("--host").arg(program);
        cmd
    } else {
        StdCommand::new(program)
    }
}

/// [`host_command`]'s `tokio::process::Command` counterpart, for the async
/// spawn call sites (`cli_process.rs`, `exiftool.rs`, `print.rs`).
pub fn host_command_tokio(program: &str) -> tokio::process::Command {
    if is_flatpak_sandboxed() {
        let mut cmd = tokio::process::Command::new("flatpak-spawn");
        cmd.arg("--host").arg(program);
        cmd
    } else {
        tokio::process::Command::new(program)
    }
}
