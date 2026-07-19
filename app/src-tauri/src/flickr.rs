//! Flickr OAuth 1.0a client (request/access token exchange, album list/
//! create, and the multipart upload endpoint) - see `export_queue.rs` for
//! where this gets called from, and `commands.rs`'s `flickr_*` commands for
//! the OAuth handshake exposed to the frontend's `FlickrSetupDialog`.
//!
//! Flickr still uses OAuth **1.0a** (three-legged, out-of-band verifier
//! code), not OAuth2 - there's no well-maintained OAuth1/Flickr crate in the
//! Rust ecosystem to lean on, so request signing (HMAC-SHA1 over a sorted,
//! percent-encoded parameter string) is hand-rolled here rather than pulled
//! in as a dependency.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha1::Sha1;

use crate::config::FlickrConfig;

type HmacSha1 = Hmac<Sha1>;

const REQUEST_TOKEN_URL: &str = "https://www.flickr.com/services/oauth/request_token";
const AUTHORIZE_URL: &str = "https://www.flickr.com/services/oauth/authorize";
const ACCESS_TOKEN_URL: &str = "https://www.flickr.com/services/oauth/access_token";
const REST_URL: &str = "https://api.flickr.com/services/rest/";
const UPLOAD_URL: &str = "https://up.flickr.com/services/upload/";

pub struct FlickrAuth {
    pub oauth_token: String,
    pub oauth_token_secret: String,
    pub user_nsid: String,
    pub username: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlickrAlbum {
    pub id: String,
    pub title: String,
    pub photo_count: u64,
}

/// Maps onto Flickr's `is_public`/`is_friend`/`is_family` upload flags.
/// `FriendsFamily` sets both `is_friend` and `is_family` - Flickr has no
/// single "friends and family" flag of its own, just the two independent
/// bits, and this app doesn't expose the friends-only/family-only split as
/// its own privacy choice (see `ExportToFlickrDialog.tsx`'s three-way
/// segmented control).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FlickrPrivacy {
    Public,
    FriendsFamily,
    Private,
}

impl FlickrPrivacy {
    fn flags(self) -> (&'static str, &'static str, &'static str) {
        match self {
            FlickrPrivacy::Public => ("1", "0", "0"),
            FlickrPrivacy::FriendsFamily => ("0", "1", "1"),
            FlickrPrivacy::Private => ("0", "0", "0"),
        }
    }
}

