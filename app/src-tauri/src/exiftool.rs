//! `exiftool` invocation for the Export to Folder / Share to Flickr metadata
//! options (see `export_queue.rs`'s `apply_metadata_policy`) - the
//! read+write metadata tool this codebase leans on rather than a bundled
//! Rust EXIF-writing crate, since `exiftool` already understands how to
//! rewrite metadata safely across the wide format range these dialogs can
//! hand it (JPEG/TIFF renditions, and - for "Original" format - many RAW
//! containers too), the same "shell out to a trusted external CLI, configured
//! by the user in Preferences -> Applications" shape `art.rs` already
//! established for `ART-cli`.
//!
//! Deliberately split into pure argv construction (`build_exiftool_args`,
//! unit-testable with no process spawned) and the actual spawn (`run_exiftool`),
//! same "isolate the untrusted assumption" shape as `art.rs`. Unlike `art.rs`,
//! there's no progress stream to parse and no multi-minute runtime to guard
//! against cancelling mid-run - a metadata edit is a near-instant operation,
//! so a plain `Command::output()` under a short timeout is enough.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MetadataPolicy {
    Keep,
    RemoveGps,
    StripAll,
}

/// Bounds how long a single `exiftool` invocation waits before giving up -
/// a metadata read/copy/strip is a near-instant operation (no demosaic, no
/// large re-encode), so this is deliberately far shorter than
/// `art::ART_CLI_RUN_TIMEOUT` - long enough to tolerate a slow NFS-backed
/// source/target file, not so long that a genuinely hung/misbehaving
/// `exiftool` binary leaves an export job stuck for minutes.
pub const EXIFTOOL_RUN_TIMEOUT: Duration = Duration::from_secs(30);

/// Builds the argv for one `exiftool` invocation, or `None` when nothing
/// needs to run at all (`Keep` with no `source` to copy from - `target`
/// should just be left exactly as it already is).
///
/// `source` is the file to copy full metadata FROM - needed for `Keep`/
/// `RemoveGps` on a freshly re-encoded JPEG rendition, which has no
/// metadata of its own yet (the `image` crate's decode/encode never
/// carries EXIF through). `None` when `target` already IS the true
/// original (the "Original" export format path), so there's nothing to
/// copy - `target` is edited in place instead.
///
/// `-TagsFromFile SRC -all:all --GROUP:all DEST` (copy every tag except one
/// group) and `-GROUP:all=`/`-all=` (delete a group/everything in place) are
/// `exiftool`'s own documented patterns for this - flag for a live sanity
/// check against the installed `exiftool` version during manual testing,
/// same epistemic caution `art.rs`'s doc comments apply to `ART-cli` flags.
/// `-overwrite_original` avoids `exiftool`'s default of leaving a
/// `*_original` backup file next to `target`.
pub fn build_exiftool_args(policy: MetadataPolicy, source: Option<&Path>, target: &Path) -> Option<Vec<String>> {
    let target = target.to_string_lossy().to_string();
    match (policy, source) {
        (MetadataPolicy::Keep, None) => None,
        (MetadataPolicy::Keep, Some(src)) => Some(vec![
            "-TagsFromFile".to_string(),
            src.to_string_lossy().to_string(),
            "-all:all".to_string(),
            "-overwrite_original".to_string(),
            target,
        ]),
        (MetadataPolicy::RemoveGps, Some(src)) => Some(vec![
            "-TagsFromFile".to_string(),
            src.to_string_lossy().to_string(),
            "-all:all".to_string(),
            "--gps:all".to_string(),
            "-overwrite_original".to_string(),
            target,
        ]),
        (MetadataPolicy::RemoveGps, None) => Some(vec!["-gps:all=".to_string(), "-overwrite_original".to_string(), target]),
        (MetadataPolicy::StripAll, _) => Some(vec!["-all=".to_string(), "-overwrite_original".to_string(), target]),
    }
}

