# ImmAture

**An LLM coded project. Human generated requirements and testing.**

I designed this for myself because I dislike the user experience and functionality that exists on GNU/Linux for managing and editing photos. For me, it fills the gap between DAM and raw editing. There are some great tools out there already like RawTherapee/ART, Digikam, RapidRAW, Digikam, Shotwell. But to me, none of them had exactly the user experience and workflow that I really wanted. So after a couple of years of threatening myself to build my own tool: I did. 

If you decide to use, please read the warnings below.

**What's in the name?**

Immature: 

- Imm_ = uses Immich as the back end

- _Ature = inspired by Apple Aperture - a great, easy to use photo management tool known for its great user experience. For those that used it in version 1.0 you will remember how buggy it was too.

- Immature = Imature / Amateur - i.e. this is an experiment from a non software developer (but professional tech product manager). The name implies a warning.

**What does it do?**

- Uses Immich and the Immich API as a self hosted asset manager backend

- Uses open source RAW editors for photo processing e.g. ART, RawTherapee. 

- A front end app that uses the above, and creates a (I think) great user experience for managing and editing your photos.

- GNU/Linux only application

**Warning!**

- This tool was created by me, for me. I am giving it to the community to allow others who are interested to use it, fork it and maintain their own copy.

- Use at your own risk! You are responsible for using this tool.

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
