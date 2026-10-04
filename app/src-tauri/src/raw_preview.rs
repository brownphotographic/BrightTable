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

//! Full-size JPEG preview embedded inside a RAW file, for the Viewer's
//! zoom/loupe (`immich-thumb://…?size=embedded`, see protocol.rs). A RAW
//! itself can't be decoded by the webview, and Immich's own `preview`
//! rendition tops out around 1440px - but nearly every camera embeds a
//! full-resolution (or close to it) JPEG of the shot inside the RAW for its
//! own playback screen, which is exactly the real pixel-level detail a
//! focus check under the loupe needs.
//!
//! Rather than parse each vendor's container (TIFF IFDs for CR2/NEF/ARW/
//! DNG/PEF, ISOBMFF boxes for CR3, Fuji's own RAF header, ...), this scans
//! the bytes for every JPEG SOI marker and validates each candidate's marker
//! structure, keeping the one with the most pixels. Raw sensor data stored
//! as *lossless* JPEG (SOF3 - CR2, many DNGs) is rejected by its SOF type,
//! so it's never mistaken for a viewable preview; random `FF D8 FF` byte
//! runs inside compressed sensor data fail the marker validation almost
//! immediately.
//!
//! Embedded previews are stored in sensor orientation (the camera records
//! "this was shot portrait" only as an EXIF tag on the RAW), so a non-1
//! orientation is baked into the pixels here - the webview would otherwise
//! show a portrait shot's loupe sideways next to Immich's already-rotated
//! preview underneath.
use std::io::Cursor;

/// How much of the RAW's start the orientation lookup reads - IFD0 (and a
/// CR3's CMT1 box) sit in a RAW's early structure, same reasoning as
/// `import::capture_time`'s `EXIF_PREFIX_BYTES`.
const EXIF_PREFIX_BYTES: usize = 4 * 1024 * 1024;
/// Where to look for a self-contained TIFF header when the RAW as a whole
/// isn't one kamadak-exif reads (CR3's CMT1 box, RW2's/ORF's non-standard
/// TIFF magic leaving only the embedded JPEG's own Exif APP1).
const TIFF_SCAN_BYTES: usize = 1024 * 1024;
const TIFF_SCAN_MAX_CANDIDATES: usize = 8;
const REENCODE_QUALITY: u8 = 92;

/// The largest embedded JPEG in `raw`, rotated upright. `None` if the file
/// has no viewable embedded JPEG at all.
pub fn extract_embedded_jpeg(raw: &[u8]) -> Option<Vec<u8>> {
    let (start, end) = find_largest_jpeg(raw)?;
    let jpeg = &raw[start..end];
    let orientation = raw_orientation(raw).or_else(|| exif_orientation(jpeg)).unwrap_or(1);
    if orientation == 1 {
        return Some(jpeg.to_vec());
    }
    // A failed rotate still beats no hi-res at all - serve it unrotated.
    Some(bake_orientation(jpeg, orientation).unwrap_or_else(|| jpeg.to_vec()))
}

/// `(start, end)` byte range of the embedded JPEG with the largest pixel
/// area.
fn find_largest_jpeg(b: &[u8]) -> Option<(usize, usize)> {
    let mut best: Option<(usize, usize, u64)> = None;
    let mut i = 0;
    while i + 3 <= b.len() {
        let Some(off) = b[i..].iter().position(|&x| x == 0xFF) else { break };
        i += off;
        if i + 3 > b.len() {
            break;
        }
        if b[i + 1] == 0xD8 && b[i + 2] == 0xFF {
            if let Some((end, w, h)) = parse_jpeg(b, i) {
                let area = w as u64 * h as u64;
                if best.map_or(true, |(_, _, a)| area > a) {
                    best = Some((i, end, area));
                }
                // Anything nested inside this one (its own Exif thumbnail)
                // is necessarily smaller - skip straight past it.
                i = end;
                continue;
            }
        }
        i += 1;
    }
    best.map(|(s, e, _)| (s, e))
}

fn be16(b: &[u8], p: usize) -> Option<usize> {
    Some(u16::from_be_bytes([*b.get(p)?, *b.get(p + 1)?]) as usize)
}

/// Validates the JPEG starting at `start` (its SOI) and returns `(end, width,
/// height)`, `end` being one past its EOI. Only baseline/extended/
/// progressive Huffman JPEGs (SOF0/1/2) qualify - the kinds a webview
/// decodes, and never the lossless SOF3 that RAW sensor data uses.
fn parse_jpeg(b: &[u8], start: usize) -> Option<(usize, u16, u16)> {
    let mut p = start + 2;
    let mut dims: Option<(u16, u16)> = None;
    loop {
        if *b.get(p)? != 0xFF {
            return None;
        }
        let mut m = *b.get(p + 1)?;
        while m == 0xFF {
            p += 1;
            m = *b.get(p + 1)?;
        }
        p += 2;
        match m {
            0xD8 | 0xD9 => return None,
            0x01 | 0xD0..=0xD7 => continue,
            _ => {}
        }
        let len = be16(b, p)?;
        if len < 2 || p + len > b.len() {
            return None;
        }
        match m {
            0xC0..=0xC2 => {
                if len < 8 {
                    return None;
                }
                let h = be16(b, p + 3)? as u16;
                let w = be16(b, p + 5)? as u16;
                if w == 0 || h == 0 {
                    return None;
                }
                dims = Some((w, h));
            }
            // Lossless, hierarchical and arithmetic-coded SOFs.
            0xC3 | 0xC5..=0xC7 | 0xC9..=0xCB | 0xCD..=0xCF => return None,
            0xDA => {
                let (w, h) = dims?;
                let end = scan_to_eoi(b, p + len)?;
                return Some((end, w, h));
            }
            _ => {}
        }
        p += len;
    }
}

