# Third-Party Licenses

BrightTable is distributed under the GNU General Public License v3.0 (see `LICENSE`). It is built on
the open-source packages listed below, each under its own license. This file
lists the package name, version, SPDX license identifier, and source
repository for every direct and transitive dependency, generated from
`Cargo.lock` (Rust/Tauri, via `cargo-license`) and `package-lock.json`
(frontend, via `license-checker`).

Full license text for any package can be found in its source repository
linked below, or in the corresponding file under `node_modules/<pkg>/LICENSE`
or the crate's source on crates.io.

This file is generated automatically by `app/scripts/gen-third-party-licenses.mjs`
as part of `npm run build:appimage` - do not edit it by hand.

## Frontend dependencies (npm)

| Package | Version | License | Repository |
|---|---|---|---|
| @tanstack/react-virtual | 3.14.5 | MIT | https://github.com/TanStack/virtual |
| @tanstack/virtual-core | 3.17.3 | MIT | https://github.com/TanStack/virtual |
| @tauri-apps/api | 2.11.1 | Apache-2.0 OR MIT | https://github.com/tauri-apps/tauri |
| @tauri-apps/plugin-dialog | 2.7.1 | MIT OR Apache-2.0 | https://github.com/tauri-apps/plugins-workspace |
| @tauri-apps/plugin-opener | 2.5.4 | MIT OR Apache-2.0 | https://github.com/tauri-apps/plugins-workspace |
| react | 19.2.7 | MIT | https://github.com/facebook/react |
| react-dom | 19.2.7 | MIT | https://github.com/facebook/react |
| scheduler | 0.27.0 | MIT | https://github.com/facebook/react |
| thumbhash | 0.1.1 | MIT | https://github.com/evanw/thumbhash |

9 packages.

## Backend dependencies (Rust / Tauri, via Cargo)

