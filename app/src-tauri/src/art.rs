//! `ART-cli` invocation for the ART CLI round trip - see the feature plan's
//! architecture writeup. Deliberately split into pure argv construction
//! (`build_art_cli_args`, unit-testable with no process spawned) and the
//! actual spawn (`run_art_cli`), same "isolate the untrusted assumption"
//! shape as `apps.rs`'s `substitute_field_codes`/`spawn` split.
//!
//! Every flag used here (`-o`, `-j<n>`, `-Y`, `-V`, `--progress`, `-s`,
//! `-d -S`, `-c`) is confirmed against a real `ART-cli -x` usage dump (ART
//! 1.26.7) - `-j92` (no space) is correct, and `-d -S` layers exactly as
//! intended: ART builds neutral values, then overrides with the default
//! profile (`-d`), then overrides again with the sidecar if one exists
//! (`-S`, skipped if it doesn't) - i.e. "sidecar wins over default",
//! matching `ArtCliMode::DefaultThenSidecarOverride`'s doc comment. What's
//! still unconfirmed: the GUI-mode launch flags for `ART` itself (as opposed
//! to `ART-cli`) - out of scope for this module, which only ever invokes
//! `ART-cli`.

use std::path::Path;
use std::process::Stdio;

use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};

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
    /// Variant 1 (interactive round trip): use the raw's own sidecar if one
    /// exists - ART itself just wrote it, from the user's edit inside the
    /// GUI - else ART's own default profile. ART-cli's `-s`.
    ApplySidecar,
    /// Variant 2 (batch round trip): start from the user's ART default
    /// profile, then layer each asset's own sidecar over it if one exists.
    /// ART-cli's `-d -S`.
    DefaultThenSidecarOverride,
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
pub async fn run_art_cli_with_progress<F>(art_cli_path: &str, args: &[String], mut on_progress: F) -> Result<(), String>
where
    F: FnMut(u8) + Send,
{
    let mut child = tokio::process::Command::new(art_cli_path)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Couldn't run ART-cli: {e}"))?;

    let stdout = child.stdout.take().expect("stdout was piped");
    let mut stderr = child.stderr.take().expect("stderr was piped");
    let stderr_handle = tauri::async_runtime::spawn(async move {
        let mut buf = Vec::new();
        let _ = stderr.read_to_end(&mut buf).await;
        buf
    });

    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if let Ok(percent) = line.trim().parse::<u8>() {
            if percent <= 100 {
                on_progress(percent);
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
        let result = retrying_on_text_file_busy(|| run_art_cli_with_progress(script.to_str().unwrap(), &[], |_| {})).await;
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
            })
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
        let result = retrying_on_text_file_busy(|| run_art_cli_with_progress(script.to_str().unwrap(), &[], |_| {})).await;
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
        let result = retrying_on_text_file_busy(|| run_art_cli_with_progress(script.to_str().unwrap(), &[], |_| {})).await;
        let err = result.unwrap_err();
        assert!(err.starts_with("ART-cli crashed reading this RAW file's metadata"), "{err}");
        assert!(err.contains("Failed to read input data"), "{err}");
        let _ = fs::remove_dir_all(&dir);
    }
}