/// Walks entropy-coded data (and, for a progressive JPEG, the DHT/SOS/...
/// segments between its scans) to one past the EOI marker.
fn scan_to_eoi(b: &[u8], mut p: usize) -> Option<usize> {
    loop {
        p += b.get(p..)?.iter().position(|&x| x == 0xFF)?;
        match *b.get(p + 1)? {
            // Stuffed 0x00, restart markers, fill bytes - still scan data.
            0x00 | 0xD0..=0xD7 | 0xFF => p += 1,
            0xD9 => return Some(p + 2),
            0xD8 => return None,
            _ => {
                let len = be16(b, p + 2)?;
                if len < 2 {
                    return None;
                }
                p += 2 + len;
            }
        }
    }
}

fn orientation_of(exif: &exif::Exif) -> Option<u32> {
    let v = exif.get_field(exif::Tag::Orientation, exif::In::PRIMARY)?.value.get_uint(0)?;
    (1..=8).contains(&v).then_some(v)
}

/// EXIF orientation of a JPEG/TIFF-style container (kamadak-exif's own
/// format sniffing).
fn exif_orientation(bytes: &[u8]) -> Option<u32> {
    let exif = exif::Reader::new().read_from_container(&mut Cursor::new(bytes)).ok()?;
    orientation_of(&exif)
}

/// The RAW's own IFD0 orientation - the one `rotate_asset` (exiftool)
/// writes. Tries the file as a TIFF container first (CR2/NEF/ARW/DNG/PEF),
/// then any standalone TIFF header near the start of the file (CR3's CMT1
/// box, or an embedded JPEG's Exif APP1).
fn raw_orientation(raw: &[u8]) -> Option<u32> {
    if let Some(o) = exif_orientation(&raw[..raw.len().min(EXIF_PREFIX_BYTES)]) {
        return Some(o);
    }
    let window = &raw[..raw.len().min(TIFF_SCAN_BYTES)];
    window
        .windows(4)
        .enumerate()
        .filter(|(_, w)| *w == b"II*\0" || *w == b"MM\0*")
        .take(TIFF_SCAN_MAX_CANDIDATES)
        .find_map(|(i, _)| {
            let slice = &raw[i..raw.len().min(i + EXIF_PREFIX_BYTES)];
            let exif = exif::Reader::new().read_raw(slice.to_vec()).ok()?;
            orientation_of(&exif)
        })
}

fn bake_orientation(jpeg: &[u8], orientation: u32) -> Option<Vec<u8>> {
    let mut img = image::load_from_memory_with_format(jpeg, image::ImageFormat::Jpeg).ok()?;
    img.apply_orientation(image::metadata::Orientation::from_exif(orientation as u8)?);
    let mut out = Cursor::new(Vec::new());
    img.write_with_encoder(image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, REENCODE_QUALITY))
        .ok()?;
    Some(out.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jpeg(w: u32, h: u32) -> Vec<u8> {
        let img = image::DynamicImage::ImageRgb8(image::RgbImage::from_fn(w, h, |x, y| image::Rgb([(x * 7) as u8, (y * 13) as u8, 90])));
        let mut out = Cursor::new(Vec::new());
        img.write_with_encoder(image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 80)).unwrap();
        out.into_inner()
    }

    // A fake lossless-JPEG (SOF3) sensor-data stream: SOI, SOF3, SOS, a
    // little scan data, EOI.
    fn lossless_jpeg() -> Vec<u8> {
        let mut v = vec![0xFF, 0xD8];
        v.extend([0xFF, 0xC3, 0x00, 0x0B, 0x0E, 0x10, 0x00, 0x10, 0x00, 0x01, 0x01, 0x11, 0x00]);
        v.extend([0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x01, 0x00, 0x00]);
        v.extend([0x12, 0x34, 0xFF, 0x00, 0x56]);
        v.extend([0xFF, 0xD9]);
        v
    }

    fn fake_raw(parts: &[Vec<u8>]) -> Vec<u8> {
        // Junk between parts deliberately includes a bare `FF D8 FF` that
        // isn't a real JPEG.
        let junk = [0x00u8, 0x11, 0xFF, 0xD8, 0xFF, 0x42, 0x99, 0x00, 0x7F];
        let mut v = b"II*\0junkheader".to_vec();
        for p in parts {
            v.extend(junk);
            v.extend(p);
        }
        v.extend(junk);
        v
    }

    #[test]
    fn picks_the_largest_embedded_jpeg() {
        let small = jpeg(16, 12);
        let large = jpeg(64, 48);
        let raw = fake_raw(&[small, large.clone(), lossless_jpeg()]);
        let (s, e) = find_largest_jpeg(&raw).unwrap();
        assert_eq!(&raw[s..e], &large[..]);
    }

    #[test]
    fn rejects_lossless_sensor_data() {
        let raw = fake_raw(&[lossless_jpeg()]);
        assert_eq!(find_largest_jpeg(&raw), None);
    }

    #[test]
    fn no_jpeg_at_all_is_none() {
        assert_eq!(extract_embedded_jpeg(&fake_raw(&[])), None);
    }

    #[test]
    fn unrotated_preview_passes_through_byte_for_byte() {
        let large = jpeg(64, 48);
        let raw = fake_raw(&[large.clone()]);
        assert_eq!(extract_embedded_jpeg(&raw).unwrap(), large);
    }

    #[test]
    fn bakes_in_a_90_degree_orientation() {
        let out = bake_orientation(&jpeg(64, 48), 6).unwrap();
        let img = image::load_from_memory(&out).unwrap();
        assert_eq!((img.width(), img.height()), (48, 64));
    }
}
