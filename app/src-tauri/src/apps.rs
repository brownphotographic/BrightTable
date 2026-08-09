//! Detection and launching of external RAW/photo editors. Best-effort only:
//! every detection step degrades to "found nothing" rather than erroring,
//! since a missing directory or unreadable `.desktop` file is the normal
//! case on many systems, not a failure worth surfacing to the picker.
//!
//! Flatpak and Snap apps are picked up "for free" by also scanning their own
//! `.desktop`-export directories (`/var/lib/flatpak/exports/...`,
//! `~/.local/share/flatpak/exports/...`, `/var/lib/snapd/desktop/applications`)
//! alongside the native ones, then classifying `AppKind` from the `Exec=`
//! line's shape - rather than shelling out to `flatpak list`/`snap list` and
//! parsing their column output. This avoids depending on either CLI being
//! resolvable from this app's `PATH` (not guaranteed for a GUI app launched
//! outside a shell) and reuses one `.desktop`-reader for every kind.
//!
//! AppImage is deliberately never auto-detected here - there's no standard
//! registry of installed AppImages to scan, so it's only reachable through
//! the picker's own "Other application…" custom-executable file-browse
//! fallback, same as the design prototype.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AppKind {
    Native,
    Flatpak,
    Snap,
    AppImage,
    Custom,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppChoice {
    pub name: String,
    pub exec: String,
    pub kind: AppKind,
    /// Extra flags inserted before the file argument on launch - e.g. ART's
    /// `-s` (Simple editor mode), which skips loading its own file-browser
    /// thumbnail panel for the opened file's containing folder. That panel's
    /// thumbnail generation is what was actually causing multi-minute hangs
    /// over NFS, not the path handoff itself - `-s` opens straight into the
    /// editor for just the one file, same as Shotwell's equivalent feature
    /// does. Free text, split on whitespace; `#[serde(default)]` so configs
    /// saved before this field existed still deserialize cleanly.
    #[serde(default)]
    pub extra_args: String,
}

/// Every directory that might hold a `.desktop` entry worth showing in the
/// picker - native apps under the two standard XDG locations, plus Flatpak's
/// and Snap's own desktop-file export directories.
fn desktop_entry_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![
        PathBuf::from("/usr/share/applications"),
        PathBuf::from("/usr/local/share/applications"),
        PathBuf::from("/var/lib/flatpak/exports/share/applications"),
        PathBuf::from("/var/lib/snapd/desktop/applications"),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        dirs.push(home.join(".local/share/applications"));
        dirs.push(home.join(".local/share/flatpak/exports/share/applications"));
    }
    dirs
}

pub fn detect_installed_apps() -> Vec<AppChoice> {
    let mut seen_exec = std::collections::HashSet::new();
    let mut apps = Vec::new();
    for dir in desktop_entry_dirs() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("desktop") {
                continue;
            }
            if let Some(app) = parse_desktop_entry(&path) {
                // The same app can show up in more than one scanned directory
                // (e.g. a user-level override of a system entry) - keep the
                // first occurrence, deduped by its exact launch command
                // rather than by name, since two different apps could
                // legitimately share a display name.
                if seen_exec.insert(app.exec.clone()) {
                    apps.push(app);
                }
            }
        }
    }
    apps.sort_by_key(|a: &AppChoice| a.name.to_lowercase());
    apps
}

/// Reads the `[Desktop Entry]` section's `Name=`/`Exec=`/`NoDisplay=` keys.
/// Not a general `.desktop`/ini parser - just enough of the format to build
/// a launchable entry, same "narrow parser for a known format" approach as
/// `paths.rs`'s `.pp3` reader.
fn parse_desktop_entry(path: &Path) -> Option<AppChoice> {
    let text = fs::read_to_string(path).ok()?;
    let mut name = None;
    let mut exec = None;
    let mut no_display = false;
    let mut in_desktop_entry = false;
    for line in text.lines() {
        let line = line.trim();
        if let Some(section) = line.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
            in_desktop_entry = section == "Desktop Entry";
            continue;
        }
        if !in_desktop_entry {
            continue;
        }
        if let Some(v) = line.strip_prefix("Name=") {
            if name.is_none() {
                name = Some(v.to_string());
            }
        } else if let Some(v) = line.strip_prefix("Exec=") {
            exec = Some(v.to_string());
        } else if let Some(v) = line.strip_prefix("NoDisplay=") {
            no_display = v.eq_ignore_ascii_case("true");
        }
    }
    if no_display {
        return None;
    }
    let name = name?;
    let exec = exec?;
    Some(AppChoice { name, kind: classify_exec(&exec), exec, extra_args: String::new() })
}

