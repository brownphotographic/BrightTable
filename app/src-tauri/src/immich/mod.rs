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

pub mod models;

use std::sync::Mutex;

use crate::config::{AutoResolution, ConnMode, LibraryConfig};
use models::{
    AlbumDetail, AlbumSummary, ConnectionStatus, LibraryInfo, PersonDetail, PersonSummary,
    RawAlbumResponse, RawBulkIdResponse, RawLibraryResponse, RawPeopleResponse,
    RawPersonResponse, RawPersonStatistics, RawSearchAsset, RawSearchMetadataResponse,
    RawStackResponse, RawTagResponse, RawTimeBucket, RawTimeBucketAssets, ServerVersion,
    StackInfo, TagDetail, TagSummary, UserInfo, MIN_TESTED_SERVER_VERSION,
};

pub struct ImmichClient {
    base_url: String,
    via: &'static str,
    api_key: String,
    http: reqwest::Client,
}

/// Applied per-request to every `get_json`/`post_json` call (metadata/search/
/// list endpoints, always small JSON payloads - not the separate thumbnail/
/// original byte-fetch methods, which can legitimately take much longer for
/// a large RAW/video and stay uncapped). Without this, a stuck connection
/// (e.g. the Tailscale/WireGuard tunnel wedged under a burst of concurrent
/// thumbnail fetches) hung forever instead of failing - so failed requests
/// piled up rather than freeing their connection/task for the next one, and
/// there was nothing to report back to the UI either.
const JSON_REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// `reqwest::Error`'s own `Display` only prints the outer "error sending
/// request for url (...)" wrapper, not *why* - the actual cause (timed out,
/// connection reset, DNS failure, TLS error, "too many open files") lives in
/// its `source()` chain and is silently dropped by `{e}`. Walking that chain
/// explicitly is the difference between the error banner saying just "error
/// sending request for url (...)" (as seen when this went unfixed) and
/// something a user can actually act on.
fn describe_reqwest_error(e: &reqwest::Error) -> String {
    let mut msg = e.to_string();
    let mut source = std::error::Error::source(e);
    while let Some(s) = source {
        msg.push_str(&format!(": {s}"));
        source = s.source();
    }
    msg
}

/// GET /server/ping is Immich's unauthenticated health-check endpoint - no
/// API key needed, so this can run before an `ImmichClient` even exists.
/// Short timeout since this only exists to disambiguate "on the LAN right
/// now" from "not" - a real request to a live LAN server answers in
/// milliseconds, so anything slower is treated as unreachable rather than
/// making every Auto-mode connection attempt wait out a long default.
async fn probe_lan(http: &reqwest::Client, lan_url: &str) -> bool {
    http.get(format!("{lan_url}/server/ping"))
        .timeout(std::time::Duration::from_millis(1200))
        .send()
        .await
        .map(|resp| resp.status().is_success())
        .unwrap_or(false)
}

/// Resolves `ConnMode::Auto` by actually checking whether the LAN endpoint
/// answers, instead of the old static heuristic ("prefer Tailscale if a URL
/// is configured for it at all") which broke as soon as Tailscale wasn't
/// actually reachable (e.g. tailscaled not running) even while sat on the
/// same LAN as the server. Non-Auto modes pass straight through to
/// `LibraryConfig::resolve_active_url`. `auto_cache` lets repeat calls in the
/// same session (a whole thumbnail grid's worth of requests) skip the probe -
/// see `AutoResolution`.
pub async fn resolve_connection(
    cfg: &LibraryConfig,
    http: &reqwest::Client,
    auto_cache: &Mutex<Option<AutoResolution>>,
) -> Result<(String, &'static str), String> {
    if cfg.conn_mode != ConnMode::Auto {
        return cfg.resolve_active_url();
    }

    let lan_url = cfg.lan_url.trim().trim_end_matches('/').to_string();
    let tailscale_url = cfg.tailscale_url.trim().trim_end_matches('/').to_string();
    if lan_url.is_empty() && tailscale_url.is_empty() {
        return Err("No server URL configured for the active connection mode".into());
    }

    {
        let cache = auto_cache.lock().unwrap();
        if let Some(cached) = cache.as_ref() {
            if cached.is_fresh_for(&lan_url, &tailscale_url) {
                return Ok((cached.resolved_url.clone(), cached.via));
            }
        }
    }

    let (resolved_url, via) = if !lan_url.is_empty() && probe_lan(http, &lan_url).await {
        (lan_url.clone(), "Auto → LAN")
    } else if !tailscale_url.is_empty() {
        (tailscale_url.clone(), "Auto → Tailscale")
    } else {
        (lan_url.clone(), "Auto → LAN")
    };

    *auto_cache.lock().unwrap() = Some(AutoResolution {
        lan_url,
        tailscale_url,
        resolved_url: resolved_url.clone(),
        via,
        resolved_at: std::time::Instant::now(),
    });

    Ok((resolved_url, via))
}

