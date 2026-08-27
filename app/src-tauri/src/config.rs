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

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

use crate::apps::AppChoice;
use crate::import::FolderDepth;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ConnMode {
    Lan,
    Tailscale,
    Auto,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ShareType {
    Nfs,
    Smb,
}

/// Which side of the (custom, `decorations: false`) title bar the minimize/
/// maximize/close buttons render on - Preferences → Configuration. Defaults
/// to `Right` (Windows/GNOME convention, and this app's original hardcoded
/// layout); `Left` mimics macOS's traffic-light placement for anyone who
/// prefers that muscle memory.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WindowControlsPosition {
    Left,
    Right,
}

impl Default for WindowControlsPosition {
    fn default() -> Self {
        WindowControlsPosition::Right
    }
}

/// App-wide light/dark theme - Preferences → Configuration. Defaults to
/// `Dark` (this app's only palette until now), so upgrading users see no
/// visual change.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ThemeMode {
    Dark,
    Light,
}

impl Default for ThemeMode {
    fn default() -> Self {
        ThemeMode::Dark
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryConfig {
    pub conn_mode: ConnMode,
    pub lan_url: String,
    pub tailscale_url: String,
    pub api_key: String,
    pub share_type: ShareType,
    // Path mapping for the External Library Immich reads in place (RAW
    // editors' own working folder) - server-side prefix + its local mount.
    pub local_root: String,
    pub immich_root: String,
    // Second, separate path mapping for assets uploaded directly into
    // Immich (mobile app / web upload), which live under Immich's own
    // internal storage root rather than the external library's folder
    // tree. `#[serde(default)]` so existing config.json files (saved before
    // this field existed) still deserialize cleanly.
    #[serde(default)]
    pub uploaded_local_root: String,
    #[serde(default)]
    pub uploaded_immich_root: String,
    #[serde(default = "default_true")]
    pub read_only: bool,
    /// Cap on how many assets a single delete or metadata-edit action can
    /// touch at once (e.g. a 30-photo multi-select edit is refused if this is
    /// 25) - not a running session total, so it doesn't need any state
    /// tracked between calls.
    #[serde(
        default = "default_write_cap",
        alias = "maxWritesPerSession",
        alias = "maxDeletePerSession"
    )]
    pub max_writes_per_batch: u32,
    /// How many `check_sidecar_metadata` scans (each one stats/reads a
    /// batch of originals for embedded rating/description/processing-
    /// sidecar presence) may run at once against the local library mount.
    /// Read once at app startup to size `IoGuard`'s semaphore (see
    /// `io_guard.rs`), not adjustable mid-session - same "read once, not
    /// live" contract as `ImportSettings::max_concurrent_jobs`, and for the
    /// same reason: this call is fired once per timeline bucket/folder as
    /// it loads, with no shared queue of its own, so how much concurrent
    /// fan-out a given NFS/SMB mount can actually absorb before per-call
    /// latency collapses is a judgment call about the user's own share, not
    /// something to hardcode. `#[serde(default = ...)]` per-field (not just
    /// relying on `LibraryConfig`'s own presence) so an existing
    /// config.json saved before this field existed still deserializes
    /// cleanly instead of resetting the whole library section to defaults.
    #[serde(default = "default_max_concurrent_metadata_scans")]
    pub max_concurrent_metadata_scans: usize,
}

fn default_true() -> bool {
    true
}

fn default_write_cap() -> u32 {
    25
}

fn default_max_concurrent_metadata_scans() -> usize {
    crate::io_guard::DEFAULT_MAX_CONCURRENT_METADATA_SCANS
}

impl Default for LibraryConfig {
    fn default() -> Self {
        Self {
            conn_mode: ConnMode::Lan,
            lan_url: String::new(),
            tailscale_url: String::new(),
            api_key: String::new(),
            share_type: ShareType::Nfs,
            local_root: String::new(),
            immich_root: String::new(),
            uploaded_local_root: String::new(),
            uploaded_immich_root: String::new(),
            read_only: true,
            max_writes_per_batch: 25,
            max_concurrent_metadata_scans: default_max_concurrent_metadata_scans(),
        }
    }
}

