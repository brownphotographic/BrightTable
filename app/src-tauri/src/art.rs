//! `ART-cli` invocation for the ART CLI round trip - see the feature plan's
//! architecture writeup. Deliberately split into pure argv construction
//! (`build_art_cli_args`, unit-testable with no process spawned) and the
//! actual spawn (`run_art_cli`), same "isolate the untrusted assumption"
//! shape as `apps.rs`'s `substitute_field_codes`/`spawn` split.
//!
//! Every flag used here (`-o`, `-j<n>`, `-Y`, `-V`, `--progress`, `-s`,
//! `-d -S`, `-c`) is confirmed against a real `ART-cli -x` usage dump (ART
//! 1.26.7) - `-j92` (no space) is correct, and each mode layers as
//! `ArtCliMode`'s own doc comments describe. What's still unconfirmed: the
//! GUI-mode launch flags for `ART` itself (as opposed to `ART-cli`) - out of
//! scope for this module, which only ever invokes `ART-cli`.
//!
//! `-s` vs. `-S` when no sidecar exists is genuinely asymmetric, confirmed
//! live against a real ART-cli 1.26.7 binary and a real RAW file with no
//! `.arp`/`.pp3` next to it - and the *opposite* of what an earlier version
//! of this module assumed: `-s` alone just warns
//! ("sidecar file requested but not found") and falls back to neutral
//! values, exiting **0**; `-d -S` together instead exits non-zero with
//! "Error: no sidecar procparams found for: ...". Both are handled correctly
//! today (`ApplySidecar`'s pre-check in `commands::launch_art_round_trip`
//! means `-s` is never actually reached without a sidecar in practice, and
//! `art_queue::mode_for_sidecar` now avoids `-S` entirely for a target
//! already confirmed to have none) - documented here so a future change to
//! either doesn't reintroduce the mismatch blind.

use std::path::Path;
use std::process::Stdio;

use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::sync::watch;

/// The exact error text `run_art_cli_with_progress` returns when `cancel`
/// fires - `art_queue.rs`'s `finish` and `commands.rs`'s Variant 1 handlers
/// both just thread this straight through as the job's `error`, same as any
/// other `ART-cli` failure, so a cancelled job reads "Failed" with this
/// message rather than needing its own `ArtJobStatus` variant. Exposed as a
/// constant (rather than repeating the literal) so the frontend's "was this
/// cancelled, not really a failure" check and this fn's own tests can't drift
/// apart.
pub const CANCELLED_BY_USER: &str = "Cancelled by user";

/// Fixed JPEG export quality for v1 - no Preferences control for
/// format/quality yet (batch export format is fixed per the plan).
const JPEG_QUALITY: u8 = 92;

/// Bounds how long a caller should wait on one `ART-cli` invocation before
/// giving up - demosaic/denoise on a full-resolution RAW, especially with a
/// heavy sidecar profile and writing the output over a slow NFS/network
/// mount, can legitimately run for several minutes (confirmed live: ~95% CPU,
/// ~2GB RSS, several minutes elapsed for one real-world export during
/// testing) - generous enough not to falsely time out real work, while still
/// eventually surfacing an error instead of leaving the UI showing "Working…"
/// forever with zero feedback for a genuinely hung process. Same "don't hang
/// forever on an unreachable NFS mount" reasoning as
/// `commands::IMPORT_SCAN_TIMEOUT`, just a different (much longer-running)
/// operation. The child process itself is left running in the background on
/// timeout, not killed - same trade-off `commands::scan_import_source`'s own
/// doc comment already accepts for its abandoned blocking task.
pub const ART_CLI_RUN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArtCliMode {
    /// Variant 1 (interactive round trip): use the raw's own sidecar - ART
    /// itself just wrote it, from the user's edit inside the GUI. ART-cli's
    /// `-s`. `commands::launch_art_round_trip` already confirms via
    /// `paths::find_processing_sidecar` that a sidecar exists before ever
    /// using this mode, so in practice `-s` always finds one - but confirmed
    /// live, if it somehow didn't (e.g. a race where the sidecar is deleted
    /// between that check and `ART-cli` actually running), plain `-s` does
    /// *not* error: it just warns and falls back to neutral values, exiting
    /// 0. `classify_exit`'s "no sidecar procparams found" match against this
    /// mode's stderr is therefore a defensive fallback that real `-s` never
    /// actually triggers, not the primary way `ApplySidecar` reports "nothing
    /// to export" (the upfront check is).
    ApplySidecar,
    /// Variant 2 (batch round trip): start from the user's ART default
    /// profile, then layer each asset's own sidecar over it if one exists.
    /// ART-cli's `-d -S`. Confirmed live: unlike `-s` above, `-S` does *not*
    /// silently skip to the default profile when there's no sidecar - it
    /// exits non-zero with "no sidecar procparams found", same message
    /// `classify_exit` maps for `ApplySidecar`. Only ever built for a target
    /// `art_queue::mode_for_sidecar` already knows has a sidecar - see
    /// `DefaultOnly` for the sidecar-less case.
    DefaultThenSidecarOverride,
    /// The user explicitly chose "use ART's default processing profile" from
    /// the no-sidecar prompt (`commands::launch_art_round_trip` already
    /// confirmed via `paths::find_processing_sidecar` that none exists before
    /// ever offering this choice) - plain `-d`, no `-s`/`-S` at all, since
    /// there's nothing to layer over it.
    DefaultOnly,
}