/// Runs `exiftool` to completion under `EXIFTOOL_RUN_TIMEOUT`, returning the
/// trimmed stderr (falling back to stdout, since `exiftool` sometimes reports
/// errors there instead - e.g. "0 image files updated" without ever touching
/// stderr) as the error on a non-zero exit or a timeout.
pub async fn run_exiftool(exiftool_path: &str, args: &[String]) -> Result<(), String> {
    let child = tokio::process::Command::new(exiftool_path)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Couldn't run exiftool: {e}"))?;

    let output = match tokio::time::timeout(EXIFTOOL_RUN_TIMEOUT, child.wait_with_output()).await {
        Ok(result) => result.map_err(|e| format!("Couldn't wait for exiftool: {e}"))?,
        Err(_) => return Err(format!("Timed out after {}s running exiftool", EXIFTOOL_RUN_TIMEOUT.as_secs())),
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if !stderr.is_empty() {
            return Err(stderr);
        }
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !stdout.is_empty() {
            return Err(stdout);
        }
        return Err(format!("exiftool exited with status {}", output.status));
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
    fn build_exiftool_args_keep_without_source_is_a_no_op() {
        assert_eq!(build_exiftool_args(MetadataPolicy::Keep, None, Path::new("/out/x.jpg")), None);
    }

    #[test]
    fn build_exiftool_args_keep_with_source_copies_all_tags() {
        let args = build_exiftool_args(MetadataPolicy::Keep, Some(Path::new("/raw/x.DNG")), Path::new("/out/x.jpg"));
        assert_eq!(
            args,
            Some(vec![
                "-TagsFromFile".to_string(),
                "/raw/x.DNG".to_string(),
                "-all:all".to_string(),
                "-overwrite_original".to_string(),
                "/out/x.jpg".to_string(),
            ])
        );
    }

    #[test]
    fn build_exiftool_args_remove_gps_with_source_excludes_gps_group() {
        let args = build_exiftool_args(MetadataPolicy::RemoveGps, Some(Path::new("/raw/x.DNG")), Path::new("/out/x.jpg"));
        assert_eq!(
            args,
            Some(vec![
                "-TagsFromFile".to_string(),
                "/raw/x.DNG".to_string(),
                "-all:all".to_string(),
                "--gps:all".to_string(),
                "-overwrite_original".to_string(),
                "/out/x.jpg".to_string(),
            ])
        );
    }

    #[test]
    fn build_exiftool_args_remove_gps_without_source_edits_target_in_place() {
        let args = build_exiftool_args(MetadataPolicy::RemoveGps, None, Path::new("/out/x.jpg"));
        assert_eq!(args, Some(vec!["-gps:all=".to_string(), "-overwrite_original".to_string(), "/out/x.jpg".to_string()]));
    }

    #[test]
    fn build_exiftool_args_strip_all_ignores_source() {
        let with_source = build_exiftool_args(MetadataPolicy::StripAll, Some(Path::new("/raw/x.DNG")), Path::new("/out/x.jpg"));
        let without_source = build_exiftool_args(MetadataPolicy::StripAll, None, Path::new("/out/x.jpg"));
        let expected = Some(vec!["-all=".to_string(), "-overwrite_original".to_string(), "/out/x.jpg".to_string()]);
        assert_eq!(with_source, expected);
        assert_eq!(without_source, expected);
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
        let dir = std::env::temp_dir().join(format!("immature-test-exiftool-{label}-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn run_exiftool_succeeds_on_a_zero_exit() {
        let dir = tmp_dir("ok");
        let script = write_stub_script(&dir, "exiftool-ok.sh", "#!/bin/sh\necho '1 image files updated'\nexit 0\n");
        let result = run_exiftool(script.to_str().unwrap(), &[]).await;
        assert!(result.is_ok(), "{result:?}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn run_exiftool_reports_trimmed_stderr_on_failure() {
        let dir = tmp_dir("fail-stderr");
        let script = write_stub_script(&dir, "exiftool-fail.sh", "#!/bin/sh\necho 'Error: File not found' >&2\nexit 1\n");
        let result = run_exiftool(script.to_str().unwrap(), &[]).await;
        assert_eq!(result, Err("Error: File not found".to_string()));
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn run_exiftool_falls_back_to_stdout_when_stderr_is_empty() {
        let dir = tmp_dir("fail-stdout");
        let script = write_stub_script(&dir, "exiftool-fail-stdout.sh", "#!/bin/sh\necho '0 image files updated'\nexit 1\n");
        let result = run_exiftool(script.to_str().unwrap(), &[]).await;
        assert_eq!(result, Err("0 image files updated".to_string()));
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn run_exiftool_falls_back_to_exit_status_when_nothing_was_written() {
        let dir = tmp_dir("fail-silent");
        let script = write_stub_script(&dir, "exiftool-fail-silent.sh", "#!/bin/sh\nexit 3\n");
        let result = run_exiftool(script.to_str().unwrap(), &[]).await;
        assert!(result.unwrap_err().contains("exited with status"));
        let _ = fs::remove_dir_all(&dir);
    }
}