impl LibraryConfig {
    /// Resolves the LAN/Tailscale endpoints for the non-Auto modes. `Auto`
    /// itself is resolved separately (see `immich::resolve_connection`),
    /// since picking a real endpoint for it requires an async reachability
    /// probe this sync helper can't do.
    pub fn resolve_active_url(&self) -> Result<(String, &'static str), String> {
        let url = match self.conn_mode {
            ConnMode::Tailscale => self.tailscale_url.clone(),
            ConnMode::Lan => self.lan_url.clone(),
            ConnMode::Auto => unreachable!("Auto is resolved via immich::resolve_connection"),
        };
        let via = match self.conn_mode {
            ConnMode::Tailscale => "via Tailscale",
            ConnMode::Lan => "via LAN",
            ConnMode::Auto => unreachable!("Auto is resolved via immich::resolve_connection"),
        };
        if url.trim().is_empty() {
            return Err("No server URL configured for the active connection mode".into());
        }
        Ok((url.trim_end_matches('/').to_string(), via))
    }
}

/// A cached outcome of probing LAN reachability for `ConnMode::Auto`, so
/// repeated calls (e.g. once per thumbnail) don't each pay a network probe.
/// Keyed by the two candidate URLs so a Preferences edit invalidates it
/// automatically; also expires after `TTL` so a LAN link that drops mid-
/// session (laptop leaves the house without touching Preferences) gets
/// re-probed instead of sticking with a stale choice forever.
#[derive(Debug, Clone)]
pub struct AutoResolution {
    pub lan_url: String,
    pub tailscale_url: String,
    pub resolved_url: String,
    pub via: &'static str,
    pub resolved_at: std::time::Instant,
}

impl AutoResolution {
    pub const TTL: std::time::Duration = std::time::Duration::from_secs(30);

    pub fn is_fresh_for(&self, lan_url: &str, tailscale_url: &str) -> bool {
        self.lan_url == lan_url && self.tailscale_url == tailscale_url && self.resolved_at.elapsed() < Self::TTL
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub library: LibraryConfig,
    pub settings_folder: Option<String>,
    /// Whether the credential vault (Immich/Flickr login - `secrets.key` +
    /// `secrets.stronghold`, see `secure_store.rs`) is relocated alongside
    /// `settings_folder` too, instead of always staying in the OS-local
    /// app-data dir. Off by default and opt-in separately from
    /// `settings_folder` itself - see `secure_store.rs`'s doc comment for why
    /// the two aren't bundled automatically. `#[serde(default)]` so existing
    /// config.json files still deserialize cleanly.
    #[serde(default)]
    pub share_vault: bool,
    /// Rebindable keyboard shortcuts, keyed by action id (e.g. "selectAll").
    /// Only overrides are stored here - the frontend fills in any action
    /// missing from this map with its own built-in default, so adding a new
    /// shortcutable action later doesn't require a config migration.
    #[serde(default)]
    pub shortcuts: HashMap<String, String>,
    #[serde(default)]
    pub smart_stack: SmartStackSettings,
    #[serde(default)]
    pub applications: ApplicationsConfig,
    #[serde(default)]
    pub import: ImportSettings,
    /// Asset ids the user has manually flagged as "actually a RAW file"
    /// despite their extension not being one of the recognized RAW
    /// extensions - e.g. TIFF was the RAW-native format on some very old
    /// digital cameras (the original Canon 1Ds), but `.tif`/`.tiff` is also
    /// an ordinary export/rendition format with no reliable way to tell the
    /// two apart from Immich's metadata alone (checked: neither camera EXIF
    /// nor pixel dimensions distinguish them in practice). Rather than
    /// guessing, `.tif`/`.tiff` defaults to "not RAW" and the user marks the
    /// exceptions individually (Edit menu -> Toggle Canon RAW).
    #[serde(default)]
    pub raw_overrides: HashSet<String>,
    #[serde(default)]
    pub sharing: SharingConfig,
    #[serde(default)]
    pub window_controls_position: WindowControlsPosition,
    #[serde(default)]
    pub theme_mode: ThemeMode,
}

/// Preferences → Sharing. Only Flickr has a real, working connection today -
/// Mastodon/PixelFed/Loops are visible "coming soon" cards in the UI (see
/// `PreferencesSharing.tsx`) with nothing but an enabled flag to persist,
/// matching the design prototype's card grid without any real upload logic
/// behind the other three yet.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SharingConfig {
    pub flickr: FlickrConfig,
    #[serde(default)]
    pub mastodon_enabled: bool,
    #[serde(default)]
    pub pixelfed_enabled: bool,
    #[serde(default)]
    pub loops_enabled: bool,
}