impl ImmichClient {
    /// `http` should be the app-wide shared client (see AppState::http) so
    /// requests reuse pooled/keep-alive connections instead of each paying a
    /// fresh TCP/TLS handshake - critical for a grid that fires one request
    /// per thumbnail. `auto_cache` is `AppState::auto_resolution` - see
    /// `resolve_connection`.
    pub async fn from_config(
        cfg: &LibraryConfig,
        http: reqwest::Client,
        auto_cache: &Mutex<Option<AutoResolution>>,
    ) -> Result<Self, String> {
        if cfg.api_key.trim().is_empty() {
            return Err("No API key configured".into());
        }
        let (base_url, via) = resolve_connection(cfg, &http, auto_cache).await?;
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
            .timeout(JSON_REQUEST_TIMEOUT)
            .send()
            .await
            .map_err(|e| format!("Request to {path} failed: {}", describe_reqwest_error(&e)))?;
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
            .timeout(JSON_REQUEST_TIMEOUT)
            .send()
            .await
            .map_err(|e| format!("Request to {path} failed: {}", describe_reqwest_error(&e)))?;
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
        self.search_paginated("/search/metadata", body, 20).await
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

    /// Shared paging loop for `/search/metadata` and `/search/smart` - both
    /// return the same `SearchResponseDto` envelope (`assets.items`/
    /// `assets.nextPage`), differing only in `path` and which filter fields
    /// the caller puts in `base_body` (date-bounded timeline/trash listings,
    /// an `albumIds`/`personIds`/`tagIds` filter, or `search_smart`'s free-
    /// text `query`). `max_pages` bounds worst-case round trips: a known-
    /// bounded collection listing (an album/person/tag's asset list) needs to
    /// come back complete, but `search_smart`'s free-text CLIP query passes a
    /// much smaller cap (see its own doc comment) - each page is a real
    /// server-side embedding search, not a cheap DB scan, so paging all the
    /// way to a generic large cap there means the UI waits out that many
    /// sequential ML round trips before showing a single result.
    async fn search_paginated(
        &self,
        path: &str,
        mut base_body: serde_json::Map<String, serde_json::Value>,
        max_pages: u32,
    ) -> Result<Vec<models::AssetSummary>, String> {
        let mut all = Vec::new();
        let mut page = 1u32;
        loop {
            base_body.insert("page".into(), serde_json::json!(page));
            let body = serde_json::Value::Object(base_body.clone());
            let resp: RawSearchMetadataResponse = self.post_json(path, &body).await?;
            let got = resp.assets.items.len();
            all.extend(resp.assets.items);
            match resp.assets.next_page {
                Some(next) if got > 0 && page < max_pages => {
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

    /// Downloads an asset's full original bytes (the untouched source file,
    /// RAW or otherwise) - unlike `get_thumbnail_bytes`, there's no `size`
    /// query param, since Immich just streams the file as stored. Used by
    /// `export_queue.rs` as the "Original" format's fallback source when no
    /// local path mapping resolves the asset (see `paths::resolve_local_path`),
    /// e.g. a library with no configured "Originals on Disk" mount at all.
    pub async fn get_original_bytes(&self, asset_id: &str) -> Result<(Vec<u8>, String), String> {
        let resp = self
            .http
            .get(self.url(&format!("/assets/{asset_id}/original")))
            .header("x-api-key", &self.api_key)
            .send()
            .await
            .map_err(|e| format!("Original download request failed: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("Original download request returned {}", resp.status()));
        }
        let content_type = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("application/octet-stream")
            .to_string();
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| format!("Could not read original bytes: {e}"))?;
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
    /// BrightTable has written a rating/description straight into an asset's
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

    /// GET /albums - every album owned by (or shared with) this account.
    /// Immich's `AlbumResponseDto` always includes a full `assets` array even
    /// here, but `AlbumSummary::from` only keeps `asset_count` - a listing
    /// page has no reason to ship every album's whole asset list to the
    /// frontend just to render a cover thumbnail + count.
    pub async fn list_albums(&self) -> Result<Vec<AlbumSummary>, String> {
        let raw: Vec<RawAlbumResponse> = self.get_json("/albums", &[]).await?;
        Ok(raw.iter().map(AlbumSummary::from).collect())
    }

    /// GET /albums/{id} for the album's own name/description/thumbnail, plus
    /// `POST /search/metadata` (`albumIds: [id]`, `withExif: true`) for its
    /// assets. Confirmed live against a real Immich 3.0.3 server: unlike
    /// what Immich's `AlbumResponseDto` schema implies, `GET /albums/{id}`'s
    /// `assets` field is simply absent from the response on this version -
    /// not just empty - even with `withoutAssets=false` explicitly passed.
    /// Same class of "documented field isn't actually populated on this
    /// server version" surprise as `/search/metadata`'s `stack` field (see
    /// `list_stacks`'s doc comment) - `/search/metadata`'s own `albumIds`
    /// filter is confirmed live to return the album's full, correct asset
    /// list (with real EXIF/rating) instead.
    pub async fn get_album(&self, album_id: &str) -> Result<AlbumDetail, String> {
        let raw: RawAlbumResponse = self.get_json(&format!("/albums/{album_id}"), &[]).await?;
        let mut body = serde_json::Map::new();
        body.insert("albumIds".into(), serde_json::json!([album_id]));
        body.insert("withExif".into(), serde_json::json!(true));
        body.insert("size".into(), serde_json::json!(1000));
        let assets = self.search_paginated("/search/metadata", body, 20).await?;
        Ok(AlbumDetail {
            id: raw.id,
            album_name: raw.album_name,
            description: raw.description,
            album_thumbnail_asset_id: raw.album_thumbnail_asset_id,
            assets,
        })
    }

    /// POST /albums - `asset_ids` may be empty (an album can be created with
    /// no assets yet, then populated via `add_assets_to_album`). The create
    /// response has the same missing-`assets`-field quirk as `GET
    /// /albums/{id}` (see `get_album`'s doc comment) - confirmed live, so
    /// this re-fetches via `get_album` rather than trusting `raw.assets`
    /// (always empty) whenever `asset_ids` was non-empty.
    pub async fn create_album(&self, name: &str, asset_ids: &[String]) -> Result<AlbumDetail, String> {
        let body = serde_json::json!({ "albumName": name, "assetIds": asset_ids });
        let raw: RawAlbumResponse = self.post_json("/albums", &body).await?;
        if asset_ids.is_empty() {
            return Ok(raw.into());
        }
        self.get_album(&raw.id).await
    }

    /// PATCH /albums/{id} - only renames; description/thumbnail/order aren't
    /// exposed anywhere in this app yet.
    pub async fn rename_album(&self, album_id: &str, name: &str) -> Result<(), String> {
        let body = serde_json::json!({ "albumName": name });
        let resp = self
            .http
            .patch(self.url(&format!("/albums/{album_id}")))
            .header("x-api-key", &self.api_key)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Rename album request failed: {e}"))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("Rename album returned {status}: {text}"));
        }
        Ok(())
    }

    /// DELETE /albums/{id} - deletes the album itself (not its assets, which
    /// stay in the library untouched).
    pub async fn delete_album(&self, album_id: &str) -> Result<(), String> {
        let resp = self
            .http
            .delete(self.url(&format!("/albums/{album_id}")))
            .header("x-api-key", &self.api_key)
            .send()
            .await
            .map_err(|e| format!("Delete album request failed: {e}"))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("Delete album returned {status}: {text}"));
        }
        Ok(())
    }

    /// PUT /albums/{id}/assets - adds assets to an existing album. Immich
    /// silently no-ops an id that's already a member (per-id `success: false`
    /// in the response body, not a request-level error), so the response
    /// itself isn't inspected here - same "fire and trust" treatment as
    /// `add_assets_to_album`'s sibling below.
    pub async fn add_assets_to_album(&self, album_id: &str, asset_ids: &[String]) -> Result<(), String> {
        let body = serde_json::json!({ "ids": asset_ids });
        let resp = self
            .http
            .put(self.url(&format!("/albums/{album_id}/assets")))
            .header("x-api-key", &self.api_key)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Add-to-album request failed: {e}"))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("Add-to-album returned {status}: {text}"));
        }
        Ok(())
    }

    /// DELETE /albums/{id}/assets - removes assets from the album; the assets
    /// themselves are untouched (still in the library, just no longer a
    /// member of this album).
    pub async fn remove_assets_from_album(&self, album_id: &str, asset_ids: &[String]) -> Result<(), String> {
        let body = serde_json::json!({ "ids": asset_ids });
        let resp = self
            .http
            .delete(self.url(&format!("/albums/{album_id}/assets")))
            .header("x-api-key", &self.api_key)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Remove-from-album request failed: {e}"))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("Remove-from-album returned {status}: {text}"));
        }
        Ok(())
    }

    /// GET /people/{id}/statistics - best-effort per-person photo count used
    /// by `list_people` to sort "most photos first"; a failed call for one
    /// person defaults that person's count to 0 rather than failing the
    /// whole list, same non-fatal treatment as `refresh_metadata`/
    /// `regenerate_thumbnail` elsewhere in this file.
    async fn get_person_statistics(&self, person_id: &str) -> Result<i64, String> {
        let raw: RawPersonStatistics = self
            .get_json(&format!("/people/{person_id}/statistics"), &[])
            .await?;
        Ok(raw.assets)
    }

    /// GET /people?withHidden=false - Immich's `PersonResponseDto` carries no
    /// asset count of its own, so this fans out one `/statistics` call per
    /// person to sort the result "most photos first", tie-broken by name
    /// with unnamed people pushed last. A large library can have hundreds or
    /// thousands of detected people, so the fan-out is capped at
    /// `PEOPLE_STATS_CONCURRENCY` in flight at a time (in submission order,
    /// via `buffered` not `buffer_unordered`, since the results below are
    /// zipped positionally with `raw.people`) rather than firing every
    /// request at once, which was exhausting the process's file descriptor
    /// limit ("Too many open files").
    pub async fn list_people(&self) -> Result<Vec<PersonSummary>, String> {
        use futures_util::StreamExt;
        const PEOPLE_STATS_CONCURRENCY: usize = 16;
        let raw: RawPeopleResponse = self
            .get_json("/people", &[("withHidden".into(), "false".into())])
            .await?;
        let stat_futures: Vec<_> = raw.people.iter().map(|p| self.get_person_statistics(&p.id)).collect();
        let stats = futures_util::stream::iter(stat_futures)
            .buffered(PEOPLE_STATS_CONCURRENCY)
            .collect::<Vec<_>>()
            .await;
        let mut people: Vec<PersonSummary> = raw
            .people
            .into_iter()
            .zip(stats)
            .map(|(p, stat)| PersonSummary {
                id: p.id,
                name: p.name,
                asset_count: stat.unwrap_or(0),
            })
            .collect();
        people.sort_by(|a, b| {
            b.asset_count.cmp(&a.asset_count).then_with(|| match (a.name.is_empty(), b.name.is_empty()) {
                (true, false) => std::cmp::Ordering::Greater,
                (false, true) => std::cmp::Ordering::Less,
                _ => a.name.cmp(&b.name),
            })
        });
        Ok(people)
    }

    /// GET /people/{id} for the name, plus `POST /search/metadata`
    /// (`personIds: [id]`, `withExif: true`) for the assets - same two-call
    /// shape as `get_album`.
    pub async fn get_person(&self, person_id: &str) -> Result<PersonDetail, String> {
        let raw: RawPersonResponse = self.get_json(&format!("/people/{person_id}"), &[]).await?;
        let mut body = serde_json::Map::new();
        body.insert("personIds".into(), serde_json::json!([person_id]));
        body.insert("withExif".into(), serde_json::json!(true));
        body.insert("size".into(), serde_json::json!(1000));
        let assets = self.search_paginated("/search/metadata", body, 20).await?;
        Ok(PersonDetail { id: raw.id, name: raw.name, assets })
    }

    /// PUT /people/{id} - only renames; birthDate/isHidden/isFavorite/
    /// featureFaceAssetId aren't exposed anywhere in this app.
    pub async fn rename_person(&self, person_id: &str, name: &str) -> Result<(), String> {
        let body = serde_json::json!({ "name": name });
        let resp = self
            .http
            .put(self.url(&format!("/people/{person_id}")))
            .header("x-api-key", &self.api_key)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Rename person request failed: {e}"))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("Rename person returned {status}: {text}"));
        }
        Ok(())
    }

