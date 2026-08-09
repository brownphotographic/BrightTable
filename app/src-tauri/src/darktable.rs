//! `darktable-cli` invocation for the DarkTable CLI round trip - the
//! darktable counterpart to `art.rs`/`rawtherapee.rs`. Kept as simple as
//! `rawtherapee.rs` (no crash-specific retry logic), but its argv shape is
//! genuinely different from either: `darktable-cli` takes its input/xmp/
//! output as positional arguments (`<input> [<xmp>] <output>`), not `-o`/`-c`
//! flags, and the xmp sidecar argument is optional - when omitted,
//! darktable-cli searches for one matching the input filename itself, which
//! is how the "no darktable edits, use default profile" case (mirroring ART/
//! RawTherapee's `-d`) is expressed here: there's no separate "apply
//! defaults, then layer a sidecar over them" flag the way `-d -S` gives ART/
//! RawTherapee, so `SidecarCliMode::ApplySidecar` and
//! `DefaultThenSidecarOverride` both just mean "pass the resolved xmp path";
//! only `DefaultOnly` omits it (see `art_queue::run_round_trip_cli`'s
//! `DarkTable` arm, which resolves that path via
//! `paths::find_darktable_history_sidecar` before calling in here).
//!
//! **`--out-ext` must be `jpg`, not `jpeg` - confirmed live (August 2026),
//! and the real root cause of an initial "blank export" bug.**
//! `export_path` always already ends in `.jpg` (`export_naming::next_export_path`),
//! and per the docs' own worked example, darktable-cli only strips an
//! existing output-filename extension when it matches `--out-ext`'s value
//! *exactly* - `"jpeg"` never matches `.jpg`, so it left the extension in
//! place as part of the base filename and appended its own on top, writing
//! the real ~12MB export to `...converted-6.jpg.jpg` while the path this app
//! actually watches (`...converted-6.jpg`) stayed the untouched 0-byte
//! placeholder `export_naming::next_export_path` pre-claimed - which is what
//! made this look like a blank/failed export rather than a filename
//! mismatch. `"jpg"` is one of the docs' own listed accepted values for this
//! flag and matches `export_path`'s real extension, making the
//! strip-and-replace a no-op.
//!
//! `run_darktable_cli` also removes any pre-existing file at `export_path`
//! immediately before invoking `darktable-cli`, as a defensive second layer
//! now that the `--out-ext` fix means darktable-cli actually targets that
//! exact path - `export_path` always arrives here as an already-claimed
//! empty placeholder (`export_naming::next_export_path`'s race-prevention
//! mechanism), and unlike ART/RawTherapee's `-Y`, `darktable-cli` has no
//! confirmed flag for "overwrite without asking," so this app clears the way
//! itself rather than relying on unconfirmed overwrite behavior. Same
//! `let _ = std::fs::remove_file(...)` idiom `commands.rs`'s own
//! cleanup-on-error paths already use, so no `spawn_blocking` hop is needed
//! for it either.
//!
//! **No progress stream**: no flag in the docs matches ART/RawTherapee's
//! zenity-style bare-integer-per-line stdout convention
//! (`cli_process::run_cli_with_progress`'s `on_progress`), so - same as
//! `rawtherapee.rs` - it's expected to simply never fire, a confirmed no-op
//! rather than an error. Not yet independently confirmed live the way the
//! `--out-ext` behavior above now is.

use std::path::Path;

use tokio::sync::watch;

use crate::cli_process;

/// Same fixed JPEG export quality as `art::JPEG_QUALITY`/`rawtherapee::JPEG_QUALITY` -
/// no Preferences control for format/quality yet, for any of the three
/// converters.
const JPEG_QUALITY: u8 = 92;