| Package | Version | License | Repository |
|---|---|---|---|
| adler2 | 2.0.1 | 0BSD OR Apache-2.0 OR MIT | https://github.com/oyvindln/adler2 |
| adler32 | 1.2.0 | Zlib | https://github.com/remram44/adler32-rs |
| aead | 0.5.2 | Apache-2.0 OR MIT | https://github.com/RustCrypto/traits |
| aes | 0.8.4 | Apache-2.0 OR MIT | https://github.com/RustCrypto/block-ciphers |
| aes-gcm | 0.10.3 | Apache-2.0 OR MIT | https://github.com/RustCrypto/AEADs |
| ahash | 0.7.8 | Apache-2.0 OR MIT | https://github.com/tkaitchuck/ahash |
| aho-corasick | 1.1.4 | MIT OR Unlicense | https://github.com/BurntSushi/aho-corasick |
| alloc-no-stdlib | 2.0.4 | BSD-3-Clause | https://github.com/dropbox/rust-alloc-no-stdlib |
| alloc-stdlib | 0.2.4 | BSD-3-Clause | https://github.com/dropbox/rust-alloc-no-stdlib |
| allocator-api2 | 0.2.21 | Apache-2.0 OR MIT | https://github.com/zakarumych/allocator-api2 |
| android_log-sys | 0.3.2 | Apache-2.0 OR MIT | https://github.com/rust-mobile/android_log-sys-rs |
| android_logger | 0.15.1 | Apache-2.0 OR MIT | https://github.com/rust-mobile/android_logger-rs |
| android_system_properties | 0.1.5 | Apache-2.0 OR MIT | https://github.com/nical/android_system_properties |
| anyhow | 1.0.103 | Apache-2.0 OR MIT | https://github.com/dtolnay/anyhow |
| arrayref | 0.3.9 | BSD-2-Clause | https://github.com/droundy/arrayref |
| arrayvec | 0.7.8 | Apache-2.0 OR MIT | https://github.com/bluss/arrayvec |
| async-broadcast | 0.7.2 | Apache-2.0 OR MIT | https://github.com/smol-rs/async-broadcast |
| async-channel | 2.5.0 | Apache-2.0 OR MIT | https://github.com/smol-rs/async-channel |
| async-executor | 1.14.0 | Apache-2.0 OR MIT | https://github.com/smol-rs/async-executor |
| async-io | 2.6.0 | Apache-2.0 OR MIT | https://github.com/smol-rs/async-io |
| async-lock | 3.4.2 | Apache-2.0 OR MIT | https://github.com/smol-rs/async-lock |
| async-process | 2.5.0 | Apache-2.0 OR MIT | https://github.com/smol-rs/async-process |
| async-recursion | 1.1.1 | Apache-2.0 OR MIT | https://github.com/dcchut/async-recursion |
| async-signal | 0.2.14 | Apache-2.0 OR MIT | https://github.com/smol-rs/async-signal |
| async-task | 4.7.1 | Apache-2.0 OR MIT | https://github.com/smol-rs/async-task |
| async-trait | 0.1.89 | Apache-2.0 OR MIT | https://github.com/dtolnay/async-trait |
| atk | 0.18.2 | MIT | https://github.com/gtk-rs/gtk3-rs |
| atk-sys | 0.18.2 | MIT | https://github.com/gtk-rs/gtk3-rs |
| atomic-waker | 1.1.2 | Apache-2.0 OR MIT | https://github.com/smol-rs/atomic-waker |
| autocfg | 1.5.1 | Apache-2.0 OR MIT | https://github.com/cuviper/autocfg |
| base16ct | 0.2.0 | Apache-2.0 OR MIT | https://github.com/RustCrypto/formats/tree/master/base16ct |
| base64 | 0.13.1 | Apache-2.0 OR MIT | https://github.com/marshallpierce/rust-base64 |
| base64 | 0.21.7 | Apache-2.0 OR MIT | https://github.com/marshallpierce/rust-base64 |
| base64 | 0.22.1 | Apache-2.0 OR MIT | https://github.com/marshallpierce/rust-base64 |
| base64 | 0.23.1 | Apache-2.0 OR MIT | https://github.com/marshallpierce/rust-base64 |
| base64ct | 1.8.3 | Apache-2.0 OR MIT | https://github.com/RustCrypto/formats |
| bincode | 1.3.3 | MIT | https://github.com/servo/bincode |
| bit-set | 0.8.0 | Apache-2.0 OR MIT | https://github.com/contain-rs/bit-set |
| bit-vec | 0.8.0 | Apache-2.0 OR MIT | https://github.com/contain-rs/bit-vec |
| bitflags | 1.3.2 | Apache-2.0 OR MIT | https://github.com/bitflags/bitflags |
| bitflags | 2.13.0 | Apache-2.0 OR MIT | https://github.com/bitflags/bitflags |
| bitvec | 1.1.1 | MIT | https://github.com/bitvecto-rs/bitvec |
| blake2 | 0.10.6 | Apache-2.0 OR MIT | https://github.com/RustCrypto/hashes |
| blake2b_simd | 1.0.4 | MIT | https://github.com/oconnor663/blake2_simd |
| blake3 | 1.8.5 | Apache-2.0 OR Apache-2.0 WITH LLVM-exception OR CC0-1.0 | https://github.com/BLAKE3-team/BLAKE3 |
| block-buffer | 0.10.4 | Apache-2.0 OR MIT | https://github.com/RustCrypto/utils |
| block-padding | 0.3.3 | Apache-2.0 OR MIT | https://github.com/RustCrypto/utils |
| block2 | 0.6.2 | MIT | https://github.com/madsmtm/objc2 |
| blocking | 1.6.2 | Apache-2.0 OR MIT | https://github.com/smol-rs/blocking |
| borsh | 1.7.0 | Apache-2.0 OR MIT | https://github.com/near/borsh-rs |
| borsh-derive | 1.7.0 | Apache-2.0 | https://github.com/near/borsh-rs |
| brotli | 8.0.4 | BSD-3-Clause AND MIT | https://github.com/dropbox/rust-brotli |
| brotli-decompressor | 5.0.3 | BSD-3-Clause OR MIT | https://github.com/dropbox/rust-brotli-decompressor |
| bs58 | 0.5.1 | Apache-2.0 OR MIT | https://github.com/Nullus157/bs58-rs |
| bumpalo | 3.20.3 | Apache-2.0 OR MIT | https://github.com/fitzgen/bumpalo |
| byte-unit | 5.2.5 | MIT | https://github.com/magiclen/byte-unit |
| bytecheck | 0.6.12 | MIT | https://github.com/djkoloski/bytecheck |
| bytecheck_derive | 0.6.12 | MIT | https://github.com/djkoloski/bytecheck |
| bytemuck | 1.25.0 | Apache-2.0 OR MIT OR Zlib | https://github.com/Lokathor/bytemuck |
| byteorder | 1.5.0 | MIT OR Unlicense | https://github.com/BurntSushi/byteorder |
| byteorder-lite | 0.1.0 | MIT OR Unlicense | https://github.com/image-rs/byteorder-lite |
| bytes | 1.12.0 | MIT | https://github.com/tokio-rs/bytes |
| cairo-rs | 0.18.5 | MIT | https://github.com/gtk-rs/gtk-rs-core |
| cairo-sys-rs | 0.18.2 | MIT | https://github.com/gtk-rs/gtk-rs-core |
| camino | 1.2.4 | Apache-2.0 OR MIT | https://github.com/camino-rs/camino |
| cargo_metadata | 0.19.2 | MIT | https://github.com/oli-obk/cargo_metadata |
| cargo_toml | 0.22.3 | Apache-2.0 OR MIT | https://gitlab.com/lib.rs/cargo_toml |
| cargo-platform | 0.1.9 | Apache-2.0 OR MIT | https://github.com/rust-lang/cargo |
| cc | 1.2.65 | Apache-2.0 OR MIT | https://github.com/rust-lang/cc-rs |
| cesu8 | 1.1.0 | Apache-2.0 OR MIT | https://github.com/emk/cesu8-rs |
| cfb | 0.7.3 | MIT | https://github.com/mdsteele/rust-cfb |
| cfg_aliases | 0.2.1 | MIT | https://github.com/katharostech/cfg_aliases |
| cfg-expr | 0.15.8 | Apache-2.0 OR MIT | https://github.com/EmbarkStudios/cfg-expr |
| cfg-if | 1.0.4 | Apache-2.0 OR MIT | https://github.com/rust-lang/cfg-if |
| chacha20 | 0.9.1 | Apache-2.0 OR MIT | https://github.com/RustCrypto/stream-ciphers |
| chacha20 | 0.10.1 | Apache-2.0 OR MIT | https://github.com/RustCrypto/stream-ciphers |
| chacha20poly1305 | 0.10.1 | Apache-2.0 OR MIT | https://github.com/RustCrypto/AEADs/tree/master/chacha20poly1305 |
| chrono | 0.4.45 | Apache-2.0 OR MIT | https://github.com/chronotope/chrono |
| cipher | 0.4.4 | Apache-2.0 OR MIT | https://github.com/RustCrypto/traits |
| combine | 4.6.7 | MIT | https://github.com/Marwes/combine |
| concurrent-queue | 2.5.0 | Apache-2.0 OR MIT | https://github.com/smol-rs/concurrent-queue |
| const-oid | 0.9.6 | Apache-2.0 OR MIT | https://github.com/RustCrypto/formats/tree/master/const-oid |
| constant_time_eq | 0.1.5 | CC0-1.0 | https://github.com/cesarb/constant_time_eq |
| constant_time_eq | 0.3.1 | Apache-2.0 OR CC0-1.0 OR MIT-0 | https://github.com/cesarb/constant_time_eq |
| constant_time_eq | 0.4.2 | Apache-2.0 OR CC0-1.0 OR MIT-0 | https://github.com/cesarb/constant_time_eq |
| cookie | 0.18.1 | Apache-2.0 OR MIT | https://github.com/SergioBenitez/cookie-rs |
| core-foundation | 0.10.1 | Apache-2.0 OR MIT | https://github.com/servo/core-foundation-rs |
| core-foundation-sys | 0.8.7 | Apache-2.0 OR MIT | https://github.com/servo/core-foundation-rs |
| core-graphics | 0.25.0 | Apache-2.0 OR MIT | https://github.com/servo/core-foundation-rs |
| core-graphics-types | 0.2.0 | Apache-2.0 OR MIT | https://github.com/servo/core-foundation-rs |
| cpufeatures | 0.2.17 | Apache-2.0 OR MIT | https://github.com/RustCrypto/utils |
| cpufeatures | 0.3.0 | Apache-2.0 OR MIT | https://github.com/RustCrypto/utils |
| crc32fast | 1.5.0 | Apache-2.0 OR MIT | https://github.com/srijs/rust-crc32fast |
| crossbeam-channel | 0.5.15 | Apache-2.0 OR MIT | https://github.com/crossbeam-rs/crossbeam |
| crossbeam-utils | 0.8.21 | Apache-2.0 OR MIT | https://github.com/crossbeam-rs/crossbeam |
| crunchy | 0.2.4 | MIT | https://github.com/eira-fransham/crunchy |
| crypto-bigint | 0.5.5 | Apache-2.0 OR MIT | https://github.com/RustCrypto/crypto-bigint |
| crypto-common | 0.1.7 | Apache-2.0 OR MIT | https://github.com/RustCrypto/traits |
| cssparser | 0.36.0 | MPL-2.0 | https://github.com/servo/rust-cssparser |
| cssparser-macros | 0.6.1 | MPL-2.0 | https://github.com/servo/rust-cssparser |
| ctor | 0.8.0 | Apache-2.0 OR MIT | https://github.com/mmastrac/rust-ctor |
| ctor-proc-macro | 0.0.7 | Apache-2.0 OR MIT | https://github.com/mmastrac/rust-ctor |
| ctr | 0.9.2 | Apache-2.0 OR MIT | https://github.com/RustCrypto/block-modes |
| curve25519-dalek | 4.1.3 | BSD-3-Clause | https://github.com/dalek-cryptography/curve25519-dalek/tree/main/curve25519-dalek |
| curve25519-dalek-derive | 0.1.1 | Apache-2.0 OR MIT | https://github.com/dalek-cryptography/curve25519-dalek |
| darling | 0.23.0 | MIT | https://github.com/TedDriggs/darling |
| darling_core | 0.23.0 | MIT | https://github.com/TedDriggs/darling |
| darling_macro | 0.23.0 | MIT | https://github.com/TedDriggs/darling |
| dary_heap | 0.3.9 | Apache-2.0 OR MIT | https://github.com/hanmertens/dary_heap |
| dbus | 0.9.12 | Apache-2.0 OR MIT | https://github.com/diwic/dbus-rs |
| der | 0.7.10 | Apache-2.0 OR MIT | https://github.com/RustCrypto/formats/tree/master/der |
| deranged | 0.5.8 | Apache-2.0 OR MIT | https://github.com/jhpratt/deranged |
| derive_more | 2.1.1 | MIT | https://github.com/JelteF/derive_more |
| derive_more-impl | 2.1.1 | MIT | https://github.com/JelteF/derive_more |
| digest | 0.10.7 | Apache-2.0 OR MIT | https://github.com/RustCrypto/traits |
| dirs | 4.0.0 | Apache-2.0 OR MIT | https://github.com/soc/dirs-rs |
| dirs | 6.0.0 | Apache-2.0 OR MIT | https://github.com/soc/dirs-rs |
| dirs-next | 2.0.0 | Apache-2.0 OR MIT | https://github.com/xdg-rs/dirs |
| dirs-sys | 0.3.7 | Apache-2.0 OR MIT | https://github.com/dirs-dev/dirs-sys-rs |
| dirs-sys | 0.5.0 | Apache-2.0 OR MIT | https://github.com/dirs-dev/dirs-sys-rs |
| dirs-sys-next | 0.1.2 | Apache-2.0 OR MIT | https://github.com/xdg-rs/dirs/tree/master/dirs-sys |
| dispatch2 | 0.3.1 | Apache-2.0 OR MIT OR Zlib | https://github.com/madsmtm/objc2 |
| displaydoc | 0.2.6 | Apache-2.0 OR MIT | https://github.com/yaahc/displaydoc |
| dlopen2 | 0.8.2 | MIT | https://github.com/OpenByteDev/dlopen2 |
| dlopen2_derive | 0.4.3 | MIT | https://github.com/OpenByteDev/dlopen2 |
| dom_query | 0.27.0 | MIT | https://github.com/niklak/dom_query |
| dpi | 0.1.2 | Apache-2.0 AND MIT | https://github.com/rust-windowing/winit |
| dtoa | 1.0.11 | Apache-2.0 OR MIT | https://github.com/dtolnay/dtoa |
| dtoa-short | 0.3.5 | MPL-2.0 | https://github.com/upsuper/dtoa-short |
| dtor | 0.3.0 | Apache-2.0 OR MIT | https://github.com/mmastrac/rust-ctor |
| dtor-proc-macro | 0.0.6 | Apache-2.0 OR MIT | https://github.com/mmastrac/rust-ctor |
| dunce | 1.0.5 | Apache-2.0 OR CC0-1.0 OR MIT-0 | https://gitlab.com/kornelski/dunce |
| dyn-clone | 1.0.20 | Apache-2.0 OR MIT | https://github.com/dtolnay/dyn-clone |
| ecdsa | 0.16.9 | Apache-2.0 OR MIT | https://github.com/RustCrypto/signatures/tree/master/ecdsa |
| ed25519 | 2.2.3 | Apache-2.0 OR MIT | https://github.com/RustCrypto/signatures/tree/master/ed25519 |
| ed25519-zebra | 4.2.0 | Apache-2.0 OR MIT | https://github.com/ZcashFoundation/ed25519-zebra |
| elliptic-curve | 0.13.8 | Apache-2.0 OR MIT | https://github.com/RustCrypto/traits/tree/master/elliptic-curve |
| embed_plist | 1.2.2 | Apache-2.0 OR MIT | https://github.com/nvzqz/embed-plist-rs |
| embed-resource | 3.0.11 | MIT | https://github.com/nabijaczleweli/rust-embed-resource |
| endi | 1.1.1 | MIT | https://github.com/zeenix/endi |
| enumflags2 | 0.7.12 | Apache-2.0 OR MIT | https://github.com/meithecatte/enumflags2 |
| enumflags2_derive | 0.7.12 | Apache-2.0 OR MIT | https://github.com/meithecatte/enumflags2 |
| env_filter | 0.1.4 | Apache-2.0 OR MIT | https://github.com/rust-cli/env_logger |
| equivalent | 1.0.2 | Apache-2.0 OR MIT | https://github.com/indexmap-rs/equivalent |
| erased-serde | 0.4.10 | Apache-2.0 OR MIT | https://github.com/dtolnay/erased-serde |
| errno | 0.3.14 | Apache-2.0 OR MIT | https://github.com/lambda-fairy/rust-errno |
| event-listener | 5.4.1 | Apache-2.0 OR MIT | https://github.com/smol-rs/event-listener |
| event-listener-strategy | 0.5.4 | Apache-2.0 OR MIT | https://github.com/smol-rs/event-listener-strategy |
| fastrand | 2.4.1 | Apache-2.0 OR MIT | https://github.com/smol-rs/fastrand |
| fax | 0.2.7 | MIT | https://github.com/pdf-rs/fax |
| fdeflate | 0.3.7 | Apache-2.0 OR MIT | https://github.com/image-rs/fdeflate |
| fern | 0.7.1 | MIT | https://github.com/daboross/fern |
| ff | 0.13.1 | Apache-2.0 OR MIT | https://github.com/zkcrypto/ff |
| fiat-crypto | 0.2.9 | Apache-2.0 OR BSD-1-Clause OR MIT | https://github.com/mit-plv/fiat-crypto |
| field-offset | 0.3.6 | Apache-2.0 OR MIT | https://github.com/Diggsey/rust-field-offset |
| filetime | 0.2.29 | Apache-2.0 OR MIT | https://github.com/alexcrichton/filetime |
| find-msvc-tools | 0.1.9 | Apache-2.0 OR MIT | https://github.com/rust-lang/cc-rs |
| flate2 | 1.1.9 | Apache-2.0 OR MIT | https://github.com/rust-lang/flate2-rs |
| fnv | 1.0.7 | Apache-2.0 OR MIT | https://github.com/servo/rust-fnv |
| foldhash | 0.2.0 | Zlib | https://github.com/orlp/foldhash |
| foreign-types | 0.5.0 | Apache-2.0 OR MIT | https://github.com/sfackler/foreign-types |
| foreign-types-macros | 0.2.3 | Apache-2.0 OR MIT | https://github.com/sfackler/foreign-types |
| foreign-types-shared | 0.3.1 | Apache-2.0 OR MIT | https://github.com/sfackler/foreign-types |
| form_urlencoded | 1.2.2 | Apache-2.0 OR MIT | https://github.com/servo/rust-url |
| fsevent-sys | 4.1.0 | MIT | https://github.com/octplane/fsevent-rust/tree/master/fsevent-sys |
| funty | 2.0.0 | MIT | https://github.com/myrrlyn/funty |
| futures-channel | 0.3.32 | Apache-2.0 OR MIT | https://github.com/rust-lang/futures-rs |
| futures-core | 0.3.32 | Apache-2.0 OR MIT | https://github.com/rust-lang/futures-rs |
| futures-executor | 0.3.32 | Apache-2.0 OR MIT | https://github.com/rust-lang/futures-rs |
| futures-io | 0.3.32 | Apache-2.0 OR MIT | https://github.com/rust-lang/futures-rs |
| futures-lite | 2.6.1 | Apache-2.0 OR MIT | https://github.com/smol-rs/futures-lite |
| futures-macro | 0.3.32 | Apache-2.0 OR MIT | https://github.com/rust-lang/futures-rs |
| futures-sink | 0.3.32 | Apache-2.0 OR MIT | https://github.com/rust-lang/futures-rs |
| futures-task | 0.3.32 | Apache-2.0 OR MIT | https://github.com/rust-lang/futures-rs |
| futures-util | 0.3.32 | Apache-2.0 OR MIT | https://github.com/rust-lang/futures-rs |
| gdk | 0.18.2 | MIT | https://github.com/gtk-rs/gtk3-rs |
| gdk-pixbuf | 0.18.5 | MIT | https://github.com/gtk-rs/gtk-rs-core |
| gdk-pixbuf-sys | 0.18.0 | MIT | https://github.com/gtk-rs/gtk-rs-core |
| gdk-sys | 0.18.2 | MIT | https://github.com/gtk-rs/gtk3-rs |
| gdkwayland-sys | 0.18.2 | MIT | https://github.com/gtk-rs/gtk3-rs |
| gdkx11 | 0.18.2 | MIT | https://github.com/gtk-rs/gtk3-rs |
| gdkx11-sys | 0.18.2 | MIT | https://github.com/gtk-rs/gtk3-rs |
| generic-array | 0.14.7 | MIT | https://github.com/fizyk20/generic-array.git |
| getrandom | 0.2.17 | Apache-2.0 OR MIT | https://github.com/rust-random/getrandom |
| getrandom | 0.3.4 | Apache-2.0 OR MIT | https://github.com/rust-random/getrandom |
| getrandom | 0.4.3 | Apache-2.0 OR MIT | https://github.com/rust-random/getrandom |
| ghash | 0.5.1 | Apache-2.0 OR MIT | https://github.com/RustCrypto/universal-hashes |
| gio | 0.18.4 | MIT | https://github.com/gtk-rs/gtk-rs-core |
| gio-sys | 0.18.1 | MIT | https://github.com/gtk-rs/gtk-rs-core |
| glib | 0.18.5 | MIT | https://github.com/gtk-rs/gtk-rs-core |
| glib-macros | 0.18.5 | MIT | https://github.com/gtk-rs/gtk-rs-core |
| glib-sys | 0.18.1 | MIT | https://github.com/gtk-rs/gtk-rs-core |
| glob | 0.3.3 | Apache-2.0 OR MIT | https://github.com/rust-lang/glob |
| gobject-sys | 0.18.0 | MIT | https://github.com/gtk-rs/gtk-rs-core |
| group | 0.13.0 | Apache-2.0 OR MIT | https://github.com/zkcrypto/group |
| gtk | 0.18.2 | MIT | https://github.com/gtk-rs/gtk3-rs |
| gtk-sys | 0.18.2 | MIT | https://github.com/gtk-rs/gtk3-rs |
| gtk3-macros | 0.18.2 | MIT | https://github.com/gtk-rs/gtk3-rs |
| half | 2.7.1 | Apache-2.0 OR MIT | https://github.com/VoidStarKat/half-rs |
| hashbrown | 0.12.3 | Apache-2.0 OR MIT | https://github.com/rust-lang/hashbrown |
| hashbrown | 0.16.1 | Apache-2.0 OR MIT | https://github.com/rust-lang/hashbrown |
| hashbrown | 0.17.1 | Apache-2.0 OR MIT | https://github.com/rust-lang/hashbrown |
| heck | 0.4.1 | Apache-2.0 OR MIT | https://github.com/withoutboats/heck |
| heck | 0.5.0 | Apache-2.0 OR MIT | https://github.com/withoutboats/heck |
| hermit-abi | 0.5.2 | Apache-2.0 OR MIT | https://github.com/hermit-os/hermit-rs |
| hex | 0.4.3 | Apache-2.0 OR MIT | https://github.com/KokaKiwi/rust-hex |
| hkdf | 0.12.4 | Apache-2.0 OR MIT | https://github.com/RustCrypto/KDFs/ |
| hmac | 0.12.1 | Apache-2.0 OR MIT | https://github.com/RustCrypto/MACs |
| html5ever | 0.38.0 | Apache-2.0 OR MIT | https://github.com/servo/html5ever |
| http | 1.4.2 | Apache-2.0 OR MIT | https://github.com/hyperium/http |
| http-body | 1.0.1 | MIT | https://github.com/hyperium/http-body |
| http-body-util | 0.1.3 | MIT | https://github.com/hyperium/http-body |
| httparse | 1.10.1 | Apache-2.0 OR MIT | https://github.com/seanmonstar/httparse |
| hyper | 1.10.1 | MIT | https://github.com/hyperium/hyper |
| hyper-rustls | 0.27.9 | Apache-2.0 OR ISC OR MIT | https://github.com/rustls/hyper-rustls |
| hyper-util | 0.1.20 | MIT | https://github.com/hyperium/hyper-util |
| iana-time-zone | 0.1.65 | Apache-2.0 OR MIT | https://github.com/strawlab/iana-time-zone |
| iana-time-zone-haiku | 0.1.2 | Apache-2.0 OR MIT | https://github.com/strawlab/iana-time-zone |
| ico | 0.5.0 | MIT | https://github.com/mdsteele/rust-ico |
| icu_collections | 2.2.0 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| icu_locale_core | 2.2.0 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| icu_normalizer | 2.2.0 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| icu_normalizer_data | 2.2.0 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| icu_properties | 2.2.0 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| icu_properties_data | 2.2.0 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| icu_provider | 2.2.0 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| ident_case | 1.0.1 | Apache-2.0 OR MIT | https://github.com/TedDriggs/ident_case |
| idna | 1.1.0 | Apache-2.0 OR MIT | https://github.com/servo/rust-url/ |
| idna_adapter | 1.2.2 | Apache-2.0 OR MIT | https://github.com/hsivonen/idna_adapter |
| image | 0.25.10 | Apache-2.0 OR MIT | https://github.com/image-rs/image |
| indexmap | 1.9.3 | Apache-2.0 OR MIT | https://github.com/bluss/indexmap |
| indexmap | 2.14.0 | Apache-2.0 OR MIT | https://github.com/indexmap-rs/indexmap |
| infer | 0.19.0 | MIT | https://github.com/bojand/infer |
| inotify | 0.11.4 | ISC | https://github.com/hannobraun/inotify-rs |
| inotify-sys | 0.1.8 | ISC | https://github.com/hannobraun/inotify-sys |
| inout | 0.1.4 | Apache-2.0 OR MIT | https://github.com/RustCrypto/utils |
| iota_stronghold | 2.1.0 | Apache-2.0 | https://github.com/iotaledger/stronghold.rs |
| iota-crypto | 0.23.2 | Apache-2.0 | https://github.com/iotaledger/crypto.rs |
| ipnet | 2.12.0 | Apache-2.0 OR MIT | https://github.com/krisprice/ipnet |
| is-docker | 0.2.0 | MIT | https://github.com/TheLarkInn/is-docker |
| is-wsl | 0.4.0 | MIT | https://github.com/TheLarkInn/is-wsl |
| iterator-sorted | 0.1.0 | Apache-2.0 | https://github.com/iotaledger/common-rs |
| itoa | 1.0.18 | Apache-2.0 OR MIT | https://github.com/dtolnay/itoa |
| javascriptcore-rs | 1.1.2 | MIT | https://github.com/tauri-apps/javascriptcore-rs |
| javascriptcore-rs-sys | 1.1.1 | MIT | https://github.com/tauri-apps/javascriptcore-rs |
| jni | 0.21.1 | Apache-2.0 OR MIT | https://github.com/jni-rs/jni-rs |
| jni-sys | 0.3.1 | Apache-2.0 OR MIT | https://github.com/jni-rs/jni-sys |
| jni-sys | 0.4.1 | Apache-2.0 OR MIT | https://github.com/jni-rs/jni-sys |
| jni-sys-macros | 0.4.1 | Apache-2.0 OR MIT | https://github.com/jni-rs/jni-sys |
| js-sys | 0.3.103 | Apache-2.0 OR MIT | https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/js-sys |
| json-patch | 3.0.1 | Apache-2.0 OR MIT | https://github.com/idubrov/json-patch |
| jsonptr | 0.6.3 | Apache-2.0 OR MIT | https://github.com/chanced/jsonptr |
| k256 | 0.13.4 | Apache-2.0 OR MIT | https://github.com/RustCrypto/elliptic-curves/tree/master/k256 |
| kamadak-exif | 0.6.1 | BSD-2-Clause | https://github.com/kamadak/exif-rs |
| keyboard-types | 0.7.0 | Apache-2.0 OR MIT | https://github.com/pyfisch/keyboard-types |
| kqueue | 1.2.0 | MIT | https://gitlab.com/rust-kqueue/rust-kqueue |
| kqueue-sys | 1.1.2 | MIT | https://gitlab.com/rust-kqueue/rust-kqueue-sys |
| libappindicator | 0.9.0 | Apache-2.0 OR MIT |  |
| libappindicator-sys | 0.9.0 | Apache-2.0 OR MIT |  |
| libc | 0.2.186 | Apache-2.0 OR MIT | https://github.com/rust-lang/libc |
| libdbus-sys | 0.2.7 | Apache-2.0 OR MIT | https://github.com/diwic/dbus-rs |
| libflate | 2.3.1 | MIT | https://github.com/sile/libflate |
| libflate_lz77 | 2.3.0 | MIT | https://github.com/sile/libflate |
| libloading | 0.7.4 | ISC | https://github.com/nagisa/rust_libloading/ |
| libmimalloc-sys | 0.1.49 | MIT | https://github.com/purpleprotocol/mimalloc_rust/tree/master/libmimalloc-sys |
| libredox | 0.1.18 | MIT | https://gitlab.redox-os.org/redox-os/libredox.git |
| libsodium-sys-stable | 1.24.0 | Apache-2.0 OR MIT | https://github.com/jedisct1/libsodium-sys-stable |
| linux-raw-sys | 0.12.1 | Apache-2.0 OR Apache-2.0 WITH LLVM-exception OR MIT | https://github.com/sunfishcode/linux-raw-sys |
| litemap | 0.8.2 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| lock_api | 0.4.14 | Apache-2.0 OR MIT | https://github.com/Amanieu/parking_lot |
| log | 0.4.33 | Apache-2.0 OR MIT | https://github.com/rust-lang/log |
| lru-slab | 0.1.2 | Apache-2.0 OR MIT OR Zlib | https://github.com/Ralith/lru-slab |
| markup5ever | 0.38.0 | Apache-2.0 OR MIT | https://github.com/servo/html5ever |
| memchr | 2.8.2 | MIT OR Unlicense | https://github.com/BurntSushi/memchr |
| memoffset | 0.6.5 | MIT | https://github.com/Gilnaa/memoffset |
| memoffset | 0.9.1 | MIT | https://github.com/Gilnaa/memoffset |
| mimalloc | 0.1.52 | MIT | https://github.com/purpleprotocol/mimalloc_rust |
| mime | 0.3.17 | Apache-2.0 OR MIT | https://github.com/hyperium/mime |
| mime_guess | 2.0.5 | MIT | https://github.com/abonander/mime_guess |
| minisign-verify | 0.2.5 | MIT | https://github.com/jedisct1/rust-minisign-verify |
| miniz_oxide | 0.8.9 | Apache-2.0 OR MIT OR Zlib | https://github.com/Frommi/miniz_oxide/tree/master/miniz_oxide |
| mio | 1.2.1 | MIT | https://github.com/tokio-rs/mio |
| moxcms | 0.8.1 | Apache-2.0 OR BSD-3-Clause | https://github.com/awxkee/moxcms.git |
| muda | 0.19.3 | Apache-2.0 OR MIT | https://github.com/tauri-apps/muda |
| mutate_once | 0.1.2 | BSD-2-Clause | https://github.com/kamadak/mutate_once-rs |
| ndk | 0.9.0 | Apache-2.0 OR MIT | https://github.com/rust-mobile/ndk |
| ndk-sys | 0.6.0+11769913 | Apache-2.0 OR MIT | https://github.com/rust-mobile/ndk |
| new_debug_unreachable | 1.0.6 | MIT | https://github.com/mbrubeck/rust-debug-unreachable |
| nix | 0.24.3 | MIT | https://github.com/nix-rust/nix |
| nix | 0.30.1 | MIT | https://github.com/nix-rust/nix |
| no_std_io2 | 0.9.4 | Apache-2.0 OR MIT | https://github.com/wcampbell0x2a/no-std-io2 |
| notify | 8.2.0 | CC0-1.0 | https://github.com/notify-rs/notify.git |
| notify-debouncer-mini | 0.7.0 | Apache-2.0 OR MIT | https://github.com/notify-rs/notify.git |
| notify-types | 2.1.0 | Apache-2.0 OR MIT | https://github.com/notify-rs/notify.git |
| ntapi | 0.4.3 | Apache-2.0 OR MIT | https://github.com/MSxDOS/ntapi |
| num_enum | 0.7.6 | Apache-2.0 OR BSD-3-Clause OR MIT | https://github.com/illicitonion/num_enum |
| num_enum_derive | 0.7.6 | Apache-2.0 OR BSD-3-Clause OR MIT | https://github.com/illicitonion/num_enum |
| num_threads | 0.1.7 | Apache-2.0 OR MIT | https://github.com/jhpratt/num_threads |
| num-conv | 0.2.2 | Apache-2.0 OR MIT | https://github.com/jhpratt/num-conv |
| num-traits | 0.2.19 | Apache-2.0 OR MIT | https://github.com/rust-num/num-traits |
| objc2 | 0.6.4 | MIT | https://github.com/madsmtm/objc2 |
| objc2-app-kit | 0.3.2 | Apache-2.0 OR MIT OR Zlib | https://github.com/madsmtm/objc2 |
| objc2-cloud-kit | 0.3.2 | Apache-2.0 OR MIT OR Zlib | https://github.com/madsmtm/objc2 |
| objc2-core-data | 0.3.2 | Apache-2.0 OR MIT OR Zlib | https://github.com/madsmtm/objc2 |
| objc2-core-foundation | 0.3.2 | Apache-2.0 OR MIT OR Zlib | https://github.com/madsmtm/objc2 |
| objc2-core-graphics | 0.3.2 | Apache-2.0 OR MIT OR Zlib | https://github.com/madsmtm/objc2 |
| objc2-core-image | 0.3.2 | Apache-2.0 OR MIT OR Zlib | https://github.com/madsmtm/objc2 |
| objc2-core-location | 0.3.2 | Apache-2.0 OR MIT OR Zlib | https://github.com/madsmtm/objc2 |
| objc2-core-text | 0.3.2 | Apache-2.0 OR MIT OR Zlib | https://github.com/madsmtm/objc2 |
| objc2-encode | 4.1.0 | MIT | https://github.com/madsmtm/objc2 |
| objc2-exception-helper | 0.1.1 | Apache-2.0 OR MIT OR Zlib | https://github.com/madsmtm/objc2 |
| objc2-foundation | 0.3.2 | MIT | https://github.com/madsmtm/objc2 |
| objc2-io-kit | 0.3.2 | Apache-2.0 OR MIT OR Zlib | https://github.com/madsmtm/objc2 |
| objc2-io-surface | 0.3.2 | Apache-2.0 OR MIT OR Zlib | https://github.com/madsmtm/objc2 |
| objc2-quartz-core | 0.3.2 | Apache-2.0 OR MIT OR Zlib | https://github.com/madsmtm/objc2 |
| objc2-ui-kit | 0.3.2 | Apache-2.0 OR MIT OR Zlib | https://github.com/madsmtm/objc2 |
| objc2-user-notifications | 0.3.2 | Apache-2.0 OR MIT OR Zlib | https://github.com/madsmtm/objc2 |
| objc2-web-kit | 0.3.2 | Apache-2.0 OR MIT OR Zlib | https://github.com/madsmtm/objc2 |
| once_cell | 1.21.4 | Apache-2.0 OR MIT | https://github.com/matklad/once_cell |
| opaque-debug | 0.3.1 | Apache-2.0 OR MIT | https://github.com/RustCrypto/utils |
| open | 5.4.0 | MIT | https://github.com/Byron/open-rs |
| option-ext | 0.2.0 | MPL-2.0 | https://github.com/soc/option-ext.git |
| ordered-stream | 0.2.0 | Apache-2.0 OR MIT | https://github.com/danieldg/ordered-stream |
| pango | 0.18.3 | MIT | https://github.com/gtk-rs/gtk-rs-core |
| pango-sys | 0.18.0 | MIT | https://github.com/gtk-rs/gtk-rs-core |
| parking | 2.2.1 | Apache-2.0 OR MIT | https://github.com/smol-rs/parking |
| parking_lot | 0.12.5 | Apache-2.0 OR MIT | https://github.com/Amanieu/parking_lot |
| parking_lot_core | 0.9.12 | Apache-2.0 OR MIT | https://github.com/Amanieu/parking_lot |
| paste | 1.0.15 | Apache-2.0 OR MIT | https://github.com/dtolnay/paste |
| pbkdf2 | 0.12.2 | Apache-2.0 OR MIT | https://github.com/RustCrypto/password-hashes/tree/master/pbkdf2 |
| percent-encoding | 2.3.2 | Apache-2.0 OR MIT | https://github.com/servo/rust-url/ |
| phf | 0.13.1 | MIT | https://github.com/rust-phf/rust-phf |
| phf_codegen | 0.13.1 | MIT | https://github.com/rust-phf/rust-phf |
| phf_generator | 0.13.1 | MIT | https://github.com/rust-phf/rust-phf |
| phf_macros | 0.13.1 | MIT | https://github.com/rust-phf/rust-phf |
| phf_shared | 0.13.1 | MIT | https://github.com/rust-phf/rust-phf |
| pin-project-lite | 0.2.17 | Apache-2.0 OR MIT | https://github.com/taiki-e/pin-project-lite |
| piper | 0.2.5 | Apache-2.0 OR MIT | https://github.com/smol-rs/piper |
| pkcs8 | 0.10.2 | Apache-2.0 OR MIT | https://github.com/RustCrypto/formats/tree/master/pkcs8 |
| pkg-config | 0.3.33 | Apache-2.0 OR MIT | https://github.com/rust-lang/pkg-config-rs |
| plist | 1.10.0 | MIT | https://github.com/ebarnard/rust-plist/ |
| png | 0.17.16 | Apache-2.0 OR MIT | https://github.com/image-rs/image-png |
| png | 0.18.1 | Apache-2.0 OR MIT | https://github.com/image-rs/image-png |
| polling | 3.11.0 | Apache-2.0 OR MIT | https://github.com/smol-rs/polling |
| poly1305 | 0.8.0 | Apache-2.0 OR MIT | https://github.com/RustCrypto/universal-hashes |
| polyval | 0.6.2 | Apache-2.0 OR MIT | https://github.com/RustCrypto/universal-hashes |
| potential_utf | 0.1.5 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| powerfmt | 0.2.0 | Apache-2.0 OR MIT | https://github.com/jhpratt/powerfmt |
| ppv-lite86 | 0.2.21 | Apache-2.0 OR MIT | https://github.com/cryptocorrosion/cryptocorrosion |
| precomputed-hash | 0.1.1 | MIT | https://github.com/emilio/precomputed-hash |
| proc-macro-crate | 1.3.1 | Apache-2.0 OR MIT | https://github.com/bkchr/proc-macro-crate |
| proc-macro-crate | 2.0.2 | Apache-2.0 OR MIT | https://github.com/bkchr/proc-macro-crate |
| proc-macro-crate | 3.5.0 | Apache-2.0 OR MIT | https://github.com/bkchr/proc-macro-crate |
| proc-macro-error | 1.0.4 | Apache-2.0 OR MIT | https://gitlab.com/CreepySkeleton/proc-macro-error |
| proc-macro-error-attr | 1.0.4 | Apache-2.0 OR MIT | https://gitlab.com/CreepySkeleton/proc-macro-error |
| proc-macro2 | 1.0.106 | Apache-2.0 OR MIT | https://github.com/dtolnay/proc-macro2 |
| ptr_meta | 0.1.4 | MIT | https://github.com/djkoloski/ptr_meta |
| ptr_meta_derive | 0.1.4 | MIT | https://github.com/djkoloski/ptr_meta |
| pxfm | 0.1.30 | Apache-2.0 OR BSD-3-Clause | https://github.com/awxkee/pxfm |
| quick-error | 2.0.1 | Apache-2.0 OR MIT | http://github.com/tailhook/quick-error |
| quick-xml | 0.41.0 | MIT | https://github.com/tafia/quick-xml |
| quinn | 0.11.11 | Apache-2.0 OR MIT | https://github.com/quinn-rs/quinn |
| quinn-proto | 0.11.16 | Apache-2.0 OR MIT | https://github.com/quinn-rs/quinn |
| quinn-udp | 0.5.15 | Apache-2.0 OR MIT | https://github.com/quinn-rs/quinn |
| quote | 1.0.46 | Apache-2.0 OR MIT | https://github.com/dtolnay/quote |
| r-efi | 5.3.0 | Apache-2.0 OR LGPL-2.1-or-later OR MIT | https://github.com/r-efi/r-efi |
| r-efi | 6.0.0 | Apache-2.0 OR LGPL-2.1-or-later OR MIT | https://github.com/r-efi/r-efi |
| radium | 0.7.0 | MIT | https://github.com/bitvecto-rs/radium |
| rand | 0.8.6 | Apache-2.0 OR MIT | https://github.com/rust-random/rand |
| rand | 0.10.2 | Apache-2.0 OR MIT | https://github.com/rust-random/rand |
| rand_chacha | 0.3.1 | Apache-2.0 OR MIT | https://github.com/rust-random/rand |
| rand_chacha | 0.9.0 | Apache-2.0 OR MIT | https://github.com/rust-random/rand |
| rand_core | 0.6.4 | Apache-2.0 OR MIT | https://github.com/rust-random/rand |
| rand_core | 0.9.5 | Apache-2.0 OR MIT | https://github.com/rust-random/rand |
| rand_core | 0.10.1 | Apache-2.0 OR MIT | https://github.com/rust-random/rand_core |
| rand_pcg | 0.10.2 | Apache-2.0 OR MIT | https://github.com/rust-random/rngs |
| raw-window-handle | 0.6.2 | Apache-2.0 OR MIT OR Zlib | https://github.com/rust-windowing/raw-window-handle |
| redox_syscall | 0.5.18 | MIT | https://gitlab.redox-os.org/redox-os/syscall |
| redox_users | 0.4.6 | MIT | https://gitlab.redox-os.org/redox-os/users |
| redox_users | 0.5.2 | MIT | https://gitlab.redox-os.org/redox-os/users |
| ref-cast | 1.0.25 | Apache-2.0 OR MIT | https://github.com/dtolnay/ref-cast |
| ref-cast-impl | 1.0.25 | Apache-2.0 OR MIT | https://github.com/dtolnay/ref-cast |
| regex | 1.12.4 | Apache-2.0 OR MIT | https://github.com/rust-lang/regex |
| regex-automata | 0.4.14 | Apache-2.0 OR MIT | https://github.com/rust-lang/regex |
| regex-syntax | 0.8.11 | Apache-2.0 OR MIT | https://github.com/rust-lang/regex |
| rend | 0.4.2 | MIT | https://github.com/djkoloski/rend |
| reqwest | 0.12.28 | Apache-2.0 OR MIT | https://github.com/seanmonstar/reqwest |
| reqwest | 0.13.4 | Apache-2.0 OR MIT | https://github.com/seanmonstar/reqwest |
| rfc6979 | 0.4.0 | Apache-2.0 OR MIT | https://github.com/RustCrypto/signatures/tree/master/rfc6979 |
| rfd | 0.16.0 | MIT | https://github.com/PolyMeilex/rfd |
| ring | 0.17.14 | Apache-2.0 AND ISC | https://github.com/briansmith/ring |
| rkyv | 0.7.46 | MIT | https://github.com/rkyv/rkyv |
| rkyv_derive | 0.7.46 | MIT | https://github.com/rkyv/rkyv |
| rle-decode-fast | 1.0.3 | Apache-2.0 OR MIT | https://github.com/WanzenBug/rle-decode-helper |
| rust_decimal | 1.42.1 | MIT | https://github.com/paupino/rust-decimal |
| rust-argon2 | 1.0.0 | Apache-2.0 OR MIT | https://github.com/sru-systems/rust-argon2 |
| rust-argon2 | 2.1.0 | Apache-2.0 OR MIT | https://github.com/sru-systems/rust-argon2 |
| rustc_version | 0.4.1 | Apache-2.0 OR MIT | https://github.com/djc/rustc-version-rs |
| rustc-hash | 2.1.3 | Apache-2.0 OR MIT | https://github.com/rust-lang/rustc-hash |
| rustix | 1.1.4 | Apache-2.0 OR Apache-2.0 WITH LLVM-exception OR MIT | https://github.com/bytecodealliance/rustix |
| rustls | 0.23.41 | Apache-2.0 OR ISC OR MIT | https://github.com/rustls/rustls |
| rustls-pki-types | 1.15.0 | Apache-2.0 OR MIT | https://github.com/rustls/pki-types |
| rustls-webpki | 0.103.13 | ISC | https://github.com/rustls/webpki |
| rustversion | 1.0.22 | Apache-2.0 OR MIT | https://github.com/dtolnay/rustversion |
| ryu | 1.0.23 | Apache-2.0 OR BSL-1.0 | https://github.com/dtolnay/ryu |
| salsa20 | 0.10.2 | Apache-2.0 OR MIT | https://github.com/RustCrypto/stream-ciphers |
| same-file | 1.0.6 | MIT OR Unlicense | https://github.com/BurntSushi/same-file |
| schemars | 0.8.22 | MIT | https://github.com/GREsau/schemars |
| schemars | 0.9.0 | MIT | https://github.com/GREsau/schemars |
| schemars | 1.2.1 | MIT | https://github.com/GREsau/schemars |
| schemars_derive | 0.8.22 | MIT | https://github.com/GREsau/schemars |
| scopeguard | 1.2.0 | Apache-2.0 OR MIT | https://github.com/bluss/scopeguard |
| scrypt | 0.11.0 | Apache-2.0 OR MIT | https://github.com/RustCrypto/password-hashes/tree/master/scrypt |
| seahash | 4.1.0 | MIT | https://gitlab.redox-os.org/redox-os/seahash |
| sec1 | 0.7.3 | Apache-2.0 OR MIT | https://github.com/RustCrypto/formats/tree/master/sec1 |
| selectors | 0.36.1 | MPL-2.0 | https://github.com/servo/stylo |
| semver | 1.0.28 | Apache-2.0 OR MIT | https://github.com/dtolnay/semver |
| serde | 1.0.228 | Apache-2.0 OR MIT | https://github.com/serde-rs/serde |
| serde_core | 1.0.228 | Apache-2.0 OR MIT | https://github.com/serde-rs/serde |
| serde_derive | 1.0.228 | Apache-2.0 OR MIT | https://github.com/serde-rs/serde |
| serde_derive_internals | 0.29.1 | Apache-2.0 OR MIT | https://github.com/serde-rs/serde |
| serde_json | 1.0.150 | Apache-2.0 OR MIT | https://github.com/serde-rs/json |
| serde_repr | 0.1.20 | Apache-2.0 OR MIT | https://github.com/dtolnay/serde-repr |
| serde_spanned | 0.6.9 | Apache-2.0 OR MIT | https://github.com/toml-rs/toml |
| serde_spanned | 1.1.1 | Apache-2.0 OR MIT | https://github.com/toml-rs/toml |
| serde_urlencoded | 0.7.1 | Apache-2.0 OR MIT | https://github.com/nox/serde_urlencoded |
| serde_with | 3.21.0 | Apache-2.0 OR MIT | https://github.com/jonasbb/serde_with/ |
| serde_with_macros | 3.21.0 | Apache-2.0 OR MIT | https://github.com/jonasbb/serde_with/ |
| serde-untagged | 0.1.9 | Apache-2.0 OR MIT | https://github.com/dtolnay/serde-untagged |
| serialize-to-javascript | 0.1.2 | Apache-2.0 OR MIT | https://github.com/chippers/serialize-to-javascript |
| serialize-to-javascript-impl | 0.1.2 | Apache-2.0 OR MIT | https://github.com/chippers/serialize-to-javascript |
| servo_arc | 0.4.3 | Apache-2.0 OR MIT | https://github.com/servo/stylo |
| sha1 | 0.10.7 | Apache-2.0 OR MIT | https://github.com/RustCrypto/hashes |
| sha2 | 0.10.9 | Apache-2.0 OR MIT | https://github.com/RustCrypto/hashes |
| shlex | 2.0.1 | Apache-2.0 OR MIT | https://github.com/comex/rust-shlex |
| signal-hook-registry | 1.4.8 | Apache-2.0 OR MIT | https://github.com/vorner/signal-hook |
| signature | 2.2.0 | Apache-2.0 OR MIT | https://github.com/RustCrypto/traits/tree/master/signature |
| simd-adler32 | 0.3.9 | MIT | https://github.com/mcountryman/simd-adler32 |
| simdutf8 | 0.1.5 | Apache-2.0 OR MIT | https://github.com/rusticstuff/simdutf8 |
| siphasher | 1.0.3 | Apache-2.0 OR MIT | https://github.com/jedisct1/rust-siphash |
| slab | 0.4.12 | MIT | https://github.com/tokio-rs/slab |
| smallvec | 1.15.2 | Apache-2.0 OR MIT | https://github.com/servo/rust-smallvec |
| socket2 | 0.6.4 | Apache-2.0 OR MIT | https://github.com/rust-lang/socket2 |
| softbuffer | 0.4.8 | Apache-2.0 OR MIT | https://github.com/rust-windowing/softbuffer |
| soup3 | 0.5.0 | MIT | https://gitlab.gnome.org/World/Rust/soup3-rs |
| soup3-sys | 0.5.0 | MIT | https://gitlab.gnome.org/World/Rust/soup3-rs |
| spki | 0.7.3 | Apache-2.0 OR MIT | https://github.com/RustCrypto/formats/tree/master/spki |
| stable_deref_trait | 1.2.1 | Apache-2.0 OR MIT | https://github.com/storyyeller/stable_deref_trait |
| string_cache | 0.9.0 | Apache-2.0 OR MIT | https://github.com/servo/string-cache |
| string_cache_codegen | 0.6.1 | Apache-2.0 OR MIT | https://github.com/servo/string-cache |
| stronghold_engine | 2.0.1 | Apache-2.0 | https://github.com/iotaledger/stronghold.rs |
| stronghold-derive | 1.0.0 | Apache-2.0 | https://github.com/iotaledger/stronghold.rs |
| stronghold-runtime | 2.0.1 | Apache-2.0 | https://github.com/iotaledger/stronghold.rs |
| stronghold-utils | 1.0.0 | Apache-2.0 | https://github.com/iotaledger/stronghold.rs |
| strsim | 0.11.1 | MIT | https://github.com/rapidfuzz/strsim-rs |
| subtle | 2.6.1 | BSD-3-Clause | https://github.com/dalek-cryptography/subtle |
| swift-rs | 1.0.7 | Apache-2.0 OR MIT | https://github.com/Brendonovich/swift-rs |
| syn | 1.0.109 | Apache-2.0 OR MIT | https://github.com/dtolnay/syn |
| syn | 2.0.118 | Apache-2.0 OR MIT | https://github.com/dtolnay/syn |
| sync_wrapper | 1.0.2 | Apache-2.0 | https://github.com/Actyx/sync_wrapper |
| synstructure | 0.13.2 | MIT | https://github.com/mystor/synstructure |
| sysinfo | 0.39.6 | MIT | https://github.com/GuillaumeGomez/sysinfo |
| system-deps | 6.2.2 | Apache-2.0 OR MIT | https://github.com/gdesmott/system-deps |
| tao | 0.35.3 | Apache-2.0 | https://github.com/tauri-apps/tao |
| tao-macros | 0.1.3 | Apache-2.0 OR MIT | https://github.com/tauri-apps/tao |
| tap | 1.0.1 | MIT | https://github.com/myrrlyn/tap |
| tar | 0.4.46 | Apache-2.0 OR MIT | https://github.com/composefs/tar-rs |
| target-lexicon | 0.12.16 | Apache-2.0 WITH LLVM-exception | https://github.com/bytecodealliance/target-lexicon |
| tauri | 2.11.5 | Apache-2.0 OR MIT | https://github.com/tauri-apps/tauri |
| tauri-build | 2.6.3 | Apache-2.0 OR MIT | https://github.com/tauri-apps/tauri |
| tauri-codegen | 2.6.3 | Apache-2.0 OR MIT | https://github.com/tauri-apps/tauri |
| tauri-macros | 2.6.3 | Apache-2.0 OR MIT | https://github.com/tauri-apps/tauri |
| tauri-plugin | 2.6.3 | Apache-2.0 OR MIT | https://github.com/tauri-apps/tauri |
| tauri-plugin-dialog | 2.7.1 | Apache-2.0 OR MIT | https://github.com/tauri-apps/plugins-workspace |
| tauri-plugin-fs | 2.5.1 | Apache-2.0 OR MIT | https://github.com/tauri-apps/plugins-workspace |
| tauri-plugin-log | 2.8.0 | Apache-2.0 OR MIT | https://github.com/tauri-apps/plugins-workspace |
| tauri-plugin-opener | 2.5.4 | Apache-2.0 OR MIT | https://github.com/tauri-apps/plugins-workspace |
| tauri-plugin-stronghold | 2.3.1 | Apache-2.0 OR MIT | https://github.com/tauri-apps/plugins-workspace |
| tauri-runtime | 2.11.3 | Apache-2.0 OR MIT | https://github.com/tauri-apps/tauri |
| tauri-runtime-wry | 2.11.4 | Apache-2.0 OR MIT | https://github.com/tauri-apps/tauri |
| tauri-utils | 2.9.3 | Apache-2.0 OR MIT | https://github.com/tauri-apps/tauri |
| tauri-winres | 0.3.6 | MIT | https://github.com/tauri-apps/winres |
| tempfile | 3.27.0 | Apache-2.0 OR MIT | https://github.com/Stebalien/tempfile |
| tendril | 0.5.0 | Apache-2.0 OR MIT | https://github.com/servo/html5ever |
| thiserror | 1.0.69 | Apache-2.0 OR MIT | https://github.com/dtolnay/thiserror |
| thiserror | 2.0.18 | Apache-2.0 OR MIT | https://github.com/dtolnay/thiserror |
| thiserror-impl | 1.0.69 | Apache-2.0 OR MIT | https://github.com/dtolnay/thiserror |
| thiserror-impl | 2.0.18 | Apache-2.0 OR MIT | https://github.com/dtolnay/thiserror |
| tiff | 0.11.3 | MIT | https://github.com/image-rs/image-tiff |
| time | 0.3.53 | Apache-2.0 OR MIT | https://github.com/time-rs/time |
| time-core | 0.1.9 | Apache-2.0 OR MIT | https://github.com/time-rs/time |
| time-macros | 0.2.31 | Apache-2.0 OR MIT | https://github.com/time-rs/time |
| tiny-keccak | 2.0.2 | CC0-1.0 |  |
| tinystr | 0.8.3 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| tinyvec | 1.11.0 | Apache-2.0 OR MIT OR Zlib | https://github.com/Lokathor/tinyvec |
| tinyvec_macros | 0.1.1 | Apache-2.0 OR MIT OR Zlib | https://github.com/Soveu/tinyvec_macros |
| tokio | 1.52.3 | MIT | https://github.com/tokio-rs/tokio |
| tokio-macros | 2.7.0 | MIT | https://github.com/tokio-rs/tokio |
| tokio-rustls | 0.26.4 | Apache-2.0 OR MIT | https://github.com/rustls/tokio-rustls |
| tokio-util | 0.7.18 | MIT | https://github.com/tokio-rs/tokio |
| toml | 0.8.2 | Apache-2.0 OR MIT | https://github.com/toml-rs/toml |
| toml | 0.9.12+spec-1.1.0 | Apache-2.0 OR MIT | https://github.com/toml-rs/toml |
| toml | 1.1.2+spec-1.1.0 | Apache-2.0 OR MIT | https://github.com/toml-rs/toml |
| toml_datetime | 0.6.3 | Apache-2.0 OR MIT | https://github.com/toml-rs/toml |
| toml_datetime | 0.7.5+spec-1.1.0 | Apache-2.0 OR MIT | https://github.com/toml-rs/toml |
| toml_datetime | 1.1.1+spec-1.1.0 | Apache-2.0 OR MIT | https://github.com/toml-rs/toml |
| toml_edit | 0.19.15 | Apache-2.0 OR MIT | https://github.com/toml-rs/toml |
| toml_edit | 0.20.2 | Apache-2.0 OR MIT | https://github.com/toml-rs/toml |
| toml_edit | 0.25.12+spec-1.1.0 | Apache-2.0 OR MIT | https://github.com/toml-rs/toml |
| toml_parser | 1.1.2+spec-1.1.0 | Apache-2.0 OR MIT | https://github.com/toml-rs/toml |
| toml_writer | 1.1.1+spec-1.1.0 | Apache-2.0 OR MIT | https://github.com/toml-rs/toml |
| tower | 0.5.3 | MIT | https://github.com/tower-rs/tower |
| tower-http | 0.6.11 | MIT | https://github.com/tower-rs/tower-http |
| tower-layer | 0.3.3 | MIT | https://github.com/tower-rs/tower |
| tower-service | 0.3.3 | MIT | https://github.com/tower-rs/tower |
| tracing | 0.1.44 | MIT | https://github.com/tokio-rs/tracing |
| tracing-attributes | 0.1.31 | MIT | https://github.com/tokio-rs/tracing |
| tracing-core | 0.1.36 | MIT | https://github.com/tokio-rs/tracing |
| tray-icon | 0.24.1 | Apache-2.0 OR MIT | https://github.com/tauri-apps/tray-icon |
| try-lock | 0.2.5 | MIT | https://github.com/seanmonstar/try-lock |
| typed-path | 0.12.3 | Apache-2.0 OR MIT | https://github.com/chipsenkbeil/typed-path |
| typeid | 1.0.3 | Apache-2.0 OR MIT | https://github.com/dtolnay/typeid |
| typenum | 1.20.1 | Apache-2.0 OR MIT | https://github.com/paholg/typenum |
| uds_windows | 1.2.1 | MIT | https://github.com/haraldh/rust_uds_windows |
| unic-char-property | 0.9.0 | Apache-2.0 OR MIT | https://github.com/open-i18n/rust-unic/ |
| unic-char-range | 0.9.0 | Apache-2.0 OR MIT | https://github.com/open-i18n/rust-unic/ |
| unic-common | 0.9.0 | Apache-2.0 OR MIT | https://github.com/open-i18n/rust-unic/ |
| unic-ucd-ident | 0.9.0 | Apache-2.0 OR MIT | https://github.com/open-i18n/rust-unic/ |
| unic-ucd-version | 0.9.0 | Apache-2.0 OR MIT | https://github.com/open-i18n/rust-unic/ |
| unicase | 2.9.0 | Apache-2.0 OR MIT | https://github.com/seanmonstar/unicase |
| unicode-ident | 1.0.24 | (Apache-2.0 OR MIT) AND Unicode-3.0 | https://github.com/dtolnay/unicode-ident |
| unicode-normalization | 0.1.25 | Apache-2.0 OR MIT | https://github.com/unicode-rs/unicode-normalization |
| unicode-segmentation | 1.13.3 | Apache-2.0 OR MIT | https://github.com/unicode-rs/unicode-segmentation |
| universal-hash | 0.5.1 | Apache-2.0 OR MIT | https://github.com/RustCrypto/traits |
| untrusted | 0.9.0 | ISC | https://github.com/briansmith/untrusted |
| ureq | 3.4.0 | Apache-2.0 OR MIT | https://github.com/algesten/ureq |
| ureq-proto | 0.6.1 | Apache-2.0 OR MIT | https://github.com/algesten/ureq-proto |
| url | 2.5.8 | Apache-2.0 OR MIT | https://github.com/servo/rust-url |
| urlpattern | 0.3.0 | MIT | https://github.com/denoland/rust-urlpattern |
| utf-8 | 0.7.6 | Apache-2.0 OR MIT | https://github.com/SimonSapin/rust-utf8 |
| utf8_iter | 1.0.4 | Apache-2.0 OR MIT | https://github.com/hsivonen/utf8_iter |
| utf8-width | 0.1.9 | MIT | https://github.com/magiclen/utf8-width |
| utf8-zero | 0.8.1 | Apache-2.0 OR MIT | https://github.com/algesten/utf8-zero |
| uuid | 1.23.4 | Apache-2.0 OR MIT | https://github.com/uuid-rs/uuid |
| value-bag | 1.12.0 | Apache-2.0 OR MIT | https://github.com/sval-rs/value-bag |
| vcpkg | 0.2.15 | Apache-2.0 OR MIT | https://github.com/mcgoo/vcpkg-rs |
| version_check | 0.9.5 | Apache-2.0 OR MIT | https://github.com/SergioBenitez/version_check |
| version-compare | 0.2.1 | MIT | https://gitlab.com/timvisee/version-compare |
| vswhom | 0.1.0 | MIT | https://github.com/nabijaczleweli/vswhom.rs |
| vswhom-sys | 0.1.3 | MIT | https://github.com/nabijaczleweli/vswhom-sys.rs |
| walkdir | 2.5.0 | MIT OR Unlicense | https://github.com/BurntSushi/walkdir |
| want | 0.3.1 | MIT | https://github.com/seanmonstar/want |
| wasi | 0.11.1+wasi-snapshot-preview1 | Apache-2.0 OR Apache-2.0 WITH LLVM-exception OR MIT | https://github.com/bytecodealliance/wasi |
| wasip2 | 1.0.4+wasi-0.2.12 | Apache-2.0 OR Apache-2.0 WITH LLVM-exception OR MIT | https://github.com/bytecodealliance/wasi-rs |
| wasm-bindgen | 0.2.126 | Apache-2.0 OR MIT | https://github.com/wasm-bindgen/wasm-bindgen |
| wasm-bindgen-futures | 0.4.76 | Apache-2.0 OR MIT | https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/futures |
| wasm-bindgen-macro | 0.2.126 | Apache-2.0 OR MIT | https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/macro |
| wasm-bindgen-macro-support | 0.2.126 | Apache-2.0 OR MIT | https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/macro-support |
| wasm-bindgen-shared | 0.2.126 | Apache-2.0 OR MIT | https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/shared |
| wasm-streams | 0.5.0 | Apache-2.0 OR MIT | https://github.com/MattiasBuelens/wasm-streams/ |
| web_atoms | 0.2.5 | Apache-2.0 OR MIT | https://github.com/servo/html5ever |
| web-sys | 0.3.103 | Apache-2.0 OR MIT | https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/web-sys |
| web-time | 1.1.0 | Apache-2.0 OR MIT | https://github.com/daxpedda/web-time |
| webkit2gtk | 2.0.2 | MIT | https://github.com/tauri-apps/webkit2gtk-rs |
| webkit2gtk-sys | 2.0.2 | MIT | https://github.com/tauri-apps/webkit2gtk-rs |
| webpki-roots | 1.0.8 | CDLA-Permissive-2.0 | https://github.com/rustls/webpki-roots |
| webview2-com | 0.38.2 | MIT | https://github.com/wravery/webview2-rs |
| webview2-com-macros | 0.8.1 | MIT | https://github.com/wravery/webview2-rs |
| webview2-com-sys | 0.38.2 | MIT | https://github.com/wravery/webview2-rs |
| weezl | 0.1.12 | Apache-2.0 OR MIT | https://github.com/image-rs/weezl |
| winapi | 0.3.9 | Apache-2.0 OR MIT | https://github.com/retep998/winapi-rs |
| winapi-i686-pc-windows-gnu | 0.4.0 | Apache-2.0 OR MIT | https://github.com/retep998/winapi-rs |
| winapi-util | 0.1.11 | MIT OR Unlicense | https://github.com/BurntSushi/winapi-util |
| winapi-x86_64-pc-windows-gnu | 0.4.0 | Apache-2.0 OR MIT | https://github.com/retep998/winapi-rs |
| window-vibrancy | 0.6.0 | Apache-2.0 OR MIT | https://github.com/tauri-apps/tauri-plugin-vibrancy |
| windows | 0.36.1 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| windows | 0.61.3 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| windows | 0.62.2 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| windows_aarch64_gnullvm | 0.42.2 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| windows_aarch64_gnullvm | 0.52.6 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| windows_aarch64_gnullvm | 0.53.1 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| windows_aarch64_msvc | 0.36.1 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| windows_aarch64_msvc | 0.42.2 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| windows_aarch64_msvc | 0.52.6 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| windows_aarch64_msvc | 0.53.1 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| windows_i686_gnu | 0.36.1 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| windows_i686_gnu | 0.42.2 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| windows_i686_gnu | 0.52.6 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| windows_i686_gnu | 0.53.1 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| windows_i686_gnullvm | 0.52.6 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| windows_i686_gnullvm | 0.53.1 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| windows_i686_msvc | 0.36.1 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| windows_i686_msvc | 0.42.2 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| windows_i686_msvc | 0.52.6 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| windows_i686_msvc | 0.53.1 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| windows_x86_64_gnu | 0.36.1 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| windows_x86_64_gnu | 0.42.2 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| windows_x86_64_gnu | 0.52.6 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| windows_x86_64_gnu | 0.53.1 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| windows_x86_64_gnullvm | 0.42.2 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| windows_x86_64_gnullvm | 0.52.6 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| windows_x86_64_gnullvm | 0.53.1 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| windows_x86_64_msvc | 0.36.1 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| windows_x86_64_msvc | 0.42.2 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| windows_x86_64_msvc | 0.52.6 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| windows_x86_64_msvc | 0.53.1 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| windows-collections | 0.2.0 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| windows-collections | 0.3.2 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| windows-core | 0.61.2 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| windows-core | 0.62.2 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| windows-future | 0.2.1 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| windows-future | 0.3.2 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| windows-implement | 0.60.2 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| windows-interface | 0.59.3 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| windows-link | 0.1.3 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| windows-link | 0.2.1 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| windows-numerics | 0.2.0 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| windows-numerics | 0.3.1 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| windows-result | 0.3.4 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| windows-result | 0.4.1 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| windows-strings | 0.4.2 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| windows-strings | 0.5.1 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| windows-sys | 0.45.0 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| windows-sys | 0.52.0 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| windows-sys | 0.59.0 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| windows-sys | 0.60.2 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| windows-sys | 0.61.2 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| windows-targets | 0.42.2 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| windows-targets | 0.52.6 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| windows-targets | 0.53.5 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| windows-threading | 0.1.0 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| windows-threading | 0.2.1 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| windows-version | 0.1.7 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| winnow | 0.5.40 | MIT | https://github.com/winnow-rs/winnow |
| winnow | 0.7.15 | MIT | https://github.com/winnow-rs/winnow |
| winnow | 1.0.3 | MIT | https://github.com/winnow-rs/winnow |
| winreg | 0.55.0 | MIT | https://github.com/gentoo90/winreg-rs |
| wit-bindgen | 0.57.1 | Apache-2.0 OR Apache-2.0 WITH LLVM-exception OR MIT | https://github.com/bytecodealliance/wit-bindgen |
| writeable | 0.6.3 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| wry | 0.55.1 | Apache-2.0 OR MIT | https://github.com/tauri-apps/wry |
| wyz | 0.5.1 | MIT | https://github.com/myrrlyn/wyz |
| x11 | 2.21.0 | MIT | https://github.com/AltF02/x11-rs.git |
| x11-dl | 2.21.0 | MIT | https://github.com/AltF02/x11-rs.git |
| x25519-dalek | 2.0.1 | BSD-3-Clause | https://github.com/dalek-cryptography/curve25519-dalek/tree/main/x25519-dalek |
| xattr | 1.6.1 | Apache-2.0 OR MIT | https://github.com/Stebalien/xattr |
| yoke | 0.8.3 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| yoke-derive | 0.8.2 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| zbus | 5.12.0 | MIT | https://github.com/z-galaxy/zbus/ |
| zbus_macros | 5.12.0 | MIT | https://github.com/z-galaxy/zbus/ |
| zbus_names | 4.3.3 | MIT | https://github.com/z-galaxy/zbus/ |
| zerocopy | 0.8.52 | Apache-2.0 OR BSD-2-Clause OR MIT | https://github.com/google/zerocopy |
| zerocopy-derive | 0.8.52 | Apache-2.0 OR BSD-2-Clause OR MIT | https://github.com/google/zerocopy |
| zerofrom | 0.1.8 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| zerofrom-derive | 0.1.7 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| zeroize | 1.9.0 | Apache-2.0 OR MIT | https://github.com/RustCrypto/utils |
| zeroize_derive | 1.5.0 | Apache-2.0 OR MIT | https://github.com/RustCrypto/utils |
| zerotrie | 0.2.4 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| zerovec | 0.11.6 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| zerovec-derive | 0.11.3 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| zip | 8.6.0 | MIT | https://github.com/zip-rs/zip2 |
| zlib-rs | 0.6.7 | Zlib | https://github.com/trifectatechfoundation/zlib-rs |
| zmij | 1.0.21 | MIT | https://github.com/dtolnay/zmij |
| zopfli | 0.8.3 | Apache-2.0 | https://github.com/zopfli-rs/zopfli |
| zune-core | 0.5.1 | Apache-2.0 OR MIT OR Zlib | https://github.com/etemesi254/zune-image |
| zune-jpeg | 0.5.15 | Apache-2.0 OR MIT OR Zlib | https://github.com/etemesi254/zune-image/tree/dev/crates/zune-jpeg |
| zvariant | 5.13.0 | MIT | https://github.com/z-galaxy/zbus/ |
| zvariant_derive | 5.13.0 | MIT | https://github.com/z-galaxy/zbus/ |
| zvariant_utils | 3.5.0 | MIT | https://github.com/z-galaxy/zbus/ |

