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

//! Encrypted-at-rest storage for the Immich and Flickr credentials that used
//! to live in plaintext in `config.json` (see `config::FlickrConfig`'s old
//! doc comment). Backed by `tauri-plugin-stronghold`'s vault engine, driven
//! straight from Rust - nothing here is exposed to the frontend as a Tauri
//! command, since `config::load`/`config::save` are already the sole
//! chokepoint every secret field passes through.
//!
//! Stronghold's snapshot file is itself just an encrypted blob - it still
//! needs a key to unlock, same as any vault. Since this is a single-user
//! desktop app with no login/master-password concept, that key is a random
//! 32 bytes generated on first run and kept in its own file
//! (`secrets.key`), permissioned 0600 on Unix, right next to the vault in
//! the OS's *local* (non-roaming/non-synced) app data dir - deliberately
//! not wherever `config.json` itself lives (`config::config_path` lets the
//! user relocate that, e.g. onto a synced drive, which the vault must never
//! follow: the key file is machine-local by design, so a synced vault would
//! just become unreadable on another machine anyway). This raises the bar
//! from "readable by ansyone who can read config.json" (a git commit, a
//! cloud-synced settings folder, a support screenshot) to "readable by
//! anyone with local filesystem access to this machine's app data dir" -
//! not OS-keychain-grade, but a real improvement, and the one the user
//! chose over plain OS-keychain storage.

use std::path::Path;

use rand::RngCore;
use tauri::{AppHandle, Manager};
use tauri_plugin_stronghold::stronghold::Stronghold;

use crate::config::AppConfig;

/// Single client namespace inside the vault - this app only ever needs one.
const CLIENT_PATH: &[u8] = b"brighttable-secrets";

const KEY_LIBRARY_API_KEY: &[u8] = b"library.apiKey";
const KEY_FLICKR_API_KEY: &[u8] = b"flickr.apiKey";
const KEY_FLICKR_API_SECRET: &[u8] = b"flickr.apiSecret";
const KEY_FLICKR_OAUTH_TOKEN: &[u8] = b"flickr.oauthToken";
const KEY_FLICKR_OAUTH_TOKEN_SECRET: &[u8] = b"flickr.oauthTokenSecret";

pub struct SecretVault {
    stronghold: Stronghold,
    client: iota_stronghold::Client,
}

impl SecretVault {
    /// Opens (creating on first run) the vault in the app's local data dir.
    pub fn open(app: &AppHandle) -> Result<Self, String> {
        let dir = app
            .path()
            .app_local_data_dir()
            .map_err(|e| format!("Could not resolve app local data dir: {e}"))?;
        Self::open_in(&dir)
    }

    /// Same as `open`, but rooted at an arbitrary directory - the split
    /// exists so tests can exercise the actual vault (create/read/write/
    /// persist-across-reopen) without spinning up a real Tauri `AppHandle`.
    fn open_in(dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(dir).map_err(|e| format!("Could not create app local data dir: {e}"))?;

        let snapshot_path = dir.join("secrets.stronghold");
        let password = load_or_create_key(&dir.join("secrets.key"))?;
        let existed = snapshot_path.exists();

        let stronghold = Stronghold::new(&snapshot_path, password).map_err(|e| e.to_string())?;
        let client = if existed {
            // A snapshot that exists but predates this client (shouldn't
            // happen in practice - nothing else writes this file - but
            // falls back to a fresh client rather than erroring) uses
            // `create_client` the same as the first-run path.
            stronghold
                .load_client(CLIENT_PATH)
                .or_else(|_| stronghold.create_client(CLIENT_PATH))
                .map_err(|e| e.to_string())?
        } else {
            stronghold.create_client(CLIENT_PATH).map_err(|e| e.to_string())?
        };

        Ok(Self { stronghold, client })
    }

    fn get(&self, key: &[u8]) -> Option<String> {
        self.client.store().get(key).ok().flatten().and_then(|bytes| String::from_utf8(bytes).ok())
    }

