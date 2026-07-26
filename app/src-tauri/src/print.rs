//! Real OS printing for the Print dialog - enumerates installed printers
//! (name, connection, ready/disabled status, installed paper sizes, and
//! supported print resolutions) and submits an actual print job, shelling
//! out to CUPS's own CLI tools (`lpstat`/`lpoptions`/`lp`) rather than
//! depending on a Rust printing crate - no actively-maintained
//! cross-platform one exists, and CUPS's CLI output is a stable, documented
//! contract. Linux and macOS both run CUPS, so they share one
//! implementation; Windows has no CUPS and gets an explicit "not supported
//! yet" degradation instead of a half-built spooler integration - see
//! `list_printers`/`submit_print_job`'s `#[cfg(target_os = ...)]` split,
//! same shape as `reveal.rs`.
//!
//! Paper sizes are read from the printer's real PPD (`parse_ppd_paper_sizes`),
//! not guessed from the `PageSize` option's keyword text
//! (`paper_size_from_keyword`, kept only as a fallback for a PPD-less/
//! IPP-Everywhere printer). Confirmed live against a real driver
//! (TurboPrint's Epson SC-3880 PPD): third-party/vendor drivers routinely
//! name sizes with no dimension encoded in the keyword at all (`USB`, `USC`,
//! `A3+-USB+`, `Custom1000`) - `lpoptions -p <name> -l` only ever exposes the
//! keyword, not its physical size, so keyword-guessing silently drops every
//! one of those. The PPD's own `*PaperDimension`/`*ImageableArea` directives
//! carry the driver's authoritative width/height and printable margins for
//! every size it defines, keyword-guessing or not. `fetch_ppd` retrieves it
//! over `http://localhost:631/printers/<name>.ppd` - CUPS serves this to any
//! local client through the scheduler regardless of the `/etc/cups/ppd/*.ppd`
//! file's own root:lp-only filesystem permissions.
//!
//! RAW assets never reach this module in practice - Print is unavailable
//! for RAW photos entirely (no ART-cli conversion path, unlike Export to
//! Folder), gated in the frontend before the dialog even opens and
//! re-checked in `commands::print_asset` as defense in depth (same
//! frontend-trusts-`isRawAsset()` shape as `ExportAssetTarget::is_raw`).
//!
//! Enumeration/parsing is deliberately split into pure, unit-testable
//! functions (no process spawned) and the actual `tokio::process::Command`
//! spawn - same "isolate the untrusted external-output assumption" shape as
//! `exiftool.rs`.

