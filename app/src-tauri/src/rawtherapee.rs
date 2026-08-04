//! `rawtherapee-cli` invocation for the RawTherapee CLI round trip - the
//! RawTherapee counterpart to `art.rs` (ART is itself a RawTherapee fork, so
//! the two tools' CLI grammar overlaps heavily). Deliberately kept much
//! simpler than `art.rs`: no Exiv2-crash retry/metadata-fallback workaround,
//! since that's a bug specific to ART's own bundled Exiv2 - start with a
//! plain run, and only add tool-specific recovery here if/when real
//! `rawtherapee-cli` testing turns up its own failure mode worth working
//! around.
//!
//! **Flag semantics below are carried over from ART's own confirmed argv
//! (`art::build_art_cli_args`) on the assumption that RawTherapee-cli, as the
//! project ART forked its CLI from, accepts the same `-o`/`-j<n>`/`-Y`/`-s`/
//! `-d -S`/`-d`/`-c` grammar - this has NOT yet been confirmed against a real
//! `rawtherapee-cli -h`/version dump the way `art.rs`'s own module doc
//! comment documents for ART 1.26.7.** Do this before relying on it for real:
//! ART's own `-s` behavior (warns + falls back to neutral values on a
//! missing sidecar) is already known to differ from RawTherapee's documented
//! `-s` (falls back to the default profile instead), so flag *presence* may
//! match while flag *behavior* doesn't - `SidecarCliMode`'s mapping here may
//! need tool-specific adjustment once verified live. `--progress`/`-V` are
//! deliberately omitted (unlike ART's argv) since RawTherapee-cli's own
//! progress-reporting convention, if any, isn't confirmed either - until
//! that's checked, RawTherapee round-trip jobs simply won't get live
//! percentage updates (`cli_process::run_cli_with_progress`'s `on_progress`
//! just never fires, which is a silent no-op, not an error).

use std::path::Path;

use tokio::sync::watch;

use crate::cli_process::{self, SidecarCliMode};

/// Same fixed JPEG export quality as `art::JPEG_QUALITY` - no Preferences
/// control for format/quality yet, for either tool.
const JPEG_QUALITY: u8 = 92;

/// Pure argv construction for one `rawtherapee-cli` invocation - see this
/// module's own doc comment for what's confirmed vs. assumed about these
/// flags. Mirrors `art::build_art_cli_args`'s shape exactly (`-o`, `-j<n>`,
/// `-Y`, one of `-s`/`-d -S`/`-d`, `-c`) minus `-V`/`--progress`.
pub fn build_rawtherapee_cli_args(mode: SidecarCliMode, export_path: &Path, raw_path: &Path) -> Vec<String> {
    let mut args = vec!["-o".to_string(), export_path.to_string_lossy().to_string(), format!("-j{JPEG_QUALITY}"), "-Y".to_string()];
    match mode {
        SidecarCliMode::ApplySidecar => args.push("-s".to_string()),
        SidecarCliMode::DefaultThenSidecarOverride => {
            args.push("-d".to_string());
            args.push("-S".to_string());
        }
        SidecarCliMode::DefaultOnly => args.push("-d".to_string()),
    }
    args.push("-c".to_string());
    args.push(raw_path.to_string_lossy().to_string());
    args
}

/// Runs `rawtherapee-cli` to completion via the shared
/// `cli_process::run_cli_with_progress` driver, using the plain generic exit
/// classifier (`cli_process::classify_exit_generic`) - no crash-specific
/// pattern matching yet, unlike `art::run_art_cli_with_progress`'s Exiv2
/// handling, since none has been found/confirmed for `rawtherapee-cli`.
pub async fn run_rawtherapee_cli_with_progress<F>(rt_cli_path: &str, args: &[String], on_progress: F, cancel: watch::Receiver<bool>) -> Result<(), String>
where
    F: FnMut(u8) + Send,
{
    cli_process::run_cli_with_progress(rt_cli_path, "RawTherapee-cli", args, on_progress, cancel, |status, stderr| {
        cli_process::classify_exit_generic("RawTherapee-cli", status, stderr)
    })
    .await
}

