use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
pub struct UserInfo {
    pub email: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ServerVersion {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
}

impl ServerVersion {
    pub fn display(&self) -> String {
        format!("{}.{}.{}", self.major, self.minor, self.patch)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionStatus {
    pub ok: bool,
    pub resolved_url: String,
    pub via: String,
    pub server_version: String,
    pub user_email: String,
}

/// Response shape for GET /timeline/buckets. Immich has used slightly different
/// field names across versions (timeBucket vs timeBucketDate) - both are accepted
/// here and normalized to `time_bucket` for the frontend.
#[derive(Debug, Clone, Deserialize)]
pub struct RawTimeBucket {
    #[serde(rename = "timeBucket", alias = "timeBucketDate")]
    pub time_bucket: String,
    pub count: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeBucketInfo {
    pub time_bucket: String,
    pub count: u32,
}

impl From<RawTimeBucket> for TimeBucketInfo {
    fn from(r: RawTimeBucket) -> Self {
        Self {
            time_bucket: r.time_bucket,
            count: r.count,
        }
    }
}

/// GET /timeline/bucket does NOT return an array of asset objects. Recent Immich
/// versions return a single object of parallel arrays (one entry per asset, same
/// index across every field) - a compact/columnar encoding. There is no
/// `originalFileName` in this shape at all; `isImage` stands in for asset type.
#[derive(Debug, Clone, Deserialize)]
pub struct RawBucketAssets {
    pub id: Vec<String>,
    #[serde(rename = "fileCreatedAt")]
    pub file_created_at: Vec<String>,
    #[serde(rename = "isFavorite", default)]
    pub is_favorite: Vec<bool>,
    #[serde(rename = "isImage", default)]
    pub is_image: Vec<bool>,
    #[serde(default)]
    pub thumbhash: Vec<Option<String>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetSummary {
    pub id: String,
    pub file_created_at: String,
    pub is_favorite: bool,
    #[serde(rename = "type")]
    pub asset_type: String,
    pub thumb_hash: Option<String>,
}

impl RawBucketAssets {
    pub fn into_summaries(self) -> Vec<AssetSummary> {
        let n = self.id.len();
        (0..n)
            .map(|i| AssetSummary {
                id: self.id[i].clone(),
                file_created_at: self.file_created_at.get(i).cloned().unwrap_or_default(),
                is_favorite: self.is_favorite.get(i).copied().unwrap_or(false),
                asset_type: if self.is_image.get(i).copied().unwrap_or(true) {
                    "IMAGE".to_string()
                } else {
                    "VIDEO".to_string()
                },
                thumb_hash: self.thumbhash.get(i).cloned().flatten(),
            })
            .collect()
    }
}