use std::collections::HashMap;
use std::io;
use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// Bounds a single CUPS CLI invocation (`lpstat`/`lpoptions`/`lp`) - all of
/// these are near-instant local queries/spool submissions, not something
/// that waits for the physical print to finish, so this stays short, same
/// reasoning as `exiftool::EXIFTOOL_RUN_TIMEOUT`.
pub const PRINT_CLI_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PrinterStatus {
    Ready,
    Disabled,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperSize {
    pub id: String,
    pub name: String,
    pub width_in: f64,
    pub height_in: f64,
    /// Largest uniform margin guaranteed to stay within the driver's real
    /// printable area on every side - derived from the PPD's
    /// `*ImageableArea` (the smallest of the four real per-side margins, so
    /// this is conservative rather than assumed even when a printer's
    /// margins are asymmetric). Falls back to a flat guess (`0.25`) only for
    /// a size that came from keyword-guessing (`paper_size_from_keyword`)
    /// because no real PPD data was available at all.
    pub margin_in: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Printer {
    pub id: String,
    pub name: String,
    pub connection: String,
    pub is_default: bool,
    pub status: PrinterStatus,
    pub papers: Vec<PaperSize>,
    pub dpis: Vec<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PrintOrientation {
    Landscape,
    Portrait,
}

/// How the source image maps onto the requested printed-image-size rectangle
/// when its aspect ratio doesn't match that rectangle's. `Crop` (the
/// default, per the user's own printing preference) fills the rectangle
/// completely with no whitespace, center-cropping whichever source
/// dimension is relatively longer - `composite_for_print` crops the source
/// to the target aspect before resizing. `Fit` never crops - the frontend
/// keeps the rectangle aspect-locked to the source photo in this mode, so no
/// cropping is needed at all, and the whole image lands within the
/// printable area (possibly with white space on one axis if the paper's
/// aspect doesn't match the photo's).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FitMode {
    Crop,
    Fit,
}

/// One asset's worth of print target - mirrors `commands::ExportAssetTarget`,
/// including trusting the frontend's `isRawAsset()` for `is_raw` rather than
/// re-deriving it from `file_extension` alone (the frontend's per-asset
/// `isRawOverride` exception has no backend-visible equivalent - see that
/// struct's own doc comment). Print has no RAW path at all (unlike Export's
/// `Jpeg` format), so `is_raw: true` here is always rejected outright rather
/// than routed anywhere.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintAssetTarget {
    pub id: String,
    pub original_path: Option<String>,
    pub file_name: String,
    pub is_raw: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintOptions {
    pub printer_id: String,
    pub paper_id: String,
    pub copies: u32,
    pub dpi: u32,
    pub orientation: PrintOrientation,
    pub fit_mode: FitMode,
    /// Already orientation-adjusted by the frontend (mirrors the mockup's
    /// `printPaperWH()` - width/height swapped so `orientation` and these
    /// dimensions always agree).
    pub paper_width_in: f64,
    pub paper_height_in: f64,
    /// The "printed image size" fields - already fit/clamped client-side to
    /// the paper's printable area. Aspect-locked to the source photo when
    /// `fit_mode` is `Fit`; independently chosen (any aspect) when `Crop`,
    /// since `composite_for_print` crops the source to match in that mode.
    pub image_width_in: f64,
    pub image_height_in: f64,
}

// ── Paper-size keyword lookup ──────────────────────────────────────────────

/// Common CUPS `PageSize` keywords that don't already spell out inches in a
/// `Custom.*` form - covers the vast majority of real consumer/photo
/// printers. Anything not listed here (an unusual vendor keyword) is
/// silently dropped rather than guessed - same degrade-gracefully posture as
/// `apps.rs`'s `.desktop` parsing. Expand this list against whatever a real
/// printer's `lpoptions -l` actually reports during manual verification.
fn known_paper_sizes() -> &'static [(&'static str, &'static str, f64, f64)] {
    &[
        ("Letter", "Letter (8.5 × 11 in)", 8.5, 11.0),
        ("Legal", "Legal (8.5 × 14 in)", 8.5, 14.0),
        ("Tabloid", "Tabloid (11 × 17 in)", 11.0, 17.0),
        ("Executive", "Executive (7.25 × 10.5 in)", 7.25, 10.5),
        ("A3", "A3 (11.69 × 16.54 in)", 11.69, 16.54),
        ("A4", "A4 (8.27 × 11.69 in)", 8.27, 11.69),
        ("A5", "A5 (5.83 × 8.27 in)", 5.83, 8.27),
        ("A6", "A6 (4.13 × 5.83 in)", 4.13, 5.83),
        ("B5", "B5 (6.93 × 9.84 in)", 6.93, 9.84),
        ("4x6", "4 × 6 in", 4.0, 6.0),
        ("5x7", "5 × 7 in", 5.0, 7.0),
        ("8x10", "8 × 10 in", 8.0, 10.0),
        ("11x14", "11 × 14 in", 11.0, 14.0),
        ("12x18", "12 × 18 in", 12.0, 18.0),
        ("13x19", "13 × 19 in (Super B/A3+)", 13.0, 19.0),
        ("A3plus", "A3+ (13 × 19 in)", 13.0, 19.0),
    ]
}

/// Maps a CUPS `PageSize` keyword (e.g. `Letter`, `A4`, `Custom.13x19in`,
/// `Custom.329x483mm`) to a physical size - `None` for anything unrecognized,
/// dropped by the caller rather than guessed.
pub fn paper_size_from_keyword(keyword: &str) -> Option<PaperSize> {
    if let Some(rest) = keyword.strip_prefix("Custom.") {
        return parse_custom_paper(rest).map(|(w, h)| PaperSize {
            id: keyword.to_string(),
            name: format!("Custom {w:.2} × {h:.2} in"),
            width_in: w,
            height_in: h,
            margin_in: FALLBACK_MARGIN_IN,
        });
    }
    let key_lower = keyword.to_lowercase();
    known_paper_sizes().iter().find(|(k, ..)| k.to_lowercase() == key_lower).map(|(k, name, w, h)| PaperSize {
        id: k.to_string(),
        name: name.to_string(),
        width_in: *w,
        height_in: *h,
        margin_in: FALLBACK_MARGIN_IN,
    })
}

/// Assumed printable-area margin for a paper size that came from
/// keyword-guessing (`paper_size_from_keyword`) rather than a real PPD -
/// only reached when a printer's PPD couldn't be fetched/parsed at all
/// (see `list_printers`'s fallback). Matches this module's original flat
/// guess before real per-paper margins (`parse_ppd_paper_sizes`) existed.
const FALLBACK_MARGIN_IN: f64 = 0.25;

/// Parses the part after `Custom.` in a CUPS custom page-size keyword:
/// `WWxHHin` or `WWxHHmm` (millimeters converted to inches).
fn parse_custom_paper(rest: &str) -> Option<(f64, f64)> {
    let (dims, factor) = if let Some(d) = rest.strip_suffix("in") {
        (d, 1.0)
    } else if let Some(d) = rest.strip_suffix("mm") {
        (d, 1.0 / 25.4)
    } else {
        return None;
    };
    let mut parts = dims.split('x');
    let w: f64 = parts.next()?.parse().ok()?;
    let h: f64 = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((w * factor, h * factor))
}

/// Parses a `Resolution` option token like `1440dpi`/`600x600dpi` into a
/// single representative DPI number (the first axis - print resolution is
/// treated as isotropic throughout this dialog, matching the mockup).
pub fn dpi_from_token(tok: &str) -> Option<u32> {
    let tok = tok.strip_suffix("dpi")?;
    let first = tok.split('x').next()?;
    first.parse().ok()
}

// ── `lpstat`/`lpoptions` output parsing ────────────────────────────────────

/// Parses `lpstat -p` output: lines shaped
/// `printer <name> is idle.  enabled since ...` /
/// `printer <name> disabled since <date> - reason` /
/// `printer <name> is processing since ...`.
pub fn parse_lpstat_p(output: &str) -> Vec<(String, PrinterStatus)> {
    output
        .lines()
        .filter_map(|line| {
            let rest = line.strip_prefix("printer ")?;
            let (name, rest) = rest.split_once(' ')?;
            let status = if rest.contains("disabled") {
                PrinterStatus::Disabled
            } else if rest.contains("idle") || rest.contains("processing") || rest.contains("printing") {
                PrinterStatus::Ready
            } else {
                PrinterStatus::Unknown
            };
            Some((name.to_string(), status))
        })
        .collect()
}

/// Parses `lpstat -d` output: `system default destination: <name>`, or
/// `None` for `no system default destination`.
pub fn parse_lpstat_d(output: &str) -> Option<String> {
    output.lines().find_map(|line| line.trim().strip_prefix("system default destination:").map(|n| n.trim().to_string()))
}

/// Parses `lpstat -v` output: `device for <name>: <uri>`, mapped to a
/// friendly connection label via the URI scheme.
pub fn parse_lpstat_v(output: &str) -> HashMap<String, String> {
    output
        .lines()
        .filter_map(|line| {
            let rest = line.strip_prefix("device for ")?;
            let (name, uri) = rest.split_once(':')?;
            Some((name.trim().to_string(), connection_label_from_uri(uri.trim())))
        })
        .collect()
}

fn connection_label_from_uri(uri: &str) -> String {
    let scheme = uri.split(':').next().unwrap_or("");
    match scheme {
        "usb" => "USB",
        "ipp" | "ipps" | "http" | "https" => "Network",
        "dnssd" | "mdns" => "AirPrint",
        "socket" | "lpd" => "Network (raw)",
        _ => "Unknown",
    }
    .to_string()
}

/// Parses one printer's `lpoptions -p <name> -l` output: lines shaped
/// `Keyword/Human Label: choice1 *choice2 choice3` (a leading `*` marks the
/// driver's current default, not otherwise used here). Extracts the
/// `PageSize` line into paper sizes and the `Resolution` line into DPIs
/// (highest first, so index `0` is always "Highest quality" and the last is
/// "Draft / fast" - matching the mockup's `dpiOptions` note logic); any
/// keyword/token this doesn't recognize is silently dropped rather than
/// guessed at.
pub fn parse_lpoptions_l(output: &str) -> (Vec<PaperSize>, Vec<u32>) {
    let mut papers: Vec<PaperSize> = Vec::new();
    let mut dpis: Vec<u32> = Vec::new();
    for line in output.lines() {
        let Some((keyword, choices)) = line.split_once(':') else { continue };
        let keyword = keyword.split('/').next().unwrap_or("").trim();
        let tokens: Vec<&str> = choices.split_whitespace().map(|t| t.trim_start_matches('*')).collect();
        match keyword {
            "PageSize" => {
                for tok in tokens {
                    if let Some(p) = paper_size_from_keyword(tok) {
                        if !papers.iter().any(|existing| existing.id == p.id) {
                            papers.push(p);
                        }
                    }
                }
            }
            "Resolution" => {
                for tok in tokens {
                    if let Some(d) = dpi_from_token(tok) {
                        if !dpis.contains(&d) {
                            dpis.push(d);
                        }
                    }
                }
            }
            _ => {}
        }
    }
    dpis.sort_unstable_by(|a, b| b.cmp(a));
    (papers, dpis)
}

/// Builds the argv for one `lp` job submission - pure, unit-testable, no
/// process spawned (same split as `exiftool::build_exiftool_args`).
/// `-o print-scaling=none` disables the driver's own fit/scale behavior,
/// since `composite_for_print` already places the image at its exact
/// physical size on a page-sized canvas; `orientation-requested` (IPP `3` =
/// portrait, `4` = landscape) tells the driver to rotate that canvas onto
/// the physically-fed page rather than trusting the raster's own aspect
/// ratio to imply orientation.
pub fn build_lp_args(printer_id: &str, paper_id: &str, dpi: u32, copies: u32, orientation: PrintOrientation, path: &Path) -> Vec<String> {
    let orientation_requested = match orientation {
        PrintOrientation::Portrait => "3",
        PrintOrientation::Landscape => "4",
    };
    vec![
        "-d".to_string(),
        printer_id.to_string(),
        "-n".to_string(),
        copies.to_string(),
        "-o".to_string(),
        format!("media={paper_id}"),
        "-o".to_string(),
        format!("resolution={dpi}dpi"),
        "-o".to_string(),
        format!("orientation-requested={orientation_requested}"),
        "-o".to_string(),
        "print-scaling=none".to_string(),
        path.to_string_lossy().to_string(),
    ]
}

// ── PPD paper-size parsing ──────────────────────────────────────────────────

/// Parses every `*PaperDimension <keyword>[/<label>]: "<w_pt> <h_pt>"` line
/// out of a raw PPD - the driver's own authoritative physical size (in
/// PostScript points, 1/72in) for each `PageSize` choice it defines,
/// including opaque/vendor-specific keywords (`USB`, `Custom1000`, ...) that
/// `paper_size_from_keyword` has no hope of recognizing from the keyword
/// text alone. The label after `/` is optional per the PPD spec; falls back
/// to the keyword itself when absent.
fn parse_ppd_paper_dimensions(ppd: &str) -> Vec<(String, String, f64, f64)> {
    let mut out = Vec::new();
    for line in ppd.lines() {
        let Some(rest) = line.strip_prefix("*PaperDimension ") else { continue };
        let Some((key_label, value)) = rest.split_once(':') else { continue };
        let (keyword, label) = match key_label.split_once('/') {
            Some((k, l)) => (k.to_string(), l.to_string()),
            None => (key_label.to_string(), key_label.to_string()),
        };
        let mut nums = value.trim().trim_matches('"').split_whitespace();
        let Some(w) = nums.next().and_then(|s| s.parse::<f64>().ok()) else { continue };
        let Some(h) = nums.next().and_then(|s| s.parse::<f64>().ok()) else { continue };
        out.push((keyword, label, w, h));
    }
    out
}

/// Parses every `*ImageableArea <keyword>[/<label>]: "<x1> <y1> <x2> <y2>"`
/// line out of a raw PPD (points, lower-left origin) - the driver's real
/// printable rectangle for that `PageSize` choice, keyed by keyword (the
/// label, if any, is redundant with `parse_ppd_paper_dimensions`'s and isn't
/// needed again here).
fn parse_ppd_imageable_areas(ppd: &str) -> HashMap<String, (f64, f64, f64, f64)> {
    let mut out = HashMap::new();
    for line in ppd.lines() {
        let Some(rest) = line.strip_prefix("*ImageableArea ") else { continue };
        let Some((key_label, value)) = rest.split_once(':') else { continue };
        let keyword = key_label.split_once('/').map(|(k, _)| k).unwrap_or(key_label);
        let mut nums = value.trim().trim_matches('"').split_whitespace();
        let (Some(x1), Some(y1), Some(x2), Some(y2)) = (
            nums.next().and_then(|s| s.parse::<f64>().ok()),
            nums.next().and_then(|s| s.parse::<f64>().ok()),
            nums.next().and_then(|s| s.parse::<f64>().ok()),
            nums.next().and_then(|s| s.parse::<f64>().ok()),
        ) else {
            continue;
        };
        out.insert(keyword.to_string(), (x1, y1, x2, y2));
    }
    out
}

/// Combines the two into real `PaperSize`s - one per `*PaperDimension`
/// entry, with a conservative uniform margin derived from the matching
/// `*ImageableArea` (or `FALLBACK_MARGIN_IN` when a size has no imageable-area
/// entry of its own, which happens on some drivers/paper choices). This is
/// the real, always-complete replacement for keyword-guessing - see the
/// module doc comment for why the latter alone confirmed live to be
/// incomplete (only 4 of a real printer's ~30 defined sizes recognized).
pub fn parse_ppd_paper_sizes(ppd: &str) -> Vec<PaperSize> {
    let areas = parse_ppd_imageable_areas(ppd);
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for (keyword, label, w_pt, h_pt) in parse_ppd_paper_dimensions(ppd) {
        if !seen.insert(keyword.clone()) {
            continue;
        }
        let w_in = w_pt / 72.0;
        let h_in = h_pt / 72.0;
        let margin_in = areas
            .get(&keyword)
            .map(|&(x1, y1, x2, y2)| {
                let left = x1 / 72.0;
                let bottom = y1 / 72.0;
                let right = (w_pt - x2) / 72.0;
                let top = (h_pt - y2) / 72.0;
                left.min(bottom).min(right).min(top).max(0.0)
            })
            .unwrap_or(FALLBACK_MARGIN_IN);
        out.push(PaperSize { id: keyword, name: format!("{label} ({w_in:.2} × {h_in:.2} in)"), width_in: w_in, height_in: h_in, margin_in });
    }
    out
}

// ── Enumeration / submission (Linux + macOS via CUPS; Windows out of scope for v1) ──

#[cfg(any(target_os = "linux", target_os = "macos"))]
async fn run_cli(program: &str, args: &[&str]) -> Result<String, String> {
    let child = tokio::process::Command::new(program)
        .args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Couldn't run {program}: {e}"))?;
    let output = match tokio::time::timeout(PRINT_CLI_TIMEOUT, child.wait_with_output()).await {
        Ok(result) => result.map_err(|e| format!("Couldn't wait for {program}: {e}"))?,
        Err(_) => return Err(format!("Timed out after {}s running {program}", PRINT_CLI_TIMEOUT.as_secs())),
    };
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if !stderr.is_empty() {
            return Err(stderr);
        }
        return Err(format!("{program} exited with status {}", output.status));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Fetches a printer's real PPD from the local CUPS scheduler over HTTP -
/// `cupsd` serves this to any local client through the standard
/// `/printers/<name>.ppd` path regardless of the `/etc/cups/ppd/*.ppd`
/// file's own root:lp-only filesystem permissions (confirmed live: this
/// user's own session can't `cat` the file directly, but this HTTP fetch
/// works). `.ppd` is CUPS's real per-destination PPD copy (auto-generated
/// for driverless/IPP-Everywhere printers too), independent of whatever
/// print system a client-specific driver might also be using.
#[cfg(any(target_os = "linux", target_os = "macos"))]
async fn fetch_ppd(printer_id: &str) -> Result<String, String> {
    let client = reqwest::Client::builder().timeout(PRINT_CLI_TIMEOUT).build().map_err(|e| e.to_string())?;
    let url = format!("http://localhost:631/printers/{printer_id}.ppd");
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("CUPS returned {} fetching this printer's PPD", resp.status()));
    }
    resp.text().await.map_err(|e| e.to_string())
}

