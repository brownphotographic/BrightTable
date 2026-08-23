<img src="requirements/BrightTable-icon.svg" width="96" height="96" alt="BrightTable icon" />

# BrightTable // Copyright (C) 2026 Rob Brown

**A desktop viewer for Linux desktop, connecting Immich and open source RAW editors into a seamless experience**
_An LLM coded project. Human generated requirements and testing._

I designed this for myself because I dislike the user experience and functionality that exists on GNU/Linux for managing and editing photos. For me, this gap it fills the gap between DAM and raw editing and honestly an experience I have been pining for since the great Apple Aperture bit the dust a decade ago. There are some great tools out there already like RawTherapee/ART, Digikam, RapiddRAW, Digikam, Shotwell. But to me, none of them had exactly the user experience and workflow that I really wanted. So after a couple of years of threatening myself to build my own tool: I did. 

While this tool uses LLMs to generate code, the concept, requirements, and testing is performed by the author. I absolutely hate the term 'vibe coding'. This is Human Reqs --> LLM Coding --> Human Testing.

If you disagree, take your neo-luddite principles elsewhere.

If you decide to use this, please read the warnings below.

**What does it do?**
_Background (the inspiration):_
For those of you who have actually used a real light table and loupe to view transparency film you will understand the purpose of this tool. Light tables to me were the most enjoyable part of my photography workflow back when I shot film: heading to my local pro film label, getting that processed film back and sticking it on their light table to view the goods. It was fun, and tactile.

As I entered the digital world in 2005 I intially used tools like Pixmantec Rawshooter (Adobe bought them out and it became Lightroom), and in 2006 the great Apple Aperture. Aperture was a rare tool that had a great user experience and brought it all together.

Since moving over to Linux I have been trying to find the perfect experience, but could not find it all in one package. Where I ended up before this tool...
- Shotwell for desktop DAM, printing, and culling. Great UX. But struggled with larger libraries. Round trip experience to raw editor basic. Also didn't play nice with my network share connected to Immich. 
- ART for raw editing. As a fork of RawTherapee this has the quality and look and feel I wanted with great film like rendering, and a simple UX.
- Immich. A self hosted DAM with API and great phone app for auto upload and viewing. Super snappy. It just never played well with my dedicated camera RAW editing workflow.

So really what I was yearning for was a tool to tie the raw editing and  server based DAM together, with a first class user experience like Shotwell has. 

Let's call this need a 'digital light table'.

_How it works:_

- The library: Uses Immich and the Immich API as a self hosted asset manager backend. It will not work without Immich!
- Processing: Uses open source RAW editors for photo processing e.g. ART, RawTherapee. 
- The light table (this app): A front end app that uses the above, and creates a (I think) great user experience for editing your photos.

**Warning!**

- This tool was created by me, for me. I am giving it to the community to allow others who are interested to use it, and accept the risks involved.

- Use at your own risk! You are responsible for using this tool. Read the code and understand what it does before using it. Test it on a sandbox first.

- If you use Immich, and use the excellent opensource RAW editing tools: ART, RawTherapee, Darktable, then you will be able to use this tool. If you don't, then sorry this is not for you.

- As they say, backup backup backup!  

- I may or may not address bugs reported by the community. I have a full time job and this is very much a side project in my spare time. I  don't have the time to deep dive bugs encountered because of differences in your setup. Sorry.

- Features are the enemy of quality! In the interest of keeping it simple I am unlikely to respond to new feature requests. You are welcome to submit a pull request with a bug fix, or a feature request that you are willing to implement yourself. However I want to keep this application primarily a simple, quality-focused tool with a user experience that is easy to use and understand. I therefore may reject pull requests for new features if I don't feel they fit the project's goals.

- That said you are welcome to fork the code! Add your own features to it, repackage it, do something completely different. Consider this a concept and take it in the direction you want it to go. 

**Usage**

For a basic user manual read this [User-Guide.md](User-Guide.md)

_System requirements:_