/// Flickr OAuth 1.0a credentials/tokens - stored in plaintext in
/// `config.json`, the same precedent `LibraryConfig.api_key` already set (no
/// OS keychain integration exists anywhere in this app). `api_key`/
/// `api_secret` are the user's own Flickr "non-commercial" app credentials
/// (see flickr.com/services/apps/create); `oauth_token`/`oauth_token_secret`
/// are the three-legged OAuth 1.0a *access* token pair obtained once the user
/// completes `FlickrSetupDialog`'s wizard - see `flickr.rs`.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FlickrConfig {
    pub api_key: String,
    pub api_secret: String,
    pub oauth_token: String,
    pub oauth_token_secret: String,
    pub username: String,
    pub user_nsid: String,
    pub connected: bool,
}

/// Last-used Smart Stack dialog settings (grouping mode, version suffix, time
/// tolerance) - persisted so the user's real ART/RawTherapee suffix (e.g.
/// " - converted") doesn't need retyping every session, unlike the design
/// prototype where this state is purely in-memory.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartStackSettings {
    pub mode: String,
    pub suffix: String,
    /// Index into the frontend's 19-step TOL scale, 0..=18.
    pub tolerance: u32,
    /// Which format Name mode prefers as a group's pick when both a RAW and
    /// a non-RAW (JPEG) rendition share a base name - "raw" preserves the
    /// long-standing unconditional-RAW-preference behavior. A plain String
    /// ("raw" | "jpeg"), matching `mode`'s own convention of staying
    /// untyped here and being validated on the TS side.
    /// `#[serde(default = ...)]` per-field (not just relying on
    /// `AppConfig.smart_stack`'s own `#[serde(default)]`, which only covers
    /// the whole `smartStack` key being absent) so an existing config.json
    /// saved before this field existed still deserializes cleanly instead
    /// of resetting the whole config to defaults - see
    /// `LibraryConfig.max_concurrent_metadata_scans` for the same pattern.
    #[serde(default = "default_name_pick_preference")]
    pub name_pick_preference: String,
    /// Version mode: when a group forms, also search the library for a
    /// RAW/JPEG sibling sharing the group's base name that wasn't part of
    /// the user's selection, and fold it in automatically. On by default.
    #[serde(default = "default_true")]
    pub version_include_siblings: bool,
}

impl Default for SmartStackSettings {
    fn default() -> Self {
        Self {
            mode: "name".into(),
            // Wildcard-flanked so it matches "converted" appearing anywhere
            // in the base name, regardless of the exact separator/spacing a
            // RAW editor used when saving the rendition (e.g. "IMG_1 -
            // converted.jpg" or "IMG_1_converted_2.jpg" both match).
            suffix: "*converted*".into(),
            tolerance: 10,
            name_pick_preference: "raw".into(),
            version_include_siblings: true,
        }
    }
}

fn default_name_pick_preference() -> String {
    "raw".into()
}

/// Which RAW converter's CLI is currently active for "Tweak RAW Roundtrip"/
/// "Headless RAW Roundtrip" - Preferences → Applications lets the user
/// configure all three converters at once (each with its own vertical
/// sub-tab, own desktop app *and* own CLI path together - see
/// `RawConverterConfig` - settings preserved when switching between them)
/// but only one is ever "live" for the roundtrip buttons at a time, matching
/// how the old single shared `raw_editor` field was already one chosen app
/// rather than a list. All three converters (including `DarkTable`, via
/// `darktable.rs`) have a working CLI invocation - `ApplicationsConfig::active_raw_cli`
/// only errors for any of them when its own `cli_path` isn't configured. See
/// `requirements.md` §1.6/§2.5.
/// `#[serde(rename)]`s pinned explicitly on `RawTherapee`/`DarkTable` rather
/// than left to `rename_all = "camelCase"`'s derivation - the frontend's
/// `RawConverterKind` type (`lib/api.ts`) uses plain lowercase product-name
/// strings (`'rawtherapee'`/`'darktable'`), but `heck`'s camelCase transform
/// treats "RawTherapee"/"DarkTable" as two English words and would derive
/// `"rawTherapee"`/`"darkTable"` instead - a silent wire-format mismatch
/// that broke saving either converter as the active one (`save_applications_config`
/// failed to deserialize the frontend's lowercase string, and the frontend's
/// `.catch(() => {})` on every `saveApplicationsConfig` call swallowed the
/// error, so the choice looked fine in the running session but never
/// actually reached disk - a restart always reverted to whatever was last
/// saved). `Art` needed no pin since "art" already has no case-boundary to
/// transform.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RawConverterKind {
    Art,
    #[serde(rename = "rawtherapee")]
    RawTherapee,
    #[serde(rename = "darktable")]
    DarkTable,
}

