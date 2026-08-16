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

//! Generic child-process driver shared by every RAW converter CLI (`art.rs`,
//! `rawtherapee.rs`) - extracted out of what was originally `art.rs`'s own
//! `run_art_cli_with_progress`/`classify_exit`, since that function never
//! actually depended on ART specifically (it takes the binary path as a plain
//! `&str`). Each tool module keeps its own thin wrapper (own progress-line
//! convention if it differs, own crash-specific `classify_exit` matching) and
//! calls `run_cli_with_progress` here for the actual spawn/stream/cancel
//! plumbing, so that logic isn't duplicated per tool.

use std::process::Stdio;

use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::sync::watch;

/// The exact error text `run_cli_with_progress` returns when `cancel` fires -
/// `art_queue.rs`'s `finish` and `commands.rs`'s round-trip handlers both just
/// thread this straight through as the job's `error`, same as any other CLI
/// failure, so a cancelled job reads "Failed" with this message rather than
/// needing its own job-status variant.
pub const CANCELLED_BY_USER: &str = "Cancelled by user";

/// Bounds how long a caller should wait on one RAW-converter CLI invocation
/// before giving up - demosaic/denoise on a full-resolution RAW, especially
/// with a heavy sidecar profile and writing the output over a slow NFS/
/// network mount, can legitimately run for several minutes (confirmed live
/// for ART-cli: ~95% CPU, ~2GB RSS, several minutes elapsed for one real-world
/// export during testing) - generous enough not to falsely time out real
/// work, while still eventually surfacing an error instead of leaving the UI
/// showing "Working…" forever with zero feedback for a genuinely hung
/// process. Shared across every converter rather than a per-tool constant -
/// RawTherapee-cli's demosaic pass is the same class of CPU/RAM-heavy work as
/// ART-cli's (ART forked RT's own processing pipeline), so the same budget
/// applies until real testing says otherwise.
pub const RAW_CLI_RUN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20 * 60);

/// The three ways a RAW converter CLI can be told what develop settings to
/// apply - shared across converters that happen to expose this exact
/// three-way choice (ART and RawTherapee, since ART's own CLI grammar was
/// forked from RawTherapee's). **The mapping from a mode to actual argv flags
/// is tool-specific** - see each tool's own `build_*_cli_args` for the flags
/// it actually emits, and don't assume they're identical: ART's `-s` is
/// already confirmed to behave differently on a missing sidecar (warns,
/// falls back to neutral values, exits 0) than RawTherapee's own documented
/// `-s` (falls back to the default profile) - `art.rs`'s module doc comment
/// has the full live-confirmed detail for ART specifically.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SidecarCliMode {
    /// Variant 1 (interactive round trip): use the RAW's own sidecar - the
    /// editor itself just wrote it, from the user's edit inside its GUI.
    ApplySidecar,
    /// Variant 2 (batch round trip): start from the user's default profile,
    /// then layer each asset's own sidecar over it if one exists. Only ever
    /// built for a target already confirmed to have a sidecar - see
    /// `DefaultOnly` for the sidecar-less case (`art_queue::mode_for_sidecar`
    /// picks between the two).
    DefaultThenSidecarOverride,
    /// The user explicitly chose "use the default processing profile" from
    /// the no-sidecar prompt, or a batch target is already confirmed to have
    /// no sidecar - no per-asset override at all.
    DefaultOnly,
}