/// Flatpak's own desktop-file exporter always starts `Exec=` with a `run`
/// invocation of a `flatpak` binary - as a bare command (`flatpak run ...`)
/// on most distros, but as an absolute path (`/usr/bin/flatpak run ...`) on
/// others (e.g. Fedora), so this checks the first token's basename rather
/// than a literal string prefix. Snap's launcher wrapper always routes
/// through `/snap/bin/<name>` (directly, or via an `env ...` prefix) -
/// anything else is a plain native binary.
fn classify_exec(exec: &str) -> AppKind {
    let mut tokens = exec.split_whitespace();
    let program = tokens.next().unwrap_or("");
    let is_flatpak_run = tokens.next() == Some("run")
        && Path::new(program).file_name().and_then(|n| n.to_str()) == Some("flatpak");
    if is_flatpak_run {
        AppKind::Flatpak
    } else if exec.contains("/snap/") {
        AppKind::Snap
    } else {
        AppKind::Native
    }
}

/// Desktop-entry field-code substitution (XDG Desktop Entry spec, §Exec key)
/// for the file-argument codes only (`%f`/`%F`/`%u`/`%U`) - `%i`/`%c`/`%k`
/// are dropped rather than expanded, since they need an icon/translated
/// name/desktop-file-path this launcher has no use for. `%%` unescapes to a
/// literal `%`. Returns whether a file-argument code was actually found, so
/// the caller knows whether it still needs to append the path itself for an
/// `Exec=` that takes no file argument at all.
fn substitute_field_codes(
    tokens: &[String],
    file_path: &str,
    extra_args: &[String],
) -> (bool, Vec<String>) {
    let mut found = false;
    let mut out = Vec::with_capacity(tokens.len() + extra_args.len());
    for tok in tokens {
        match tok.as_str() {
            "%f" | "%F" | "%u" | "%U" => {
                // Extra args (e.g. ART's `-s`) belong to the editor itself,
                // so they must land right before the path - not before the
                // exec line's own leading tokens, which for a Snap/env-wrapped
                // entry (`env VAR=val /snap/bin/art %f`) would otherwise put
                // them ahead of `env`'s own VAR=val args and get parsed as
                // flags to `env` rather than to the editor.
                if !found {
                    out.extend(extra_args.iter().cloned());
                }
                out.push(file_path.to_string());
                found = true;
            }
            "%i" | "%c" | "%k" => {}
            "%%" => out.push("%".to_string()),
            other => out.push(other.to_string()),
        }
    }
    (found, out)
}

/// Splits an `Exec=` value into argv. A plain whitespace split, not a full
/// shell-quoting-aware tokenizer - covers the overwhelming majority of real
/// entries (every example in this app's own picker uses plain `%f`/`%U`
/// tokens with no embedded spaces), at the cost of not handling an `Exec=`
/// whose own arguments contain quoted spaces. The picker always shows the
/// raw `exec` string, so a launch that goes wrong here is at least
/// diagnosable.
fn parse_exec_tokens(exec: &str) -> Vec<String> {
    exec.split_whitespace().map(str::to_string).collect()
}

/// Builds the `(program, args)` to launch `choice` with `path` as the file to
/// open - factored out of `launch_app` so `launch_app_and_wait` (the ART CLI
/// round trip's "done editing" signal, see `art.rs`) can reuse the exact same
/// argv-building logic rather than duplicating it. Native/Flatpak/Snap
/// entries all carry a real `Exec=` command line that already knows how to
/// invoke the app (for Flatpak/Snap this includes `flatpak run <id>`/the
/// `/snap/bin/<name>` wrapper itself) - only the file-argument field code
/// needs substituting. AppImage/Custom entries are just a bare executable
/// path with no `Exec=` grammar at all, so the path is simply appended.
fn build_argv(choice: &AppChoice, path: &Path) -> Result<(String, Vec<String>), String> {
    let path_str = path.to_string_lossy().to_string();
    let extra_args = parse_exec_tokens(&choice.extra_args);
    match choice.kind {
        AppKind::Native | AppKind::Flatpak | AppKind::Snap => {
            let tokens = parse_exec_tokens(&choice.exec);
            let Some((program, rest)) = tokens.split_first() else {
                return Err(format!("\"{}\" has no launch command configured", choice.name));
            };
            let (had_field_code, mut args) = substitute_field_codes(rest, &path_str, &extra_args);
            if !had_field_code {
                args.extend(extra_args);
                args.push(path_str);
            }
            Ok((program.clone(), args))
        }
        AppKind::AppImage | AppKind::Custom => {
            let mut full_args = extra_args;
            full_args.push(path_str);
            Ok((choice.exec.clone(), full_args))
        }
    }
}