    /// GET /people/{id}/thumbnail - the face-crop image Immich generated for
    /// this person; same shape as `get_thumbnail_bytes` but with no `size`
    /// query param (there's only one rendition of this one).
    pub async fn get_person_thumbnail_bytes(&self, person_id: &str) -> Result<(Vec<u8>, String), String> {
        let resp = self
            .http
            .get(self.url(&format!("/people/{person_id}/thumbnail")))
            .header("x-api-key", &self.api_key)
            .send()
            .await
            .map_err(|e| format!("Person thumbnail request failed: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("Person thumbnail request returned {}", resp.status()));
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
            .map_err(|e| format!("Could not read person thumbnail bytes: {e}"))?;
        Ok((bytes.to_vec(), content_type))
    }

    /// GET /tags - every tag owned by this account, as a bare array (unlike
    /// `/people`, there's no wrapper envelope). Sorted alphabetically by
    /// `value` (the flat display name) - Immich returns no guaranteed order
    /// of its own.
    pub async fn list_tags(&self) -> Result<Vec<TagSummary>, String> {
        let raw: Vec<RawTagResponse> = self.get_json("/tags", &[]).await?;
        let mut tags: Vec<TagSummary> = raw.into_iter().map(Into::into).collect();
        tags.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(tags)
    }

    /// GET /tags/{id} for the name/color, plus `POST /search/metadata`
    /// (`tagIds: [id]`, `withExif: true`) for the assets - same two-call
    /// shape as `get_album`/`get_person`.
    pub async fn get_tag(&self, tag_id: &str) -> Result<TagDetail, String> {
        let raw: RawTagResponse = self.get_json(&format!("/tags/{tag_id}"), &[]).await?;
        let mut body = serde_json::Map::new();
        body.insert("tagIds".into(), serde_json::json!([tag_id]));
        body.insert("withExif".into(), serde_json::json!(true));
        body.insert("size".into(), serde_json::json!(1000));
        let assets = self.search_paginated("/search/metadata", body, 20).await?;
        Ok(TagDetail { id: raw.id, name: raw.value, color: raw.color, assets })
    }

    /// POST /tags - `color` is only ever set here at creation time; Immich's
    /// `PUT /tags/{id}` (`updateTag`) accepts *only* `color`, not `name` -
    /// there's no rename-tag endpoint at all, so this app doesn't offer one.
    /// `parentId` is deliberately omitted - every tag BrightTable creates is
    /// top-level, matching the flat-list (no tree UI) decision.
    pub async fn create_tag(&self, name: &str, color: Option<&str>) -> Result<TagSummary, String> {
        let mut body = serde_json::Map::new();
        body.insert("name".into(), serde_json::json!(name));
        if let Some(c) = color {
            body.insert("color".into(), serde_json::json!(c));
        }
        let raw: RawTagResponse = self.post_json("/tags", &serde_json::Value::Object(body)).await?;
        Ok(raw.into())
    }

    /// DELETE /tags/{id} - deletes the tag itself; tagged assets are
    /// untouched (just no longer associated with this tag).
    pub async fn delete_tag(&self, tag_id: &str) -> Result<(), String> {
        let resp = self
            .http
            .delete(self.url(&format!("/tags/{tag_id}")))
            .header("x-api-key", &self.api_key)
            .send()
            .await
            .map_err(|e| format!("Delete tag request failed: {e}"))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("Delete tag returned {status}: {text}"));
        }
        Ok(())
    }