/// RFC 3986 unreserved characters only (`A-Za-z0-9-._~`) - stricter than
/// `url` crate's default path/query encoders, and OAuth 1.0a's spec requires
/// exactly this set for both the request URL and every parameter that goes
/// into a signature base string.
fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 3 <= bytes.len() => {
                match u8::from_str_radix(&s[i + 1..i + 3], 16) {
                    Ok(byte) => {
                        out.push(byte);
                        i += 3;
                    }
                    Err(_) => {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn parse_form_body(body: &str) -> BTreeMap<String, String> {
    body.split('&')
        .filter_map(|pair| {
            let mut it = pair.splitn(2, '=');
            let k = it.next()?;
            let v = it.next().unwrap_or("");
            Some((percent_decode(k), percent_decode(v)))
        })
        .collect()
}

static NONCE_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Only needs to be unique-per-request, not cryptographically random - a
/// wall-clock timestamp in nanoseconds combined with a process-wide counter
/// is enough, and avoids pulling in a `rand` dependency for this alone.
fn nonce() -> String {
    let t = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    let n = NONCE_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{t:x}{n:x}")
}

fn timestamp() -> String {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs().to_string()
}

fn oauth_base_params(api_key: &str, token: Option<&str>) -> BTreeMap<String, String> {
    let mut p = BTreeMap::new();
    p.insert("oauth_consumer_key".into(), api_key.into());
    p.insert("oauth_nonce".into(), nonce());
    p.insert("oauth_signature_method".into(), "HMAC-SHA1".into());
    p.insert("oauth_timestamp".into(), timestamp());
    p.insert("oauth_version".into(), "1.0".into());
    if let Some(t) = token {
        p.insert("oauth_token".into(), t.into());
    }
    p
}

/// Builds the OAuth 1.0a `oauth_signature` (HMAC-SHA1, base64) for one
/// request. `params` must be every parameter that will actually be sent
/// (form fields for a `form`-encoded POST, or the non-file fields of a
/// multipart upload - Flickr's own upload API spec is explicit that the
/// signature never covers the binary photo part).  A `BTreeMap` keeps keys
/// sorted, matching OAuth 1.0a's "sort by parameter name" requirement.
fn sign(method: &str, url: &str, params: &BTreeMap<String, String>, consumer_secret: &str, token_secret: &str) -> String {
    let param_string = params.iter().map(|(k, v)| format!("{}={}", percent_encode(k), percent_encode(v))).collect::<Vec<_>>().join("&");
    let base_string = format!("{}&{}&{}", method, percent_encode(url), percent_encode(&param_string));
    let signing_key = format!("{}&{}", percent_encode(consumer_secret), percent_encode(token_secret));
    let mut mac = HmacSha1::new_from_slice(signing_key.as_bytes()).expect("HMAC accepts a key of any length");
    mac.update(base_string.as_bytes());
    BASE64.encode(mac.finalize().into_bytes())
}

/// First leg of the three-legged flow - `oauth_callback=oob` (out-of-band)
/// since this is a desktop app with no redirect URI to receive a callback
/// on; the user instead pastes back a verifier code Flickr shows them after
/// authorizing (see `access_token` below).
pub async fn request_token(http: &reqwest::Client, api_key: &str, api_secret: &str) -> Result<(String, String), String> {
    let mut params = oauth_base_params(api_key, None);
    params.insert("oauth_callback".into(), "oob".into());
    let sig = sign("POST", REQUEST_TOKEN_URL, &params, api_secret, "");
    params.insert("oauth_signature".into(), sig);

    let resp = http.post(REQUEST_TOKEN_URL).form(&params).send().await.map_err(|e| format!("Flickr request_token failed: {e}"))?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| format!("Could not read Flickr response: {e}"))?;
    if !status.is_success() {
        return Err(format!("Flickr request_token returned {status}: {body}"));
    }
    let parsed = parse_form_body(&body);
    let token = parsed.get("oauth_token").cloned().ok_or_else(|| format!("Flickr request_token response missing oauth_token: {body}"))?;
    let secret = parsed
        .get("oauth_token_secret")
        .cloned()
        .ok_or_else(|| format!("Flickr request_token response missing oauth_token_secret: {body}"))?;
    Ok((token, secret))
}

/// The URL `FlickrSetupDialog` opens in the system browser (via the opener
/// plugin) for the user to approve write access. `perms=write` matches the
/// "Upload & replace photos (write)" scope shown in the wizard's permissions
/// box.
pub fn authorize_url(oauth_token: &str) -> String {
    format!("{AUTHORIZE_URL}?oauth_token={}&perms=write", percent_encode(oauth_token))
}

/// Final leg - exchanges the request token plus the verifier code the user
/// pasted back in for a real access token pair, which is what every
/// subsequent signed call (`list_albums`/`upload`/`create_album`/
/// `add_to_album`) authenticates with.
pub async fn access_token(
    http: &reqwest::Client,
    api_key: &str,
    api_secret: &str,
    oauth_token: &str,
    oauth_token_secret: &str,
    verifier: &str,
) -> Result<FlickrAuth, String> {
    let mut params = oauth_base_params(api_key, Some(oauth_token));
    params.insert("oauth_verifier".into(), verifier.into());
    let sig = sign("POST", ACCESS_TOKEN_URL, &params, api_secret, oauth_token_secret);
    params.insert("oauth_signature".into(), sig);

    let resp = http.post(ACCESS_TOKEN_URL).form(&params).send().await.map_err(|e| format!("Flickr access_token failed: {e}"))?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| format!("Could not read Flickr response: {e}"))?;
    if !status.is_success() {
        return Err(format!("Flickr access_token returned {status}: {body} — double-check the verification code"));
    }
    let parsed = parse_form_body(&body);
    let token = parsed.get("oauth_token").cloned().ok_or_else(|| format!("Flickr access_token response missing oauth_token: {body}"))?;
    let secret = parsed
        .get("oauth_token_secret")
        .cloned()
        .ok_or_else(|| format!("Flickr access_token response missing oauth_token_secret: {body}"))?;
    let user_nsid = parsed.get("user_nsid").cloned().unwrap_or_default();
    let username = parsed.get("username").cloned().unwrap_or_default();
    Ok(FlickrAuth { oauth_token: token, oauth_token_secret: secret, user_nsid, username })
}

async fn call_rest(http: &reqwest::Client, cfg: &FlickrConfig, method: &str, extra: &[(&str, &str)]) -> Result<serde_json::Value, String> {
    let mut params = oauth_base_params(&cfg.api_key, Some(&cfg.oauth_token));
    params.insert("method".into(), method.into());
    params.insert("format".into(), "json".into());
    params.insert("nojsoncallback".into(), "1".into());
    for (k, v) in extra {
        params.insert((*k).to_string(), (*v).to_string());
    }
    let sig = sign("POST", REST_URL, &params, &cfg.api_secret, &cfg.oauth_token_secret);
    params.insert("oauth_signature".into(), sig);

    let resp = http.post(REST_URL).form(&params).send().await.map_err(|e| format!("Flickr API request failed: {e}"))?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| format!("Could not read Flickr response: {e}"))?;
    if !status.is_success() {
        return Err(format!("Flickr API returned {status}: {body}"));
    }
    let json: serde_json::Value = serde_json::from_str(&body).map_err(|e| format!("Flickr API returned invalid JSON: {e} — {body}"))?;
    if json.get("stat").and_then(|s| s.as_str()) != Some("ok") {
        let msg = json.get("message").and_then(|m| m.as_str()).unwrap_or("unknown error");
        return Err(format!("Flickr API error: {msg}"));
    }
    Ok(json)
}