/// One RAW converter's own settings - its GUI app *and* its CLI path
/// together, rather than a shared `raw_editor` app picked separately from
/// which CLI processes the result. Keeping them paired here is deliberate:
/// launching ART's GUI and then running `rawtherapee-cli` against the
/// sidecar it wrote (or vice versa) would never actually work, since each
/// tool's sidecar format (`.arp`/`.pp3`) is its own, so there's no reason to
/// let the two drift apart in Preferences the way a single shared
/// `raw_editor` field used to allow.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawConverterConfig {
    /// The GUI app "Tweak RAW Roundtrip" opens and waits on before running
    /// this tool's CLI (or, with no CLI path set, the plain launch-only RAW
    /// Editor round trip uses this alone) - `None` until chosen in the app
    /// picker, same "redirect to Preferences instead of launching" contract
    /// `external_editor` already has.
    pub app: Option<AppChoice>,
    /// Path to this tool's CLI binary - a plain string, not an `AppChoice`,
    /// since there's no `.desktop` entry for a CLI tool to pick from the app
    /// picker, only a manual file-browse in Preferences → Applications.
    /// `#[serde(default)]` so a config.json saved before this field existed
    /// still deserializes cleanly.
    #[serde(default)]
    pub cli_path: String,
}

/// The user's chosen editors - Preferences → Applications persists this.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationsConfig {
    pub external_editor: Option<AppChoice>,
    /// Which converter's own config (below) actually drives "Tweak RAW
    /// Roundtrip"/"Headless RAW Roundtrip"/the plain launch-only RAW Editor
    /// role - `None` (the default) means no RAW Editor app is configured at
    /// all, same "redirect to Preferences" contract `external_editor` unset
    /// already has. `#[serde(default)]` so existing config.json files still
    /// deserialize cleanly; `config::load`'s migration step sets this to
    /// `Some(Art)` for an old config that had a `rawEditor` app and/or a
    /// non-empty ART-cli path under the pre-per-converter shapes this config
    /// went through, so upgrading needs no re-configuration.
    #[serde(default)]
    pub active_raw_converter: Option<RawConverterKind>,
    #[serde(default)]
    pub art: RawConverterConfig,
    #[serde(default)]
    pub rawtherapee: RawConverterConfig,
    /// Persisted the same as the other two, and read by a working roundtrip
    /// command like they are. darktable's processing history lives inside
    /// the same `.xmp` sidecar `paths.rs` already reads/writes for
    /// rating/description, unlike ART's `.arp`/RawTherapee's `.pp3` - so
    /// unlike those two, "does this asset have edits to roundtrip" is
    /// answered by `paths::find_darktable_history_sidecar` (a surgical read
    /// of that shared file's darktable `history` stack via
    /// `xmp::has_darktable_history`) rather than a plain sidecar-exists
    /// check. See `requirements.md` §1.6/§2.4.
    #[serde(default)]
    pub darktable: RawConverterConfig,
    /// Path to the `exiftool` binary - same shape as each `RawConverterConfig::cli_path`
    /// (a plain string, manual file-browse only, no `.desktop` entry to pick
    /// from). A non-empty value is required by the Export to Folder/Share to
    /// Flickr dialogs' "Keep all metadata"/"Remove GPS only" options (see
    /// `export_queue.rs`/`exiftool.rs`) - "Strip all metadata" needs no
    /// external tool for a JPEG-format rendition (the `image` crate re-encode
    /// already drops everything), so it works with this unset.
    /// `#[serde(default)]` for the same old-config.json-compatibility reason.
    #[serde(default)]
    pub exiftool_path: String,
}

impl ApplicationsConfig {
    /// Resolves the active converter's CLI path, or an error describing why
    /// no RAW CLI round trip is available right now - the single place
    /// `commands::launch_raw_cli_round_trip`/`batch_raw_cli_round_trip` (and
    /// the frontend's `rawRoundTripEnabled`, mirrored in `lib/applications.tsx`)
    /// decide this, so the two can't drift apart.
    pub fn active_raw_cli(&self) -> Result<(RawConverterKind, &str), String> {
        match self.active_raw_converter {
            None => Err("No RAW converter chosen — pick one in Preferences → Applications".into()),
            Some(RawConverterKind::Art) => {
                if self.art.cli_path.trim().is_empty() {
                    Err("No ART-cli path configured — set one in Preferences → Applications".into())
                } else {
                    Ok((RawConverterKind::Art, self.art.cli_path.as_str()))
                }
            }
            Some(RawConverterKind::RawTherapee) => {
                if self.rawtherapee.cli_path.trim().is_empty() {
                    Err("No RawTherapee-cli path configured — set one in Preferences → Applications".into())
                } else {
                    Ok((RawConverterKind::RawTherapee, self.rawtherapee.cli_path.as_str()))
                }
            }
            Some(RawConverterKind::DarkTable) => {
                if self.darktable.cli_path.trim().is_empty() {
                    Err("No darktable-cli path configured — set one in Preferences → Applications".into())
                } else {
                    Ok((RawConverterKind::DarkTable, self.darktable.cli_path.as_str()))
                }
            }
        }
    }
}

