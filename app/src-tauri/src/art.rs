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

use crate::exiftool;
use crate::paths;

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

/// The exact prefix `classify_exit` emits for the "terminate called after
/// throwing an instance of 'Exiv2::Error'" crash - checked against, rather
/// than re-matching the raw stderr a second time here, since that's the only
/// path that ever produces this specific prefix.
const EXIV2_CRASH_ERROR_PREFIX: &str = "ART-cli crashed reading this RAW file's metadata";

/// Extra attempts made when `ART-cli` crashes with the Exiv2 signature above
/// - confirmed live (see the upstream bug report filed against ART) to be a
/// nondeterministic race in ART-cli's own bundled Exiv2 usage. Ruled out as
/// file corruption, disk/network I/O, or a bug in Exiv2 itself (the bundled
/// `libexiv2.so` reads the same file cleanly when driven by a different,
/// single-threaded caller).
///
/// Only used in two places now, both on paths where a blind retry is
/// actually worth its ~30-60s-per-attempt cost: `finish_art_round_trip_with_default_profile`
/// (`DefaultOnly`, no sidecar - there's no known fix to fall back to, so
/// retrying the only option available is all that can be done), and the
/// *patched* `Mode=0` attempt inside `run_art_cli_with_metadata_fallback`
/// (cheap insurance on a path that's already reliable, not the primary
/// mitigation). It is **not** used for the original `Mode=1` sidecar
/// attempt itself - confirmed live that `Mode=1` succeeds only ~1 time in 12
/// once a file is crash-prone at all, so spending several ~30-60s retries on
/// it before reaching the fallback that actually works reliably would be
/// pure wasted wall-clock time; see `run_art_cli_with_metadata_fallback`'s
/// own doc comment for why that path gets exactly one attempt instead.
const EXIV2_CRASH_RETRIES: u32 = 4;

/// Runs `ART-cli` via `run_art_cli_with_progress`, automatically retrying
/// (up to `EXIV2_CRASH_RETRIES` extra attempts) when it fails with the
/// racy Exiv2 crash `EXIV2_CRASH_RETRIES`'s doc comment describes - every
/// other error (including cancellation) is returned immediately, same as a
/// single `run_art_cli_with_progress` call. `finish_art_round_trip_with_default_profile`
/// calls this directly (see `EXIV2_CRASH_RETRIES`'s doc comment for why);
/// `run_art_cli_with_metadata_fallback` calls this only for its own patched
/// `Mode=0` fallback attempt, not for the original `Mode=1` one. The plain
/// `run_art_cli_with_progress` stays as-is (and independently tested) for
/// the case where a caller genuinely wants a single attempt.
///
/// `on_progress` may be called multiple times with a percentage that resets
/// toward 0 partway through if an earlier attempt crashed and a retry
/// started over - an accepted, minor UI quirk (a progress bar jumping back)
/// in exchange for not surfacing a spurious failure for what's usually a
/// transient crash.
pub async fn run_art_cli_with_progress_and_retry<F>(
    art_cli_path: &str,
    args: &[String],
    mut on_progress: F,
    cancel: watch::Receiver<bool>,
) -> Result<(), String>
where
    F: FnMut(u8) + Send,
{
    let mut attempt = 0;
    loop {
        let result = run_art_cli_with_progress(art_cli_path, args, &mut on_progress, cancel.clone()).await;
        match &result {
            Err(e) if attempt < EXIV2_CRASH_RETRIES && e.starts_with(EXIV2_CRASH_ERROR_PREFIX) && !*cancel.borrow() => {
                attempt += 1;
            }
            _ => return result,
        }
    }
}

/// Rewrites a `.arp`/`.pp3` processing profile's `[MetaData] Mode=1` line to
/// `Mode=0` - ART's own "re-read the RAW's EXIF via Exiv2 and copy specific
/// tags into the output" step, confirmed live (see the upstream bug report
/// filed under this crash) to be the most reliable trigger found for it:
/// disabling it turned 4/4 crashes on a real saved sidecar into 4/4 clean
/// exports, with every other line of the profile left byte-identical. Plain
/// line scanning rather than a full INI parser - both `.arp` and `.pp3`
/// sidecars are flat `[Section]`/`key=value` text with no nesting, and this
/// is the one narrowly-scoped edit this module ever needs to make to one. A
/// `Mode=` key outside `[MetaData]` (there isn't one today, but nothing
/// guarantees that stays true) is deliberately left untouched.
fn patch_metadata_mode_off(sidecar: &str) -> String {
    let mut in_metadata_section = false;
    let mut out = String::with_capacity(sidecar.len());
    for line in sidecar.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            in_metadata_section = trimmed.eq_ignore_ascii_case("[MetaData]");
            out.push_str(line);
        } else if in_metadata_section && trimmed.starts_with("Mode=") {
            out.push_str("Mode=0");
        } else {
            out.push_str(line);
        }
        out.push('\n');
    }
    out
}

