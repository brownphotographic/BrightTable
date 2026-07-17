//! `ART-cli` invocation for the ART CLI round trip - see the feature plan's
//! architecture writeup. Deliberately split into pure argv construction
//! (`build_art_cli_args`, unit-testable with no process spawned) and the
//! actual spawn (`run_art_cli`), same "isolate the untrusted assumption"
//! shape as `apps.rs`'s `substitute_field_codes`/`spawn` split.
//!
//! The exact ART-cli quality-flag syntax (`-j92` vs `-j 92` vs some other
//! form) is asserted here from the feature spec's prose only, not yet
//! confirmed against a real `ART-cli -h`/manual - the one unverified
//! assumption in this module; confirm before/during manual testing.

use std::path::Path;

/// Fixed JPEG export quality for v1 - no Preferences control for
/// format/quality yet (batch export format is fixed per the plan).
const JPEG_QUALITY: u8 = 92;

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
/// `run_art_cli` specifically so the untrusted flag syntax above stays in one
/// place and is unit-testable without spawning a real process.
pub fn build_art_cli_args(mode: ArtCliMode, export_path: &Path, raw_path: &Path) -> Vec<String> {
    let mut args = vec![
        "-o".to_string(),
        export_path.to_string_lossy().to_string(),
        format!("-j{JPEG_QUALITY}"),
        "-Y".to_string(),
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

/// Runs `ART-cli` to completion and classifies the outcome - a non-zero exit
/// is an error carrying trimmed stderr (or the exit status itself, if
/// `ART-cli` wrote nothing to stderr).
pub async fn run_art_cli(art_cli_path: &str, args: &[String]) -> Result<(), String> {
    let output = tokio::process::Command::new(art_cli_path)
        .args(args)
        .output()
        .await
        .map_err(|e| format!("Couldn't run ART-cli: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() { format!("ART-cli exited with status {}", output.status) } else { stderr });
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

    #[tokio::test]
    async fn run_art_cli_ok_on_zero_exit() {
        let dir = tmp_dir("ok");
        let script = write_stub_script(&dir, "art-cli-ok.sh", "#!/bin/sh\nexit 0\n");
        let result = run_art_cli(script.to_str().unwrap(), &[]).await;
        assert!(result.is_ok());
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn run_art_cli_reports_trimmed_stderr_on_failure() {
        let dir = tmp_dir("fail");
        let script = write_stub_script(&dir, "art-cli-fail.sh", "#!/bin/sh\necho 'bad raw profile' >&2\nexit 1\n");
        let result = run_art_cli(script.to_str().unwrap(), &[]).await;
        assert_eq!(result, Err("bad raw profile".to_string()));
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn run_art_cli_falls_back_to_exit_status_when_stderr_is_empty() {
        let dir = tmp_dir("fail-silent");
        let script = write_stub_script(&dir, "art-cli-fail-silent.sh", "#!/bin/sh\nexit 3\n");
        let result = run_art_cli(script.to_str().unwrap(), &[]).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("exited with status"));
        let _ = fs::remove_dir_all(&dir);
    }
}
