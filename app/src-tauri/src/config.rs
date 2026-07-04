use serde::{Deserialize, Serialize};
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
    #[serde(default = "default_delete_cap")]
    pub max_delete_per_session: u32,
}

fn default_true() -> bool {
    true
}

fn default_delete_cap() -> u32 {
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
            max_delete_per_session: 25,
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