/// Runs one RAW-converter CLI invocation to completion, streaming stdout live
/// so `on_progress` fires as the process's own progress output arrives (a
/// bare line that parses as an integer 0-100 is a percentage, anything else
/// is ignored - matches ART-cli/RawTherapee-cli's shared "zenity-compatible"
/// `--progress` convention). Both ART CLI round-trip variants use this
/// (Variant 1 via a Tauri event, since it's a single awaited `invoke` call
/// with no polled job to attach a percentage to; Variant 2 via
/// `ArtJob::progress_percent`, polled through `ArtQueueStatus`).
///
/// stderr is drained concurrently on its own task rather than after stdout
/// finishes - the child can write to both pipes, and only reading one at a
/// time risks that pipe's OS buffer filling up and stalling the child if it
/// writes enough to the other one first.
///
/// `cancel` is watched throughout via `tokio::select!` so a user-requested
/// cancellation (see `art_queue.rs::ArtQueue::request_cancel`) takes effect
/// mid-run rather than only being noticed after the child exits on its own.
/// On cancellation this sends the child a best-effort `SIGKILL`
/// (`start_kill`, not the async `kill` - that one `.await`s the child's own
/// exit internally, which would defeat the whole point if the child is
/// genuinely wedged in uninterruptible I/O, e.g. a stalled write to a hung
/// NFS mount) and returns immediately without waiting for it to actually die
/// - same "abandon it, don't block on it" trade-off `RAW_CLI_RUN_TIMEOUT`'s
/// own doc comment already accepts for the timeout case, just reached sooner
/// and with a kill signal at least attempted.
///
/// `classify_exit` is the caller's own non-zero-exit interpreter (empty
/// stderr fallback, tool-specific crash/friendly-message matching) - kept a
/// caller-supplied closure rather than baked in here, since it's the one part
/// of this whole flow that genuinely differs per tool.
pub async fn run_cli_with_progress<F, C>(
    cli_path: &str,
    program_label: &str,
    args: &[String],
    mut on_progress: F,
    mut cancel: watch::Receiver<bool>,
    classify_exit: C,
) -> Result<(), String>
where
    F: FnMut(u8) + Send,
    C: FnOnce(std::process::ExitStatus, &[u8]) -> Result<(), String>,
{
    let mut child = tokio::process::Command::new(cli_path)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Couldn't run {program_label}: {e}"))?;

    if *cancel.borrow() {
        let _ = child.start_kill();
        return Err(CANCELLED_BY_USER.to_string());
    }

    let stdout = child.stdout.take().expect("stdout was piped");
    let mut stderr = child.stderr.take().expect("stderr was piped");
    let stderr_handle = tauri::async_runtime::spawn(async move {
        let mut buf = Vec::new();
        let _ = stderr.read_to_end(&mut buf).await;
        buf
    });

    let mut lines = BufReader::new(stdout).lines();
    loop {
        tokio::select! {
            line = lines.next_line() => {
                match line {
                    Ok(Some(l)) => {
                        if let Ok(percent) = l.trim().parse::<u8>() {
                            if percent <= 100 {
                                on_progress(percent);
                            }
                        }
                    }
                    _ => break,
                }
            }
            _ = cancel.changed() => {
                if *cancel.borrow() {
                    let _ = child.start_kill();
                    return Err(CANCELLED_BY_USER.to_string());
                }
            }
        }
    }

    let status = child.wait().await.map_err(|e| format!("Couldn't wait for {program_label}: {e}"))?;
    let stderr_bytes = stderr_handle.await.unwrap_or_default();
    classify_exit(status, &stderr_bytes)
}

/// The plain, no-special-cases exit classifier - a non-zero exit with no
/// stderr becomes a generic "exited with status" message, otherwise the raw
/// trimmed stderr is surfaced as-is. What `art.rs`'s own `classify_exit`
/// wraps with its Exiv2-crash/no-sidecar friendly-message matching;
/// `rawtherapee.rs` uses this directly, having no known crash signature of
/// its own yet.
pub fn classify_exit_generic(program_label: &str, status: std::process::ExitStatus, stderr_bytes: &[u8]) -> Result<(), String> {
    if !status.success() {
        let stderr = String::from_utf8_lossy(stderr_bytes).trim().to_string();
        if stderr.is_empty() {
            return Err(format!("{program_label} exited with status {status}"));
        }
        return Err(stderr);
    }
    Ok(())
}