- Designed and tested on GNU/Linux only. While it technically could be extended to Mac or Windows, I don't have either platform to test and to be honest life is way better on Linux. 
- Requires Node.js, Rust/Cargo, and the Tauri CLI (`cargo install tauri-cli`) installed.
- To use the executable AppImage, your distro needs glibc 2.39 or newer (check yours with `ldd --version`). As a reference point, that's:
  - Ubuntu 24.04 LTS or later (or downstream variants, e.g. Linux Mint 22+, Pop!_OS 24.04+)
  - Debian 13 "trixie" or later (Debian 12 doesn't qualify — its glibc is frozen at 2.36)
  - Fedora 40 or later
  - Rolling-release distros (Arch, openSUSE Tumbleweed) are effectively always ahead of this floor
- Running the AppImage itself needs no dev packages or kernel headers - those are only relevant if you're building from source yourself (see Developers below). One separate gotcha: some newer distros (Ubuntu 22.04+, Fedora) dropped `libfuse2` from the default install, which AppImages need to mount themselves — install `libfuse2`, or run the AppImage with `--appimage-extract-and-run` if you'd rather not. If you get stuck, an LLM (e.g. Claude, ChatGPT) can help you troubleshoot and get you going.
- A Flatpak build is also available as a second, sandboxed distribution option — see "Building a Flatpak" under Developers below if you'd rather build one yourself than trust the pre-built AppImage. It needs a couple of one-time permission grants beyond the AppImage's "just works" default (documented there), since this app talks to external editors and arbitrary library paths that a stock sandbox wouldn't otherwise see.

_How to use:_
- Executable: A stable AppImmage version is included here [https://github.com/brownphotographic/BrightTable/releases/tag/production](https://github.com/brownphotographic/BrightTable/releases/tag/production). I recommend using GearLever to manage your AppImages.

_Developers:_

**Prerequisites**

- [Rust via rustup](https://rustup.rs) — Debian/Ubuntu's packaged `rustc` is too old for Tauri 2.x, so use rustup even on Linux.
- Node.js 20+ (Debian/Ubuntu's apt package is often too old — use [nvm](https://github.com/nvm-sh/nvm) or your distro's Node setup instead).
- Tauri CLI: `cargo install tauri-cli --version "^2"`.
- Linux system packages (Debian/Ubuntu names — adjust for your distro):
  ```bash
  sudo apt update
  sudo apt install -y libwebkit2gtk-4.1-dev libglib2.0-dev build-essential curl wget file \
    libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev pkg-config
  ```

**Dev mode** (hot-reloading frontend + native window):
```bash
cd app && cargo tauri dev
```

**Building a distributable AppImage**

An AppImage bundles WebKitGTK and its dependency tree (glib, codec libs, etc.) straight from
whatever machine you build on, and links all of it — including your own compiled binary — against
that machine's glibc. glibc's forward-compatibility guarantee only runs one way: a binary built
against glibc *X* runs on any host with glibc *X or newer*, never older. So **the distro/version you
build on becomes the oldest distro your AppImage will run on** — build on something newer than that
and every user on an older system hits `GLIBC_X.YY' not found` errors, even though nothing about
their setup is actually broken.

Pick a build host old enough to cover whoever you want to support, then either build on it directly
or spin up a throwaway container for it (recommended, so it doesn't disturb your day-to-day machine).
[distrobox](https://distrobox.it) is the easiest way to do this on Linux since it shares your home
directory with the container, so `cargo`/`npm` caches persist across runs:

```bash
distrobox create --name brighttable-build --image ubuntu:24.04
distrobox enter brighttable-build
# inside the container: install the prerequisites above, then:
cd /path/to/BrightTable/app
npm install
npm run build:appimage
```

(Swap `ubuntu:24.04` for whatever base you want as your compatibility floor — e.g. `debian:12` goes
further back at the cost of an older bundled WebKitGTK; see the Compatibility section under
Troubleshooting below for the actual trade-off.)

**Gotcha: `cargo-tauri: ... GLIBC_2.4X' not found (required by /home/you/.cargo/bin/cargo-tauri)`
when running `cargo tauri build` *inside* the container.** This is the same glibc mismatch again,
just hitting your own tooling instead of the shipped AppImage. distrobox shares your home directory
with the container (that's what makes `cargo`/`npm` caches persist across runs), which also means
`~/.cargo/bin` is shared — if `cargo install tauri-cli` was ever run on a newer host (e.g. your
day-to-day Fedora machine), that binary is linked against *that* host's glibc, and your older
container can't execute it. Fix by reinstalling it from inside the container, so it gets rebuilt
against the container's (older) glibc:
```bash
cargo install tauri-cli --version "^2" --force
```
This is safe to do from inside the container — the rebuilt binary needs only the container's older
glibc, so it still runs fine back on your newer host afterwards (older-build-runs-on-newer-host always
works, never the reverse). If the build itself misbehaves after this rather than just failing to
launch, `src-tauri/target/` may also have stale artifacts from a newer host sharing the same home
directory — `cargo clean` inside the container, or point `CARGO_TARGET_DIR` at a container-only path,
to rule that out.

- `npm run build:appimage` runs the full release pipeline: prompts for the app version and the
  Immich server version this build was tested against (or reads `APP_VERSION`/`TESTED_IMMICH_VERSION`
  from the env non-interactively), bumps versions, regenerates `THIRD-PARTY-LICENSES.md`, then builds.
  Version convention: `First.Second.Third` — First = sweeping changes, Second = new features
  (keeps incrementing, e.g. `1.101.0` is fine), Third = bug fixes.
- `npm run build:appimage:only` skips straight to `cargo tauri build --bundles appimage` + the
  GStreamer AppRun fix, reusing whatever version is already in `Cargo.toml` — no prompts, nothing
  else touched. Use this while iterating/debugging the build itself (e.g. testing a new build host)
  so you're not re-answering prompts or regenerating the license file every run. It's still a real
  `cargo tauri build`, so the first run in a fresh environment compiles the whole Rust dependency
  tree; later runs are incremental as long as `src-tauri/target` persists.
- Set `TESTED_IMMICH_VERSION` (e.g. `TESTED_IMMICH_VERSION=3.0.1 npm run build:appimage`) so the
  version bump also updates the About dialog's compatibility line. Still update
  [COMPATIBILITY.md](COMPATIBILITY.md) by hand afterwards — that part isn't automated.
- Output lands at `app/src-tauri/target/release/bundle/appimage/BrightTable_<version>_amd64.AppImage`.

**Building a Flatpak**

A second, additive distribution option (the AppImage above stays the default/simplest path) — a sandboxed
build for anyone who'd rather not run an app with full, unprompted host access. Unlike the AppImage, this
compiles from source *inside* `flatpak-builder`'s own sandbox, against the GNOME runtime/SDK's own toolchain and glibc — so the whole "pick an old enough build host" dance the AppImage needs doesn't apply here; the result's compatibility floor is whatever GNOME runtime version it's built against, the same for every user regardless of which machine ran the build.

One-time host setup (this runs on your actual host, *not* inside the AppImage's distrobox container —
`flatpak-builder` needs its own sandboxing tools and the runtime/SDK installed via `flatpak install`, an
unrelated concern from that container's glibc-floor purpose):
```bash
sudo apt install -y flatpak flatpak-builder   # or your distro's equivalent
flatpak remote-add --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo
flatpak install -y flathub org.gnome.Platform//50 org.gnome.Sdk//50 \
  org.freedesktop.Sdk.Extension.rust-stable//25.08 org.freedesktop.Sdk.Extension.node22//25.08
```
The two SDK extensions need that explicit `//25.08` branch — `org.gnome.Sdk//50` doesn't declare an
automatic version remap for them (confirmed via `flatpak info --show-metadata org.gnome.Sdk//50`), and
Flathub only publishes them under freedesktop-sdk's own year.month branches, never under GNOME's "50". `50`
happens to be built against freedesktop-sdk `25.08` (visible in its own `org.freedesktop.Platform.GL`/
`.Timezones` extension points), so that's the correct, ABI-matching branch to pin — not a workaround. The
manifest's `add-build-extensions` block pins the same branch for the actual build; if a future GNOME runtime
bump changes this, `flatpak info --show-metadata org.gnome.Sdk//<version>` is how to find the right one
again.

Then, from `app/`:
```bash
npm run build:flatpak
```
Output lands at `app/src-tauri/target/release/bundle/flatpak/BrightTable_<version>_x86_64.flatpak`.

**Installing it:**

1. Install the bundle:
   ```bash
   flatpak install --user src-tauri/target/release/bundle/flatpak/BrightTable_<version>_x86_64.flatpak
   ```
   (Drop `--user` for a system-wide install instead, which needs root via polkit. Double-clicking the
   `.flatpak` file in Files/GNOME Software does a system-wide install too, same end result.)

2. **Grant network access — required, not optional.** The manifest's `finish-args` doesn't include
   `--share=network` (only `build-options.build-args` does, and that only applies during the
   `flatpak-builder` build itself — it has zero effect on the installed app's runtime permissions).
   Without this grant, BrightTable can't reach your Immich server at all; you'll get connection errors
   the moment you try to configure a library in Preferences. Either:
   ```bash
   flatpak override --user --share=network io.github.brownphotographic.BrightTable
   ```
   or in [Flatseal](https://github.com/tingping/flatseal): select **BrightTable** from the app list,
   then toggle **Network** on — it's one of the top-level switches on the app's permissions page,
   not nested under Filesystem/Session Bus/System Bus/Sockets.

3. Confirm it installed and check which kind:
   ```bash
   flatpak info io.github.brownphotographic.BrightTable   # shows "Installation: user" or "Installation: system"
   ```

4. Launch it — either from your app menu as "BrightTable", or directly from a terminal:
   ```bash
   flatpak run io.github.brownphotographic.BrightTable
   ```

5. If your photo library lives outside `$HOME` (e.g. an NFS-mounted External Library), grant that path
   too — same CLI-override/Flatseal pattern as step 2, see "What this actually does under the hood"
   below for the exact command.

**Updating after a rebuild:** this is a local bundle install with no remote to track, so `flatpak update`
won't find a newer build on its own — reinstall over the old one instead (same `--user`/system choice as
above, matching however it's currently installed):
```bash
flatpak install --user --reinstall src-tauri/target/release/bundle/flatpak/BrightTable_<version>_x86_64.flatpak
```

**Uninstalling:**
```bash
flatpak uninstall io.github.brownphotographic.BrightTable
```

*What this actually does under the hood* — the manifest lives at
[`flatpak/io.github.brownphotographic.BrightTable.yml`](app/flatpak/io.github.brownphotographic.BrightTable.yml).
Worth reading before you build, since it grants real permissions on your behalf:
- `--filesystem=home` for your photo library — deliberately not the broader `--filesystem=host`. If your
  library (or an NFS-mounted "External Library", per this app's own Immich pattern) lives outside `$HOME`,
  the sandbox can't see it until you grant that specific path yourself, either via
  [Flatseal](https://github.com/tingping/flatseal) (Filesystem tab → add the path) or:
  ```bash
  flatpak override --user --filesystem=/path/to/your/library io.github.brownphotographic.BrightTable
  ```
- `--talk-name=org.freedesktop.Flatpak` — lets the app launch host editors/CLI tools (ART, RawTherapee,
  exiftool, CUPS's `lp`/`lpstat`, `xdg-open`) via `flatpak-spawn --host` from inside the sandbox, since a
  sandboxed process can't exec a host binary directly (it doesn't share the host's library namespace). See
  `app/src-tauri/src/flatpak.rs` for the wrapper this backs.
- `--filesystem=host-os:ro` plus an explicit read-only grant for Snap's desktop-export directory — so the
  app's editor auto-detection (which scans `.desktop` files under `/usr/share/applications` etc.) still
  finds natively-installed editors. **Known limitation:** even with this, editors installed somewhere
  unusual may not show up in the auto-detected list the way they do in the AppImage build — use
  Preferences → Applications → "Other application…" to browse to it directly, which always works
  regardless of sandboxing.
- `--talk-name=org.freedesktop.FileManager1` and `--system-talk-name=org.freedesktop.login1` for "Show in
  File Manager" and the suspend-inhibit guard around long NFS operations, respectively — both cross the
  sandbox over D-Bus rather than `flatpak-spawn`, so they just need the permission grant, nothing else.

*Trade-off, stated plainly:* the build uses `--share=network` to let `cargo`/`npm` resolve dependencies
live during the `flatpak-builder` build, rather than vendoring every dependency offline the way a Flathub
submission would require. Fine for building your own copy; would need real dependency vendoring
(`flatpak-cargo-generator`/`flatpak-node-generator`) before this could ever go on Flathub.

*Also worth knowing:* part of the motivation for adding this was the hope that a Flatpak's own bundled
WebKitGTK (from the GNOME runtime, likely a different/newer version than whatever your AppImage build host
shipped) sidesteps WebKitGTK-version-specific rendering bugs the AppImage can hit — this hasn't been
confirmed either way and should be treated as speculative until tested on an actual affected machine.

## Troubleshooting:

_Compatibility_

- Not sure if your Immich server version is supported? See [COMPATIBILITY.md](COMPATIBILITY.md) for which Immich version each BrightTable release has actually been tested against.
- On some distros with very new glibc/binutils, the bundled `linuxdeploy` tool's `strip` binary can't parse newer libraries and fails the build — `build:appimage` already sets `NO_STRIP=1` to work around this.
- **Seeing `libc.so.6: version GLIBC_2.4X' not found` (or similar) running the AppImage?** That means it was built on a newer distro than yours — see "Building a distributable AppImage" above for why, and rebuild on an older base (e.g. `ubuntu:24.04` or `debian:12` in a container) to widen compatibility. Roughly:

  | Build host | glibc | Runs on |
  |---|---|---|
  | Ubuntu 24.04 LTS | 2.39 | Ubuntu 24.04+, Debian 13+, Fedora 40+ |
  | Debian 12 "bookworm" | 2.36 | + Ubuntu 22.04, Debian 12, Fedora 37+ |

  Going further back than Debian 12 isn't recommended — WebKitGTK gets rebased to newer upstream releases via each distro's normal security updates, so the bundled engine isn't frozen at whatever the build host originally shipped, but it does still start from that base.

- **AppImage launches (window opens) but shows a blank white page, with the terminal printing `Could not create default EGL display: EGL_BAD_PARAMETER. Aborting...`?** This is a different bug from the glibc one above, and no WebKit/GDK env var fixes it (`WEBKIT_DISABLE_COMPOSITING_MODE`, `WEBKIT_DISABLE_DMABUF_RENDERER`, `GDK_BACKEND=x11`, `GDK_GL=disable` all had zero effect when this was actually hit). Root cause: `linuxdeploy`'s GTK plugin bundled `libwayland-egl.so.1` — the Wayland↔EGL glue library — straight from the build host, and the runtime host loads that frozen copy instead of its own matching one, so EGL init fails outright when the two don't negotiate cleanly (hit going from an Ubuntu 24.04 build host to a much newer Fedora 44 runtime host). Like `libEGL`/`libGL`/`libgbm`, this library should never be bundled — it must always come from the runtime host. `build:appimage`/`build:appimage:only` already run `scripts/fix-appimage-bundled-gl-libs.mjs` to strip it from the bundle post-build, so the app falls through to the runtime host's own copy. If a *different* GPU-driver-adjacent library ends up bundled and causes the same symptom, add its filename pattern to `excludePatterns` in that script.

_NFS Permission Errors (Immich + Unraid)_
Seeing `Permission denied` errors when BrightTable writes metadata over NFS (e.g. Immich + Unraid)?

**Symptom:** BrightTable throws a permission error writing metadata (ratings, tags, etc.) to photos — either in an **external library** mounted into Immich, or in **Immich's own managed upload library** — even though the Docker mount shows `rw`, the Immich container runs as root, and the folder looks writable when checked directly on the Unraid host.

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