/// Last-used SD-card/disk import settings - the chosen folder hierarchy and
/// the last source path browsed to, so re-importing from the same card
/// doesn't need re-picking the folder every session.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSettings {
    pub folder_depth: FolderDepth,
    pub last_source_path: Option<String>,
    /// How many copies run at once - read once at app startup to size the
    /// import queue's semaphore (`import::queue::run`), not adjustable mid-
    /// session. `#[serde(default = ...)]` specifically (not just relying on
    /// the outer `AppConfig.import` field's own `#[serde(default)]`, which
    /// only covers the whole `import` key being absent): this field was
    /// added after `folder_depth`/`last_source_path` already shipped, so an
    /// existing `config.json` from a session before this field existed has
    /// an `import` key present but missing just this one - without a
    /// per-field default, that would fail to parse and silently reset the
    /// *entire* config (library connection, shortcuts, everything) back to
    /// defaults, per `config::load`'s `unwrap_or_default` fallback.
    #[serde(default = "default_max_concurrent_import_jobs")]
    pub max_concurrent_jobs: usize,
}

fn default_max_concurrent_import_jobs() -> usize {
    crate::import::queue::DEFAULT_MAX_CONCURRENT_IMPORT_JOBS
}

impl Default for ImportSettings {
    fn default() -> Self {
        Self {
            folder_depth: FolderDepth::YearMonth,
            last_source_path: None,
            max_concurrent_jobs: default_max_concurrent_import_jobs(),
        }
    }
}

fn config_path(app: &AppHandle, cfg: &AppConfig) -> Result<PathBuf, String> {
    let dir = match &cfg.settings_folder {
        Some(folder) if !folder.trim().is_empty() => PathBuf::from(folder.trim()),
        _ => app
            .path()
            .app_config_dir()
            .map_err(|e| format!("Could not resolve app config dir: {e}"))?,
    };
    Ok(dir.join("config.json"))
}

/// Peeks the two fields needed before either config.json or the credential
/// vault can be opened for real - the `settingsFolder` redirect, and whether
/// the vault should follow it - by reading the same pointer-stub-then-real-
/// file chain `load` does below, but stopping short of full deserialization.
/// Safe to call before the vault exists (neither field is a secret), which is
/// exactly why `lib.rs`'s `.setup()` calls this first: it needs to know where
/// to open the vault *before* it can open it, and where the vault lives can
/// itself be set inside the very config.json this app hasn't loaded yet.
pub fn resolve_early_config(app: &AppHandle) -> (Option<PathBuf>, bool) {
    let Ok(default_dir) = app.path().app_config_dir() else {
        return (None, false);
    };
    let Ok(raw_default) = fs::read_to_string(default_dir.join("config.json")) else {
        return (None, false);
    };

    let mut raw = raw_default.clone();
    let mut folder: Option<PathBuf> = None;
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw_default) {
        if let Some(f) = value.get("settingsFolder").and_then(|v| v.as_str()) {
            let f = f.trim();
            if !f.is_empty() {
                folder = Some(PathBuf::from(f));
                if let Ok(redirected_raw) = fs::read_to_string(PathBuf::from(f).join("config.json")) {
                    raw = redirected_raw;
                }
            }
        }
    }

    let share_vault = serde_json::from_str::<serde_json::Value>(&raw)
        .ok()
        .and_then(|v| v.get("shareVault").and_then(|v| v.as_bool()))
        .unwrap_or(false);

    (folder, share_vault)
}

