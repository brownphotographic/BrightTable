pub mod models;

use crate::config::LibraryConfig;
use models::{
    ConnectionStatus, LibraryInfo, RawLibraryResponse, RawSearchAsset, RawSearchMetadataResponse,
    RawStackResponse, RawTimeBucket, RawTimeBucketAssets, ServerVersion, StackInfo, UserInfo,
    MIN_TESTED_SERVER_VERSION,
};

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

    async fn post_json<T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        body: &serde_json::Value,
    ) -> Result<T, String> {
        let resp = self
            .http
            .post(self.url(path))
            .header("x-api-key", &self.api_key)
            .header("Content-Type", "application/json")
            .json(body)
            .send()
            .await
            .map_err(|e| format!("Request to {path} failed: {e}"))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("{path} returned {status}: {text}"));
        }
        resp.json::<T>()
            .await
            .map_err(|e| format!("Could not parse response from {path}: {e}"))
    }

    pub async fn test_connection(&self) -> Result<ConnectionStatus, String> {
        let version: ServerVersion = self.get_json("/server/version", &[]).await?;
        let user: UserInfo = self.get_json("/users/me", &[]).await?;
        let (min_major, min_minor, min_patch) = MIN_TESTED_SERVER_VERSION;
        Ok(ConnectionStatus {
            ok: true,
            resolved_url: self.base_url.clone(),
            via: self.via.to_string(),
            server_version: version.display(),
            user_email: user.email,
            server_version_supported: version.is_at_least(min_major, min_minor, min_patch),
        })
    }

    pub async fn get_time_buckets(&self) -> Result<Vec<models::TimeBucketInfo>, String> {
        self.get_time_buckets_filtered(false).await
    }

    async fn get_time_buckets_filtered(&self, is_trashed: bool) -> Result<Vec<models::TimeBucketInfo>, String> {
        let raw: Vec<RawTimeBucket> = self
            .get_json(
                "/timeline/buckets",
                &[("isTrashed".into(), is_trashed.to_string())],
            )
            .await?;
        Ok(raw.into_iter().map(Into::into).collect())
    }

    /// The compact `/timeline/bucket` endpoint (columnar arrays) is fast but
    /// missing `originalFileName` and EXIF `rating` entirely. `/search/metadata`
    /// with `withExif:true` returns the full per-asset object instead, at the
    /// same "one call per visible month" granularity (confirmed against a real
    /// 295-asset month in a single page) - so this gets file type + ratings
    /// without reintroducing a request-per-thumbnail cost.
    ///
    /// There's no `isTrashed` filter here (unlike the timeline endpoints below) -
    /// checked against Immich's own OpenAPI spec, `/search/metadata`'s
    /// `MetadataSearchDto` has no such field at all, so a value here would be
    /// silently ignored by the server. Its default behavior already excludes
    /// trashed assets, which is what the main timeline wants anyway.
    pub async fn get_time_bucket_assets(
        &self,
        time_bucket: &str,
    ) -> Result<Vec<models::AssetSummary>, String> {
        let (taken_after, taken_before) = month_range(time_bucket)?;
        let mut body = serde_json::Map::new();
        body.insert("takenAfter".into(), serde_json::json!(taken_after));
        body.insert("takenBefore".into(), serde_json::json!(taken_before));
        body.insert("withExif".into(), serde_json::json!(true));
        body.insert("size".into(), serde_json::json!(1000));
        self.search_metadata_paginated(body).await
    }

    /// Trash listing can't use `/search/metadata` at all (see the note on
    /// `get_time_bucket_assets` above) - confirmed live against a real server,
    /// passing `isTrashed: true` there silently returned the *entire* library
    /// (tens of thousands of assets) instead of just the trash, since the field
    /// doesn't exist on that endpoint's DTO. `/timeline/buckets` and
    /// `/timeline/bucket` both take a real `isTrashed` query param per Immich's
    /// OpenAPI spec, so this pages through those instead - the columnar shape
    /// is missing `originalFileName`/rating/full EXIF, but the Trash view
    /// doesn't display any of that.
    pub async fn get_trashed_assets(&self) -> Result<Vec<models::AssetSummary>, String> {
        let buckets = self.get_time_buckets_filtered(true).await?;
        let mut all = Vec::new();
        for bucket in buckets {
            let raw: RawTimeBucketAssets = self
                .get_json(
                    "/timeline/bucket",
                    &[
                        ("timeBucket".into(), bucket.time_bucket),
                        ("isTrashed".into(), "true".into()),
                    ],
                )
                .await?;
            all.extend(raw.to_assets());
        }
        Ok(all)
    }

    /// Shared paging loop for `/search/metadata` - the timeline (date-bounded)
    /// and trash (unbounded) listings only differ in their filter fields.
    async fn search_metadata_paginated(
        &self,
        mut base_body: serde_json::Map<String, serde_json::Value>,
    ) -> Result<Vec<models::AssetSummary>, String> {
        let mut all = Vec::new();
        let mut page = 1u32;
        loop {
            base_body.insert("page".into(), serde_json::json!(page));
            let body = serde_json::Value::Object(base_body.clone());
            let resp: RawSearchMetadataResponse = self.post_json("/search/metadata", &body).await?;
            let got = resp.assets.items.len();
            all.extend(resp.assets.items);
            match resp.assets.next_page {
                Some(next) if got > 0 && page < 20 => {
                    page = next.parse().unwrap_or(page + 1);
                }
                _ => break,
            }
        }
        Ok(all.into_iter().map(Into::into).collect())
    }

    /// GET /view/folder/unique-paths - one entry per real filesystem directory
    /// that directly contains at least one (non-trashed, non-archived) asset,
    /// e.g. "upload/library/admin/2024/09". This is the actual server-side
    /// folder structure (Immich's own "Folders" view is built off the same
    /// call) - nothing to do with capture date. Requires the API key to have
    /// the `folder.read` permission.
    pub async fn get_unique_folder_paths(&self) -> Result<Vec<String>, String> {
        self.get_json("/view/folder/unique-paths", &[]).await
    }

    /// GET /view/folder?path=X - the assets whose originalPath's parent
    /// directory is exactly `path` (direct children only, not recursive
    /// descendants - matches how a real file browser navigates one folder at
    /// a time). Deserializes the same per-asset shape as `/search/metadata`
    /// (both are Immich's full `AssetResponseDto`; unknown fields are
    /// ignored by serde either way).
    pub async fn get_folder_assets(&self, path: &str) -> Result<Vec<models::AssetSummary>, String> {
        let raw: Vec<RawSearchAsset> = self
            .get_json("/view/folder", &[("path".into(), path.to_string())])
            .await?;
        Ok(raw.into_iter().map(Into::into).collect())
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

    /// `force: false` moves assets to Immich's trash (recoverable); `true`
    /// deletes them immediately and permanently.
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

    pub async fn restore_assets(&self, ids: &[String]) -> Result<(), String> {
        let body = serde_json::json!({ "ids": ids });
        let resp = self
            .http
            .post(self.url("/trash/restore/assets"))
            .header("x-api-key", &self.api_key)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Restore request failed: {e}"))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("Restore returned {status}: {text}"));
        }
        Ok(())
    }

    pub async fn empty_trash(&self) -> Result<(), String> {
        let resp = self
            .http
            .post(self.url("/trash/empty"))
            .header("x-api-key", &self.api_key)
            .send()
            .await
            .map_err(|e| format!("Empty trash request failed: {e}"))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("Empty trash returned {status}: {text}"));
        }
        Ok(())
    }

    /// POST /assets/jobs {name: "refresh-metadata"} - best-effort nudge after
    /// ImmAture has written a rating/description straight into an asset's
    /// `.xmp` sidecar (see `xmp::patch_or_create`), so Immich re-reads the
    /// file and its own `exifInfo`/UI catch up promptly instead of waiting on
    /// Immich's own periodic sidecar-scan queue. Callers treat failure here
    /// as non-fatal - it only affects how soon Immich's own view reflects an
    /// edit that has already durably landed on disk either way.
    pub async fn refresh_metadata(&self, id: &str) -> Result<(), String> {
        let body = serde_json::json!({ "assetIds": [id], "name": "refresh-metadata" });
        let resp = self
            .http
            .post(self.url("/assets/jobs"))
            .header("x-api-key", &self.api_key)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Refresh-metadata request failed: {e}"))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("Refresh-metadata returned {status}: {text}"));
        }
        Ok(())
    }

    /// POST /assets/jobs {name: "regenerate-thumbnail"} - best-effort nudge
    /// after a round-trip export lands (`roundTrip.ts`'s `ingestRoundTripExport`).
    /// Confirmed live: an asset discovered via `scan_library` above (as every
    /// round-trip export is) doesn't reliably get Immich's own
    /// `thumbnailGeneration` job auto-queued the way a normal upload does -
    /// `thumbhash` stays `null` and its `/thumbnail` endpoint 404s
    /// indefinitely (no backlog, nothing queued - not just slow) until
    /// something else happens to trigger it. `refresh_metadata` above does
    /// *not* fix this on its own (confirmed live) - thumbnail generation
    /// needs its own explicit job. Callers treat failure here as non-fatal,
    /// same reasoning as `refresh_metadata`: the export already durably
    /// landed on disk and in Immich's DB either way.
    pub async fn regenerate_thumbnail(&self, id: &str) -> Result<(), String> {
        let body = serde_json::json!({ "assetIds": [id], "name": "regenerate-thumbnail" });
        let resp = self
            .http
            .post(self.url("/assets/jobs"))
            .header("x-api-key", &self.api_key)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Regenerate-thumbnail request failed: {e}"))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("Regenerate-thumbnail returned {status}: {text}"));
        }
        Ok(())
    }

    /// PUT /assets/{id} - only the fields actually passed as `Some` are sent,
    /// so this never clobbers fields the caller didn't mean to touch.
    pub async fn update_asset(
        &self,
        id: &str,
        rating: Option<i32>,
        is_favorite: Option<bool>,
        description: Option<&str>,
        date_time_original: Option<&str>,
    ) -> Result<(), String> {
        let mut body = serde_json::Map::new();
        if let Some(r) = rating {
            body.insert("rating".into(), serde_json::json!(r));
        }
        if let Some(f) = is_favorite {
            body.insert("isFavorite".into(), serde_json::json!(f));
        }
        if let Some(d) = description {
            body.insert("description".into(), serde_json::json!(d));
        }
        if let Some(dt) = date_time_original {
            body.insert("dateTimeOriginal".into(), serde_json::json!(dt));
        }
        if body.is_empty() {
            return Ok(());
        }
        let resp = self
            .http
            .put(self.url(&format!("/assets/{id}")))
            .header("x-api-key", &self.api_key)
            .json(&serde_json::Value::Object(body))
            .send()
            .await
            .map_err(|e| format!("Update request failed: {e}"))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("Update returned {status}: {text}"));
        }
        Ok(())
    }

    /// POST /stacks - the first id in `asset_ids` becomes the stack's primary
    /// (pick); this is Immich's own semantics, not something we choose
    /// separately, so callers must put the intended pick first.
    pub async fn create_stack(&self, asset_ids: &[String]) -> Result<StackInfo, String> {
        let body = serde_json::json!({ "assetIds": asset_ids });
        let raw: RawStackResponse = self.post_json("/stacks", &body).await?;
        Ok(raw.into())
    }

    pub async fn get_stack(&self, stack_id: &str) -> Result<StackInfo, String> {
        let raw: RawStackResponse = self.get_json(&format!("/stacks/{stack_id}"), &[]).await?;
        Ok(raw.into())
    }

    /// GET /stacks - every stack in the whole library, unscoped by date/bucket.
    /// Needed because this server version doesn't populate the `stack` field
    /// on `/search/metadata`/`/timeline/bucket` at all (confirmed live against
    /// a real Immich 2.7.5 server - that inline data is a newer-server-only
    /// optimization), so stack membership has to be cross-referenced
    /// client-side from this instead of trusted off individual asset records.
    pub async fn list_stacks(&self) -> Result<Vec<StackInfo>, String> {
        let raw: Vec<RawStackResponse> = self.get_json("/stacks", &[]).await?;
        Ok(raw.into_iter().map(Into::into).collect())
    }

    /// PUT /stacks/{id} - changes which member is the pick. Deprecated in
    /// Immich's spec but still the only endpoint that does this (its own
    /// history metadata points back at itself with no real replacement).
    pub async fn update_stack_primary(
        &self,
        stack_id: &str,
        primary_asset_id: &str,
    ) -> Result<(), String> {
        let body = serde_json::json!({ "primaryAssetId": primary_asset_id });
        let resp = self
            .http
            .put(self.url(&format!("/stacks/{stack_id}")))
            .header("x-api-key", &self.api_key)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Update stack request failed: {e}"))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("Update stack returned {status}: {text}"));
        }
        Ok(())
    }

    /// GET /libraries - used only by the import feature's library-id
    /// auto-match (`import::library_match::find_matching_library`), to
    /// identify which Immich External Library corresponds to the
    /// configured `immich_root` without asking the user to paste a library
    /// id manually.
    pub async fn get_libraries(&self) -> Result<Vec<LibraryInfo>, String> {
        let raw: Vec<RawLibraryResponse> = self.get_json("/libraries", &[]).await?;
        Ok(raw.into_iter().map(Into::into).collect())
    }

    /// POST /libraries/{id}/scan - queues Immich's own External Library
    /// scan job to discover files that exist on disk under that library's
    /// `importPaths` but that Immich has never seen before. Distinct from
    /// `refresh_metadata` above: that one only re-reads a file for an
    /// asset Immich *already knows about* - it does nothing for a
    /// genuinely new file, which is exactly what an import just created.
    pub async fn scan_library(&self, library_id: &str) -> Result<(), String> {
        let resp = self
            .http
            .post(self.url(&format!("/libraries/{library_id}/scan")))
            .header("x-api-key", &self.api_key)
            .send()
            .await
            .map_err(|e| format!("Library scan request failed: {e}"))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("Library scan returned {status}: {text}"));
        }
        Ok(())
    }

    /// DELETE /stacks/{id} - dissolves the whole stack; every member becomes
    /// an independent, ordinary asset again. There's no partial-removal call
    /// in this app (the real prototype's "Unstack" always dissolves entirely).
    pub async fn delete_stack(&self, stack_id: &str) -> Result<(), String> {
        let resp = self
            .http
            .delete(self.url(&format!("/stacks/{stack_id}")))
            .header("x-api-key", &self.api_key)
            .send()
            .await
            .map_err(|e| format!("Delete stack request failed: {e}"))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("Delete stack returned {status}: {text}"));
        }
        Ok(())
    }
}

fn days_in_month(year: i32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 {
                29
            } else {
                28
            }
        }
        _ => 31,
    }
}

/// `time_bucket` is a month key like "2026-06-01" - returns the ISO instant
/// range covering that whole calendar month for `/search/metadata`'s
/// takenAfter/takenBefore filters.
fn month_range(time_bucket: &str) -> Result<(String, String), String> {
    let parts: Vec<&str> = time_bucket.split('-').collect();
    if parts.len() < 2 {
        return Err(format!("Malformed time bucket: {time_bucket}"));
    }
    let year: i32 = parts[0]
        .parse()
        .map_err(|_| format!("Malformed year in time bucket: {time_bucket}"))?;
    let month: u32 = parts[1]
        .parse()
        .map_err(|_| format!("Malformed month in time bucket: {time_bucket}"))?;
    let days = days_in_month(year, month);
    Ok((
        format!("{year:04}-{month:02}-01T00:00:00.000Z"),
        format!("{year:04}-{month:02}-{days:02}T23:59:59.999Z"),
    ))
}
