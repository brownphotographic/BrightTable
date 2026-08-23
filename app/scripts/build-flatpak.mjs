#!/usr/bin/env node
// Builds and bundles the Flatpak distribution - the second, additive
// distribution channel alongside the AppImage (see build:appimage:only).
//
// Unlike the AppImage build, this does a real *source* build inside
// flatpak-builder's own sandbox, compiled against the GNOME runtime/SDK's
// own toolchain and glibc - not whatever host/distrobox container this
// script happens to run in. That's the whole point: the resulting binary's
// glibc-symbol floor is the runtime's, identical for every user regardless
// of the build machine, sidestepping the entire "build on an old enough
// host" dance the AppImage path needs. See flatpak/*.yml's own comments for
// the manifest-level detail (permissions granted, the --share=network
// build-time trade-off, etc).
//
// Must run on the host, not inside the Ubuntu 24.04 distrobox used for the
// AppImage build - flatpak-builder needs its own sandboxing (bubblewrap)
// and the GNOME runtime/SDK/extensions installed via `flatpak install`,
// which is unrelated to that container's glibc-floor purpose. See
// README.md's Flatpak section for one-time host setup.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appDir = join(scriptDir, "..");
const appId = "io.github.brownphotographic.BrightTable";
const manifest = join(appDir, "flatpak", `${appId}.yml`);
const buildDir = join(appDir, "flatpak-build");
const repoDir = join(appDir, "flatpak-repo");

if (!existsSync(manifest)) {
  throw new Error(`Expected Flatpak manifest not found: ${manifest}`);
}

for (const tool of ["flatpak-builder", "flatpak"]) {
  try {
    execFileSync("which", [tool], { stdio: "ignore" });
  } catch {
    throw new Error(
      `${tool} not found on PATH - see README.md's Flatpak section for one-time host setup ` +
        "(flatpak-builder, plus `flatpak install org.gnome.Platform//50 org.gnome.Sdk//50 " +
        "org.freedesktop.Sdk.Extension.rust-stable org.freedesktop.Sdk.Extension.node22`).",
    );
  }
}

const cargoToml = join(appDir, "src-tauri", "Cargo.toml");
const version = readFileSync(cargoToml, "utf8").match(/^version = "(\d+\.\d+\.\d+)"/m)?.[1];
if (!version) throw new Error(`Could not read version from ${cargoToml}`);

console.log(`Building Flatpak for ${appId} (app version ${version})`);
execFileSync("flatpak-builder", ["--force-clean", "--repo", repoDir, buildDir, manifest], {
  cwd: appDir,
  stdio: "inherit",
});

const outputPath = join(appDir, "src-tauri", "target", "release", "bundle", "flatpak", `BrightTable_${version}_x86_64.flatpak`);
mkdirSync(dirname(outputPath), { recursive: true });

console.log(`Bundling ${outputPath}`);
execFileSync("flatpak", ["build-bundle", repoDir, outputPath, appId], { cwd: appDir, stdio: "inherit" });

console.log(`Done: ${outputPath}`);
console.log(`Install locally with: flatpak install --user ${outputPath}`);