pub fn load(app: &AppHandle, vault: Option<&crate::secure_store::SecretVault>) -> AppConfig {
    let default_cfg = AppConfig::default();
    let Ok(default_dir) = app.path().app_config_dir() else {
        return default_cfg;
    };
    let default_path = default_dir.join("config.json");
    let Ok(raw_default) = fs::read_to_string(&default_path) else {
        return default_cfg;
    };

    // A `settingsFolder` override (Preferences -> Configuration) moves
    // config.json to a folder of the user's choosing - e.g. so a dev build
    // and a Flatpak install can share one file. Which folder that is can't
    // be known until config.json itself has been read,
    // so `save` always keeps a stub containing just this one field at the
    // OS-default location - read that first, purely to find the redirect,
    // then load the real file from wherever it points.
    let mut raw = raw_default.clone();
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw_default) {
        if let Some(folder) = value.get("settingsFolder").and_then(|v| v.as_str()) {
            let folder = folder.trim();
            if !folder.is_empty() {
                if let Ok(redirected_raw) = fs::read_to_string(PathBuf::from(folder).join("config.json")) {
                    raw = redirected_raw;
                }
            }
        }
    }

    let mut cfg: AppConfig = serde_json::from_str(&raw).unwrap_or_default();

    // Migrates a config.json saved under either of two shapes this app went
    // through before settling on `RawConverterConfig` (app + CLI path
    // together, per converter): the original ART-only shape (a single shared
    // `applications.rawEditor` app plus a flat `applications.artCliPath`),
    // and a brief intermediate shape with flat per-tool `*CliPath` fields but
    // still one shared `rawEditor`. Serde already silently dropped whichever
    // of these legacy keys it found (unknown fields are ignored, not an
    // error) and left the new `art`/`rawtherapee`/`darktable` structs at
    // their all-empty `Default` above - re-reading the raw JSON `Value`
    // directly recovers them into their new per-converter home instead of
    // silently losing an existing user's setup on upgrade.
    if let Ok(raw_value) = serde_json::from_str::<serde_json::Value>(&raw) {
        if let Some(applications) = raw_value.get("applications") {
            // A pre-existing `rawEditor` was necessarily ART's own GUI (ART
            // was the only converter this app ever supported before
            // RawTherapee/DarkTable existed) - migrated into `art.app`
            // specifically, whether or not `artCliPath` was also set (a
            // user in plain launch-only mode, no CLI configured at all, gets
            // their editor choice preserved here just as faithfully).
            if cfg.applications.art.app.is_none() {
                if let Some(app_value) = applications.get("rawEditor") {
                    if let Ok(app_choice) = serde_json::from_value::<AppChoice>(app_value.clone()) {
                        cfg.applications.art.app = Some(app_choice);
                    }
                }
            }
            if cfg.applications.art.cli_path.trim().is_empty() {
                if let Some(p) = applications.get("artCliPath").and_then(|v| v.as_str()) {
                    cfg.applications.art.cli_path = p.to_string();
                }
            }
            if cfg.applications.rawtherapee.cli_path.trim().is_empty() {
                if let Some(p) = applications.get("rawtherapeeCliPath").and_then(|v| v.as_str()) {
                    cfg.applications.rawtherapee.cli_path = p.to_string();
                }
            }
            if cfg.applications.darktable.cli_path.trim().is_empty() {
                if let Some(p) = applications.get("darktableCliPath").and_then(|v| v.as_str()) {
                    cfg.applications.darktable.cli_path = p.to_string();
                }
            }
        }
    }
    // A non-empty `art.app`/`art.cli_path` recovered above (from either
    // legacy shape) used to mean "ART is the editor in use" all by itself,
    // with no explicit `active_raw_converter` concept existing at all -
    // preserve that exact behavior for an existing user rather than
    // silently leaving the RAW Editor role unconfigured until they revisit
    // Preferences.
    if cfg.applications.active_raw_converter.is_none()
        && (cfg.applications.art.app.is_some() || !cfg.applications.art.cli_path.trim().is_empty())
    {
        cfg.applications.active_raw_converter = Some(RawConverterKind::Art);
    }

    // Immich/Flickr credentials live in the encrypted Stronghold vault, not
    // config.json - see `secure_store.rs`. `vault` is `None` when opening it
    // failed at startup (no writable app-local-data dir); that just leaves
    // whatever config.json already had in place, same as before the vault
    // existed.
    if let Some(vault) = vault {
        if vault.read_into(&mut cfg) {
            // config.json still had these fields in plaintext (an old save
            // from before the vault existed) and the vault had no entry of
            // its own yet - migrate them in and rewrite config.json with
            // them blanked right now, rather than waiting for the user's
            // next Preferences save.
            let _ = save(app, &cfg, Some(vault));
        }
    }

    cfg
}