/// Real paper sizes for one printer: the PPD's own `*PaperDimension`/
/// `*ImageableArea` data when fetchable (every size the driver defines, with
/// correct dimensions and margins - see the module doc comment), falling
/// back to keyword-guessing only when the PPD couldn't be fetched or parsed
/// into anything at all (e.g. a driverless printer CUPS has no real PPD
/// file for).
#[cfg(any(target_os = "linux", target_os = "macos"))]
async fn printer_papers(name: &str, lpoptions_papers: Vec<PaperSize>) -> Vec<PaperSize> {
    match fetch_ppd(name).await {
        Ok(ppd) => {
            let parsed = parse_ppd_paper_sizes(&ppd);
            if parsed.is_empty() {
                lpoptions_papers
            } else {
                parsed
            }
        }
        Err(_) => lpoptions_papers,
    }
}

/// Enumerates real printers via CUPS. Degrades to an empty list on any
/// failure (CUPS not installed/running, no printers configured) rather than
/// erroring - same posture as `apps::detect_installed_apps`. A single
/// printer's own `lpoptions`/PPD-fetch failure only empties *that* printer's
/// papers/dpis, it doesn't drop the printer from the list.
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub async fn list_printers() -> Vec<Printer> {
    let Ok(p_out) = run_cli("lpstat", &["-p"]).await else { return Vec::new() };
    let statuses = parse_lpstat_p(&p_out);
    if statuses.is_empty() {
        return Vec::new();
    }
    let default_name = match run_cli("lpstat", &["-d"]).await {
        Ok(out) => parse_lpstat_d(&out),
        Err(_) => None,
    };
    let connections = match run_cli("lpstat", &["-v"]).await {
        Ok(out) => parse_lpstat_v(&out),
        Err(_) => HashMap::new(),
    };

    let mut printers = Vec::with_capacity(statuses.len());
    for (name, status) in statuses {
        let (lpoptions_papers, dpis) = match run_cli("lpoptions", &["-p", &name, "-l"]).await {
            Ok(out) => parse_lpoptions_l(&out),
            Err(_) => (Vec::new(), Vec::new()),
        };
        let papers = printer_papers(&name, lpoptions_papers).await;
        let connection = connections.get(&name).cloned().unwrap_or_else(|| "Unknown".to_string());
        let is_default = default_name.as_deref() == Some(name.as_str());
        printers.push(Printer { id: name.clone(), name, connection, is_default, status, papers, dpis });
    }
    printers
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
pub async fn submit_print_job(composited_path: &Path, options: &PrintOptions) -> Result<(), String> {
    let args = build_lp_args(&options.printer_id, &options.paper_id, options.dpi, options.copies, options.orientation, composited_path);
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_cli("lp", &arg_refs).await.map(|_| ())
}

#[cfg(target_os = "windows")]
pub async fn list_printers() -> Vec<Printer> {
    Vec::new()
}

#[cfg(target_os = "windows")]
pub async fn submit_print_job(_composited_path: &Path, _options: &PrintOptions) -> Result<(), String> {
    Err("Printing isn't supported on Windows yet".to_string())
}

// ── Compositing ─────────────────────────────────────────────────────────────

/// Center-crops `img` to exactly `target_aspect` (width/height), trimming
/// whichever dimension is relatively longer than the target - the source's
/// own aspect ratio is otherwise left alone (no distortion). A no-op (returns
/// `img` untouched) when the aspect already matches within floating-point
/// tolerance.
fn crop_to_aspect(img: image::DynamicImage, target_aspect: f64) -> image::DynamicImage {
    let (w, h) = (img.width(), img.height());
    let current_aspect = w as f64 / h as f64;
    if (current_aspect - target_aspect).abs() < 1e-6 {
        return img;
    }
    if current_aspect > target_aspect {
        // Relatively wider than the target - crop the left/right edges.
        let new_w = ((h as f64 * target_aspect).round() as u32).clamp(1, w);
        let x = (w - new_w) / 2;
        img.crop_imm(x, 0, new_w, h)
    } else {
        // Relatively taller than the target - crop the top/bottom edges.
        let new_h = ((w as f64 / target_aspect).round() as u32).clamp(1, h);
        let y = (h - new_h) / 2;
        img.crop_imm(0, y, w, new_h)
    }
}

/// Composites `source_bytes` (an already-decodable raster image) centered
/// onto a white `paper_width_in × paper_height_in` canvas at `dpi`, scaled to
/// exactly `image_width_in × image_height_in`. Returns encoded JPEG bytes
/// ready to hand to `lp` - precision comes from this pre-composite, not from
/// CUPS' own scale-to-fit options (`submit_print_job`'s `build_lp_args` call
/// passes `print-scaling=none` to disable the driver's own rescaling).
pub fn composite_for_print(
    source_bytes: &[u8],
    paper_width_in: f64,
    paper_height_in: f64,
    image_width_in: f64,
    image_height_in: f64,
    dpi: u32,
    fit_mode: FitMode,
) -> Result<Vec<u8>, String> {
    let img = image::load_from_memory(source_bytes).map_err(|e| format!("Could not decode source image: {e}"))?;

    let canvas_w = (paper_width_in * dpi as f64).round().max(1.0) as u32;
    let canvas_h = (paper_height_in * dpi as f64).round().max(1.0) as u32;
    let image_w = (image_width_in * dpi as f64).round().max(1.0) as u32;
    let image_h = (image_height_in * dpi as f64).round().max(1.0) as u32;

    // `Fit` never needs cropping - the frontend already keeps image_w/image_h
    // aspect-locked to the source photo in that mode, so a direct resize
    // can't distort or need to crop anything. `Crop` (the default) can be
    // asked for any target rectangle regardless of the source's own aspect
    // (e.g. a 2:3 photo onto a 5x7 sheet) - crop_to_aspect trims whichever
    // source dimension is relatively longer before the resize, so the final
    // image fills image_w x image_h with no whitespace, same as CSS
    // `object-fit: cover`.
    let img = match fit_mode {
        FitMode::Fit => img,
        FitMode::Crop => crop_to_aspect(img, image_w as f64 / image_h as f64),
    };
    let resized = img.resize_exact(image_w, image_h, image::imageops::FilterType::Lanczos3).to_rgb8();

    let mut canvas_buf = image::RgbImage::from_pixel(canvas_w, canvas_h, image::Rgb([255, 255, 255]));
    let x = ((canvas_w as i64 - image_w as i64) / 2).max(0);
    let y = ((canvas_h as i64 - image_h as i64) / 2).max(0);
    image::imageops::overlay(&mut canvas_buf, &resized, x, y);

    let canvas = image::DynamicImage::ImageRgb8(canvas_buf);
    let mut out = Vec::new();
    let mut cursor = io::Cursor::new(&mut out);
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, 95);
    canvas.write_with_encoder(encoder).map_err(|e| format!("Could not encode print JPEG: {e}"))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_lpstat_p_statuses() {
        let out = "printer Epson_SureColor_P700 is idle.  enabled since Mon 01 Jan 2026\nprinter Old_Printer disabled since Mon 01 Jan 2026 - unplugged\n";
        let parsed = parse_lpstat_p(out);
        assert_eq!(
            parsed,
            vec![("Epson_SureColor_P700".to_string(), PrinterStatus::Ready), ("Old_Printer".to_string(), PrinterStatus::Disabled),]
        );
    }

    #[test]
    fn parses_lpstat_d_default() {
        assert_eq!(parse_lpstat_d("system default destination: Epson_SureColor_P700\n"), Some("Epson_SureColor_P700".to_string()));
        assert_eq!(parse_lpstat_d("no system default destination\n"), None);
    }

    #[test]
    fn parses_lpstat_v_connections() {
        let out = "device for Epson_SureColor_P700: usb://EPSON/SC-P700\ndevice for Canon_PIXMA: ipp://192.168.1.5/ipp/print\n";
        let parsed = parse_lpstat_v(out);
        assert_eq!(parsed.get("Epson_SureColor_P700").map(String::as_str), Some("USB"));
        assert_eq!(parsed.get("Canon_PIXMA").map(String::as_str), Some("Network"));
    }

    #[test]
    fn parses_known_paper_keyword() {
        let p = paper_size_from_keyword("A4").unwrap();
        assert_eq!(p.id, "A4");
        assert!((p.width_in - 8.27).abs() < 0.01);
    }

    #[test]
    fn parses_custom_paper_keyword_inches() {
        let p = paper_size_from_keyword("Custom.13x19in").unwrap();
        assert!((p.width_in - 13.0).abs() < 0.001);
        assert!((p.height_in - 19.0).abs() < 0.001);
    }

    #[test]
    fn parses_custom_paper_keyword_millimeters() {
        let p = paper_size_from_keyword("Custom.210x297mm").unwrap();
        assert!((p.width_in - 8.267).abs() < 0.01);
        assert!((p.height_in - 11.69).abs() < 0.01);
    }

    #[test]
    fn drops_unrecognized_paper_keyword() {
        assert!(paper_size_from_keyword("SomeVendorSpecificThing").is_none());
    }

    #[test]
    fn parses_dpi_tokens() {
        assert_eq!(dpi_from_token("1440dpi"), Some(1440));
        assert_eq!(dpi_from_token("600x600dpi"), Some(600));
        assert_eq!(dpi_from_token("garbage"), None);
    }

    #[test]
    fn parses_lpoptions_output_highest_dpi_first() {
        let out = "PageSize/Media Size: *Letter A4 Custom.13x19in\nResolution/Resolution: 360dpi *720dpi 1440dpi\n";
        let (papers, dpis) = parse_lpoptions_l(out);
        assert_eq!(papers.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), vec!["Letter", "A4", "Custom.13x19in"]);
        assert_eq!(dpis, vec![1440, 720, 360]);
    }

    // Sampled verbatim from a real TurboPrint (Epson SC-3880) PPD fetched
    // live via fetch_ppd - confirms the fix for the reported bug (only 4 of
    // this printer's ~30 real sizes were recognized by keyword-guessing
    // alone, since TurboPrint names them USB/USC/A3+-USB+/Custom1000 etc.
    // with no dimension in the keyword text at all).
    const SAMPLE_PPD: &str = r#"
