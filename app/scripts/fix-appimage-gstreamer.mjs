#!/usr/bin/env node
// Repairs a GStreamer plugin-discovery bug in the AppImage that
// `cargo tauri build --bundles appimage` just produced, then repackages it.
//
// No GStreamer plugins are bundled into this AppImage (bundle_media_framework
// is off), but linuxdeploy's AppRun binary unconditionally sets
// GST_PLUGIN_SYSTEM_PATH(_1_0) to "$APPDIR/usr/lib/gstreamer-1.0" (which
// doesn't exist) before exec'ing the app. Because GST_PLUGIN_SYSTEM_PATH_1_0
// being set at all makes GStreamer stop scanning its compiled-in default
// system plugin dir, this makes every codec/element installed on the host -
// down to core elements like appsink - invisible to the packaged app. Video
// played inside the app either fails outright or, worse, decodes through
// whatever fallback element GStreamer still manages to find, producing
// garbled output instead of a hard error.
//
// linuxdeploy's AppRun appends whatever value GST_PLUGIN_SYSTEM_PATH(_1_0)
// already has after its own bogus path, so pre-seeding it (in the editable
// apprun-hooks script that runs just before AppRun) with the real system
// plugin dirs fixes it without bundling a frozen snapshot of today's codecs.
//
// That alone isn't enough: WebKitGTK renders this app's content in a
// separate, bubblewrap-sandboxed WebProcess, which does not inherit the
// main process's environment (only a curated allowlist gets through) - so
// GST_PLUGIN_SYSTEM_PATH_1_0 set above never reaches the process that
// actually needs it for media playback. Disabling the sandbox is what
// makes the env fix actually take effect. This is acceptable here because
// this WebProcess only ever renders this app's own bundled UI and local
// blob: media - never third-party/remote web content.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const bundleDir = join(scriptDir, "..", "src-tauri", "target", "release", "bundle", "appimage");
const appDir = join(bundleDir, "BrightTable.AppDir");
const hookPath = join(appDir, "apprun-hooks", "linuxdeploy-plugin-gtk.sh");

if (!existsSync(hookPath)) {
  throw new Error(`Expected AppRun hook not found: ${hookPath} - did the appimage build run first?`);
}

const marker = "# GST_PLUGIN_SYSTEM_PATH fix (fix-appimage-gstreamer.mjs)";
const hook = readFileSync(hookPath, "utf8");

if (hook.includes(marker)) {
  console.log("AppRun hook already patched, skipping.");
} else {
  const patch = `
${marker}
export GST_PLUGIN_SYSTEM_PATH_1_0="/usr/lib64/gstreamer-1.0:/usr/lib/x86_64-linux-gnu/gstreamer-1.0:/usr/lib/gstreamer-1.0:\${GST_PLUGIN_SYSTEM_PATH_1_0}"
export GST_PLUGIN_SYSTEM_PATH="/usr/lib64/gstreamer:/usr/lib/x86_64-linux-gnu/gstreamer:/usr/lib/gstreamer:\${GST_PLUGIN_SYSTEM_PATH}"
export WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1
`;
  writeFileSync(hookPath, hook + patch);
  console.log(`Patched ${hookPath}`);
}

// Cargo.toml's version is what tauri.conf.json's appimage filename inherits.
const cargoToml = readFileSync(join(scriptDir, "..", "src-tauri", "Cargo.toml"), "utf8");
const version = cargoToml.match(/^version = "(\d+\.\d+\.\d+)"/m)?.[1];
if (!version) throw new Error("Could not read version from Cargo.toml");

const outputPath = join(bundleDir, `BrightTable_${version}_amd64.AppImage`);
const plugin = join(homedir(), ".cache", "tauri", "linuxdeploy-plugin-appimage.AppImage");
if (!existsSync(plugin)) {
  throw new Error(`Expected linuxdeploy plugin not found: ${plugin} - has the appimage build run at least once on this machine?`);
}

console.log(`Repackaging ${outputPath}`);
execFileSync(plugin, ["--appimage-extract-and-run", "--appdir", appDir], {
  env: { ...process.env, OUTPUT: outputPath, ARCH: "x86_64", APPIMAGE_EXTRACT_AND_RUN: "1" },
  stdio: "inherit",
});
