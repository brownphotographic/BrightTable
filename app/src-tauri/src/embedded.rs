// Locates metadata embedded directly inside a JPEG/TIFF's own bytes (as
// opposed to a separate sidecar file) - digiKam and similar tools write
// straight into these formats when they can, rather than creating a `.xmp`.
// RAW files are out of scope here: every tool in BrightTable's supported list
// uses a sidecar for RAW regardless, since none of them safely rewrite a
// proprietary RAW container in place. Extracted text is handed off to
// `xmp.rs`'s field parsers, which don't care whether it came from a sidecar
// or an embedded packet.
use std::fs;
use std::path::Path;

const XMP_SIGNATURE: &[u8] = b"http://ns.adobe.com/xap/1.0/\0";
const PHOTOSHOP_SIGNATURE: &[u8] = b"Photoshop 3.0\0";
const IPTC_RESOURCE_ID: u16 = 0x0404;
const IPTC_RECORD_APPLICATION: u8 = 2;
const IPTC_DATASET_CAPTION: u8 = 120;

fn extension_lower(path: &Path) -> Option<String> {
    Some(path.extension()?.to_str()?.to_ascii_lowercase())
}

/// The XMP XML packet embedded in a JPEG's APP1 segment or a TIFF's tag
/// `0x02BC` (IFD0 only - XMP is essentially never anywhere else). `None` for
/// any other format, a malformed file, or simply no embedded XMP present.
pub fn find_embedded_xmp(path: &Path) -> Option<String> {
    match extension_lower(path)?.as_str() {
        "jpg" | "jpeg" => {
            let bytes = fs::read(path).ok()?;
            let (_, payload) = jpeg_segments(&bytes)
                .into_iter()
                .find(|(marker, payload)| *marker == 0xE1 && payload.starts_with(XMP_SIGNATURE))?;
            std::str::from_utf8(&payload[XMP_SIGNATURE.len()..]).ok().map(str::to_string)
        }
        "tif" | "tiff" => {
            let bytes = fs::read(path).ok()?;
            find_tiff_xmp(&bytes)
        }
        _ => None,
    }
}