/// Pure argv construction for one `ART-cli` invocation - isolated from
/// `run_art_cli`/`run_art_cli_with_progress` specifically so the flag syntax
/// above stays in one place and is unit-testable without spawning a real
/// process. `-V` (verbose) is always included so a failure always carries
/// real diagnostic stderr text rather than a bare exit code - `run_art_cli`'s
/// fallback-to-exit-status error path exists for the case where `ART-cli`
/// still writes nothing (e.g. it's not even executable), not as the expected
/// common case. `--progress` is always included too, harmless if unconsumed
/// (`run_art_cli` never reads stdout at all), so that
/// `run_art_cli_with_progress` can report live percentage as ART-cli's own
/// zenity-compatible progress protocol emits it.
pub fn build_art_cli_args(mode: ArtCliMode, export_path: &Path, raw_path: &Path) -> Vec<String> {
    let mut args = vec![
        "-o".to_string(),
        export_path.to_string_lossy().to_string(),
        format!("-j{JPEG_QUALITY}"),
        "-Y".to_string(),
        "-V".to_string(),
        "--progress".to_string(),
    ];
    match mode {
        ArtCliMode::ApplySidecar => args.push("-s".to_string()),
        ArtCliMode::DefaultThenSidecarOverride => {
            args.push("-d".to_string());
            args.push("-S".to_string());
        }
        ArtCliMode::DefaultOnly => args.push("-d".to_string()),
    }
    args.push("-c".to_string());
    args.push(raw_path.to_string_lossy().to_string());
    args
}

/// Runs `ART-cli` to completion, streaming stdout live so `on_progress` fires
/// as ART-cli's own `--progress` output (a format "compatible with zenity" -
/// see the module doc comment) arrives: a bare line that parses as an
/// integer 0-100 is a percentage, anything else (e.g. a `#`-prefixed status
/// line) is ignored - there's no per-stage status text field to put it in
/// yet, just the numeric percentage. Both ART CLI round-trip variants use
/// this (Variant 1 via a Tauri event, since it's a single awaited `invoke`
/// call with no polled job to attach a percentage to; Variant 2 via
/// `ArtJob::progress_percent`, polled through `ArtQueueStatus`) - a non-zero
/// exit is an error carrying trimmed stderr (or the exit status itself, in
/// the unlikely case `ART-cli` wrote nothing to stderr even with `-V` set).
///
/// stderr is drained concurrently on its own task rather than after stdout
/// finishes - `ART-cli` can write to both pipes, and only reading one at a
/// time risks that pipe's OS buffer filling up and stalling the child if it
/// writes enough to the other one first.
///
/// `cancel` is watched throughout via `tokio::select!` so a user-requested
/// cancellation (see `art_queue.rs::ArtQueue::request_cancel`) takes effect
/// mid-run rather than only being noticed after `ART-cli` exits on its own.
/// On cancellation this sends the child a best-effort `SIGKILL`
/// (`start_kill`, not the async `kill` - that one `.await`s the child's own
/// exit internally, which would defeat the whole point if the child is
/// genuinely wedged in uninterruptible I/O, e.g. a stalled write to a hung
/// NFS mount) and returns immediately without waiting for it to actually
/// die - same "abandon it, don't block on it" trade-off `ART_CLI_RUN_TIMEOUT`'s
/// own doc comment already accepts for the timeout case, just reached sooner
/// and with a kill signal at least attempted.
pub async fn run_art_cli_with_progress<F>(art_cli_path: &str, args: &[String], mut on_progress: F, mut cancel: watch::Receiver<bool>) -> Result<(), String>
where
    F: FnMut(u8) + Send,
{
    let mut child = tokio::process::Command::new(art_cli_path)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Couldn't run ART-cli: {e}"))?;

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

    let status = child.wait().await.map_err(|e| format!("Couldn't wait for ART-cli: {e}"))?;
    let stderr_bytes = stderr_handle.await.unwrap_or_default();
    classify_exit(status, &stderr_bytes)
}