668 crates.

## License summary

| License | Package count |
|---|---|
| Apache-2.0 OR MIT | 405 |
| MIT | 157 |
| Apache-2.0 OR MIT OR Zlib | 24 |
| Unicode-3.0 | 18 |
| Apache-2.0 | 11 |
| MIT OR Unlicense | 7 |
| BSD-3-Clause | 5 |
| MPL-2.0 | 5 |
| ISC | 5 |
| Apache-2.0 OR Apache-2.0 WITH LLVM-exception OR MIT | 5 |
| Zlib | 3 |
| BSD-2-Clause | 3 |
| CC0-1.0 | 3 |
| Apache-2.0 OR CC0-1.0 OR MIT-0 | 3 |
| MIT OR Apache-2.0 | 2 |
| Apache-2.0 OR ISC OR MIT | 2 |
| Apache-2.0 OR BSD-3-Clause | 2 |
| Apache-2.0 OR BSD-3-Clause OR MIT | 2 |
| Apache-2.0 OR LGPL-2.1-or-later OR MIT | 2 |
| Apache-2.0 OR BSD-2-Clause OR MIT | 2 |
| 0BSD OR Apache-2.0 OR MIT | 1 |
| Apache-2.0 OR Apache-2.0 WITH LLVM-exception OR CC0-1.0 | 1 |
| BSD-3-Clause AND MIT | 1 |
| BSD-3-Clause OR MIT | 1 |
| Apache-2.0 AND MIT | 1 |
| Apache-2.0 OR BSD-1-Clause OR MIT | 1 |
| Apache-2.0 AND ISC | 1 |
| Apache-2.0 OR BSL-1.0 | 1 |
| Apache-2.0 WITH LLVM-exception | 1 |
| (Apache-2.0 OR MIT) AND Unicode-3.0 | 1 |
| CDLA-Permissive-2.0 | 1 |
