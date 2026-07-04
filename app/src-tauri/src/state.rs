use crate::config::AppConfig;
use std::sync::Mutex;

pub struct AppState {
    pub config: Mutex<AppConfig>,
    /// Counts deletes performed since the app launched. Resets on restart -
    /// a soft safety net during testing, not a hard security boundary.
    pub session_deleted: Mutex<u32>,
    /// Shared, connection-pooling HTTP client. Reused across every request
    /// (including per-thumbnail fetches) instead of paying a fresh TCP/TLS
    /// handshake per call - this is what makes the Photos grid load fast.
    pub http: reqwest::Client,
}

impl AppState {
    pub fn new(config: AppConfig) -> Self {
        Self {
            config: Mutex::new(config),
            session_deleted: Mutex::new(0),
            http: reqwest::Client::new(),
        }
    }

    pub fn library_config(&self) -> crate::config::LibraryConfig {
        self.config.lock().unwrap().library.clone()
    }
}