fn classify_exit(status: std::process::ExitStatus, stderr_bytes: &[u8]) -> Result<(), String> {
    if !status.success() {
        let stderr = String::from_utf8_lossy(stderr_bytes).trim().to_string();
        if stderr.is_empty() {
            return Err(format!("ART-cli exited with status {status}"));
        }
        // `ART-cli` links a bundled Exiv2 that can `std::terminate` (an
        // uncaught C++ exception, not a normal error return) while reading a
        // specific RAW file's embedded metadata - confirmed live against a
        // real Leica M10-R DNG that a plain manual `ART-cli` invocation
        // crashes on identically, with no ImmAture involvement at all (same
        // crash with no sidecar present, and the file reads cleanly under a
        // separate, newer system Exiv2 - so it's not disk/network corruption
        // either). Framed explicitly as ART-cli's own crash rather than
        // leaving the bare C++ exception text looking like an ImmAture bug.
        if stderr.contains("terminate called after throwing an instance of") {
            return Err(format!(
                "ART-cli crashed reading this RAW file's metadata (an ART/Exiv2 bug or format incompatibility, not an ImmAture issue) — {stderr}"
            ));
        }
        // Real source, confirmed live: `-S` (Variant 2's
        // `DefaultThenSidecarOverride`, built only for a target already
        // confirmed *to have* a sidecar - see `art_queue::mode_for_sidecar`)
        // erroring unexpectedly, e.g. a race where the sidecar existed at
        // enqueue time but is gone by the time `ART-cli` actually reads it.
        // Also reachable, in principle, from `ApplySidecar` mode's own `-s`
        // (Variant 1) for the identical kind of race - though confirmed live
        // that plain `-s` normally does *not* error this way when there's no
        // sidecar (it warns and falls back to neutral values instead, exit
        // 0), so this remains a defensive catch-all for both modes rather
        // than the primary way either reports "nothing to export".
        // `commands::launch_art_round_trip` already checks with
        // `paths::find_processing_sidecar` *before* ever running ART-cli in
        // `ApplySidecar` mode, offering the user a choice (default profile
        // vs. cancel) instead of reaching this branch at all in the common
        // case.
        if stderr.contains("no sidecar procparams found") {
            return Err(
                "No edits were saved in ART for this photo, so there's nothing new to export — make an adjustment (or save) in ART before closing it, then try again".to_string(),
            );
        }
        return Err(stderr);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;

    #[test]
    fn build_art_cli_args_apply_sidecar_mode() {
        let args = build_art_cli_args(ArtCliMode::ApplySidecar, Path::new("/out/IMG_1_converted-1.jpg"), Path::new("/raw/IMG_1.DNG"));
        assert_eq!(
            args,
            vec![
                "-o".to_string(),
                "/out/IMG_1_converted-1.jpg".to_string(),
                "-j92".to_string(),
                "-Y".to_string(),
                "-V".to_string(),
                "--progress".to_string(),
                "-s".to_string(),
                "-c".to_string(),
                "/raw/IMG_1.DNG".to_string(),
            ]
        );
    }

    #[test]
    fn build_art_cli_args_default_then_sidecar_override_mode() {
        let args = build_art_cli_args(ArtCliMode::DefaultThenSidecarOverride, Path::new("/out/x.jpg"), Path::new("/raw/x.DNG"));
        assert_eq!(
            args,
            vec![
                "-o".to_string(),
                "/out/x.jpg".to_string(),
                "-j92".to_string(),
                "-Y".to_string(),
                "-V".to_string(),
                "--progress".to_string(),
                "-d".to_string(),
                "-S".to_string(),
                "-c".to_string(),
                "/raw/x.DNG".to_string(),
            ]
        );
    }

    #[test]
    fn build_art_cli_args_default_only_mode() {
        let args = build_art_cli_args(ArtCliMode::DefaultOnly, Path::new("/out/x.jpg"), Path::new("/raw/x.DNG"));
        assert_eq!(
            args,
            vec![
                "-o".to_string(),
                "/out/x.jpg".to_string(),
                "-j92".to_string(),
                "-Y".to_string(),
                "-V".to_string(),
                "--progress".to_string(),
                "-d".to_string(),
                "-c".to_string(),
                "/raw/x.DNG".to_string(),
            ]
        );
    }

    fn write_stub_script(dir: &Path, name: &str, contents: &str) -> PathBuf {
        let path = dir.join(name);
        fs::write(&path, contents).unwrap();
        let mut perms = fs::metadata(&path).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&path, perms).unwrap();
        path
    }

    fn tmp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("immature-test-art-{label}-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A cancel channel that's never signalled - for every test in this
    /// module unrelated to cancellation itself.
    fn no_cancel() -> watch::Receiver<bool> {
        watch::channel(false).1
    }

    /// Test-only: retries a freshly-written stub script's spawn on "Text file
    /// busy" - a real but purely environmental race under this suite's full
    /// parallel run (many threads each writing+chmodding+exec'ing their own
    /// tiny script in quick succession can transiently hit stale write-mode
    /// fd/inode-reuse accounting on some filesystems, confirmed reproducible
    /// here). Not a production concern: `ART-cli` is a pre-existing installed
    /// binary that's never freshly written by another thread moments before
    /// being exec'd, so `run_art_cli`/`run_art_cli_with_progress` themselves
    /// stay retry-free. Safe to retry unconditionally on this specific error:
    /// it only ever fires at the `spawn()` call itself, before `on_progress`
    /// could have been invoked even once.
    async fn retrying_on_text_file_busy<Fut>(mut attempt: impl FnMut() -> Fut) -> Result<(), String>
    where
        Fut: std::future::Future<Output = Result<(), String>>,
    {
        for i in 0..5 {
            match attempt().await {
                Err(e) if e.contains("Text file busy") && i < 4 => {
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                }
                other => return other,
            }
        }
        unreachable!()
    }

    #[tokio::test]
    async fn run_art_cli_with_progress_falls_back_to_exit_status_when_stderr_is_empty() {
        let dir = tmp_dir("fail-silent");
        let script = write_stub_script(&dir, "art-cli-fail-silent.sh", "#!/bin/sh\nexit 3\n");
        let result = retrying_on_text_file_busy(|| run_art_cli_with_progress(script.to_str().unwrap(), &[], |_| {}, no_cancel())).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("exited with status"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn run_art_cli_with_progress_reports_percent_lines_and_ignores_hash_status_lines() {
        let dir = tmp_dir("progress-ok");
        // Mirrors ART-cli's own "zenity-compatible" --progress protocol: bare
        // integer lines are percentages, `#`-prefixed lines are status text
        // that should be ignored rather than misparsed as a percentage.
        let script = write_stub_script(
            &dir,
            "art-cli-progress.sh",
            "#!/bin/sh\necho '0'\necho '# Loading raw file...'\necho '50'\necho '100'\nexit 0\n",
        );
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let result = retrying_on_text_file_busy(|| {
            seen.lock().unwrap().clear();
            let seen_clone = seen.clone();
            run_art_cli_with_progress(script.to_str().unwrap(), &[], move |pct| {
                seen_clone.lock().unwrap().push(pct);
            }, no_cancel())
        })
        .await;
        assert!(result.is_ok());
        assert_eq!(*seen.lock().unwrap(), vec![0, 50, 100]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn run_art_cli_with_progress_still_reports_trimmed_stderr_on_failure() {
        let dir = tmp_dir("progress-fail");
        let script = write_stub_script(&dir, "art-cli-progress-fail.sh", "#!/bin/sh\necho '10'\necho 'demosaic failed' >&2\nexit 1\n");
        let result = retrying_on_text_file_busy(|| run_art_cli_with_progress(script.to_str().unwrap(), &[], |_| {}, no_cancel())).await;
        assert_eq!(result, Err("demosaic failed".to_string()));
        let _ = fs::remove_dir_all(&dir);
    }

    /// Confirmed live: a real Leica M10-R DNG makes a plain manual `ART-cli`
    /// invocation abort with exactly this "terminate called..." text - an
    /// uncaught C++ exception in ART's bundled Exiv2, reproducible with no
    /// ImmAture involvement at all. This should read as ART-cli's own crash,
    /// not a bare, unattributed C++ exception dump.
    #[tokio::test]
    async fn run_art_cli_with_progress_attributes_exiv2_terminate_crashes_to_art_cli() {
        let dir = tmp_dir("progress-exiv2-crash");
        let script = write_stub_script(
            &dir,
            "art-cli-exiv2-crash.sh",
            "#!/bin/sh\necho '85'\necho \"terminate called after throwing an instance of 'Exiv2::Error'\" >&2\necho '  what():  Failed to read input data' >&2\nexit 134\n",
        );
        let result = retrying_on_text_file_busy(|| run_art_cli_with_progress(script.to_str().unwrap(), &[], |_| {}, no_cancel())).await;
        let err = result.unwrap_err();
        assert!(err.starts_with("ART-cli crashed reading this RAW file's metadata"), "{err}");
        assert!(err.contains("Failed to read input data"), "{err}");
        let _ = fs::remove_dir_all(&dir);
    }

    /// Confirmed live: `ART-cli -d -S ...` (Variant 2's
    /// `DefaultThenSidecarOverride` mode) against a real RAW with no
    /// `.arp`/`.pp3` next to it exits non-zero with exactly this stderr text
    /// - unlike plain `-s`, which just warns and falls back to neutral
    /// values instead. This exercises `classify_exit`'s friendly-message
    /// mapping for that stderr regardless of which mode actually produced
    /// it.
    #[tokio::test]
    async fn run_art_cli_with_progress_gives_a_friendly_message_when_no_sidecar_exists() {
        let dir = tmp_dir("progress-no-sidecar");
        let script = write_stub_script(
            &dir,
            "art-cli-no-sidecar.sh",
            "#!/bin/sh\necho 'no sidecar procparams found for: /raw/x.DNG' >&2\nexit 1\n",
        );
        let result = retrying_on_text_file_busy(|| run_art_cli_with_progress(script.to_str().unwrap(), &[], |_| {}, no_cancel())).await;
        let err = result.unwrap_err();
        assert!(err.contains("nothing new to export"), "{err}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn run_art_cli_with_progress_returns_cancelled_when_already_cancelled_before_spawn() {
        let dir = tmp_dir("cancel-before-spawn");
        // A long-sleeping script, so a bug that failed to check `cancel`
        // up front (and instead let the child run to completion) would hang
        // this test rather than passing it by accident.
        let script = write_stub_script(&dir, "art-cli-sleep.sh", "#!/bin/sh\nsleep 30\nexit 0\n");
        let (tx, rx) = watch::channel(false);
        tx.send(true).unwrap();
        let result = retrying_on_text_file_busy(|| run_art_cli_with_progress(script.to_str().unwrap(), &[], |_| {}, rx.clone())).await;
        assert_eq!(result, Err(CANCELLED_BY_USER.to_string()));
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn run_art_cli_with_progress_kills_the_child_and_returns_cancelled_mid_run() {
        let dir = tmp_dir("cancel-mid-run");
        let script = write_stub_script(&dir, "art-cli-sleep.sh", "#!/bin/sh\necho '10'\nsleep 30\necho '100'\nexit 0\n");
        let (tx, rx) = watch::channel(false);
        let run = run_art_cli_with_progress(script.to_str().unwrap(), &[], |_| {}, rx);
        tokio::pin!(run);
        // Give the child a moment to actually start and emit its first
        // progress line before cancelling, so this exercises the mid-run
        // `select!` branch rather than the pre-spawn check above.
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        tx.send(true).unwrap();
        let result = tokio::time::timeout(std::time::Duration::from_secs(5), run)
            .await
            .expect("cancellation should make run_art_cli_with_progress return promptly, not hang for the full sleep 30");
        assert_eq!(result, Err(CANCELLED_BY_USER.to_string()));
        let _ = fs::remove_dir_all(&dir);
    }
}