pub fn launch_app(choice: &AppChoice, path: &Path) -> Result<(), String> {
    let (program, args) = build_argv(choice, path)?;
    spawn(&program, &args, &choice.name)
}

/// Same argv construction as `launch_app`, but spawns and `.wait()`s on the
/// process's exit instead of firing-and-forgetting it - the ART CLI round
/// trip's Variant 1 "done editing" signal (spawning `ART <raw_path>` as its
/// own dedicated process per invocation, not a shared `-R` instance - see the
/// feature plan's decision on this trade-off). Any clean process exit counts
/// as "done", including a non-zero one from the user cancelling inside the
/// GUI - this only reports a *launch* failure, never treats the app's own
/// exit code as this command's own failure.
pub async fn launch_app_and_wait(choice: &AppChoice, path: &Path) -> Result<(), String> {
    let (program, args) = build_argv(choice, path)?;
    let mut child = tokio::process::Command::new(&program)
        .args(&args)
        .spawn()
        .map_err(|e| format!("Couldn't launch {}: {e}", choice.name))?;
    child.wait().await.map_err(|e| format!("Couldn't wait for {}: {e}", choice.name))?;
    Ok(())
}

fn spawn(program: &str, args: &[String], name: &str) -> Result<(), String> {
    Command::new(program)
        .args(args)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Couldn't launch {name}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_desktop_entry(dir: &Path, filename: &str, contents: &str) -> PathBuf {
        let path = dir.join(filename);
        fs::write(&path, contents).unwrap();
        path
    }

    #[test]
    fn build_argv_native_substitutes_field_code() {
        let choice = AppChoice { name: "GIMP".into(), exec: "gimp %U".into(), kind: AppKind::Native, extra_args: String::new() };
        let (program, args) = build_argv(&choice, Path::new("/mnt/photos/img.CR2")).unwrap();
        assert_eq!(program, "gimp");
        assert_eq!(args, vec!["/mnt/photos/img.CR2".to_string()]);
    }

    #[test]
    fn build_argv_custom_appends_path_with_no_exec_grammar() {
        let choice = AppChoice { name: "MyTool".into(), exec: "/opt/mytool".into(), kind: AppKind::Custom, extra_args: "-s".into() };
        let (program, args) = build_argv(&choice, Path::new("/x/img.DNG")).unwrap();
        assert_eq!(program, "/opt/mytool");
        assert_eq!(args, vec!["-s".to_string(), "/x/img.DNG".to_string()]);
    }

    #[test]
    fn build_argv_errors_on_empty_exec() {
        let choice = AppChoice { name: "Broken".into(), exec: String::new(), kind: AppKind::Native, extra_args: String::new() };
        assert!(build_argv(&choice, Path::new("/x/img.DNG")).is_err());
    }

    #[tokio::test]
    async fn launch_app_and_wait_succeeds_on_clean_exit_including_nonzero() {
        let dir = std::env::temp_dir().join(format!("brighttable-test-apps-wait-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let script = dir.join("fake-editor.sh");
        fs::write(&script, "#!/bin/sh\nexit 7\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&script).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&script, perms).unwrap();

        let choice = AppChoice { name: "Fake".into(), exec: script.to_string_lossy().to_string(), kind: AppKind::Custom, extra_args: String::new() };
        let result = launch_app_and_wait(&choice, &dir.join("img.DNG")).await;
        // A non-zero exit (e.g. the user cancelling inside the GUI) is still
        // "done editing", not a launch failure.
        assert!(result.is_ok());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn parses_name_exec_and_classifies_native() {
        let dir = std::env::temp_dir().join(format!("brighttable-test-apps-native-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = write_desktop_entry(
            &dir,
            "gimp.desktop",
            "[Desktop Entry]\nType=Application\nName=GIMP\nExec=gimp %U\n",
        );
        let app = parse_desktop_entry(&path).unwrap();
        assert_eq!(app.name, "GIMP");
        assert_eq!(app.exec, "gimp %U");
        assert_eq!(app.kind, AppKind::Native);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn classifies_flatpak_and_snap_from_exec_shape() {
        assert_eq!(
            classify_exec("flatpak run --branch=stable --arch=x86_64 --command=darktable org.darktable.Darktable @@u %u @@"),
            AppKind::Flatpak
        );
        // Fedora's flatpak exporter writes an absolute path rather than the
        // bare "flatpak run" most distros use - see real-world desktop entry
        // for org.gimp.GIMP on this system.
        assert_eq!(
            classify_exec("/usr/bin/flatpak run --branch=stable --arch=x86_64 --command=gimp-3.2 --file-forwarding org.gimp.GIMP @@u %U @@"),
            AppKind::Flatpak
        );
        assert_eq!(classify_exec("env BAMF_DESKTOP_FILE_HINT=/x /snap/bin/gimp %U"), AppKind::Snap);
        assert_eq!(classify_exec("/usr/bin/gimp %U"), AppKind::Native);
    }

    #[test]
    fn skips_no_display_entries() {
        let dir = std::env::temp_dir().join(format!("brighttable-test-apps-nodisplay-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = write_desktop_entry(
            &dir,
            "hidden.desktop",
            "[Desktop Entry]\nType=Application\nName=Hidden Helper\nExec=hidden-helper %f\nNoDisplay=true\n",
        );
        assert!(parse_desktop_entry(&path).is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn ignores_keys_outside_desktop_entry_section() {
        let dir = std::env::temp_dir().join(format!("brighttable-test-apps-section-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = write_desktop_entry(
            &dir,
            "multi.desktop",
            "[Desktop Action Foo]\nExec=wrong-command\n\n[Desktop Entry]\nName=Real App\nExec=real-command %f\n",
        );
        let app = parse_desktop_entry(&path).unwrap();
        assert_eq!(app.name, "Real App");
        assert_eq!(app.exec, "real-command %f");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn substitutes_file_field_code() {
        let tokens = parse_exec_tokens("gimp %U --new-instance");
        let (found, args) = substitute_field_codes(&tokens[1..], "/mnt/photos/img.CR2", &[]);
        assert!(found);
        assert_eq!(args, vec!["/mnt/photos/img.CR2".to_string(), "--new-instance".to_string()]);
    }

    #[test]
    fn appends_path_when_no_field_code_present() {
        let tokens = parse_exec_tokens("some-editor --gui");
        let (found, args) = substitute_field_codes(&tokens[1..], "/mnt/photos/img.CR2", &[]);
        assert!(!found);
        assert_eq!(args, vec!["--gui".to_string()]);
    }

    #[test]
    fn unescapes_literal_percent() {
        let tokens = parse_exec_tokens("some-editor %% %f");
        let (found, args) = substitute_field_codes(&tokens[1..], "/x.jpg", &[]);
        assert!(found);
        assert_eq!(args, vec!["%".to_string(), "/x.jpg".to_string()]);
    }

    #[test]
    fn extra_args_land_before_path_not_before_env_wrapper() {
        // Snap desktop entries are commonly exported as `env VAR=val
        // /snap/bin/app %f` - extra_args (e.g. ART's `-s`) must end up right
        // before the path, not ahead of `env`'s own VAR=val token, or `env`
        // itself tries (and fails) to parse them as its own flags.
        let tokens = parse_exec_tokens("env BAMF_DESKTOP_FILE_HINT=/x /snap/bin/art %f");
        let extra_args = parse_exec_tokens("-s");
        let (found, args) = substitute_field_codes(&tokens[1..], "/mnt/photos/img.CR2", &extra_args);
        assert!(found);
        assert_eq!(
            args,
            vec![
                "BAMF_DESKTOP_FILE_HINT=/x".to_string(),
                "/snap/bin/art".to_string(),
                "-s".to_string(),
                "/mnt/photos/img.CR2".to_string(),
            ]
        );
    }
}
