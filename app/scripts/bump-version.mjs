#!/usr/bin/env node
// Bumps the patch version in src-tauri/Cargo.toml, which tauri.conf.json
// (no "version" field of its own) inherits as the app/AppImage version.
//
// If a TESTED_IMMICH_VERSION env var is set (e.g.
// `TESTED_IMMICH_VERSION=3.0.1 npm run build:appimage`), this also updates
// the "Tested against Immich ..." line shown in the About dialog
// (AboutDialog.tsx), pairing it with the floor from MIN_TESTED_SERVER_VERSION
// in immich/models.rs. That's the one thing bumping the version doesn't
// otherwise sync automatically (the app version number in the About dialog
// already updates on its own via Tauri's getVersion()) - see COMPATIBILITY.md
// for the same information at the repo-doc level, which still needs updating
// by hand.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const cargoTomlPath = join(scriptDir, "..", "src-tauri", "Cargo.toml");
const cargoToml = readFileSync(cargoTomlPath, "utf8");

const versionLine = /^version = "(\d+)\.(\d+)\.(\d+)"/m;
const match = cargoToml.match(versionLine);
if (!match) {
  throw new Error(`Could not find a "version = \"x.y.z\"" line in ${cargoTomlPath}`);
}

const [, major, minor, patch] = match;
const nextVersion = `${major}.${minor}.${Number(patch) + 1}`;
writeFileSync(cargoTomlPath, cargoToml.replace(versionLine, `version = "${nextVersion}"`));

console.log(`Bumped version: ${major}.${minor}.${patch} -> ${nextVersion}`);

const testedVersion = process.env.TESTED_IMMICH_VERSION;
if (testedVersion) {
  const modelsRsPath = join(scriptDir, "..", "src-tauri", "src", "immich", "models.rs");
  const modelsRs = readFileSync(modelsRsPath, "utf8");
  const floorMatch = modelsRs.match(/MIN_TESTED_SERVER_VERSION: \(u32, u32, u32\) = \((\d+), (\d+), (\d+)\)/);
  if (!floorMatch) {
    throw new Error(`Could not find MIN_TESTED_SERVER_VERSION in ${modelsRsPath}`);
  }
  const floor = `${floorMatch[1]}.${floorMatch[2]}.${floorMatch[3]}`;

  const aboutDialogPath = join(scriptDir, "..", "src", "components", "AboutDialog.tsx");
  const aboutDialog = readFileSync(aboutDialogPath, "utf8");
  const testedLine = /const TESTED_SERVER_VERSIONS = '.*';/;
  if (!testedLine.test(aboutDialog)) {
    throw new Error(`Could not find TESTED_SERVER_VERSIONS line in ${aboutDialogPath}`);
  }
  writeFileSync(
    aboutDialogPath,
    aboutDialog.replace(testedLine, `const TESTED_SERVER_VERSIONS = '${floor} (floor) – ${testedVersion} (confirmed)';`),
  );
  console.log(`Updated About dialog: tested against Immich ${floor} (floor) – ${testedVersion} (confirmed)`);
  console.log("Remember to also update COMPATIBILITY.md by hand.");
} else {
  console.log("TESTED_IMMICH_VERSION not set - About dialog compatibility line left unchanged.");
}
