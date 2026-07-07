use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryConfig {
    pub conn_mode: ConnMode,
    pub lan_url: String,
    pub tailscale_url: String,
    pub api_key: String,
    pub share_type: ShareType,
    pub local_root: String,
    pub immich_root: String,
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
}

fn default_true() -> bool {
    true
}

fn default_write_cap() -> u32 {
    25
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
            read_only: true,
            max_writes_per_batch: 25,
        }
    }
}

impl LibraryConfig {
    /// Mirrors the prototype's effLibUrl()/effLibVia() lan/tailscale/auto logic.
    pub fn resolve_active_url(&self) -> Result<(String, &'static str), String> {
        let (url, via) = match self.conn_mode {
            ConnMode::Tailscale => (self.tailscale_url.clone(), "via Tailscale"),
            ConnMode::Auto => {
                if !self.tailscale_url.trim().is_empty() {
                    (self.tailscale_url.clone(), "Auto → Tailscale")
                } else {
                    (self.lan_url.clone(), "Auto → LAN")
                }
            }
            ConnMode::Lan => (self.lan_url.clone(), "via LAN"),
        };
        if url.trim().is_empty() {
            return Err("No server URL configured for the active connection mode".into());
        }
        Ok((url.trim_end_matches('/').to_string(), via))
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