/// Legacy IPTC-IIM "Caption-Abstract" (record 2, dataset 120) from a JPEG's
/// APP13 "Photoshop 3.0" resource block - the one place classic IPTC still
/// matters, since sidecar files are always XMP, never IIM. Only a fallback
/// (used when there's no XMP description anywhere) - most modern tools
/// mirror this into `dc:description` instead, which `xmp.rs` already covers.
/// Text is decoded UTF-8-lossy: IPTC's own character-set tag is ignored, a
/// deliberate simplification since captions from these tools are
/// overwhelmingly plain ASCII/UTF-8 already.
pub fn find_embedded_iptc_caption(path: &Path) -> Option<String> {
    if extension_lower(path)?.as_str() != "jpg" && extension_lower(path)?.as_str() != "jpeg" {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    let (_, payload) = jpeg_segments(&bytes)
        .into_iter()
        .find(|(marker, payload)| *marker == 0xED && payload.starts_with(PHOTOSHOP_SIGNATURE))?;
    let resource_data = find_8bim_resource(&payload[PHOTOSHOP_SIGNATURE.len()..], IPTC_RESOURCE_ID)?;
    find_iptc_dataset(resource_data, IPTC_RECORD_APPLICATION, IPTC_DATASET_CAPTION)
}

/// Walks a JPEG's marker segments up to (not including) the entropy-coded
/// scan data, returning each marker byte with its raw payload (length bytes
/// excluded). Bails out (returns whatever was found so far) on anything that
/// doesn't look like a well-formed marker stream, rather than panicking or
/// scanning byte-by-byte through image data.
fn jpeg_segments(bytes: &[u8]) -> Vec<(u8, &[u8])> {
    let mut out = Vec::new();
    if bytes.len() < 4 || bytes[0] != 0xFF || bytes[1] != 0xD8 {
        return out;
    }
    let mut i = 2;
    while i + 1 < bytes.len() {
        if bytes[i] != 0xFF {
            break;
        }
        // JPEG allows arbitrary 0xFF fill bytes before the real marker byte.
        let mut marker_pos = i + 1;
        while marker_pos < bytes.len() && bytes[marker_pos] == 0xFF {
            marker_pos += 1;
        }
        if marker_pos >= bytes.len() {
            break;
        }
        let marker = bytes[marker_pos];
        // Markers with no payload: SOI/TEM/RSTn (EOI or SOS end the search).
        if marker == 0x01 || (0xD0..=0xD7).contains(&marker) {
            i = marker_pos + 1;
            continue;
        }
        if marker == 0xD9 || marker == 0xDA {
            break;
        }
        let len_pos = marker_pos + 1;
        if len_pos + 2 > bytes.len() {
            break;
        }
        let seg_len = u16::from_be_bytes([bytes[len_pos], bytes[len_pos + 1]]) as usize;
        if seg_len < 2 || len_pos + seg_len > bytes.len() {
            break;
        }
        out.push((marker, &bytes[len_pos + 2..len_pos + seg_len]));
        i = len_pos + seg_len;
    }
    out
}

fn find_tiff_xmp(bytes: &[u8]) -> Option<String> {
    const XMP_TAG: u16 = 0x02BC;
    if bytes.len() < 8 {
        return None;
    }
    let little_endian = match &bytes[0..2] {
        b"II" => true,
        b"MM" => false,
        _ => return None,
    };
    let read_u16 = |off: usize| -> Option<u16> {
        let b = bytes.get(off..off + 2)?;
        Some(if little_endian { u16::from_le_bytes([b[0], b[1]]) } else { u16::from_be_bytes([b[0], b[1]]) })
    };
    let read_u32 = |off: usize| -> Option<u32> {
        let b = bytes.get(off..off + 4)?;
        Some(if little_endian {
            u32::from_le_bytes([b[0], b[1], b[2], b[3]])
        } else {
            u32::from_be_bytes([b[0], b[1], b[2], b[3]])
        })
    };
    if read_u16(2)? != 42 {
        return None;
    }
    let ifd_offset = read_u32(4)? as usize;
    let entry_count = read_u16(ifd_offset)? as usize;
    for entry in 0..entry_count {
        let entry_off = ifd_offset + 2 + entry * 12;
        if read_u16(entry_off)? != XMP_TAG {
            continue;
        }
        let count = read_u32(entry_off + 4)? as usize;
        let value_off = if count <= 4 { entry_off + 8 } else { read_u32(entry_off + 8)? as usize };
        let data = bytes.get(value_off..value_off + count)?;
        return std::str::from_utf8(data).ok().map(str::to_string);
    }
    None
}

/// Walks Photoshop "Image Resource Block" entries (the `8BIM` records an
/// APP13 segment is made of) looking for one specific resource ID, returning
/// its data slice.
fn find_8bim_resource(mut data: &[u8], want_id: u16) -> Option<&[u8]> {
    loop {
        if data.len() < 4 || &data[0..4] != b"8BIM" {
            return None;
        }
        let id = u16::from_be_bytes([data[4], data[5]]);
        let name_len = data[6] as usize;
        let name_field_len = (1 + name_len + 1) / 2 * 2; // padded to even, including the length byte
        let size_off = 6 + name_field_len;
        let size = u32::from_be_bytes(data.get(size_off..size_off + 4)?.try_into().ok()?) as usize;
        let data_off = size_off + 4;
        let resource_data = data.get(data_off..data_off + size)?;
        if id == want_id {
            return Some(resource_data);
        }
        let padded_size = (size + 1) / 2 * 2;
        data = data.get(data_off + padded_size..)?;
    }
}

/// Walks legacy IPTC-IIM datasets (each `0x1C <record> <dataset> <len:u16>
/// <data>`) inside one resource's bytes, returning the first match for the
/// given record/dataset pair. Extended-length datasets (length field's high
/// bit set) aren't supported - vanishingly rare for the fields this app
/// reads - and simply stop the scan rather than misinterpreting the rest of
/// the buffer.
fn find_iptc_dataset(mut data: &[u8], want_record: u8, want_dataset: u8) -> Option<String> {
    while data.len() >= 5 {
        if data[0] != 0x1C {
            return None;
        }
        let (record, dataset) = (data[1], data[2]);
        let len = u16::from_be_bytes([data[3], data[4]]);
        if len & 0x8000 != 0 {
            return None; // extended-length form, unsupported
        }
        let len = len as usize;
        let value = data.get(5..5 + len)?;
        if record == want_record && dataset == want_dataset {
            let text = String::from_utf8_lossy(value).trim().to_string();
            return (!text.is_empty()).then_some(text);
        }
        data = data.get(5 + len..)?;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app1_xmp_segment(xml: &str) -> Vec<u8> {
        let mut payload = XMP_SIGNATURE.to_vec();
        payload.extend_from_slice(xml.as_bytes());
        let seg_len = (payload.len() + 2) as u16;
        let mut seg = vec![0xFF, 0xE1];
        seg.extend_from_slice(&seg_len.to_be_bytes());
        seg.extend_from_slice(&payload);
        seg
    }

    fn iptc_dataset(record: u8, dataset: u8, value: &[u8]) -> Vec<u8> {
        let mut v = vec![0x1C, record, dataset];
        v.extend_from_slice(&(value.len() as u16).to_be_bytes());
        v.extend_from_slice(value);
        v
    }

    fn resource_8bim(id: u16, data: &[u8]) -> Vec<u8> {
        let mut v = b"8BIM".to_vec();
        v.extend_from_slice(&id.to_be_bytes());
        v.push(0x00); // empty Pascal name
        v.push(0x00); // pad the (length-byte + name) field to even
        v.extend_from_slice(&(data.len() as u32).to_be_bytes());
        v.extend_from_slice(data);
        if data.len() % 2 == 1 {
            v.push(0x00);
        }
        v
    }

    fn app13_iptc_segment(resource: &[u8]) -> Vec<u8> {
        let mut payload = PHOTOSHOP_SIGNATURE.to_vec();
        payload.extend_from_slice(resource);
        let seg_len = (payload.len() + 2) as u16;
        let mut seg = vec![0xFF, 0xED];
        seg.extend_from_slice(&seg_len.to_be_bytes());
        seg.extend_from_slice(&payload);
        seg
    }

    fn write_temp(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("brighttable-test-embedded-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn finds_xmp_in_jpeg_app1() {
        let xml = r#"<rdf:Description xmp:Rating="4"/>"#;
        let mut jpeg = vec![0xFF, 0xD8];
        jpeg.extend(app1_xmp_segment(xml));
        jpeg.extend_from_slice(&[0xFF, 0xD9]);
        let path = write_temp("test.jpg", &jpeg);
        assert_eq!(find_embedded_xmp(&path), Some(xml.to_string()));
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn no_xmp_in_plain_jpeg() {
        let jpeg = vec![0xFF, 0xD8, 0xFF, 0xD9];
        let path = write_temp("plain.jpg", &jpeg);
        assert_eq!(find_embedded_xmp(&path), None);
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn finds_iptc_caption_in_jpeg_app13() {
        let caption = iptc_dataset(IPTC_RECORD_APPLICATION, IPTC_DATASET_CAPTION, b"A caption from IPTC");
        let resource = resource_8bim(IPTC_RESOURCE_ID, &caption);
        let mut jpeg = vec![0xFF, 0xD8];
        jpeg.extend(app13_iptc_segment(&resource));
        jpeg.extend_from_slice(&[0xFF, 0xD9]);
        let path = write_temp("iptc.jpg", &jpeg);
        assert_eq!(find_embedded_iptc_caption(&path), Some("A caption from IPTC".to_string()));
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn finds_xmp_in_tiff_ifd0() {
        let xml = r#"<rdf:Description xmp:Rating="2"/>"#;
        let xml_bytes = xml.as_bytes();
        // Header (8) + 1 IFD entry (2 count + 12 entry + 4 next-IFD) + xml data.
        let ifd_offset: u32 = 8;
        let data_offset: u32 = 8 + 2 + 12 + 4;
        let mut tiff = Vec::new();
        tiff.extend_from_slice(b"II");
        tiff.extend_from_slice(&42u16.to_le_bytes());
        tiff.extend_from_slice(&ifd_offset.to_le_bytes());
        tiff.extend_from_slice(&1u16.to_le_bytes()); // entry count
        tiff.extend_from_slice(&0x02BCu16.to_le_bytes()); // tag
        tiff.extend_from_slice(&7u16.to_le_bytes()); // type: UNDEFINED
        tiff.extend_from_slice(&(xml_bytes.len() as u32).to_le_bytes());
        tiff.extend_from_slice(&data_offset.to_le_bytes());
        tiff.extend_from_slice(&0u32.to_le_bytes()); // next IFD offset
        tiff.extend_from_slice(xml_bytes);
        let path = write_temp("test.tiff", &tiff);
        assert_eq!(find_embedded_xmp(&path), Some(xml.to_string()));
        let _ = fs::remove_file(&path);
    }
}
