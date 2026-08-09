<img src="screenshots/icon.png" width="96" height="96" alt="ImmAture icon" />

# ImmAture

**An LLM coded project. Human generated requirements and testing.**

I designed this for myself because I dislike the user experience and functionality that exists on GNU/Linux for managing and editing photos. For me, it fills the gap between DAM and raw editing. There are some great tools out there already like RawTherapee/ART, Digikam, RapidRAW, Digikam, Shotwell. But to me, none of them had exactly the user experience and workflow that I really wanted. So after a couple of years of threatening myself to build my own tool: I did. 

If you decide to use, please read the warnings below.

**What's in the name?**

Immature: 

- Imm_ = uses Immich as the back end

- _Ature = inspired by Apple Aperture - a great, easy to use photo management tool known for its great user experience. For those that used it in version 1.0 you will remember how buggy it was too.

- Immature = Immature / Amateur - i.e. this is an experiment from an amateur. The name implies a warning.

**What does it do?**

- Uses Immich and the Immich API as a self hosted asset manager backend

- Uses open source RAW editors for photo processing e.g. ART, RawTherapee. 

- A front end app that uses the above, and creates a (I think) great user experience for managing and editing your photos.

- GNU/Linux only application

**Warning!**

- This tool was created by me, for me. I am giving it to the community to allow others who are interested to use it, fork it and maintain their own copy.

- Use at your own risk! You are responsible for using this tool. Read the code and understand what it does before using it. Test it on a sandbox first.

- You must be technically savvy! I am purposefully going to give as least instruction as possible on how to install and use it. If you can code, use gen AI tools, and run Immich, use opensource RAW editing tools you may find value in this. If you don't I suggest heading in a different direction and use Shotwell, ART, RawTherapee, Darktable or RapidRAW. Those projects are supported by expert developers and well tested. This project is an experiment only.

- As they say, backup backup backup!  

- I may or may not address bugs reported by the community. Likely not, or not fast because I have a job and this is very much a side project. I absolutely don't have the time to deep dive bugs encountered. 

- Features are the enemy of quality! In the interest of keeping it simple I am unlikely to respond to requests to make the tool integrate with other systems.

- Do your own testing to make sure it works in a sandboxed test environment.

- Please, please - fork it! Add your own features to it, repackage it, do something completely different. Consider this a concept and take it in the direction you want it to go. 

**Usage**

Requires Node.js, Rust/Cargo, and the Tauri CLI (`cargo install tauri-cli`) installed.

- Run in dev mode (hot-reloading frontend + native window): `cd Immature && cargo tauri dev`

- Build a distributable AppImage: `cd Immature && npm run build:appimage`

  Output lands at `Immature/src-tauri/target/release/bundle/appimage/ImmAture_<version>_amd64.AppImage`.

  Note: on some distros with very new glibc/binutils, the bundled `linuxdeploy` tool's `strip` binary can't parse newer libraries and fails the build — `build:appimage` already sets `NO_STRIP=1` to work around this.

  Each run of `build:appimage` auto-bumps the patch version in `src-tauri/Cargo.toml` first (e.g. `0.1.0` → `0.1.1`) — that's the single source of truth for the app version; `tauri.conf.json` and the AppImage filename both inherit it. Nothing is committed automatically — commit the version bump yourself (`git add Immature/src-tauri/Cargo.toml Immature/src-tauri/Cargo.lock`) if/when you want it in history. Bump major/minor by hand by editing the `version` line in `Cargo.toml` directly.

  If you tested this build against a specific Immich server version, set `TESTED_IMMICH_VERSION` so the version bump also updates the About dialog's compatibility line, e.g. `TESTED_IMMICH_VERSION=3.0.1 npm run build:appimage`. Still update [COMPATIBILITY.md](COMPATIBILITY.md) by hand — that isn't automated.