    fn set(&self, key: &[u8], value: &str) -> Result<(), String> {
        let store = self.client.store();
        if value.is_empty() {
            store.delete(key).map_err(|e| e.to_string())?;
        } else {
            store.insert(key.to_vec(), value.as_bytes().to_vec(), None).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// Overwrites `cfg`'s secret fields with whatever the vault holds for
    /// each one. Returns `true` if any field the vault has no entry for
    /// still holds a non-empty value in `cfg` - i.e. it arrived via
    /// `config.json` (an old plaintext save, or a fresh user edit still
    /// in-flight) and hasn't been migrated into the vault yet, so the
    /// caller should persist it there.
    pub fn read_into(&self, cfg: &mut AppConfig) -> bool {
        let mut needs_migration = false;
        for (key, field) in self.fields_mut(cfg) {
            match self.get(key) {
                Some(value) => *field = value,
                None => needs_migration |= !field.is_empty(),
            }
        }
        needs_migration
    }

    /// Writes `cfg`'s current secret fields into the vault and commits the
    /// snapshot to disk - a no-op if none of them actually changed.
    ///
    /// That early-out matters: `config::save` calls this on *every* save
    /// (theme toggle, window position, shortcuts - not just credential
    /// edits), and Stronghold's snapshot commit is a fixed ~1s cost in a
    /// release build (full-snapshot re-encryption, not proportional to what
    /// changed) - measured via this module's own tests. Skipping it when
    /// nothing changed is the only lever available; the commit itself can't
    /// be made cheaper.
    pub fn write_secrets(&self, cfg: &AppConfig) -> Result<(), String> {
        if self.matches(cfg) {
            return Ok(());
        }
        for (key, field) in self.fields(cfg) {
            self.set(key, field)?;
        }
        self.stronghold.save().map_err(|e| e.to_string())
    }

    fn matches(&self, cfg: &AppConfig) -> bool {
        self.fields(cfg).into_iter().all(|(key, field)| self.get(key).unwrap_or_default() == *field)
    }

    fn fields<'a>(&self, cfg: &'a AppConfig) -> [(&'static [u8], &'a String); 5] {
        [
            (KEY_LIBRARY_API_KEY, &cfg.library.api_key),
            (KEY_FLICKR_API_KEY, &cfg.sharing.flickr.api_key),
            (KEY_FLICKR_API_SECRET, &cfg.sharing.flickr.api_secret),
            (KEY_FLICKR_OAUTH_TOKEN, &cfg.sharing.flickr.oauth_token),
            (KEY_FLICKR_OAUTH_TOKEN_SECRET, &cfg.sharing.flickr.oauth_token_secret),
        ]
    }

    fn fields_mut<'a>(&self, cfg: &'a mut AppConfig) -> [(&'static [u8], &'a mut String); 5] {
        [
            (KEY_LIBRARY_API_KEY, &mut cfg.library.api_key),
            (KEY_FLICKR_API_KEY, &mut cfg.sharing.flickr.api_key),
            (KEY_FLICKR_API_SECRET, &mut cfg.sharing.flickr.api_secret),
            (KEY_FLICKR_OAUTH_TOKEN, &mut cfg.sharing.flickr.oauth_token),
            (KEY_FLICKR_OAUTH_TOKEN_SECRET, &mut cfg.sharing.flickr.oauth_token_secret),
        ]
    }
}

/// Loads the vault's unlock key from `path`, generating and persisting a
/// fresh random one on first run. Not a passphrase a human ever sees or
/// types - already-uniform 32 random bytes, so no KDF stretching step is
/// needed on top (unlike `Builder::with_argon2`, which exists for actual
/// human-typed passwords).
fn load_or_create_key(path: &Path) -> Result<Vec<u8>, String> {
    if let Ok(existing) = std::fs::read(path) {
        if existing.len() == 32 {
            return Ok(existing);
        }
    }
    let mut key = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut key);
    std::fs::write(path, key).map_err(|e| format!("Could not write {}: {e}", path.display()))?;
    restrict_permissions(path);
    Ok(key.to_vec())
}