*PageSize Letter/US-Letter: "<</zedoPageSize(Letter)>>pop <</PageSize[612.0 792.0]/ImagingBBox null/cupsRowCount 1>>setpagedevice"
*PageSize USB/US B: "<</zedoPageSize(USB)>>pop <</PageSize[792.0 1224.0]/ImagingBBox null/cupsRowCount 9>>setpagedevice"
*PageSize Custom1000/9"x13": "<</zedoPageSize(Custom1000)>>pop <</PageSize[629.6 908.71]/ImagingBBox null/cupsRowCount 1000>>setpagedevice"
*PaperDimension Letter/US-Letter: "612.0 792.0"
*PaperDimension USB/US B: "792.0 1224.0"
*PaperDimension Custom1000/9"x13": "629.6 908.71"
*ImageableArea Letter/US-Letter: "8.64 8.64 603.36 783.36"
*ImageableArea USB/US B: "8.64 8.64 783.36 1215.36"
"#;

    #[test]
    fn parses_ppd_paper_dimensions_including_vendor_specific_keywords() {
        let dims = parse_ppd_paper_dimensions(SAMPLE_PPD);
        assert_eq!(dims.len(), 3);
        let usb = dims.iter().find(|(k, ..)| k == "USB").unwrap();
        assert_eq!(usb.1, "US B");
        assert!((usb.2 - 792.0).abs() < 0.01);
        assert!((usb.3 - 1224.0).abs() < 0.01);
    }

    #[test]
    fn parses_ppd_paper_sizes_recovers_vendor_specific_and_custom_keywords() {
        let papers = parse_ppd_paper_sizes(SAMPLE_PPD);
        let ids: Vec<&str> = papers.iter().map(|p| p.id.as_str()).collect();
        // These three keywords carry zero dimension info in their own text
        // (unlike "Letter"/"A4") - only real for real without reading the PPD.
        assert!(ids.contains(&"USB"));
        assert!(ids.contains(&"Custom1000"));

        let usb = papers.iter().find(|p| p.id == "USB").unwrap();
        assert!((usb.width_in - 11.0).abs() < 0.01); // 792pt / 72 = 11in
        assert!((usb.height_in - 17.0).abs() < 0.01); // 1224pt / 72 = 17in

        let custom = papers.iter().find(|p| p.id == "Custom1000").unwrap();
        assert!((custom.width_in - 629.6 / 72.0).abs() < 0.01);
        assert!(custom.name.contains("9\"x13\""));
    }

    #[test]
    fn parses_ppd_paper_sizes_derives_conservative_margin_from_imageable_area() {
        let papers = parse_ppd_paper_sizes(SAMPLE_PPD);
        let letter = papers.iter().find(|p| p.id == "Letter").unwrap();
        // ImageableArea "8.64 8.64 603.36 783.36" on a 612x792pt page: every
        // side works out to 8.64pt (=0.12in) margin.
        assert!((letter.margin_in - 8.64 / 72.0).abs() < 0.001);
    }

    #[test]
    fn parses_ppd_paper_sizes_falls_back_to_flat_margin_without_imageable_area() {
        let papers = parse_ppd_paper_sizes(SAMPLE_PPD);
        let custom = papers.iter().find(|p| p.id == "Custom1000").unwrap();
        assert_eq!(custom.margin_in, FALLBACK_MARGIN_IN);
    }

    #[test]
    fn builds_lp_args() {
        let args = build_lp_args("Epson_SureColor_P700", "A4", 720, 2, PrintOrientation::Landscape, Path::new("/tmp/print.jpg"));
        assert_eq!(
            args.iter().map(String::as_str).collect::<Vec<_>>(),
            vec![
                "-d",
                "Epson_SureColor_P700",
                "-n",
                "2",
                "-o",
                "media=A4",
                "-o",
                "resolution=720dpi",
                "-o",
                "orientation-requested=4",
                "-o",
                "print-scaling=none",
                "/tmp/print.jpg",
            ]
        );
    }

    #[test]
    fn composites_to_requested_canvas_size() {
        let img = image::RgbImage::from_pixel(10, 10, image::Rgb([255, 0, 0]));
        let mut src = Vec::new();
        let mut cursor = io::Cursor::new(&mut src);
        image::DynamicImage::ImageRgb8(img)
            .write_with_encoder(image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, 95))
            .unwrap();

        let out = composite_for_print(&src, 4.0, 6.0, 4.0, 6.0, 100, FitMode::Fit).unwrap();
        let decoded = image::load_from_memory(&out).unwrap();
        assert_eq!(decoded.width(), 400);
        assert_eq!(decoded.height(), 600);
    }

    fn encode_solid_jpeg(w: u32, h: u32) -> Vec<u8> {
        let img = image::RgbImage::from_pixel(w, h, image::Rgb([255, 0, 0]));
        let mut out = Vec::new();
        let mut cursor = io::Cursor::new(&mut out);
        image::DynamicImage::ImageRgb8(img)
            .write_with_encoder(image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, 95))
            .unwrap();
        out
    }

    #[test]
    fn crop_to_aspect_trims_a_relatively_wider_source() {
        // 300x100 (aspect 3.0) cropped to a 1.0 target -> 100x100, centered.
        let img = image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(300, 100, image::Rgb([0, 0, 0])));
        let cropped = crop_to_aspect(img, 1.0);
        assert_eq!(cropped.width(), 100);
        assert_eq!(cropped.height(), 100);
    }

    #[test]
    fn crop_to_aspect_trims_a_relatively_taller_source() {
        // 100x300 (aspect 0.333) cropped to a 1.0 target -> 100x100.
        let img = image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(100, 300, image::Rgb([0, 0, 0])));
        let cropped = crop_to_aspect(img, 1.0);
        assert_eq!(cropped.width(), 100);
        assert_eq!(cropped.height(), 100);
    }

    #[test]
    fn crop_to_aspect_is_a_noop_when_already_matching() {
        let img = image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(200, 100, image::Rgb([0, 0, 0])));
        let cropped = crop_to_aspect(img, 2.0);
        assert_eq!(cropped.width(), 200);
        assert_eq!(cropped.height(), 100);
    }

    #[test]
    fn composite_crop_mode_fills_a_mismatched_target_with_no_whitespace() {
        // A 2:3 (600x900) source printed at a 5:7 target - Crop mode must
        // still produce exactly the requested pixel size (the whole canvas
        // is the image, no letterboxing), unlike Fit mode which would only
        // reach that size on one axis.
        let src = encode_solid_jpeg(600, 900);
        let out = composite_for_print(&src, 5.0, 7.0, 5.0, 7.0, 100, FitMode::Crop).unwrap();
        let decoded = image::load_from_memory(&out).unwrap();
        assert_eq!(decoded.width(), 500);
        assert_eq!(decoded.height(), 700);
    }
}