pub fn save(app: &AppHandle, cfg: &AppConfig, vault: Option<&crate::secure_store::SecretVault>) -> Result<(), String> {
    let path = config_path(app, cfg)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Could not create settings folder: {e}"))?;
    }
    let mut on_disk = cfg.clone();
    if let Some(vault) = vault {
        if vault.write_secrets(cfg).is_ok() {
            on_disk.library.api_key.clear();
            on_disk.sharing.flickr.api_key.clear();
            on_disk.sharing.flickr.api_secret.clear();
            on_disk.sharing.flickr.oauth_token.clear();
            on_disk.sharing.flickr.oauth_token_secret.clear();
        }
        // Vault write failed (rather than vault being unavailable, which
        // never got here at all): fall through and let config.json keep
        // carrying these fields in plaintext, same as before the vault
        // existed - better than silently blanking them on disk with
        // nowhere else they got saved.
    }
    let raw = serde_json::to_string_pretty(&on_disk).map_err(|e| e.to_string())?;
    fs::write(&path, raw).map_err(|e| format!("Could not write config.json: {e}"))?;

    // When settingsFolder redirects config.json elsewhere, also drop a stub
    // holding just that one field at the OS-default location - `load` reads
    // it first on a fresh launch to find the redirect before it can know
    // anything else about the real config (see `load`'s own comment).
    let default_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Could not resolve app config dir: {e}"))?;
    let default_path = default_dir.join("config.json");
    if default_path != path {
        fs::create_dir_all(&default_dir).map_err(|e| format!("Could not create app config dir: {e}"))?;
        let stub = serde_json::json!({ "settingsFolder": cfg.settings_folder });
        let stub_raw = serde_json::to_string_pretty(&stub).map_err(|e| e.to_string())?;
        fs::write(&default_path, stub_raw).map_err(|e| format!("Could not write settings-folder pointer: {e}"))?;
    }
    Ok(())
}

/// Where the credential vault should live for a given config - `Some` only
/// when `share_vault` is on and a real `settings_folder` is set. Mirrors
/// `resolve_early_config`'s early-boot version of the same formula (that one
/// works off a raw `serde_json::Value` since it runs before `AppConfig` can
/// be deserialized at all - see its own doc comment).
fn vault_dir_for(cfg: &AppConfig) -> Option<PathBuf> {
    if cfg.share_vault {
        cfg.settings_folder.as_deref().map(str::trim).filter(|f| !f.is_empty()).map(PathBuf::from)
    } else {
        None
    }
}

/// Reopens the credential vault at wherever `next` says it should now live
/// (a no-op if that's unchanged from `current`) and swaps it into
/// `secret_vault` immediately, adopting whatever secrets are already sitting
/// there into `next` - the same "adopt what's already at the destination"
/// treatment `set_settings_folder` below already gives an existing
/// `config.json`. Without this, the old location's vault would stay the live
/// one until the next restart, so any secret edited in the meantime (e.g.
/// re-entering the API key right after moving the vault) would silently land
/// in the old, no-longer-read location and get orphaned there.
fn reopen_vault_if_moved(
    app: &AppHandle,
    current: &AppConfig,
    next: &mut AppConfig,
    secret_vault: &std::sync::RwLock<Option<crate::secure_store::SecretVault>>,
) -> Result<(), String> {
    if vault_dir_for(current) == vault_dir_for(next) {
        return Ok(());
    }
    let reopened = crate::secure_store::SecretVault::open(app, vault_dir_for(next).as_deref())?;
    reopened.read_into(next);
    *secret_vault.write().unwrap() = Some(reopened);
    Ok(())
}

/// Redirects config.json to `folder` (or back to the OS-default location if
/// `None`/empty) - Preferences -> Configuration. If `folder` already holds
/// its own full config.json (e.g. a shared folder another install of this
/// app already wrote to, or - when clearing the override - a real config
/// still sitting at the OS-default location from before a redirect was ever
/// set) that file's contents are adopted wholesale rather than overwritten
/// with whatever this install currently has loaded; otherwise (nothing there
/// yet, or just the `settingsFolder`-only pointer stub `save` leaves behind)
/// the current in-memory config is written there instead, effectively moving
/// it. If vault-sharing is (or, via an adopted config.json above, now is) on,
/// the credential vault moves right along with it - see
/// `reopen_vault_if_moved`.
pub fn set_settings_folder(
    app: &AppHandle,
    current: &AppConfig,
    folder: Option<String>,
    secret_vault: &std::sync::RwLock<Option<crate::secure_store::SecretVault>>,
) -> Result<AppConfig, String> {
    let folder = folder.map(|f| f.trim().to_string()).filter(|f| !f.is_empty());
    let target_dir = match &folder {
        Some(f) => PathBuf::from(f),
        None => app
            .path()
            .app_config_dir()
            .map_err(|e| format!("Could not resolve app config dir: {e}"))?,
    };
    let target_path = target_dir.join("config.json");

    let mut next = fs::read_to_string(&target_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<AppConfig>(&raw).ok())
        .unwrap_or_else(|| current.clone());
    next.settings_folder = folder;

    reopen_vault_if_moved(app, current, &mut next, secret_vault)?;

    save(app, &next, secret_vault.read().unwrap().as_ref())?;
    Ok(next)
}

