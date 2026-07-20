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

/// Lowest Immich server version this app has been concretely, end-to-end
/// verified against (2026-07 - Trash, ratings/favorites, Filters, Folders,
/// and Stacks all confirmed live on 2.7.5 in the same session that added
/// this check). Not a hard technical requirement - the app doesn't refuse
/// to connect below it - just the honest boundary of what's actually been
/// tested, surfaced as a warning in Preferences -> Library rather than
/// silently leaving the user to wonder why something behaves oddly.
pub const MIN_TESTED_SERVER_VERSION: (u32, u32, u32) = (2, 7, 5);

impl ServerVersion {
    pub fn display(&self) -> String {
        format!("{}.{}.{}", self.major, self.minor, self.patch)
    }

    pub fn is_at_least(&self, major: u32, minor: u32, patch: u32) -> bool {
        (self.major, self.minor, self.patch) >= (major, minor, patch)
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
    pub server_version_supported: bool,
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

/// Columnar shape of `GET /timeline/bucket` (Immich's `TimeBucketAssetResponseDto`) -
/// unlike `/search/metadata`, this endpoint's `isTrashed` query param is real and
/// actually filters, which is what makes it usable for listing the trash. Only
/// the fields the Trash view actually renders are pulled in here; the rest of
/// this DTO (duration, latitude/longitude, stack, visibility, etc.) isn't needed.
#[derive(Debug, Clone, Deserialize)]
pub struct RawTimeBucketAssets {
    pub id: Vec<String>,
    #[serde(rename = "isFavorite")]
    pub is_favorite: Vec<bool>,
    #[serde(rename = "isImage")]
    pub is_image: Vec<bool>,
    #[serde(rename = "fileCreatedAt")]
    pub file_created_at: Vec<String>,
    pub thumbhash: Vec<Option<String>>,
    pub city: Vec<Option<String>>,
    pub country: Vec<Option<String>>,
}

impl RawTimeBucketAssets {
    /// The fields this columnar response doesn't carry (filename, extension,
    /// rating, full EXIF) are left `None`/empty - the Trash view never reads
    /// them, unlike the main grid's `/search/metadata`-backed asset list.
    pub fn to_assets(&self) -> Vec<AssetSummary> {
        (0..self.id.len())
            .map(|i| AssetSummary {
                id: self.id[i].clone(),
                file_name: String::new(),
                file_created_at: self.file_created_at[i].clone(),
                is_favorite: self.is_favorite[i],
                asset_type: if self.is_image[i] { "IMAGE".into() } else { "VIDEO".into() },
                thumb_hash: self.thumbhash[i].clone(),
                file_extension: String::new(),
                rating: None,
                city: self.city[i].clone(),
                country: self.country[i].clone(),
                make: None,
                model: None,
                lens_model: None,
                f_number: None,
                focal_length: None,
                iso: None,
                exposure_time: None,
                exif_image_width: None,
                exif_image_height: None,
                file_size_in_byte: None,
                description: None,
                stack: None,
                original_path: None,
            })
            .collect()
    }
}

/// `/search/metadata` (with `withExif:true`) returns full per-asset objects,
/// unlike the compact columnar `/timeline/bucket` shape - this is what gives us
/// `originalFileName` (file type badge) and `exifInfo.rating` (star rating),
/// neither of which the bucket endpoint exposes at all.
#[derive(Debug, Clone, Deserialize)]
pub struct RawExifInfo {
    #[serde(default)]
    pub rating: Option<i32>,
    #[serde(default)]
    pub city: Option<String>,
    #[serde(default)]
    pub country: Option<String>,
    #[serde(default)]
    pub make: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(rename = "lensModel", default)]
    pub lens_model: Option<String>,
    #[serde(rename = "fNumber", default)]
    pub f_number: Option<f64>,
    #[serde(rename = "focalLength", default)]
    pub focal_length: Option<f64>,
    #[serde(default)]
    pub iso: Option<i64>,
    #[serde(rename = "exposureTime", default)]
    pub exposure_time: Option<String>,
    #[serde(rename = "exifImageWidth", default)]
    pub exif_image_width: Option<u32>,
    #[serde(rename = "exifImageHeight", default)]
    pub exif_image_height: Option<u32>,
    #[serde(rename = "fileSizeInByte", default)]
    pub file_size_in_byte: Option<i64>,
    #[serde(default)]
    pub description: Option<String>,
}

/// Stack membership as returned inline on an asset by `/search/metadata`
/// (Immich's `AssetStackResponseDto`) - `primary_asset_id` is the id of
/// whichever member is currently the stack's pick, so a caller can tell
/// whether *this* asset is the pick by comparing it to its own `id`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetStackInfo {
    pub id: String,
    pub primary_asset_id: String,
    pub asset_count: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RawSearchAsset {
    pub id: String,
    #[serde(rename = "originalFileName")]
    pub original_file_name: String,
    #[serde(rename = "fileCreatedAt")]
    pub file_created_at: String,
    #[serde(rename = "isFavorite", default)]
    pub is_favorite: bool,
    #[serde(rename = "type")]
    pub asset_type: String,
    #[serde(default)]
    pub thumbhash: Option<String>,
    #[serde(rename = "exifInfo", default)]
    pub exif_info: Option<RawExifInfo>,
    #[serde(default)]
    pub stack: Option<AssetStackInfo>,
    #[serde(rename = "originalPath", default)]
    pub original_path: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RawSearchAssetsPage {
    pub items: Vec<RawSearchAsset>,
    #[serde(rename = "nextPage")]
    pub next_page: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RawSearchMetadataResponse {
    pub assets: RawSearchAssetsPage,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetSummary {
    pub id: String,
    pub file_name: String,
    pub file_created_at: String,
    pub is_favorite: bool,
    #[serde(rename = "type")]
    pub asset_type: String,
    pub thumb_hash: Option<String>,
    pub file_extension: String,
    pub rating: Option<i32>,
    pub city: Option<String>,
    pub country: Option<String>,
    pub make: Option<String>,
    pub model: Option<String>,
    pub lens_model: Option<String>,
    pub f_number: Option<f64>,
    pub focal_length: Option<f64>,
    pub iso: Option<i64>,
    pub exposure_time: Option<String>,
    pub exif_image_width: Option<u32>,
    pub exif_image_height: Option<u32>,
    pub file_size_in_byte: Option<i64>,
    pub description: Option<String>,
    pub stack: Option<AssetStackInfo>,
    /// Server-side path (real filesystem path for an External Library asset,
    /// or Immich's own internal upload-storage path otherwise) - used to
    /// resolve a real local file for RAW-editor sidecar read/write (see
    /// `paths::resolve_local_path`). Not populated for Trash view assets
    /// (`RawTimeBucketAssets::to_assets`), which is fine since sidecar
    /// sync/copy-paste don't apply there.
    pub original_path: Option<String>,
}

impl From<RawSearchAsset> for AssetSummary {
    fn from(r: RawSearchAsset) -> Self {
        let file_extension = r
            .original_file_name
            .rsplit_once('.')
            .map(|(_, ext)| ext.to_uppercase())
            .unwrap_or_default();
        let e = r.exif_info;
        Self {
            id: r.id,
            file_name: r.original_file_name,
            file_created_at: r.file_created_at,
            is_favorite: r.is_favorite,
            asset_type: r.asset_type,
            thumb_hash: r.thumbhash,
            file_extension,
            rating: e.as_ref().and_then(|e| e.rating),
            city: e.as_ref().and_then(|e| e.city.clone()),
            country: e.as_ref().and_then(|e| e.country.clone()),
            make: e.as_ref().and_then(|e| e.make.clone()),
            model: e.as_ref().and_then(|e| e.model.clone()),
            lens_model: e.as_ref().and_then(|e| e.lens_model.clone()),
            f_number: e.as_ref().and_then(|e| e.f_number),
            focal_length: e.as_ref().and_then(|e| e.focal_length),
            iso: e.as_ref().and_then(|e| e.iso),
            exposure_time: e.as_ref().and_then(|e| e.exposure_time.clone()),
            exif_image_width: e.as_ref().and_then(|e| e.exif_image_width),
            exif_image_height: e.as_ref().and_then(|e| e.exif_image_height),
            file_size_in_byte: e.as_ref().and_then(|e| e.file_size_in_byte),
            description: e.as_ref().and_then(|e| e.description.clone()),
            stack: r.stack,
            original_path: r.original_path,
        }
    }
}

/// `GET /stacks/{id}` (and the `201`/`200` bodies of create/update) - `assets`
/// reuses the same rich per-asset shape as `/search/metadata` rather than a
/// bare id list, so expanding a stack in the grid gets full asset data
/// (thumbnail, rating, favorite, etc.) in one request.
#[derive(Debug, Clone, Deserialize)]
pub struct RawStackResponse {
    pub id: String,
    #[serde(rename = "primaryAssetId")]
    pub primary_asset_id: String,
    pub assets: Vec<RawSearchAsset>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StackInfo {
    pub id: String,
    pub primary_asset_id: String,
    pub assets: Vec<AssetSummary>,
}

impl From<RawStackResponse> for StackInfo {
    fn from(r: RawStackResponse) -> Self {
        Self {
            id: r.id,
            primary_asset_id: r.primary_asset_id,
            assets: r.assets.into_iter().map(Into::into).collect(),
        }
    }
}

/// GET /libraries - only the fields the import feature's library-id
/// auto-match needs (`immich/mod.rs::find_matching_library`); Immich's
/// `LibraryResponseDto` has several more (name, ownerId, assetCount,
/// exclusionPatterns) not used here.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawLibraryResponse {
    pub id: String,
    pub import_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryInfo {
    pub id: String,
    pub import_paths: Vec<String>,
}

impl From<RawLibraryResponse> for LibraryInfo {
    fn from(r: RawLibraryResponse) -> Self {
        Self { id: r.id, import_paths: r.import_paths }
    }
}

/// `GET /albums` (list) and `GET /albums/{id}` (detail) both return Immich's
/// full `AlbumResponseDto` - `assets` is always present (even on the list
/// call), but `AlbumSummary::from` below only keeps `asset_count` for the
/// list view rather than carrying every album's full asset array over to the
/// frontend just to show a cover + count.
#[derive(Debug, Clone, Deserialize)]
pub struct RawAlbumResponse {
    pub id: String,
    #[serde(rename = "albumName")]
    pub album_name: String,
    #[serde(default)]
    pub description: String,
    #[serde(rename = "albumThumbnailAssetId", default)]
    pub album_thumbnail_asset_id: Option<String>,
    #[serde(rename = "assetCount", default)]
    pub asset_count: i64,
    #[serde(default)]
    pub assets: Vec<RawSearchAsset>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumSummary {
    pub id: String,
    pub album_name: String,
    pub description: String,
    pub album_thumbnail_asset_id: Option<String>,
    pub asset_count: i64,
}

impl From<&RawAlbumResponse> for AlbumSummary {
    fn from(r: &RawAlbumResponse) -> Self {
        Self {
            id: r.id.clone(),
            album_name: r.album_name.clone(),
            description: r.description.clone(),
            album_thumbnail_asset_id: r.album_thumbnail_asset_id.clone(),
            asset_count: r.asset_count,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumDetail {
    pub id: String,
    pub album_name: String,
    pub description: String,
    pub album_thumbnail_asset_id: Option<String>,
    pub assets: Vec<AssetSummary>,
}

impl From<RawAlbumResponse> for AlbumDetail {
    fn from(r: RawAlbumResponse) -> Self {
        Self {
            id: r.id,
            album_name: r.album_name,
            description: r.description,
            album_thumbnail_asset_id: r.album_thumbnail_asset_id,
            assets: r.assets.into_iter().map(Into::into).collect(),
        }
    }
}
