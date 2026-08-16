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

//! Content hashing for the SD-card/disk import feature's dedupe cache
//! (`history.rs`). BLAKE3 throughout - chosen over the already-transitively-
//! present `sha2` specifically because the one place a full-file read is
//! unavoidable anyway (the actual copy, see `copy_with_hash`) is exactly
//! where BLAKE3's throughput advantage matters: RAW files run tens of MB
//! each, and a full SD card import batch can be hundreds of them.

use std::fs::File;
use std::io::{self, BufWriter, Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

/// How much of the file the fast rescan-dedupe check hashes - not the whole
/// file. Hashing every RAW file in full on every rescan over a slow card
/// reader is exactly the cost this avoids; combined with the file's size
/// (compared alongside this, not folded into the hash itself), two
/// unrelated photo files coincidentally matching in just their first 4MB
/// isn't a realistic risk at this scale.
const PARTIAL_HASH_BYTES: u64 = 4 * 1024 * 1024;

const COPY_CHUNK_SIZE: usize = 256 * 1024;

/// Hashes at most the first `PARTIAL_HASH_BYTES` of `path`. Shorter files
/// are hashed in full.
pub fn partial_hash(path: &Path) -> io::Result<String> {
    let file = File::open(path)?;
    let mut limited = file.take(PARTIAL_HASH_BYTES);
    let mut hasher = blake3::Hasher::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = limited.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().to_hex().to_string())
}

#[derive(Debug)]
pub struct CopyOutcome {
    pub bytes_copied: u64,
    pub hash: String,
}

/// Copies `src` to `dst` while hashing the full content in the same pass -
/// one read of the source, not a copy followed by a separate re-read to
/// verify. `dst`'s parent directory must already exist; the caller is
/// responsible for the atomic unique-temp-name-then-rename pattern used
/// elsewhere in this codebase (`thumb_cache.rs`, `xmp.rs`) - this function
/// just does the byte-for-byte copy-plus-hash, not the rename.
///
/// `progress`, if given, is updated with the cumulative byte count after
/// every chunk - confirmed real-world links for this feature can be as slow
/// as ~400KB/s (a `sync`-mounted NFS share over a WAN link with no fast
/// write log on the far end), so a large RAW/video file can legitimately
/// take many minutes; `queue.rs`'s idle-timeout supervisor polls this to
/// tell "still slowly progressing" apart from "genuinely stuck", and it
/// doubles as live progress for the Activity panel.
pub fn copy_with_hash(src: &Path, dst: &Path, progress: Option<&AtomicU64>) -> io::Result<CopyOutcome> {
    let mut reader = File::open(src)?;
    let mut writer = BufWriter::new(File::create(dst)?);
    let mut hasher = blake3::Hasher::new();
    let mut buf = [0u8; COPY_CHUNK_SIZE];
    let mut total = 0u64;
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        writer.write_all(&buf[..n])?;
        hasher.update(&buf[..n]);
        total += n as u64;
        if let Some(p) = progress {
            p.store(total, Ordering::Relaxed);
        }
    }
    writer.flush()?;
    Ok(CopyOutcome { bytes_copied: total, hash: hasher.finalize().to_hex().to_string() })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("brighttable-test-hash-{name}-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn partial_hash_matches_for_identical_content() {
        let dir = tmp_dir("identical");
        let a = dir.join("a.bin");
        let b = dir.join("b.bin");
        fs::write(&a, b"same content, twice over").unwrap();
        fs::write(&b, b"same content, twice over").unwrap();
        assert_eq!(partial_hash(&a).unwrap(), partial_hash(&b).unwrap());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn partial_hash_differs_for_different_content() {
        let dir = tmp_dir("different");
        let a = dir.join("a.bin");
        let b = dir.join("b.bin");
        fs::write(&a, b"content A").unwrap();
        fs::write(&b, b"content B").unwrap();
        assert_ne!(partial_hash(&a).unwrap(), partial_hash(&b).unwrap());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn partial_hash_handles_file_smaller_than_the_window() {
        let dir = tmp_dir("small");
        let a = dir.join("small.bin");
        fs::write(&a, b"tiny").unwrap();
        // Just checking this doesn't error/hang on a file far smaller than
        // PARTIAL_HASH_BYTES - the exact digest value isn't the point.
        assert!(partial_hash(&a).is_ok());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn copy_with_hash_copies_bytes_and_hashes_full_content() {
        let dir = tmp_dir("copy");
        let src = dir.join("src.bin");
        let dst = dir.join("dst.bin");
        let content = b"copy me faithfully, including my hash";
        fs::write(&src, content).unwrap();

        let outcome = copy_with_hash(&src, &dst, None).unwrap();
        assert_eq!(outcome.bytes_copied, content.len() as u64);
        assert_eq!(fs::read(&dst).unwrap(), content);
        assert_eq!(outcome.hash, blake3::hash(content).to_hex().to_string());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn copy_with_hash_handles_empty_file() {
        let dir = tmp_dir("empty");
        let src = dir.join("empty.bin");
        let dst = dir.join("empty-copy.bin");
        fs::write(&src, b"").unwrap();

        let outcome = copy_with_hash(&src, &dst, None).unwrap();
        assert_eq!(outcome.bytes_copied, 0);
        assert_eq!(fs::read(&dst).unwrap(), b"");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn copy_with_hash_reports_final_progress() {
        let dir = tmp_dir("progress");
        let src = dir.join("src.bin");
        let dst = dir.join("dst.bin");
        let content = vec![7u8; 600_000]; // bigger than COPY_CHUNK_SIZE, several chunks
        fs::write(&src, &content).unwrap();

        let progress = AtomicU64::new(0);
        let outcome = copy_with_hash(&src, &dst, Some(&progress)).unwrap();
        assert_eq!(progress.load(Ordering::Relaxed), content.len() as u64);
        assert_eq!(outcome.bytes_copied, content.len() as u64);
        let _ = fs::remove_dir_all(&dir);
    }
}