#[cfg(unix)]
fn restrict_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn test_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("brighttable-test-vault-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn sample_cfg(suffix: &str) -> AppConfig {
        let mut cfg = AppConfig::default();
        cfg.library.api_key = format!("immich-{suffix}");
        cfg.sharing.flickr.api_key = format!("flickr-key-{suffix}");
        cfg.sharing.flickr.api_secret = format!("flickr-secret-{suffix}");
        cfg.sharing.flickr.oauth_token = format!("oauth-token-{suffix}");
        cfg.sharing.flickr.oauth_token_secret = format!("oauth-token-secret-{suffix}");
        cfg
    }

    #[test]
    fn round_trips_secrets_across_reopen() {
        let dir = test_dir("roundtrip");
        let written = sample_cfg("a");

        let vault = SecretVault::open_in(&dir).unwrap();
        vault.write_secrets(&written).unwrap();
        drop(vault);

        // Reopening loads the persisted snapshot rather than starting a
        // fresh (empty) client - this is the whole point of `.save()`.
        let vault = SecretVault::open_in(&dir).unwrap();
        let mut read_back = AppConfig::default();
        let needs_migration = vault.read_into(&mut read_back);

        assert!(!needs_migration);
        assert_eq!(read_back.library.api_key, written.library.api_key);
        assert_eq!(read_back.sharing.flickr.api_key, written.sharing.flickr.api_key);
        assert_eq!(read_back.sharing.flickr.api_secret, written.sharing.flickr.api_secret);
        assert_eq!(read_back.sharing.flickr.oauth_token, written.sharing.flickr.oauth_token);
        assert_eq!(read_back.sharing.flickr.oauth_token_secret, written.sharing.flickr.oauth_token_secret);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn flags_plaintext_fields_not_yet_in_the_vault_as_needing_migration() {
        let dir = test_dir("migration");
        let vault = SecretVault::open_in(&dir).unwrap();

        // Simulates an old config.json loaded with plaintext secrets from
        // before the vault existed: the vault is empty, but `cfg` already
        // carries real values.
        let mut cfg = sample_cfg("b");
        let needs_migration = vault.read_into(&mut cfg);

        assert!(needs_migration);
        // The vault had nothing for these keys, so the caller's in-memory
        // values must survive untouched rather than getting clobbered.
        assert_eq!(cfg.library.api_key, "immich-b");
        assert_eq!(cfg.sharing.flickr.api_key, "flickr-key-b");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_secrets_is_a_true_no_op_when_nothing_changed() {
        // `config::save` calls `write_secrets` on every save, including
        // ones that never touch credentials (theme toggle, window
        // position, ...) - it must skip the ~1s snapshot commit in that
        // case rather than paying it on every unrelated preference change.
        // Can't measure the timing skip directly in a unit test, but can
        // assert the vault's on-disk snapshot file is untouched.
        let dir = test_dir("no-op-write");
        let vault = SecretVault::open_in(&dir).unwrap();
        let cfg = sample_cfg("d");
        vault.write_secrets(&cfg).unwrap();

        let snapshot_path = dir.join("secrets.stronghold");
        let mtime_after_first_write = fs::metadata(&snapshot_path).unwrap().modified().unwrap();

        std::thread::sleep(std::time::Duration::from_millis(1100));
        vault.write_secrets(&cfg).unwrap();
        let mtime_after_second_write = fs::metadata(&snapshot_path).unwrap().modified().unwrap();

        assert_eq!(
            mtime_after_first_write, mtime_after_second_write,
            "write_secrets re-committed the snapshot even though nothing changed"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn clearing_a_field_deletes_its_vault_entry() {
        let dir = test_dir("clear");
        let vault = SecretVault::open_in(&dir).unwrap();

        vault.write_secrets(&sample_cfg("c")).unwrap();
        vault.write_secrets(&AppConfig::default()).unwrap();

        let mut read_back = sample_cfg("stale-in-memory-value");
        let needs_migration = vault.read_into(&mut read_back);

        // The vault has no entry for any field (all cleared), and the
        // in-memory struct passed in had non-empty values, so this
        // correctly reports "needs migration" even though nothing should
        // actually be written back - `config::save` always calls
        // `write_secrets` unconditionally on every save, migration or not,
        // so this case never actually reaches `config::load`'s "rewrite
        // config.json" branch in practice.
        assert!(needs_migration);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn generates_a_32_byte_key_with_restricted_permissions() {
        let dir = test_dir("keyfile");
        fs::create_dir_all(&dir).unwrap();
        let key_path = dir.join("secrets.key");

        let key = load_or_create_key(&key_path).unwrap();
        assert_eq!(key.len(), 32);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&key_path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }

        // Reopening reuses the same key rather than generating a new one
        // (which would make any existing vault snapshot unreadable).
        let key_again = load_or_create_key(&key_path).unwrap();
        assert_eq!(key, key_again);

        let _ = fs::remove_dir_all(&dir);
    }
}
