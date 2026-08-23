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

use image::ImageDecoder;
use serde::{Deserialize, Serialize};

#[cfg(any(target_os = "linux", target_os = "macos"))]
use crate::flatpak::host_command_tokio;

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
    /// How the printer is *reached* - derived from the CUPS device URI
    /// scheme (`connection_label_from_uri`). Distinct from `driver`: a
    /// `dnssd://`-discovered queue reads as "AirPrint" here regardless of
    /// whether a real third-party rasterizer is actually processing the
    /// job downstream - see `driver`'s own doc comment.
    pub connection: String,
    /// The PPD's own self-description of the driver actually rasterizing
    /// the job (`driver_name_from_ppd`) - e.g. `"Epson_StylusPro3880
    /// TurboPrint"` for a real vendor driver, versus `None` when no PPD
    /// was fetchable at all (a driverless/IPP-Everywhere queue still gets
    /// a CUPS-generated PPD with its own NickName, so `None` here really
    /// means "PPD fetch failed", not "no driver"). Confirmed live: this
    /// matters because `connection` alone can't tell you a queue's
    /// `dnssd://` discovery URI has nothing to do with whether TurboPrint
    /// (or any other real driver) sits in the actual rasterization path.
    pub driver: Option<String>,
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
    /// Not read backend-side anymore (`build_lp_args` stopped taking it,
    /// `wrap_jpeg_as_pdf` derives orientation itself from whether
    /// `paper_width_in > paper_height_in`) - kept only because the frontend
    /// still sends it as part of this JSON payload (it drives `paperWH()`
    /// client-side, before `paper_width_in`/`paper_height_in` are computed).
    #[allow(dead_code)]
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
///
/// `-o media={paper_id}` AND `-o PageSize={paper_id}` - both, not either.
/// This is the fix that actually mattered, found by reading `/var/log/
/// turboprint/print.log` for our own real (failing) jobs: TurboPrint's
/// filter (`pstoturboprint`) receives every CUPS job option as a `---
/// key=value` argument to `tpprint`, and every one of our jobs carried
/// `'---media=Letter'` (or whichever paper we'd actually asked for) *and*
/// `'---PageSize=Borderless4x6in'` - unconditionally, unchanged across every
/// paper we ever selected, exactly matching this PPD's `*DefaultPageSize`.
/// `media` and `PageSize` are two separate, overlapping CUPS job template
/// attributes (`media` the modern/universal one, `PageSize` the older
/// PPD-native option name); CUPS is supposed to translate one into the
/// other for a PPD-based printer, but evidently doesn't reliably do that for
/// this PPD's non-standard keywords (`Borderless5x7in` etc. aren't
/// PWG-standard media names) - so `PageSize` was silently defaulting to the
/// PPD's own default instead. `pstoturboprint` reads `PageSize`, not
/// `media`; the log even says so explicitly: `page size Borderless4x6in
/// overwritten by ---media=Borderless4x6in` after *every* job, regardless of
/// what we requested. That's the entire "shrunk to a corner, rest of the
/// page blank" bug from the start - the real print was always happening
/// onto a fixed 4x6in borderless page inside whatever larger sheet was
/// actually loaded, no matter what paper size, DPI, or file format
/// (JPEG/PDF, landscape/rotated-portrait) we sent. Setting `PageSize`
/// explicitly ourselves is what actually closes the gap; `media` is kept
/// alongside it since some other filter/printer might read that one
/// instead.
///
/// `-o print-scaling=none` disables the driver's own fit/scale behavior,
/// since `composite_for_print` already places the image at its exact
/// physical size on a page-sized canvas.
///
/// No `orientation-requested` here (deliberately, not an oversight): it used
/// to be passed (IPP `3`=portrait/`4`=landscape) on the theory that it'd
/// tell the driver to rotate a landscape-shaped canvas onto the physically
/// portrait-fed page. That turned out not to be the real bug (see above),
/// but it's still not brought back: `wrap_jpeg_as_pdf` never emits a
/// landscape-shaped `/MediaBox` in the first place (always portrait-native,
/// rotating the *content* itself for a landscape request - see that
/// function's doc comment), so there's nothing left for this option to
/// describe.
///
/// `resolution={dpi}dpi` and `ppi={dpi}` look redundant but historically
/// controlled two different things: `resolution` is a PPD `Resolution`
/// *choice* - how many dots-per-inch the printhead itself lays down, not how
/// big CUPS decides the page content prints. `ppi` was meant to be the
/// answer to that second question - the standard CUPS `imagetops`/
/// `imagetoraster` option for pixels-per-inch of a bare raster input. Kept
/// here as a harmless, standards-documented hint alongside `composite_for_
/// print`'s embedded JFIF `PixelDensity` and the PDF's own `/MediaBox` -
/// none of the three turned out to be the actual bug, but none of them
/// hurt either. `resolution` is still meaningful on its own (print
/// quality/halftoning), so it stays regardless.
pub fn build_lp_args(printer_id: &str, paper_id: &str, dpi: u32, copies: u32, path: &Path) -> Vec<String> {
    vec![
        "-d".to_string(),
        printer_id.to_string(),
        "-n".to_string(),
        copies.to_string(),
        "-o".to_string(),
        format!("media={paper_id}"),
        "-o".to_string(),
        format!("PageSize={paper_id}"),
        "-o".to_string(),
        format!("resolution={dpi}dpi"),
        "-o".to_string(),
        format!("ppi={dpi}"),
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
    let child = host_command_tokio(program)
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

/// Parses a PPD's own self-description of the driver actually in use -
/// `*NickName`, falling back to `*ShortNickName`/`*Manufacturer` when
/// absent - the signal that says "TurboPrint" for a real third-party
/// rasterizer, independent of `connection_label_from_uri`'s device-URI-scheme
/// guess (`dnssd://` reads as "AirPrint" whether or not a real vendor driver
/// is actually doing the rasterizing downstream - confirmed live on a
/// TurboPrint queue discovered over `dnssd://`, whose real PPD's `*NickName`
/// is `"Epson_StylusPro3880 TurboPrint"`).
fn driver_name_from_ppd(ppd: &str) -> Option<String> {
    for key in ["*NickName:", "*ShortNickName:", "*Manufacturer:"] {
        let found = ppd.lines().find_map(|line| {
            let value = line.trim_start().strip_prefix(key)?.trim().trim_matches('"').trim();
            if value.is_empty() {
                None
            } else {
                Some(value.to_string())
            }
        });
        if found.is_some() {
            return found;
        }
    }
    None
}

/// Real paper sizes and driver name for one printer, from a single PPD
/// fetch: paper sizes from the PPD's own `*PaperDimension`/`*ImageableArea`
/// data when fetchable (every size the driver defines, with correct
/// dimensions and margins - see the module doc comment), falling back to
/// keyword-guessing only when the PPD couldn't be fetched or parsed into
/// anything at all (e.g. a driverless printer CUPS has no real PPD file
/// for); driver name from `driver_name_from_ppd`, `None` when the PPD
/// couldn't be fetched at all.
#[cfg(any(target_os = "linux", target_os = "macos"))]
async fn printer_papers_and_driver(name: &str, lpoptions_papers: Vec<PaperSize>) -> (Vec<PaperSize>, Option<String>) {
    match fetch_ppd(name).await {
        Ok(ppd) => {
            let parsed = parse_ppd_paper_sizes(&ppd);
            let papers = if parsed.is_empty() { lpoptions_papers } else { parsed };
            (papers, driver_name_from_ppd(&ppd))
        }
        Err(_) => (lpoptions_papers, None),
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
        let (papers, driver) = printer_papers_and_driver(&name, lpoptions_papers).await;
        let connection = connections.get(&name).cloned().unwrap_or_else(|| "Unknown".to_string());
        let is_default = default_name.as_deref() == Some(name.as_str());
        printers.push(Printer { id: name.clone(), name, connection, driver, is_default, status, papers, dpis });
    }
    printers
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
pub async fn submit_print_job(composited_path: &Path, options: &PrintOptions) -> Result<(), String> {
    let args = build_lp_args(&options.printer_id, &options.paper_id, options.dpi, options.copies, composited_path);
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
/// exactly `image_width_in × image_height_in`, then wraps the result in a
/// minimal one-page PDF (`wrap_jpeg_as_pdf`) sized to that same physical
/// paper size - see that function's doc comment for why a bare JPEG isn't
/// enough. Returns PDF bytes ready to hand to `lp`; precision comes from
/// this pre-composite plus the PDF's own explicit page geometry, not from
/// CUPS' or the driver's own scale-to-fit behavior (`submit_print_job`'s
/// `build_lp_args` call still passes `print-scaling=none` as a second line
/// of defense, but the PDF's `/MediaBox` is what actually pins this down).
///
/// Two things a plain `image::load_from_memory` + `JpegEncoder::
/// new_with_quality` pipeline gets silently wrong that this guards against:
///
/// - EXIF orientation: `image::load_from_memory` never applies it, and
///   `source_bytes` here is the *true original* file (`fetch_true_original`),
///   not the orientation-corrected thumbnail the dialog's own preview `<img>`
///   shows. A photo with a non-1 `Orientation` tag (confirmed present in this
///   library, e.g. RAW-embedded previews) would get cropped/composited
///   against the wrong axes entirely - decoding via `ImageDecoder::
///   orientation()` + `DynamicImage::apply_orientation` (the pattern the
///   `image` crate's own docs recommend) fixes this at the source, before
///   any cropping/resizing happens.
/// - Physical scale: `JpegEncoder`'s default `PixelDensity` is `(1,1)
///   PixelAspectRatio` (confirmed via `exiftool`/`identify` on real encoder
///   output: `ResolutionUnit: None`), i.e. a bare JPEG here would carry no
///   absolute size at all. `set_pixel_density` fixes that for anything that
///   *does* read JFIF density - but confirmed live that this printer's own
///   driver doesn't reliably (see `wrap_jpeg_as_pdf`), which is the deeper
///   reason the PDF wrapping exists: the JPEG's density is kept as a cheap,
///   correct-in-isolation property of the intermediate image, not relied on
///   as the sole source of truth for physical size anymore.
pub fn composite_for_print(
    source_bytes: &[u8],
    paper_width_in: f64,
    paper_height_in: f64,
    image_width_in: f64,
    image_height_in: f64,
    dpi: u32,
    fit_mode: FitMode,
) -> Result<Vec<u8>, String> {
    let reader = image::ImageReader::new(io::Cursor::new(source_bytes))
        .with_guessed_format()
        .map_err(|e| format!("Could not detect source image format: {e}"))?;
    let mut decoder = reader.into_decoder().map_err(|e| format!("Could not decode source image: {e}"))?;
    let orientation = decoder.orientation().unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut img = image::DynamicImage::from_decoder(decoder).map_err(|e| format!("Could not decode source image: {e}"))?;
    img.apply_orientation(orientation);

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
    let mut jpeg = Vec::new();
    let mut cursor = io::Cursor::new(&mut jpeg);
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, 95);
    encoder.set_pixel_density(image::codecs::jpeg::PixelDensity::dpi(dpi.min(u16::MAX as u32) as u16));
    canvas.write_with_encoder(encoder).map_err(|e| format!("Could not encode print JPEG: {e}"))?;

    Ok(wrap_jpeg_as_pdf(&jpeg, paper_width_in, paper_height_in, canvas_w, canvas_h))
}

/// Wraps an already-composited, page-sized JPEG in a minimal one-page PDF
/// whose `/MediaBox` is the physical paper size in points and whose content
/// stream draws the image to fill that box exactly via a `cm` transform -
/// the standard, unambiguous way a print pipeline states physical size,
/// used instead of submitting the bare JPEG to `lp`.
///
/// The PDF wrapping itself turned out to be necessary, not just belt-and-
/// suspenders alongside `set_pixel_density`/`-o ppi=`: printed live against
/// this printer's real driver (TurboPrint's `pstoturboprint`, registered in
/// the PPD's own `*cupsFilter` as the actual final-stage rasterizer for this
/// queue - see `build_lp_args`'s doc comment), a bare full-bleed JPEG with
/// correct JFIF density still printed shrunk to roughly a third size and
/// pinned to one corner. Tracing the standard CUPS filter chain directly
/// with `cupsfilter --list-filters`/`-m application/vnd.cups-raster` showed
/// why: CUPS's own `imagetoraster`/`cfFilterImageToRaster` filter (the
/// fallback used for a bare raster image submission) computes its own
/// "natural size to fit the page" from the image's pixel dimensions - it
/// doesn't reliably defer to `-o ppi`/`-o print-scaling=none` the way the
/// older CUPS documentation describes.
///
/// But the PDF wrapping *alone* wasn't the whole fix either - confirmed live
/// (the shrink-and-corner-anchor symptom persisted unchanged after adding
/// it). The remaining culprit: `-o media={paper_id}` tells CUPS which PPD
/// `PageSize` to use, and a real-world PPD almost always declares that in
/// portrait-native terms (e.g. Letter's `*PaperDimension` is `612 792`,
/// width < height) - but the canvas this wraps was already pre-rotated into
/// *landscape* pixel shape upstream (the frontend's `printPaperWH()` swaps
/// width/height for landscape before this ever runs). Submitting a
/// landscape-shaped `/MediaBox` against a portrait-declared media is exactly
/// the kind of page-size/media mismatch that triggers a filter's own
/// "helpfully" auto-fit/rescale behavior - we'd already seen a raster filter
/// do this once (above), and evidently a PDF-consuming stage in this same
/// chain does something equivalent rather than trusting the mismatched
/// `/MediaBox` outright. `orientation-requested` exists to reconcile exactly
/// this kind of mismatch, and was already being passed - it didn't help
/// either.
///
/// The fix that actually removes the ambiguity: never submit a `/MediaBox`
/// shape that disagrees with the PPD's own declared (portrait-native) page
/// size at all. This always emits `/MediaBox` in portrait order (narrower
/// side first, matching how PPDs declare `*PaperDimension`) regardless of
/// `width_in`/`height_in`'s own order, and for a landscape-shaped canvas
/// (`width_in > height_in`), rotates the *content* itself 90° via the `cm`
/// matrix so it still exactly fills that portrait-shaped page - see the
/// worked-out corner mapping in the code below. With no shape disagreement
/// left anywhere in the submitted PDF, there's nothing left for any
/// downstream filter to "fix" by rescaling. `build_lp_args` correspondingly
/// stopped sending `orientation-requested` - it no longer has anything
/// meaningful to describe once orientation is baked into the page content.
///
/// Deliberately minimal rather than pulling in a PDF-writing crate: a
/// single-page, single-image PDF is a handful of objects, and the JPEG can
/// be embedded byte-for-byte as a `DCTDecode`-filtered stream - no
/// recompression, no dependency.
fn wrap_jpeg_as_pdf(jpeg: &[u8], width_in: f64, height_in: f64, width_px: u32, height_px: u32) -> Vec<u8> {
    const POINTS_PER_INCH: f64 = 72.0;
    let w_pt = width_in * POINTS_PER_INCH;
    let h_pt = height_in * POINTS_PER_INCH;

    // Portrait-native MediaBox always, matching how PPDs declare
    // *PaperDimension - never the (possibly landscape-swapped) w_pt/h_pt
    // order directly.
    let media_w_pt = w_pt.min(h_pt);
    let media_h_pt = w_pt.max(h_pt);

    // Landscape input (wider than tall): rotate the image 90° within the
    // portrait-shaped MediaBox instead of using a landscape-shaped page.
    // Derivation (PDF's `cm` is [a b c d e f]: x'=a·u+c·v+e, y'=b·u+d·v+f
    // for image-space (u,v) in the unit square): composing the already-
    // correct unrotated placement (unit square -> [0,w_pt]x[0,h_pt]) with a
    // 90°-clockwise physical-page rotation (landscape BL/BR/TR/TL corners ->
    // portrait TL/BL/TR... i.e. old-bottom-left ends up at new-top-left) and
    // simplifying gives exactly [0, -w_pt, h_pt, 0, 0, w_pt]. Confirmed by
    // rendering this construction (poppler's `pdftoppm`) on the numbered
    // calibration grid and checking each corner's number landed where a 90°
    // CW physical rotation predicts.
    let content = if w_pt > h_pt {
        format!("q 0 {:.3} {h_pt:.3} 0 0 {w_pt:.3} cm /Im0 Do Q", -w_pt)
    } else {
        format!("q {w_pt:.3} 0 0 {h_pt:.3} 0 0 cm /Im0 Do Q")
    }
    .into_bytes();

    let catalog = b"<< /Type /Catalog /Pages 2 0 R >>".to_vec();
    let pages = b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec();
    let page =
        format!("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {media_w_pt:.3} {media_h_pt:.3}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>")
            .into_bytes();
    let mut image_obj = format!(
        "<< /Type /XObject /Subtype /Image /Width {width_px} /Height {height_px} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length {} >>\nstream\n",
        jpeg.len()
    )
    .into_bytes();
    image_obj.extend_from_slice(jpeg);
    image_obj.extend_from_slice(b"\nendstream");
    let mut content_obj = format!("<< /Length {} >>\nstream\n", content.len()).into_bytes();
    content_obj.extend_from_slice(&content);
    content_obj.extend_from_slice(b"\nendstream");

    let objects: [&[u8]; 5] = [&catalog, &pages, &page, &image_obj, &content_obj];

    let mut out = Vec::new();
    out.extend_from_slice(b"%PDF-1.4\n");
    let mut offsets = [0usize; 5];
    for (i, body) in objects.iter().enumerate() {
        offsets[i] = out.len();
        out.extend_from_slice(format!("{} 0 obj\n", i + 1).as_bytes());
        out.extend_from_slice(body);
        out.extend_from_slice(b"\nendobj\n");
    }

    let xref_offset = out.len();
    out.extend_from_slice(format!("xref\n0 {}\n", objects.len() + 1).as_bytes());
    out.extend_from_slice(b"0000000000 65535 f \n");
    for offset in offsets {
        out.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
    }
    out.extend_from_slice(format!("trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF", objects.len() + 1).as_bytes());

    out
}

// ── Calibration test pattern ────────────────────────────────────────────────
//
// A synthetic "numbered grid" target for diagnosing print placement/scale
// bugs empirically rather than by guessing at CUPS/driver filter internals
// from the outside - print it with the exact same printer/paper/dpi/
// orientation/fit-mode options as a real photo and read the result with a
// ruler:
//   - a 1in grid (0.5in minor ticks) with each inch labeled from the
//     top-left corner, so any offset/scale error reads directly in inches
//   - a distinct color band flush with each of the four edges (red=top,
//     green=right, blue=bottom, magenta=left) - an asymmetric border shows
//     up as which color survives, no measuring required
//   - a crosshair at the exact geometric center
//   - the four corners numbered 1(TL)/2(TR)/3(BR)/4(BL) clockwise, so a
//     rotation or mirror shows up as which numbered corner lands where
//
// It's generated fresh with no EXIF data at all, so a bad result here
// isolates the fault to composite_for_print's own math or the CUPS/`lp`
// submission stage (build_lp_args/submit_print_job) - it can't be an EXIF
// orientation quirk of some particular photo (that path has its own direct
// test, composite_honors_exif_orientation_before_cropping_and_resizing).

/// 3x5 bitmap digits, one row per `u8` (only the low 3 bits are used, MSB
/// first) - just enough to print inch labels on the calibration grid without
/// pulling in a font-rendering dependency for a debug-only feature.
fn digit_glyph(d: u8) -> [u8; 5] {
    match d {
        0 => [0b111, 0b101, 0b101, 0b101, 0b111],
        1 => [0b010, 0b110, 0b010, 0b010, 0b111],
        2 => [0b111, 0b001, 0b111, 0b100, 0b111],
        3 => [0b111, 0b001, 0b111, 0b001, 0b111],
        4 => [0b101, 0b101, 0b111, 0b001, 0b001],
        5 => [0b111, 0b100, 0b111, 0b001, 0b111],
        6 => [0b111, 0b100, 0b111, 0b101, 0b111],
        7 => [0b111, 0b001, 0b001, 0b001, 0b001],
        8 => [0b111, 0b101, 0b111, 0b101, 0b111],
        _ => [0b111, 0b101, 0b111, 0b001, 0b111],
    }
}

fn set_px(img: &mut image::RgbImage, x: i64, y: i64, color: image::Rgb<u8>) {
    if x >= 0 && y >= 0 && (x as u32) < img.width() && (y as u32) < img.height() {
        img.put_pixel(x as u32, y as u32, color);
    }
}

fn fill_rect(img: &mut image::RgbImage, x0: i64, y0: i64, w: i64, h: i64, color: image::Rgb<u8>) {
    for y in y0..(y0 + h) {
        for x in x0..(x0 + w) {
            set_px(img, x, y, color);
        }
    }
}

/// Draws one digit's top-left corner at `(x0, y0)`, each glyph "pixel"
/// blown up to a `scale`x`scale` block so it stays legible at print
/// resolution.
fn draw_digit(img: &mut image::RgbImage, d: u8, x0: i64, y0: i64, scale: i64, color: image::Rgb<u8>) {
    for (row, bits) in digit_glyph(d).iter().enumerate() {
        for col in 0..3 {
            if bits & (0b100 >> col) != 0 {
                fill_rect(img, x0 + col as i64 * scale, y0 + row as i64 * scale, scale, scale, color);
            }
        }
    }
}

/// Draws `n`'s decimal digits left-to-right starting at `(x0, y0)`, one
/// glyph-width gap between digits.
fn draw_number(img: &mut image::RgbImage, n: u32, x0: i64, y0: i64, scale: i64, color: image::Rgb<u8>) {
    let s = n.to_string();
    for (i, ch) in s.chars().enumerate() {
        let d = ch.to_digit(10).unwrap_or(0) as u8;
        draw_digit(img, d, x0 + i as i64 * 4 * scale, y0, scale, color);
    }
}

/// Renders the calibration target at exactly `width_in × height_in` (the
/// same "printed image size" rectangle a real photo would target) so that
/// when this is routed through the real `composite_for_print`, its aspect
/// already matches the request and `Crop` mode's `crop_to_aspect` is a
/// guaranteed no-op - nothing hides the grid, and any discrepancy in the
/// final print is attributable only to the canvas/overlay math or the CUPS
/// submission itself, not to cropping.
pub fn generate_test_pattern(width_in: f64, height_in: f64, dpi: u32) -> image::RgbImage {
    let w = (width_in * dpi as f64).round().max(1.0) as u32;
    let h = (height_in * dpi as f64).round().max(1.0) as u32;
    let mut img = image::RgbImage::from_pixel(w, h, image::Rgb([255, 255, 255]));

    let px_per_in = dpi as f64;
    let band = (0.15 * px_per_in).round().max(1.0) as i64;
    let (wi, hi) = (w as i64, h as i64);

    // Edge bands, drawn before the grid/labels so they sit underneath.
    fill_rect(&mut img, 0, 0, wi, band, image::Rgb([220, 30, 30])); // top: red
    fill_rect(&mut img, wi - band, 0, band, hi, image::Rgb([30, 160, 60])); // right: green
    fill_rect(&mut img, 0, hi - band, wi, band, image::Rgb([40, 90, 220])); // bottom: blue
    fill_rect(&mut img, 0, 0, band, hi, image::Rgb([200, 30, 180])); // left: magenta

    // 0.5in minor / 1in major grid.
    let minor_gray = image::Rgb([210, 210, 210]);
    let major_gray = image::Rgb([120, 120, 120]);
    let mut x = 0.0_f64;
    while x <= width_in + 1e-6 {
        let px = (x * px_per_in).round() as i64;
        let is_major = (x.round() - x).abs() < 1e-6;
        for y in 0..hi {
            set_px(&mut img, px, y, if is_major { major_gray } else { minor_gray });
        }
        x += 0.5;
    }
    let mut y = 0.0_f64;
    while y <= height_in + 1e-6 {
        let py = (y * px_per_in).round() as i64;
        let is_major = (y.round() - y).abs() < 1e-6;
        for xp in 0..wi {
            set_px(&mut img, xp, py, if is_major { major_gray } else { minor_gray });
        }
        y += 0.5;
    }

    // Inch labels along the top and left edges, inset past the color bands.
    let label_scale = (0.025 * px_per_in).round().max(1.0) as i64;
    let label_color = image::Rgb([20, 20, 20]);
    for inch in 1..(width_in as u32) {
        let px = (inch as f64 * px_per_in).round() as i64;
        draw_number(&mut img, inch, px + label_scale, band + label_scale, label_scale, label_color);
    }
    for inch in 1..(height_in as u32) {
        let py = (inch as f64 * px_per_in).round() as i64;
        draw_number(&mut img, inch, band + label_scale, py + label_scale, label_scale, label_color);
    }

    // Center crosshair.
    let (cx, cy) = (wi / 2, hi / 2);
    let arm = (0.4 * px_per_in).round() as i64;
    let black = image::Rgb([0, 0, 0]);
    for i in -arm..=arm {
        set_px(&mut img, cx + i, cy, black);
        set_px(&mut img, cx, cy + i, black);
    }

    // Corner numbers, clockwise from top-left: 1/2/3/4.
    let corner_scale = (0.05 * px_per_in).round().max(1.0) as i64;
    let inset = band + corner_scale;
    draw_number(&mut img, 1, inset, inset, corner_scale, black);
    draw_number(&mut img, 2, wi - inset - 4 * corner_scale, inset, corner_scale, black);
    draw_number(&mut img, 3, wi - inset - 4 * corner_scale, hi - inset - 5 * corner_scale, corner_scale, black);
    draw_number(&mut img, 4, inset, hi - inset - 5 * corner_scale, corner_scale, black);

    img
}

/// Builds a calibration print job through the *real* `composite_for_print` -
/// same code path a real photo takes, just with `generate_test_pattern`'s
/// synthetic grid standing in for `fetch_true_original`'s bytes.
pub fn composite_test_pattern_for_print(options: &PrintOptions) -> Result<Vec<u8>, String> {
    let pattern = generate_test_pattern(options.image_width_in, options.image_height_in, options.dpi);

    let mut src_bytes = Vec::new();
    let mut cursor = io::Cursor::new(&mut src_bytes);
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, 95);
    encoder.set_pixel_density(image::codecs::jpeg::PixelDensity::dpi(options.dpi.min(u16::MAX as u32) as u16));
    image::DynamicImage::ImageRgb8(pattern).write_with_encoder(encoder).map_err(|e| format!("Could not encode test pattern JPEG: {e}"))?;

    composite_for_print(&src_bytes, options.paper_width_in, options.paper_height_in, options.image_width_in, options.image_height_in, options.dpi, options.fit_mode)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::GenericImageView;

    /// Pulls the embedded JPEG back out of a `wrap_jpeg_as_pdf` PDF - our
    /// fixed object layout always emits it byte-for-byte (no
    /// recompression), starting at the first SOI marker and running to the
    /// next `endstream`, so tests can decode/inspect it exactly as they did
    /// before `composite_for_print` started returning a PDF instead of a
    /// bare JPEG.
    fn extract_pdf_jpeg(pdf: &[u8]) -> Vec<u8> {
        let start = pdf.windows(2).position(|w| w == [0xFF, 0xD8]).expect("no JPEG SOI marker found in PDF");
        let end = pdf[start..].windows(10).position(|w| w == b"\nendstream").expect("no endstream found after JPEG data") + start;
        pdf[start..end].to_vec()
    }

    /// Parses `/MediaBox [0 0 W H]` (our own fixed formatting) back into
    /// points - the PDF page geometry that actually pins down physical
    /// print size now, in place of the JPEG's own JFIF density.
    fn extract_pdf_mediabox(pdf: &[u8]) -> (f64, f64) {
        let marker = b"/MediaBox [0 0 ";
        let start = pdf.windows(marker.len()).position(|w| w == marker).expect("no /MediaBox found in PDF") + marker.len();
        let end = pdf[start..].iter().position(|&b| b == b']').expect("unterminated /MediaBox") + start;
        let text = std::str::from_utf8(&pdf[start..end]).expect("/MediaBox operands must be ASCII");
        let mut parts = text.split_whitespace();
        let w: f64 = parts.next().unwrap().parse().unwrap();
        let h: f64 = parts.next().unwrap().parse().unwrap();
        (w, h)
    }

    /// Parses the `a b c d e f cm` operands out of the content stream (our
    /// own fixed `"q {a} {b} {c} {d} {e} {f} cm /Im0 Do Q"` formatting).
    fn extract_pdf_cm(pdf: &[u8]) -> [f64; 6] {
        let jpeg_start = pdf.windows(2).position(|w| w == [0xFF, 0xD8]).expect("no JPEG SOI marker found in PDF");
        // The content stream's own "stream\n...endstream" comes after the
        // image object in our fixed object order, so search from there.
        let after_image = pdf[jpeg_start..].windows(10).position(|w| w == b"\nendstream").expect("no endstream after image data") + jpeg_start;
        let marker = b"q ";
        let start = pdf[after_image..].windows(marker.len()).position(|w| w == marker).expect("no content stream 'q' found") + after_image + marker.len();
        let end = pdf[start..].windows(4).position(|w| w == b" cm ").expect("no 'cm' operator found") + start;
        let text = std::str::from_utf8(&pdf[start..end]).expect("cm operands must be ASCII");
        let nums: Vec<f64> = text.split_whitespace().map(|s| s.parse().unwrap()).collect();
        nums.try_into().expect("expected exactly 6 cm operands")
    }

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
    fn driver_name_prefers_nickname_over_manufacturer() {
        // Sampled verbatim from the same real TurboPrint PPD as the module
        // doc comments reference - this is the exact string that should
        // replace a naive "AirPrint" guess from the dnssd:// discovery URI.
        let ppd = "*Manufacturer:  \"EPSON TurboPrint\"\n*ShortNickName: \"Epson_StylusPro3880\"\n*NickName:      \"Epson_StylusPro3880 TurboPrint\"\n";
        assert_eq!(driver_name_from_ppd(ppd), Some("Epson_StylusPro3880 TurboPrint".to_string()));
    }

    #[test]
    fn driver_name_falls_back_through_shortnickname_to_manufacturer() {
        assert_eq!(driver_name_from_ppd("*ShortNickName: \"Generic PCL\"\n"), Some("Generic PCL".to_string()));
        assert_eq!(driver_name_from_ppd("*Manufacturer: \"Generic\"\n"), Some("Generic".to_string()));
        assert_eq!(driver_name_from_ppd("*PageSize Letter: \"\"\n"), None);
    }

    #[test]
    fn builds_lp_args() {
        let args = build_lp_args("Epson_SureColor_P700", "A4", 720, 2, Path::new("/tmp/print.jpg"));
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
                "PageSize=A4",
                "-o",
                "resolution=720dpi",
                "-o",
                "ppi=720",
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
        assert_eq!(extract_pdf_mediabox(&out), (288.0, 432.0)); // 4in x 6in in points
        let decoded = image::load_from_memory(&extract_pdf_jpeg(&out)).unwrap();
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
        let decoded = image::load_from_memory(&extract_pdf_jpeg(&out)).unwrap();
        assert_eq!(decoded.width(), 500);
        assert_eq!(decoded.height(), 700);
    }

    /// Reads the JFIF `APP0` segment's own density fields directly out of the
    /// encoded bytes - the same fields confirmed empirically (via `exiftool`/
    /// `identify` on real `JpegEncoder` output) to default to `(1,1)
    /// PixelAspectRatio`/`ResolutionUnit: None` when `set_pixel_density` isn't
    /// called, which is the root cause this test guards against regressing.
    fn jfif_density(jpeg: &[u8]) -> (u8, u16, u16) {
        assert_eq!(&jpeg[0..2], &[0xFF, 0xD8], "must start with the SOI marker");
        assert_eq!(&jpeg[2..4], &[0xFF, 0xE0], "APP0 (JFIF) must be the first segment");
        assert_eq!(&jpeg[6..11], b"JFIF\x00", "APP0 identifier");
        // Layout after the FF E0 marker: length(2) + "JFIF\0"(5) + version(2) +
        // units(1) + Xdensity(2) + Ydensity(2), all big-endian.
        let units = jpeg[13];
        let x_density = u16::from_be_bytes([jpeg[14], jpeg[15]]);
        let y_density = u16::from_be_bytes([jpeg[16], jpeg[17]]);
        (units, x_density, y_density)
    }

    #[test]
    fn composite_embeds_the_requested_dpi_in_the_jfif_header() {
        let src = encode_solid_jpeg(100, 100);
        let out = composite_for_print(&src, 5.0, 7.0, 5.0, 7.0, 300, FitMode::Crop).unwrap();
        let (units, x_density, y_density) = jfif_density(&extract_pdf_jpeg(&out));
        assert_eq!(units, 1, "units must be dots-per-inch, not the encoder's default PixelAspectRatio");
        assert_eq!(x_density, 300);
        assert_eq!(y_density, 300);
    }

    /// Builds a minimal well-formed Exif `APP1` segment carrying a single
    /// `Orientation` tag, and splices it in as the very first segment after
    /// the SOI marker - the same position a real camera JPEG carries it in.
    fn jpeg_with_exif_orientation(jpeg: &[u8], exif_orientation: u8) -> Vec<u8> {
        let mut tiff = Vec::new();
        tiff.extend_from_slice(b"II\x2A\x00"); // little-endian TIFF header
        tiff.extend_from_slice(&8u32.to_le_bytes()); // IFD0 offset
        tiff.extend_from_slice(&1u16.to_le_bytes()); // 1 IFD0 entry
        tiff.extend_from_slice(&0x0112u16.to_le_bytes()); // tag: Orientation
        tiff.extend_from_slice(&3u16.to_le_bytes()); // type: SHORT
        tiff.extend_from_slice(&1u32.to_le_bytes()); // count: 1
        tiff.extend_from_slice(&(exif_orientation as u16).to_le_bytes());
        tiff.extend_from_slice(&0u16.to_le_bytes()); // padding to fill the 4-byte value slot
        tiff.extend_from_slice(&0u32.to_le_bytes()); // next IFD offset: none

        let mut app1 = Vec::new();
        app1.extend_from_slice(&[0xFF, 0xE1]);
        let len = (2 + 6 + tiff.len()) as u16;
        app1.extend_from_slice(&len.to_be_bytes());
        app1.extend_from_slice(b"Exif\x00\x00");
        app1.extend_from_slice(&tiff);

        let mut out = Vec::new();
        out.extend_from_slice(&jpeg[0..2]); // SOI
        out.extend_from_slice(&app1);
        out.extend_from_slice(&jpeg[2..]);
        out
    }

    fn encode_two_tone_jpeg(w: u32, h: u32) -> Vec<u8> {
        // Left half red, right half blue - asymmetric enough that a rotation
        // is visually unmistakable in a pixel sample far from the seam/edges.
        let img = image::RgbImage::from_fn(w, h, |x, _y| if x < w / 2 { image::Rgb([255, 0, 0]) } else { image::Rgb([0, 0, 255]) });
        let mut out = Vec::new();
        let mut cursor = io::Cursor::new(&mut out);
        image::DynamicImage::ImageRgb8(img)
            .write_with_encoder(image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, 95))
            .unwrap();
        out
    }

    #[test]
    fn composite_honors_exif_orientation_before_cropping_and_resizing() {
        // 40x20 (landscape, red left / blue right), tagged Exif orientation 6
        // ("Rotate 90 CW" - what a RAW-embedded preview or phone photo shot
        // in portrait commonly carries). Un-rotated pixels would still be
        // landscape; a correctly oriented decode is 20x40 with the original
        // left (red) edge now forming the top.
        let src = jpeg_with_exif_orientation(&encode_two_tone_jpeg(40, 20), 6);
        let out = composite_for_print(&src, 20.0, 40.0, 20.0, 40.0, 1, FitMode::Fit).unwrap();
        let decoded = image::load_from_memory(&extract_pdf_jpeg(&out)).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (20, 40));

        let top = decoded.get_pixel(10, 10);
        let bottom = decoded.get_pixel(10, 30);
        assert!(top[0] > 200 && top[2] < 50, "expected the rotated top region to still be red, got {top:?}");
        assert!(bottom[2] > 200 && bottom[0] < 50, "expected the rotated bottom region to still be blue, got {bottom:?}");
    }

    #[test]
    fn test_pattern_is_sized_to_the_requested_inches_at_dpi() {
        let pattern = generate_test_pattern(5.0, 7.0, 100);
        assert_eq!((pattern.width(), pattern.height()), (500, 700));
    }

    #[test]
    fn test_pattern_edge_bands_are_distinct_colors_on_each_side() {
        let pattern = generate_test_pattern(5.0, 7.0, 100);
        let (w, h) = (pattern.width(), pattern.height());
        // 207px lands on neither a 0.5in minor nor a 1in major gridline
        // (multiples of 50/100 at this 100dpi), and outside every digit
        // label's footprint - a clean sample of just the band color.
        let top = pattern.get_pixel(207, 2);
        let right = pattern.get_pixel(w - 3, 207);
        let bottom = pattern.get_pixel(207, h - 3);
        let left = pattern.get_pixel(2, 207);
        // Distinguishable by which channel dominates, not exact values -
        // draw_number/grid lines can locally overwrite a handful of pixels.
        assert!(top[0] > top[1] && top[0] > top[2], "top band should read red, got {top:?}");
        assert!(right[1] > right[0] && right[1] > right[2], "right band should read green, got {right:?}");
        assert!(bottom[2] > bottom[0] && bottom[2] > bottom[1], "bottom band should read blue, got {bottom:?}");
        assert!(left[0] > left[1] && left[2] > left[1], "left band should read magenta, got {left:?}");
    }

    #[test]
    fn composite_test_pattern_matches_a_real_composite_of_the_same_size() {
        // Fill Paper (image size == paper size) - the pattern is generated
        // at exactly that aspect, so this must come out full-bleed with no
        // border, same as any other Crop-mode composite at 1:1 with the
        // canvas.
        let options = PrintOptions {
            printer_id: "test".to_string(),
            paper_id: "test".to_string(),
            copies: 1,
            dpi: 100,
            orientation: PrintOrientation::Landscape,
            fit_mode: FitMode::Crop,
            paper_width_in: 7.0,
            paper_height_in: 5.0,
            image_width_in: 7.0,
            image_height_in: 5.0,
        };
        let out = composite_test_pattern_for_print(&options).unwrap();
        // Portrait-native MediaBox even though the canvas itself is
        // landscape (7x5in) - see wrap_jpeg_as_pdf's doc comment.
        assert_eq!(extract_pdf_mediabox(&out), (360.0, 504.0));
        let decoded = image::load_from_memory(&extract_pdf_jpeg(&out)).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (700, 500));
    }

    #[test]
    fn wrap_jpeg_as_pdf_embeds_the_source_jpeg_byte_for_byte_at_the_right_media_box() {
        let jpeg = encode_solid_jpeg(120, 80);
        let pdf = wrap_jpeg_as_pdf(&jpeg, 5.0, 7.0, 120, 80);
        assert_eq!(&pdf[0..8], b"%PDF-1.4");
        assert_eq!(extract_pdf_mediabox(&pdf), (360.0, 504.0)); // 5in x 7in in points
        assert_eq!(extract_pdf_jpeg(&pdf), jpeg);
        assert_eq!(extract_pdf_cm(&pdf), [360.0, 0.0, 0.0, 504.0, 0.0, 0.0]); // portrait: no rotation
    }

    #[test]
    fn wrap_jpeg_as_pdf_rotates_a_landscape_canvas_into_a_portrait_native_media_box() {
        // 11x8.5in (landscape) - a real PPD would declare this media
        // portrait-native (8.5x11, e.g. Letter's *PaperDimension is
        // "612 792"), so the MediaBox this emits must stay portrait-shaped
        // regardless, with the rotation baked into the `cm` matrix instead.
        let jpeg = encode_solid_jpeg(200, 100);
        let pdf = wrap_jpeg_as_pdf(&jpeg, 11.0, 8.5, 200, 100);
        assert_eq!(extract_pdf_mediabox(&pdf), (612.0, 792.0)); // 8.5in x 11in, portrait order
        // Matches the doc comment's derivation: [0, -w_pt, h_pt, 0, 0, w_pt].
        assert_eq!(extract_pdf_cm(&pdf), [0.0, -792.0, 612.0, 0.0, 0.0, 792.0]);
    }

}