/// Powers the album dropdown in `ExportToFlickrDialog.tsx`.
pub async fn list_albums(http: &reqwest::Client, cfg: &FlickrConfig) -> Result<Vec<FlickrAlbum>, String> {
    let json = call_rest(http, cfg, "flickr.photosets.getList", &[]).await?;
    let sets = json.get("photosets").and_then(|p| p.get("photoset")).and_then(|p| p.as_array()).cloned().unwrap_or_default();
    Ok(sets
        .into_iter()
        .filter_map(|s| {
            let id = s.get("id")?.as_str()?.to_string();
            let title = s.get("title")?.get("_content")?.as_str()?.to_string();
            let photo_count = s.get("photos").and_then(|p| p.as_u64().or_else(|| p.as_str().and_then(|x| x.parse().ok()))).unwrap_or(0);
            Some(FlickrAlbum { id, title, photo_count })
        })
        .collect())
}

/// Flickr requires an existing photo id to create a photoset around, so a
/// "New album" export always uploads its first photo, then creates the
/// album from that photo's id, then adds the rest via `add_to_album` - see
/// `export_queue.rs`'s Flickr delivery step.
pub async fn create_album(http: &reqwest::Client, cfg: &FlickrConfig, title: &str, primary_photo_id: &str) -> Result<String, String> {
    let json = call_rest(http, cfg, "flickr.photosets.create", &[("title", title), ("primary_photo_id", primary_photo_id)]).await?;
    json.get("photoset").and_then(|p| p.get("id")).and_then(|id| id.as_str()).map(str::to_string).ok_or_else(|| "Flickr photosets.create response missing an id".to_string())
}

pub async fn add_to_album(http: &reqwest::Client, cfg: &FlickrConfig, album_id: &str, photo_id: &str) -> Result<(), String> {
    call_rest(http, cfg, "flickr.photosets.addPhoto", &[("photoset_id", album_id), ("photo_id", photo_id)]).await?;
    Ok(())
}

/// Uploads one photo's bytes. The signature (`sign`, above) only ever covers
/// the OAuth/API fields, never `bytes` itself - Flickr's multipart upload
/// endpoint expects those same fields sent again as ordinary multipart text
/// parts alongside the binary `photo` part, not as an `Authorization`
/// header.
pub async fn upload(http: &reqwest::Client, cfg: &FlickrConfig, bytes: Vec<u8>, filename: &str, mime: &str, title: &str, privacy: FlickrPrivacy) -> Result<String, String> {
    let (is_public, is_friend, is_family) = privacy.flags();
    let mut params = oauth_base_params(&cfg.api_key, Some(&cfg.oauth_token));
    params.insert("title".into(), title.into());
    params.insert("is_public".into(), is_public.into());
    params.insert("is_friend".into(), is_friend.into());
    params.insert("is_family".into(), is_family.into());
    let sig = sign("POST", UPLOAD_URL, &params, &cfg.api_secret, &cfg.oauth_token_secret);
    params.insert("oauth_signature".into(), sig);

    let mut form = reqwest::multipart::Form::new();
    for (k, v) in &params {
        form = form.text(k.clone(), v.clone());
    }
    let file_part = reqwest::multipart::Part::bytes(bytes).file_name(filename.to_string()).mime_str(mime).map_err(|e| format!("Could not build upload part: {e}"))?;
    form = form.part("photo", file_part);

    let resp = http.post(UPLOAD_URL).multipart(form).send().await.map_err(|e| format!("Flickr upload failed: {e}"))?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| format!("Could not read Flickr upload response: {e}"))?;
    if !status.is_success() {
        return Err(format!("Flickr upload returned {status}: {body}"));
    }
    parse_upload_response(&body)
}

