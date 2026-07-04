pub mod models;

use crate::config::LibraryConfig;
use models::{ConnectionStatus, RawBucketAssets, RawTimeBucket, ServerVersion, UserInfo};

pub struct ImmichClient {
    base_url: String,
    via: &'static str,
    api_key: String,
    http: reqwest::Client,
}

impl ImmichClient {
    /// `http` should be the app-wide shared client (see AppState::http) so
    /// requests reuse pooled/keep-alive connections instead of each paying a
    /// fresh TCP/TLS handshake - critical for a grid that fires one request
    /// per thumbnail.
    pub fn from_config(cfg: &LibraryConfig, http: reqwest::Client) -> Result<Self, String> {
        let (base_url, via) = cfg.resolve_active_url()?;
        if cfg.api_key.trim().is_empty() {
            return Err("No API key configured".into());
        }
        Ok(Self {
            base_url,
            via,
            api_key: cfg.api_key.clone(),
            http,
        })
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path)
    }

    async fn get_json<T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        query: &[(&str, String)],
    ) -> Result<T, String> {
        let resp = self
            .http
            .get(self.url(path))
            .header("x-api-key", &self.api_key)
            .header("Accept", "application/json")
            .query(query)
            .send()
            .await
            .map_err(|e| format!("Request to {path} failed: {e}"))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("{path} returned {status}: {body}"));
        }
        resp.json::<T>()
            .await
            .map_err(|e| format!("Could not parse response from {path}: {e}"))
    }

    pub async fn test_connection(&self) -> Result<ConnectionStatus, String> {
        let version: ServerVersion = self.get_json("/server/version", &[]).await?;
        let user: UserInfo = self.get_json("/users/me", &[]).await?;
        Ok(ConnectionStatus {
            ok: true,
            resolved_url: self.base_url.clone(),
            via: self.via.to_string(),
            server_version: version.display(),
            user_email: user.email,
        })
    }

    pub async fn get_time_buckets(&self) -> Result<Vec<models::TimeBucketInfo>, String> {
        let raw: Vec<RawTimeBucket> = self
            .get_json(
                "/timeline/buckets",
                &[("isTrashed".into(), "false".into())],
            )
            .await?;
        Ok(raw.into_iter().map(Into::into).collect())
    }

    pub async fn get_time_bucket_assets(
        &self,
        time_bucket: &str,
    ) -> Result<Vec<models::AssetSummary>, String> {
        let raw: RawBucketAssets = self
            .get_json(
                "/timeline/bucket",
                &[
                    ("timeBucket".into(), time_bucket.to_string()),
                    ("isTrashed".into(), "false".into()),
                ],
            )
            .await?;
        Ok(raw.into_summaries())
    }

    pub async fn get_thumbnail_bytes(
        &self,
        asset_id: &str,
        size: &str,
    ) -> Result<(Vec<u8>, String), String> {
        let resp = self
            .http
            .get(self.url(&format!("/assets/{asset_id}/thumbnail")))
            .header("x-api-key", &self.api_key)
            .query(&[("size", size)])
            .send()
            .await
            .map_err(|e| format!("Thumbnail request failed: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("Thumbnail request returned {}", resp.status()));
        }
        let content_type = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("image/jpeg")
            .to_string();
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| format!("Could not read thumbnail bytes: {e}"))?;
        Ok((bytes.to_vec(), content_type))
    }

    pub async fn delete_assets(&self, ids: &[String], force: bool) -> Result<(), String> {
        let body = serde_json::json!({ "ids": ids, "force": force });
        let resp = self
            .http
            .delete(self.url("/assets"))
            .header("x-api-key", &self.api_key)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Delete request failed: {e}"))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("Delete returned {status}: {text}"));
        }
        Ok(())
    }
}