/// Toggles whether the credential vault follows `settings_folder` - see
/// `AppConfig::share_vault`'s doc comment and `reopen_vault_if_moved`, which
/// does the actual work: reopening the vault at (or back from) the shared
/// folder right now, adopting whatever's already there, rather than waiting
/// for the next launch. Turning sharing back off leaves the shared copy in
/// place rather than copying it back; the OS-local dir picks up wherever it
/// already was (nothing, for an install that always shared).
pub fn set_share_vault(
    app: &AppHandle,
    current: &AppConfig,
    share: bool,
    secret_vault: &std::sync::RwLock<Option<crate::secure_store::SecretVault>>,
) -> Result<AppConfig, String> {
    let mut next = current.clone();
    next.share_vault = share;

    reopen_vault_if_moved(app, current, &mut next, secret_vault)?;

    save(app, &next, secret_vault.read().unwrap().as_ref())?;
    Ok(next)
}

#[cfg(test)]
mod raw_converter_kind_wire_format_tests {
    use super::RawConverterKind;

    /// Locks in the exact wire format the frontend's `RawConverterKind`
    /// type (`lib/api.ts`) actually sends/expects - plain lowercase, not
    /// `rename_all = "camelCase"`'s derived `"rawTherapee"`/`"darkTable"`.
    /// A prior mismatch here meant picking RawTherapee/DarkTable as the
    /// active converter looked fine in the running session (pure React
    /// state) but silently failed to persist: `save_applications_config`
    /// couldn't deserialize the frontend's lowercase string, and the
    /// frontend's `saveApplicationsConfig(...).catch(() => {})` swallowed
    /// the resulting error, so a restart always reverted to whatever was
    /// last actually saved.
    #[test]
    fn serializes_as_the_frontends_lowercase_strings() {
        assert_eq!(serde_json::to_string(&RawConverterKind::Art).unwrap(), "\"art\"");
        assert_eq!(serde_json::to_string(&RawConverterKind::RawTherapee).unwrap(), "\"rawtherapee\"");
        assert_eq!(serde_json::to_string(&RawConverterKind::DarkTable).unwrap(), "\"darktable\"");
    }

    #[test]
    fn deserializes_the_frontends_lowercase_strings() {
        assert_eq!(serde_json::from_str::<RawConverterKind>("\"art\"").unwrap(), RawConverterKind::Art);
        assert_eq!(serde_json::from_str::<RawConverterKind>("\"rawtherapee\"").unwrap(), RawConverterKind::RawTherapee);
        assert_eq!(serde_json::from_str::<RawConverterKind>("\"darktable\"").unwrap(), RawConverterKind::DarkTable);
    }
}

#[cfg(test)]
mod vault_dir_for_tests {
    use super::{vault_dir_for, AppConfig};

    #[test]
    fn none_when_share_vault_is_off_even_with_a_folder_set() {
        let mut cfg = AppConfig::default();
        cfg.settings_folder = Some("/shared/BrightTable".to_string());
        cfg.share_vault = false;
        assert_eq!(vault_dir_for(&cfg), None);
    }

    #[test]
    fn none_when_share_vault_is_on_but_no_folder_is_set() {
        let mut cfg = AppConfig::default();
        cfg.share_vault = true;
        assert_eq!(vault_dir_for(&cfg), None);

        cfg.settings_folder = Some("   ".to_string());
        assert_eq!(vault_dir_for(&cfg), None);
    }

    #[test]
    fn the_trimmed_folder_when_both_are_set() {
        let mut cfg = AppConfig::default();
        cfg.settings_folder = Some("  /shared/BrightTable  ".to_string());
        cfg.share_vault = true;
        assert_eq!(vault_dir_for(&cfg), Some(std::path::PathBuf::from("/shared/BrightTable")));
    }
}