/// Flickr's upload endpoint answers with a small fixed-shape XML document
/// (`<rsp stat="ok"><photoid>N</photoid></rsp>` or
/// `<rsp stat="fail"><err code="X" msg="Y"/></rsp>`) - simple enough to pull
/// apart with plain string search rather than pulling in an XML crate for
/// this one response shape.
fn parse_upload_response(body: &str) -> Result<String, String> {
    if let Some(start) = body.find("<photoid>") {
        let start = start + "<photoid>".len();
        if let Some(end) = body[start..].find("</photoid>") {
            return Ok(body[start..start + end].to_string());
        }
    }
    if let Some(start) = body.find("msg=\"") {
        let start = start + "msg=\"".len();
        if let Some(end) = body[start..].find('"') {
            return Err(format!("Flickr upload failed: {}", &body[start..start + end]));
        }
    }
    Err(format!("Unexpected Flickr upload response: {body}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_encode_leaves_unreserved_characters_alone() {
        assert_eq!(percent_encode("abcXYZ019-._~"), "abcXYZ019-._~");
    }

    #[test]
    fn percent_encode_escapes_everything_else() {
        assert_eq!(percent_encode("a b/c=d&e"), "a%20b%2Fc%3Dd%26e");
    }

    #[test]
    fn percent_decode_round_trips_percent_encode() {
        let original = "hello world/foo=bar&baz";
        assert_eq!(percent_decode(&percent_encode(original)), original);
    }

    #[test]
    fn percent_decode_treats_plus_as_space_like_form_encoding_does() {
        assert_eq!(percent_decode("a+b"), "a b");
    }

    #[test]
    fn parse_form_body_splits_and_decodes_pairs() {
        let parsed = parse_form_body("oauth_token=abc123&oauth_token_secret=xyz&username=Jane%20Doe");
        assert_eq!(parsed.get("oauth_token").map(String::as_str), Some("abc123"));
        assert_eq!(parsed.get("oauth_token_secret").map(String::as_str), Some("xyz"));
        assert_eq!(parsed.get("username").map(String::as_str), Some("Jane Doe"));
    }

    #[test]
    fn sign_is_deterministic_for_the_same_inputs() {
        let mut params = BTreeMap::new();
        params.insert("oauth_consumer_key".to_string(), "key".to_string());
        params.insert("oauth_nonce".to_string(), "fixed-nonce".to_string());
        params.insert("oauth_signature_method".to_string(), "HMAC-SHA1".to_string());
        params.insert("oauth_timestamp".to_string(), "1700000000".to_string());
        params.insert("oauth_version".to_string(), "1.0".to_string());
        let a = sign("POST", "https://example.com/x", &params, "secret", "");
        let b = sign("POST", "https://example.com/x", &params, "secret", "");
        assert_eq!(a, b);
        // A different consumer secret must produce a different signature.
        let c = sign("POST", "https://example.com/x", &params, "other-secret", "");
        assert_ne!(a, c);
    }

    #[test]
    fn flickr_privacy_flags_map_as_expected() {
        assert_eq!(FlickrPrivacy::Public.flags(), ("1", "0", "0"));
        assert_eq!(FlickrPrivacy::FriendsFamily.flags(), ("0", "1", "1"));
        assert_eq!(FlickrPrivacy::Private.flags(), ("0", "0", "0"));
    }

    #[test]
    fn parse_upload_response_extracts_photo_id_on_success() {
        let body = r#"<rsp stat="ok"><photoid>54321</photoid></rsp>"#;
        assert_eq!(parse_upload_response(body), Ok("54321".to_string()));
    }

    #[test]
    fn parse_upload_response_extracts_error_message_on_failure() {
        let body = r#"<rsp stat="fail"><err code="99" msg="Insufficient permissions"/></rsp>"#;
        let err = parse_upload_response(body).unwrap_err();
        assert!(err.contains("Insufficient permissions"), "{err}");
    }
}
