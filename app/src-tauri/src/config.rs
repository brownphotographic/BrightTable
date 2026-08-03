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
        }
    }
}

/// The user's chosen RAW/external editor, one per role - Preferences →
/// Applications persists this. `None` until the user picks something in the
/// app picker; `Viewer.tsx`'s editor buttons redirect there instead of
/// launching when a role is unset.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationsConfig {
    pub raw_editor: Option<AppChoice>,
    pub external_editor: Option<AppChoice>,
    /// Path to the `ART-cli` binary - a plain string, not an `AppChoice`,
    /// since there's no `.desktop` entry for it to pick from the app picker,
    /// only a manual file-browse in Preferences → Applications. A non-empty
    /// value is the single signal that switches "Tweak RAW Roundtrip"/the new
    /// "Headless RAW Roundtrip" action over to the ART CLI round trip (see
    /// `commands::launch_art_round_trip`/`batch_art_round_trip`) - empty
    /// (the default) means the existing generic round trip's behavior stays
    /// byte-for-byte unchanged. `#[serde(default)]` so existing config.json
    /// files (saved before this field existed) still deserialize cleanly.
    #[serde(default)]
    pub art_cli_path: String,
    /// Path to the `exiftool` binary - same shape as `art_cli_path` (a
    /// plain string, manual file-browse only, no `.desktop` entry to pick
    /// from). A non-empty value is required by the Export to Folder/Share to
    /// Flickr dialogs' "Keep all metadata"/"Remove GPS only" options (see
    /// `export_queue.rs`/`exiftool.rs`) - "Strip all metadata" needs no
    /// external tool for a JPEG-format rendition (the `image` crate re-encode
    /// already drops everything), so it works with this unset.
    /// `#[serde(default)]` for the same old-config.json-compatibility reason
    /// as `art_cli_path`.
    #[serde(default)]
    pub exiftool_path: String,
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
        Some(folder) if !folder.trim().is_empty() => PathBuf::from(folder),
        _ => app
            .path()
            .app_config_dir()
            .map_err(|e| format!("Could not resolve app config dir: {e}"))?,
    };
    Ok(dir.join("config.json"))
}

pub fn load(app: &AppHandle) -> AppConfig {
    let default_cfg = AppConfig::default();
    let Ok(path) = config_path(app, &default_cfg) else {
        return default_cfg;
    };
    match fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => default_cfg,
    }
}

pub fn save(app: &AppHandle, cfg: &AppConfig) -> Result<(), String> {
    let path = config_path(app, cfg)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Could not create settings folder: {e}"))?;
    }
    let raw = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    fs::write(&path, raw).map_err(|e| format!("Could not write config.json: {e}"))
}
