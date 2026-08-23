#!/usr/bin/env node
// Strips GPU/Wayland-driver-adjacent libraries that linuxdeploy's GTK plugin
// swept up from the build host as transitive deps of GTK3/WebKitGTK, but
// that must always come from the *runtime* host instead - virtually every
// Linux desktop with a working Wayland/GTK session already has these
// installed, and bundling a frozen copy from the build machine means the
// app tries to negotiate with the runtime host's Wayland/Mesa stack using
// a shim built for a different one.
//
// Concretely: bundling libwayland-egl.so.1 from an Ubuntu 24.04 build host
// produced `Could not create default EGL display: EGL_BAD_PARAMETER.
// Aborting...` on launch on a Fedora 44 host - a hard abort, not a
// degraded-but-working fallback, and invisible to every WebKit/GDK
// rendering env var (WEBKIT_DISABLE_COMPOSITING_MODE,
// WEBKIT_DISABLE_DMABUF_RENDERER, GDK_BACKEND=x11, GDK_GL=disable all had
// zero effect) because none of those change which libwayland-egl.so
// actually gets loaded via AppRun's LD_LIBRARY_PATH. Deleting the bundled
// copy makes the dynamic linker fall through to the runtime host's own
// (correct, matching) copy instead, same as already happens for libc/libEGL/
// libGL/etc., which linuxdeploy's default excludelist already keeps out of
// the bundle - libwayland-egl.so just isn't on that list.
//
// See README.md's Troubleshooting section for the fuller writeup.
import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const libDir = join(
  scriptDir,
  "..",
  "src-tauri",
  "target",
  "release",
  "bundle",
  "appimage",
  "BrightTable.AppDir",
  "usr",
  "lib",
);

if (!existsSync(libDir)) {
  throw new Error(`Expected AppDir lib dir not found: ${libDir} - did the appimage build run first?`);
}

const excludePatterns = [/^libwayland-egl\.so(\.|$)/];

const removed = readdirSync(libDir).filter((name) => excludePatterns.some((pattern) => pattern.test(name)));
for (const name of removed) {
  unlinkSync(join(libDir, name));
}

console.log(
  removed.length > 0
    ? `Removed bundled GPU-driver-adjacent libs so the runtime host's own copy is used instead: ${removed.join(", ")}`
    : "No bundled GPU-driver-adjacent libs found to remove.",
);