- Seeing `Permission denied` errors when ImmAture writes metadata over NFS (e.g. Immich + Unraid)? See [Troubleshooting: NFS Permission Errors](#troubleshooting-nfs-permission-errors-immich--unraid) below.

- Not sure if your Immich server version is supported? See [COMPATIBILITY.md](COMPATIBILITY.md) for which Immich version each ImmAture release has actually been tested against.

## Troubleshooting: NFS Permission Errors (Immich + Unraid)

**Symptom:** ImmAture throws a permission error writing metadata (ratings, tags, etc.) to photos — either in an **external library** mounted into Immich, or in **Immich's own managed upload library** — even though the Docker mount shows `rw`, the Immich container runs as root, and the folder looks writable when checked directly on the Unraid host.

**Root cause** (two variants, both boiling down to a UID/GID mismatch over NFS):

1. **External library folders** are typically owned by whatever UID/GID they were originally created under, with restrictive bits (e.g. `drwxr-xr-x`) that don't grant write access to your NFS client user.
2. **Immich-managed upload library folders** are created by the Immich container itself, usually owned by Unraid's default `nobody` user (uid 99, group `users`) with standard `644`/`755` permissions. Your client connects over NFS as a different UID (e.g. `rbrown` = uid 1000) — the kernel enforces permissions by numeric UID, not username, so the mismatch blocks the write even though both "look" like valid users.

**Why ACLs don't fix it:** setting a POSIX ACL (`setfacl`) on the Unraid host — even directly on the underlying ZFS dataset with `posixacl` enabled — doesn't reliably propagate over Unraid's `shfs` FUSE union export path (`/mnt/user/...`). `getfacl` from the NFS client shows no ACL entries at all, even though the ACL is present server-side. Go straight to `chown`/`chmod` instead.

**The fix:** apply a blunt permissions reset directly on the **underlying disk path** (not the `/mnt/user/...` shfs union path — find the real disk with `ls -la /mnt/disk*/...`):

```bash
chown -R nobody:users /mnt/bigdisk/Rob/Immich_Uploaded/library
chmod -R 777 /mnt/bigdisk/Rob/Immich_Uploaded/library
```

Plain POSIX permission bits transmit reliably over NFS even though ACLs don't. Substitute the correct disk path for the external library if different.

**Why it breaks again, and the permanent fix:** a one-off `chmod -R 777` only fixes files that exist at that moment — any file Immich creates afterward gets its default ownership/permissions again, so the error recurs on new photos. The official `ghcr.io/immich-app/immich-server` image doesn't support `PUID`/`PGID`/`UMASK` (that's a linuxserver.io convention, not used here), so there's no simple env-var fix. Instead, set up a recurring fix via Unraid's **User Scripts** plugin:

1. Install **User Scripts** from Community Applications, if not already installed.
2. **User Scripts** tab → **Add New Script** (e.g. `fix-immich-library-perms`).
3. Script contents:
   ```bash
   #!/bin/bash
   chmod -R 777 /mnt/bigdisk/Rob/Immich_Uploaded/library
   ```
   Add more `chmod -R 777 ...` lines for any external library path(s) too.
4. Schedule it (e.g. nightly, or a cron expression like `0 3 * * *`), and optionally run it once manually to confirm it works immediately.

*Higher-risk alternative, not recommended without testing:* run the Immich container as your own UID (`--user 1000:100` in the Unraid Docker template) so new files are owned correctly from creation. This avoids the recurring script but risks breaking permissions on `/config` (appdata) and other mounted paths that may currently be owned by root or a different UID.

**If this recurs on a different library/folder later**, work through in order: confirm the Docker mount is `rw` (`docker inspect`), confirm the container's UID (`docker exec ... id`), check ownership as Immich sees it (`docker exec ... ls -la /path/inside/container`), check for ACLs from the client (`getfacl` — if empty, skip straight to `chown`/`chmod`), find the real underlying disk path rather than fixing only `/mnt/user/...`, apply the `chown`/`chmod` fix above, and add it to the scheduled User Script if it's a folder Immich actively writes new files into.