/// argv for a single-profile `ART-cli` run (`-p <profile> -c <raw>`, no
/// `-d`/`-s`/`-S`) - what `run_art_cli_with_metadata_fallback` uses for its
/// patched-sidecar retry, since `-s`/`-S` always apply *last* regardless of
/// where they sit on the command line (`ART-cli -h`'s own documented merge
/// order: neutral values, then `-d`, then every `-p`, then `-s`/`-S`
/// finally overriding all of it) - stacking a `-p` override alongside the
/// original `-s`/`-S` would just have the untouched sidecar's own
/// `Mode=1` win again, so the sidecar has to be edited and substituted
/// wholesale instead of layered under.
fn build_art_cli_args_for_profile(profile_path: &Path, export_path: &Path, raw_path: &Path) -> Vec<String> {
    vec![
        "-o".to_string(),
        export_path.to_string_lossy().to_string(),
        format!("-j{JPEG_QUALITY}"),
        "-Y".to_string(),
        "-V".to_string(),
        "--progress".to_string(),
        "-p".to_string(),
        profile_path.to_string_lossy().to_string(),
        "-c".to_string(),
        raw_path.to_string_lossy().to_string(),
    ]
}

/// Runs `ART-cli` for a sidecar-driven mode (`ApplySidecar`/
/// `DefaultThenSidecarOverride`), with a fallback for the Exiv2 crash: if it
/// crashes, this rebuilds a temp copy of the *actual* sidecar (via
/// `paths::find_processing_sidecar`) with `patch_metadata_mode_off` and
/// reruns against that copy (`build_art_cli_args_for_profile`) instead of the
/// original `-s`/`-S` invocation. On a successful fallback run, shells out to
/// `exiftool` (if `exiftool_path` is configured - same convention as
/// `export_queue::apply_metadata_policy`, an empty string means "not set up,
/// skip") to copy the metadata `Mode=1` would otherwise have embedded, via
/// the same `Keep`-policy args `export_queue.rs`'s own metadata-policy
/// dialogs use - so the fallback doesn't silently produce a metadata-less
/// export. A failure in that `exiftool` step, or no `exiftool_path`
/// configured at all, is treated as "the export itself still succeeded"
/// rather than failing the whole operation - a JPEG with missing metadata is
/// still a far better outcome for the user than no JPEG at all, and this is
/// already the crash-recovery path, not the common case.
///
/// Deliberately gives the *original* `Mode=1` invocation only a single
/// attempt (`run_art_cli_with_progress`, not `..._and_retry`) before falling
/// back, rather than burning `EXIV2_CRASH_RETRIES` more attempts on it first:
/// confirmed live that `Mode=1` succeeds on only about 1 real attempt in 12
/// once it's crashed once on a given file, while the patched `Mode=0`
/// fallback has been clean on every attempt observed. Retrying the failing
/// path first was the original (wrong) design - each attempt costs a real
/// ~30-60s full processing pass, so spending several of those on a ~8%-odds
/// path before trying the one that reliably works is pure wasted wall-clock
/// time for no meaningfully better outcome. The fallback attempt itself
/// still goes through `run_art_cli_with_progress_and_retry` - its own small
/// retry margin is cheap insurance on a path that's actually likely to
/// succeed, unlike the original one.
///
/// Falls straight back to the original crash error - not the fallback
/// attempt's own error, which would usually just be a second instance of
/// the identical crash - if: the error wasn't this specific crash signature,
/// cancellation fired, no sidecar is found (shouldn't happen - both call
/// sites only reach this in a mode that already confirmed one exists - but
/// defensive rather than panicking), the sidecar can't be read/copied, or
/// the fallback run itself still fails.
pub async fn run_art_cli_with_metadata_fallback<F>(
    art_cli_path: &str,
    exiftool_path: &str,
    raw_path: &Path,
    export_path: &Path,
    mode: ArtCliMode,
    mut on_progress: F,
    cancel: watch::Receiver<bool>,
) -> Result<(), String>
where
    F: FnMut(u8) + Send,
{
    let args = build_art_cli_args(mode, export_path, raw_path);
    let result = run_art_cli_with_progress(art_cli_path, &args, &mut on_progress, cancel.clone()).await;
    let Err(crash_err) = &result else { return result };
    if *cancel.borrow() || !crash_err.starts_with(EXIV2_CRASH_ERROR_PREFIX) {
        return result;
    }
    let Some((sidecar_path, _, _)) = paths::find_processing_sidecar(raw_path) else { return result };
    let Ok(sidecar_content) = tokio::fs::read_to_string(&sidecar_path).await else { return result };
    let patched = patch_metadata_mode_off(&sidecar_content);
    let temp_path = std::env::temp_dir().join(format!(
        "immature-art-metadata-fallback-{}-{}.arp",
        std::process::id(),
        raw_path.file_name().and_then(|n| n.to_str()).unwrap_or("export")
    ));
    if tokio::fs::write(&temp_path, &patched).await.is_err() {
        return result;
    }

    let fallback_args = build_art_cli_args_for_profile(&temp_path, export_path, raw_path);
    let fallback_result = run_art_cli_with_progress_and_retry(art_cli_path, &fallback_args, &mut on_progress, cancel).await;
    let _ = tokio::fs::remove_file(&temp_path).await;

    match fallback_result {
        Ok(()) => {
            if !exiftool_path.trim().is_empty() {
                if let Some(exif_args) = exiftool::build_exiftool_args(exiftool::MetadataPolicy::Keep, Some(raw_path), export_path) {
                    let _ = exiftool::run_exiftool(exiftool_path, &exif_args).await;
                }
            }
            Ok(())
        }
        Err(_) => result,
    }
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

    /// A stub script whose behavior depends on how many times it's been
    /// invoked so far, tracked via a counter file (its own process restarts
    /// fresh every attempt, so state can't live in-process) - lets these
    /// tests simulate ART-cli's real "crashes for its first N runs, then
    /// succeeds" flakiness without an actual flaky binary.
    fn write_counting_stub_script(dir: &Path, name: &str, counter: &Path, crash_until_attempt: u32) -> PathBuf {
        write_stub_script(
            dir,
            name,
            &format!(
                "#!/bin/sh\n\
                 n=$(cat '{counter}' 2>/dev/null || echo 0)\n\
                 n=$((n+1))\n\
                 echo $n > '{counter}'\n\
                 if [ $n -le {crash_until_attempt} ]; then\n\
                 echo \"terminate called after throwing an instance of 'Exiv2::Error'\" >&2\n\
                 echo '  what():  Failed to read input data' >&2\n\
                 exit 134\n\
                 fi\n\
                 echo '100'\n\
                 exit 0\n",
                counter = counter.display(),
            ),
        )
    }

    #[tokio::test]
    async fn run_art_cli_with_progress_and_retry_succeeds_after_crashing_within_the_retry_budget() {
        let dir = tmp_dir("retry-eventual-success");
        let counter = dir.join("attempts");
        // Crashes on every attempt up to `EXIV2_CRASH_RETRIES`, succeeds on
        // the last one the budget allows - the edge of what should still
        // succeed rather than give up.
        let script = write_counting_stub_script(&dir, "art-cli-eventual-success.sh", &counter, EXIV2_CRASH_RETRIES);
        let result = retrying_on_text_file_busy(|| run_art_cli_with_progress_and_retry(script.to_str().unwrap(), &[], |_| {}, no_cancel())).await;
        assert!(result.is_ok(), "{result:?}");
        assert_eq!(
            fs::read_to_string(&counter).unwrap().trim(),
            (EXIV2_CRASH_RETRIES + 1).to_string(),
            "expected exactly {} attempts (1 + {} retries)",
            EXIV2_CRASH_RETRIES + 1,
            EXIV2_CRASH_RETRIES
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn run_art_cli_with_progress_and_retry_gives_up_after_exhausting_the_retry_budget() {
        let dir = tmp_dir("retry-exhausted");
        let counter = dir.join("attempts");
        // Never stops crashing - exercises the "still failing after every
        // retry" path, not just eventual success.
        let script = write_counting_stub_script(&dir, "art-cli-always-crash.sh", &counter, u32::MAX);
        let result = retrying_on_text_file_busy(|| run_art_cli_with_progress_and_retry(script.to_str().unwrap(), &[], |_| {}, no_cancel())).await;
        let err = result.unwrap_err();
        assert!(err.starts_with(EXIV2_CRASH_ERROR_PREFIX), "{err}");
        assert_eq!(
            fs::read_to_string(&counter).unwrap().trim(),
            (EXIV2_CRASH_RETRIES + 1).to_string(),
            "expected exactly {} attempts total (1 initial + {} retries), then giving up",
            EXIV2_CRASH_RETRIES + 1,
            EXIV2_CRASH_RETRIES
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn run_art_cli_with_progress_and_retry_does_not_retry_a_non_crash_failure() {
        let dir = tmp_dir("retry-not-applicable");
        let counter = dir.join("attempts");
        // Fails deterministically (not the Exiv2 crash signature) - retrying
        // this would just waste time before failing identically again, so it
        // should return after exactly one attempt.
        let script = write_stub_script(
            &dir,
            "art-cli-deterministic-fail.sh",
            &format!("#!/bin/sh\nn=$(cat '{c}' 2>/dev/null || echo 0)\necho $((n+1)) > '{c}'\necho 'some other error' >&2\nexit 1\n", c = counter.display()),
        );
        let result = retrying_on_text_file_busy(|| run_art_cli_with_progress_and_retry(script.to_str().unwrap(), &[], |_| {}, no_cancel())).await;
        assert_eq!(result, Err("some other error".to_string()));
        assert_eq!(fs::read_to_string(&counter).unwrap().trim(), "1", "a non-crash failure should not be retried");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn patch_metadata_mode_off_flips_mode_inside_the_metadata_section_only() {
        let sidecar = "[Other]\nMode=1\n\n[MetaData]\nMode=1\nExifKeys=Exif.Image.Make;\nNotes=\n\n[Exif]\nLens=\n";
        let patched = patch_metadata_mode_off(sidecar);
        // The [MetaData] section's own Mode flips...
        assert!(patched.contains("[MetaData]\nMode=0\n"), "{patched}");
        // ...but an unrelated section's identically-named key does not, and
        // every other line is untouched.
        assert!(patched.contains("[Other]\nMode=1\n"), "{patched}");
        assert!(patched.contains("ExifKeys=Exif.Image.Make;\n"), "{patched}");
        assert!(patched.contains("[Exif]\nLens=\n"), "{patched}");
    }

    #[test]
    fn patch_metadata_mode_off_is_a_no_op_without_a_metadata_section() {
        let sidecar = "[Exif]\nLens=\n";
        assert_eq!(patch_metadata_mode_off(sidecar), "[Exif]\nLens=\n");
    }

    #[test]
    fn build_art_cli_args_for_profile_uses_p_not_s_or_d() {
        let args = build_art_cli_args_for_profile(Path::new("/tmp/patched.arp"), Path::new("/out/x.jpg"), Path::new("/raw/x.DNG"));
        assert_eq!(
            args,
            vec![
                "-o".to_string(),
                "/out/x.jpg".to_string(),
                "-j92".to_string(),
                "-Y".to_string(),
                "-V".to_string(),
                "--progress".to_string(),
                "-p".to_string(),
                "/tmp/patched.arp".to_string(),
                "-c".to_string(),
                "/raw/x.DNG".to_string(),
            ]
        );
    }

    /// A stub `ART-cli` that crashes with the Exiv2 signature whenever `-s`
    /// is on its argv (simulating the real sidecar's `Mode=1` crashing) and
    /// succeeds otherwise (simulating the patched `-p` fallback profile
    /// working) - logs every invocation's argv, and copies whatever file
    /// follows a `-p` flag out to `profile_copy` so a test can inspect what
    /// `run_art_cli_with_metadata_fallback` actually substituted in before
    /// the real function deletes its temp copy.
    fn write_fallback_aware_stub(dir: &Path, calls_log: &Path, profile_copy: &Path) -> PathBuf {
        write_stub_script(
            dir,
            "art-cli-fallback-aware.sh",
            &format!(
                "#!/bin/sh\n\
                 echo \"$@\" >> '{calls_log}'\n\
                 prev=\"\"\n\
                 for a in \"$@\"; do\n\
                 if [ \"$prev\" = \"-p\" ]; then cp \"$a\" '{profile_copy}'; fi\n\
                 prev=\"$a\"\n\
                 done\n\
                 for a in \"$@\"; do\n\
                 if [ \"$a\" = \"-s\" ]; then\n\
                 echo \"terminate called after throwing an instance of 'Exiv2::Error'\" >&2\n\
                 echo '  what():  Failed to read input data' >&2\n\
                 exit 134\n\
                 fi\n\
                 done\n\
                 echo '100'\n\
                 exit 0\n",
                calls_log = calls_log.display(),
                profile_copy = profile_copy.display(),
            ),
        )
    }

    #[tokio::test]
    async fn run_art_cli_with_metadata_fallback_patches_the_sidecar_and_restores_metadata_via_exiftool() {
        let dir = tmp_dir("fallback-success");
        let raw_path = dir.join("photo.DNG");
        fs::write(&raw_path, b"raw").unwrap();
        // `arp_sidecar_path`'s append form - what `paths::find_processing_sidecar` looks for first.
        let sidecar_path = dir.join("photo.DNG.arp");
        fs::write(&sidecar_path, "[MetaData]\nMode=1\nExifKeys=Exif.Image.Make;\nNotes=\n\n[Exif]\nLens=\n").unwrap();
        let export_path = dir.join("out.jpg");

        let calls_log = dir.join("art-cli-calls.log");
        let profile_copy = dir.join("profile-used-by-fallback.arp");
        let art_cli = write_fallback_aware_stub(&dir, &calls_log, &profile_copy);

        let exiftool_log = dir.join("exiftool-calls.log");
        let exiftool_stub = write_stub_script(&dir, "exiftool-stub.sh", &format!("#!/bin/sh\necho \"$@\" >> '{log}'\nexit 0\n", log = exiftool_log.display()));

        let result = retrying_on_text_file_busy(|| {
            run_art_cli_with_metadata_fallback(
                art_cli.to_str().unwrap(),
                exiftool_stub.to_str().unwrap(),
                &raw_path,
                &export_path,
                ArtCliMode::ApplySidecar,
                |_| {},
                no_cancel(),
            )
        })
        .await;
        assert!(result.is_ok(), "{result:?}");

        let calls = fs::read_to_string(&calls_log).unwrap();
        let s_attempts = calls.lines().filter(|l| l.split_whitespace().any(|a| a == "-s")).count();
        assert_eq!(s_attempts, 1, "the original Mode=1 attempt should not be retried before falling back: {calls}");
        assert!(calls.contains(" -p "), "expected a fallback -p attempt: {calls}");

        let used_profile = fs::read_to_string(&profile_copy).unwrap();
        assert!(used_profile.contains("Mode=0"), "{used_profile}");
        assert!(!used_profile.contains("Mode=1"), "{used_profile}");

        let exif_calls = fs::read_to_string(&exiftool_log).unwrap();
        assert!(exif_calls.contains("-TagsFromFile"), "{exif_calls}");
        assert!(exif_calls.contains(raw_path.to_str().unwrap()), "{exif_calls}");

        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn run_art_cli_with_metadata_fallback_returns_the_original_crash_when_the_fallback_also_fails() {
        let dir = tmp_dir("fallback-still-fails");
        let raw_path = dir.join("photo.DNG");
        fs::write(&raw_path, b"raw").unwrap();
        let sidecar_path = dir.join("photo.DNG.arp");
        fs::write(&sidecar_path, "[MetaData]\nMode=1\n").unwrap();
        let export_path = dir.join("out.jpg");

        // Crashes unconditionally, regardless of -s vs -p - so both the
        // primary attempts and the patched-profile fallback fail.
        let script = write_stub_script(
            &dir,
            "art-cli-always-crash.sh",
            "#!/bin/sh\necho \"terminate called after throwing an instance of 'Exiv2::Error'\" >&2\necho '  what():  Failed to read input data' >&2\nexit 134\n",
        );

        let result = retrying_on_text_file_busy(|| {
            run_art_cli_with_metadata_fallback(script.to_str().unwrap(), "", &raw_path, &export_path, ArtCliMode::ApplySidecar, |_| {}, no_cancel())
        })
        .await;
        let err = result.unwrap_err();
        assert!(err.starts_with(EXIV2_CRASH_ERROR_PREFIX), "{err}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn run_art_cli_with_metadata_fallback_does_not_attempt_a_fallback_for_a_non_crash_failure() {
        let dir = tmp_dir("fallback-not-applicable");
        let raw_path = dir.join("photo.DNG");
        fs::write(&raw_path, b"raw").unwrap();
        // No sidecar written at all - if the fallback were (incorrectly)
        // attempted here, `paths::find_processing_sidecar` would find
        // nothing and it would still fall through to the original error, so
        // this also exercises that defensive path.
        let export_path = dir.join("out.jpg");
        let script = write_stub_script(&dir, "art-cli-deterministic-fail.sh", "#!/bin/sh\necho 'some other error' >&2\nexit 1\n");

        let result = retrying_on_text_file_busy(|| {
            run_art_cli_with_metadata_fallback(script.to_str().unwrap(), "", &raw_path, &export_path, ArtCliMode::ApplySidecar, |_| {}, no_cancel())
        })
        .await;
        assert_eq!(result, Err("some other error".to_string()));
        let _ = fs::remove_dir_all(&dir);
    }
}