/// Builds argv and runs `rawtherapee-cli` in one call - what
/// `art_queue::run_round_trip_cli` actually calls, mirroring
/// `art::run_art_cli_with_metadata_fallback`'s "build args, then run" shape
/// (minus the fallback) so both tools' dispatch looks the same from the
/// caller's side.
pub async fn run_rawtherapee_cli<F>(rt_cli_path: &str, raw_path: &Path, export_path: &Path, mode: SidecarCliMode, on_progress: F, cancel: watch::Receiver<bool>) -> Result<(), String>
where
    F: FnMut(u8) + Send,
{
    let args = build_rawtherapee_cli_args(mode, export_path, raw_path);
    run_rawtherapee_cli_with_progress(rt_cli_path, &args, on_progress, cancel).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;

    #[test]
    fn build_rawtherapee_cli_args_apply_sidecar_mode() {
        let args = build_rawtherapee_cli_args(SidecarCliMode::ApplySidecar, Path::new("/out/IMG_1_converted-1.jpg"), Path::new("/raw/IMG_1.DNG"));
        assert_eq!(
            args,
            vec![
                "-o".to_string(),
                "/out/IMG_1_converted-1.jpg".to_string(),
                "-j92".to_string(),
                "-Y".to_string(),
                "-s".to_string(),
                "-c".to_string(),
                "/raw/IMG_1.DNG".to_string(),
            ]
        );
    }

    #[test]
    fn build_rawtherapee_cli_args_default_then_sidecar_override_mode() {
        let args = build_rawtherapee_cli_args(SidecarCliMode::DefaultThenSidecarOverride, Path::new("/out/x.jpg"), Path::new("/raw/x.DNG"));
        assert_eq!(
            args,
            vec!["-o".to_string(), "/out/x.jpg".to_string(), "-j92".to_string(), "-Y".to_string(), "-d".to_string(), "-S".to_string(), "-c".to_string(), "/raw/x.DNG".to_string(),]
        );
    }

    #[test]
    fn build_rawtherapee_cli_args_default_only_mode() {
        let args = build_rawtherapee_cli_args(SidecarCliMode::DefaultOnly, Path::new("/out/x.jpg"), Path::new("/raw/x.DNG"));
        assert_eq!(args, vec!["-o".to_string(), "/out/x.jpg".to_string(), "-j92".to_string(), "-Y".to_string(), "-d".to_string(), "-c".to_string(), "/raw/x.DNG".to_string(),]);
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
        let dir = std::env::temp_dir().join(format!("immature-test-rawtherapee-{label}-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn no_cancel() -> watch::Receiver<bool> {
        watch::channel(false).1
    }

    /// Same environmental retry as `art.rs`'s own test suite - see its
    /// `retrying_on_text_file_busy` doc comment for why this is test-only.
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
    async fn run_rawtherapee_cli_with_progress_falls_back_to_exit_status_when_stderr_is_empty() {
        let dir = tmp_dir("fail-silent");
        let script = write_stub_script(&dir, "rawtherapee-cli-fail-silent.sh", "#!/bin/sh\nexit 3\n");
        let result = retrying_on_text_file_busy(|| run_rawtherapee_cli_with_progress(script.to_str().unwrap(), &[], |_| {}, no_cancel())).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("exited with status"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn run_rawtherapee_cli_with_progress_still_reports_trimmed_stderr_on_failure() {
        let dir = tmp_dir("fail-stderr");
        let script = write_stub_script(&dir, "rawtherapee-cli-fail-stderr.sh", "#!/bin/sh\necho 'processing failed' >&2\nexit 1\n");
        let result = retrying_on_text_file_busy(|| run_rawtherapee_cli_with_progress(script.to_str().unwrap(), &[], |_| {}, no_cancel())).await;
        assert_eq!(result, Err("processing failed".to_string()));
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn run_rawtherapee_cli_with_progress_returns_cancelled_when_already_cancelled_before_spawn() {
        let dir = tmp_dir("cancel-before-spawn");
        let script = write_stub_script(&dir, "rawtherapee-cli-sleep.sh", "#!/bin/sh\nsleep 30\nexit 0\n");
        let (tx, rx) = watch::channel(false);
        tx.send(true).unwrap();
        let result = retrying_on_text_file_busy(|| run_rawtherapee_cli_with_progress(script.to_str().unwrap(), &[], |_| {}, rx.clone())).await;
        assert_eq!(result, Err(cli_process::CANCELLED_BY_USER.to_string()));
        let _ = fs::remove_dir_all(&dir);
    }
}