    /// PUT /tags/{id}/assets - adds assets to a tag. Same "fire and trust"
    /// treatment as `add_assets_to_album`: the response is a per-id
    /// `BulkIdResponseDto[]` (an id already tagged just comes back
    /// `success: false`, not a request-level error), not inspected here.
    pub async fn tag_assets(&self, tag_id: &str, asset_ids: &[String]) -> Result<(), String> {
        let body = serde_json::json!({ "ids": asset_ids });
        let resp = self
            .http
            .put(self.url(&format!("/tags/{tag_id}/assets")))
            .header("x-api-key", &self.api_key)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Tag-assets request failed: {e}"))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("Tag-assets returned {status}: {text}"));
        }
        check_bulk_id_results(resp, "Tag-assets").await
    }

    /// DELETE /tags/{id}/assets - removes assets from a tag; the assets
    /// themselves are untouched, same reasoning as `remove_assets_from_album`.
    pub async fn untag_assets(&self, tag_id: &str, asset_ids: &[String]) -> Result<(), String> {
        let body = serde_json::json!({ "ids": asset_ids });
        let resp = self
            .http
            .delete(self.url(&format!("/tags/{tag_id}/assets")))
            .header("x-api-key", &self.api_key)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Untag-assets request failed: {e}"))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("Untag-assets returned {status}: {text}"));
        }
        check_bulk_id_results(resp, "Untag-assets").await
    }

    /// POST /search/smart - Immich's natural-language "smart search" (CLIP
    /// embeddings), the same mechanism behind Immich's own web UI search
    /// box. Returns the same `SearchResponseDto` envelope as `/search/
    /// metadata` (confirmed against Immich's own `search.dto.ts`), so this
    /// reuses `search_paginated` - just a different path and a free-text
    /// `query` field instead of a structural filter. Capped at `size: 200`
    /// per page (vs. 1000 for a known-bounded album/person/tag asset list)
    /// since an open-ended text query against a large library could
    /// otherwise return an unbounded number of "relevant" results. Unlike
    /// those bounded listings, this also passes a much smaller *page* cap (3,
    /// vs. `search_paginated`'s general 20) - each page here is a real
    /// server-side CLIP embedding search, not a cheap DB scan, so waiting out
    /// 20 of them serially before the UI shows a single result made a broad
    /// query feel like it had hung. 3 pages (600 results, already ranked by
    /// relevance) is generous for a search box and cuts worst-case latency by
    /// nearly 7x.
    pub async fn search_smart(&self, query: &str) -> Result<Vec<models::AssetSummary>, String> {
        let mut body = serde_json::Map::new();
        body.insert("query".into(), serde_json::json!(query));
        body.insert("withExif".into(), serde_json::json!(true));
        body.insert("size".into(), serde_json::json!(200));
        self.search_paginated("/search/smart", body, 3).await
    }

    /// POST /search/metadata with an `originalFileName` filter - Smart
    /// Stack's Version mode uses this to look up RAW/JPEG siblings sharing
    /// a group's base name that the user didn't include in their selection
    /// (see SmartStackDialog's sibling-expansion effect). A cheap
    /// DB-indexed lookup, not a CLIP embedding search like search_smart, so
    /// a small page cap (1) is plenty - there are only ever a couple of
    /// files sharing one base name. `filename` is passed extension-less
    /// (the group's un-suffixed base name); results are re-filtered
    /// client-side against an exact base-name match (smartStack.ts's
    /// baseName()) regardless of whether the server does exact/prefix/
    /// substring matching on this field, since a loose server-side match
    /// (e.g. "IMG_100" also matching "IMG_1000") would otherwise merge
    /// unrelated files into the group.
    pub async fn search_by_filename(&self, filename: &str) -> Result<Vec<models::AssetSummary>, String> {
        let mut body = serde_json::Map::new();
        body.insert("originalFileName".into(), serde_json::json!(filename));
        body.insert("withExif".into(), serde_json::json!(true));
        body.insert("size".into(), serde_json::json!(50));
        self.search_paginated("/search/metadata", body, 1).await
    }

    /// GET /assets/{id} - a single asset's full detail. Confirmed against
    /// Immich's own server source (`asset.repository.ts`'s `withTags`
    /// helper) that `/search/metadata` and `/search/smart` do **not** join
    /// the `tags` relation at all - every `AssetSummary` obtained via
    /// `search_paginated` (timeline/album/person/tag/search results) always
    /// has an empty `tags` array regardless of what's actually assigned.
    /// `GET /assets/{id}` returns the same per-asset shape (`RawSearchAsset`
    /// deserializes it unchanged) but *does* include `tags` - so this is the
    /// only reliable way to learn an asset's tags, called on demand for
    /// whichever single asset the Metadata sidebar/Viewer Info panel is
    /// currently showing (see `MetadataRows.tsx`), not fetched in bulk for
    /// every asset in a grid.
    pub async fn get_asset(&self, asset_id: &str) -> Result<models::AssetSummary, String> {
        let raw: RawSearchAsset = self.get_json(&format!("/assets/{asset_id}"), &[]).await?;
        Ok(raw.into())
    }
}

/// Inspects a `BulkIdResponseDto[]` body (the response of `PUT`/`DELETE
/// /tags/{id}/assets`) for any per-id `success: false` entry - a bare 200
/// status on this endpoint does **not** mean every id actually applied, so
/// `tag_assets`/`untag_assets` call this instead of trusting the status code
/// alone (unlike `add_assets_to_album`'s deliberately looser "fire and
/// trust", where the only realistic per-id failure is an already-a-member
/// no-op, harmless to ignore - a bulk tag/untag failure is worth surfacing).
async fn check_bulk_id_results(resp: reqwest::Response, op: &str) -> Result<(), String> {
    let results: Vec<RawBulkIdResponse> = resp
        .json()
        .await
        .map_err(|e| format!("{op}: could not parse response: {e}"))?;
    let failures: Vec<String> = results
        .into_iter()
        .filter(|r| !r.success)
        .map(|r| {
            let reason = r.error_message.or(r.error).unwrap_or_else(|| "unknown reason".into());
            format!("{} ({reason})", r.id)
        })
        .collect();
    if failures.is_empty() {
        Ok(())
    } else {
        Err(format!("{op} failed for {} of the selected photo(s): {}", failures.len(), failures.join("; ")))
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