/// Pure argv construction for one `darktable-cli` invocation - see this
/// module's own doc comment for what's confirmed vs. assumed. `xmp_path` is
/// `None` for `SidecarCliMode::DefaultOnly` (no darktable edits to apply,
/// same "use the plain default profile" contract `-d` gives ART/RawTherapee),
/// `Some` otherwise.
pub fn build_darktable_cli_args(xmp_path: Option<&Path>, raw_path: &Path, export_path: &Path) -> Vec<String> {
    let mut args = vec![raw_path.to_string_lossy().to_string()];
    if let Some(xmp) = xmp_path {
        args.push(xmp.to_string_lossy().to_string());
    }
    args.push(export_path.to_string_lossy().to_string());
    args.push("--hq".to_string());
    args.push("true".to_string());
    args.push("--out-ext".to_string());
    // "jpg", not "jpeg" - confirmed live (August 2026) this isn't cosmetic:
    // the docs' own worked example is exactly this app's situation.
    // `export_path` always already ends in `.jpg` (`export_naming::next_export_path`),
    // and darktable-cli only strips an existing extension when it matches
    // --out-ext's value *exactly* - "jpeg" never matches ".jpg", so it left
    // the extension in place as part of the base filename and appended its
    // own, landing at "...converted-6.jpg.jpg" (a real ~12MB file) while the
    // path this app actually watches for ("...converted-6.jpg") stayed the
    // untouched 0-byte placeholder - which is what made this look like a
    // blank-export bug rather than a filename mismatch. "jpg" is one of the
    // docs' own listed accepted values for this flag (either "a common
    // extension (e.g. jpg. tif, exr) or a format (e.g. jpeg, tiff)"), and
    // matches export_path's real extension, so the strip-and-replace is now
    // a no-op rather than a concatenation.
    args.push("jpg".to_string());
    args.push("--core".to_string());
    args.push("--conf".to_string());
    args.push(format!("plugins/imageio/format/jpeg/quality={JPEG_QUALITY}"));
    args
}

/// Runs `darktable-cli` to completion via the shared
/// `cli_process::run_cli_with_progress` driver, using the plain generic exit
/// classifier - no crash-specific pattern matching yet, same posture as
/// `rawtherapee::run_rawtherapee_cli_with_progress`.
pub async fn run_darktable_cli_with_progress<F>(dt_cli_path: &str, args: &[String], on_progress: F, cancel: watch::Receiver<bool>) -> Result<(), String>
where
    F: FnMut(u8) + Send,
{
    cli_process::run_cli_with_progress(dt_cli_path, "darktable-cli", args, on_progress, cancel, |status, stderr| {
        cli_process::classify_exit_generic("darktable-cli", status, stderr)
    })
    .await
}

/// Builds argv and runs `darktable-cli` in one call - what
/// `art_queue::run_round_trip_cli` actually calls, mirroring
/// `rawtherapee::run_rawtherapee_cli`'s "build args, then run" shape, plus
/// the `xmp_path` this tool's grammar needs that RawTherapee's doesn't.
///
/// Removes `export_path` first - confirmed live that `darktable-cli` won't
/// overwrite it itself (see this module's own doc comment). `export_path`
/// always arrives here as an already-claimed empty placeholder
/// (`export_naming::next_export_path`'s race-prevention mechanism, shared by
/// every RAW CLI round trip target regardless of tool), so removing it right
/// before the spawn - not any earlier - keeps that claim's race-prevention
/// window as short as possible: nothing else in this app targets this exact
/// path while a round trip for it is in flight (`ArtQueue`'s per-asset
/// dispatch), so there's no real window for a second writer to slip in
/// between the remove and darktable-cli's own create. Best-effort
/// (`let _ =`, same idiom `commands.rs`'s own cleanup-on-error paths use) -
/// if the remove itself fails for some other reason (e.g. already gone),
/// darktable-cli's own run below surfaces whatever real problem remains.
pub async fn run_darktable_cli<F>(
    dt_cli_path: &str,
    raw_path: &Path,
    export_path: &Path,
    xmp_path: Option<&Path>,
    on_progress: F,
    cancel: watch::Receiver<bool>,
) -> Result<(), String>
where
    F: FnMut(u8) + Send,
{
    let _ = std::fs::remove_file(export_path);
    let args = build_darktable_cli_args(xmp_path, raw_path, export_path);
    run_darktable_cli_with_progress(dt_cli_path, &args, on_progress, cancel).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;

    #[test]
    fn build_darktable_cli_args_with_xmp_path() {
        let args = build_darktable_cli_args(Some(Path::new("/raw/IMG_1.CR2.xmp")), Path::new("/raw/IMG_1.CR2"), Path::new("/out/IMG_1_converted-1.jpg"));
        assert_eq!(
            args,
            vec![
                "/raw/IMG_1.CR2".to_string(),
                "/raw/IMG_1.CR2.xmp".to_string(),
                "/out/IMG_1_converted-1.jpg".to_string(),
                "--hq".to_string(),
                "true".to_string(),
                "--out-ext".to_string(),
                "jpg".to_string(),
                "--core".to_string(),
                "--conf".to_string(),
                "plugins/imageio/format/jpeg/quality=92".to_string(),
            ]
        );
    }

    #[test]
    fn build_darktable_cli_args_without_xmp_path() {
        let args = build_darktable_cli_args(None, Path::new("/raw/x.CR2"), Path::new("/out/x.jpg"));
        assert_eq!(
            args,
            vec![
                "/raw/x.CR2".to_string(),
                "/out/x.jpg".to_string(),
                "--hq".to_string(),
                "true".to_string(),
                "--out-ext".to_string(),
                "jpg".to_string(),
                "--core".to_string(),
                "--conf".to_string(),
                "plugins/imageio/format/jpeg/quality=92".to_string(),
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
        let dir = std::env::temp_dir().join(format!("brighttable-test-darktable-{label}-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn no_cancel() -> watch::Receiver<bool> {
        watch::channel(false).1
    }

    /// Same environmental retry as `art.rs`/`rawtherapee.rs`'s own test
    /// suites - see their `retrying_on_text_file_busy` doc comment for why
    /// this is test-only.
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
    async fn run_darktable_cli_with_progress_falls_back_to_exit_status_when_stderr_is_empty() {
        let dir = tmp_dir("fail-silent");
        let script = write_stub_script(&dir, "darktable-cli-fail-silent.sh", "#!/bin/sh\nexit 3\n");
        let result = retrying_on_text_file_busy(|| run_darktable_cli_with_progress(script.to_str().unwrap(), &[], |_| {}, no_cancel())).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("exited with status"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn run_darktable_cli_with_progress_still_reports_trimmed_stderr_on_failure() {
        let dir = tmp_dir("fail-stderr");
        let script = write_stub_script(&dir, "darktable-cli-fail-stderr.sh", "#!/bin/sh\necho 'processing failed' >&2\nexit 1\n");
        let result = retrying_on_text_file_busy(|| run_darktable_cli_with_progress(script.to_str().unwrap(), &[], |_| {}, no_cancel())).await;
        assert_eq!(result, Err("processing failed".to_string()));
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn run_darktable_cli_removes_an_existing_placeholder_before_running() {
        // Regression test for the real live bug: darktable-cli left a
        // pre-existing empty placeholder untouched (0 bytes, no error),
        // which Immich then showed as a blank image. This stub fails loudly
        // if it ever sees the output path already exist, proving
        // `run_darktable_cli` removes it first rather than leaving it for
        // darktable-cli to (not) deal with.
        let dir = tmp_dir("removes-placeholder");
        let export_path = dir.join("out.jpg");
        fs::write(&export_path, b"").unwrap();
        let script = write_stub_script(
            &dir,
            "darktable-cli-checks-no-preexisting-output.sh",
            "#!/bin/sh\nif [ -e \"$2\" ]; then echo 'output already existed' >&2; exit 1; fi\nprintf 'real jpeg bytes' > \"$2\"\nexit 0\n",
        );
        let result = retrying_on_text_file_busy(|| {
            run_darktable_cli(script.to_str().unwrap(), Path::new("/raw/x.CR2"), &export_path, None, |_| {}, no_cancel())
        })
        .await;
        assert_eq!(result, Ok(()));
        assert_eq!(fs::read_to_string(&export_path).unwrap(), "real jpeg bytes");
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn run_darktable_cli_with_progress_returns_cancelled_when_already_cancelled_before_spawn() {
        let dir = tmp_dir("cancel-before-spawn");
        let script = write_stub_script(&dir, "darktable-cli-sleep.sh", "#!/bin/sh\nsleep 30\nexit 0\n");
        let (tx, rx) = watch::channel(false);
        tx.send(true).unwrap();
        let result = retrying_on_text_file_busy(|| run_darktable_cli_with_progress(script.to_str().unwrap(), &[], |_| {}, rx.clone())).await;
        assert_eq!(result, Err(cli_process::CANCELLED_BY_USER.to_string()));
        let _ = fs::remove_dir_all(&dir);
    }
}
