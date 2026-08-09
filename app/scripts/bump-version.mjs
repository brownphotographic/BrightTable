#!/usr/bin/env node
// Bumps the patch version in src-tauri/Cargo.toml, which tauri.conf.json
// (no "version" field of its own) inherits as the app/AppImage version.
//
// Also requires an Immich server version this build was tested against.
// Policy: no backward-compat testing, so that version is used as both the
// floor (MIN_TESTED_SERVER_VERSION in immich/models.rs, which drives the
// "below floor" warning in Preferences/sidebar) and the confirmed version
// shown in the About dialog (AboutDialog.tsx) - they're always the same
// value now. Set TESTED_IMMICH_VERSION to skip the prompt (e.g.
// `TESTED_IMMICH_VERSION=3.1.0 npm run build:appimage`); otherwise this
// prompts on a TTY, or fails outright when run non-interactively, rather
// than silently shipping a stale compatibility claim.
//
// The tested version is resolved *before* any file is written, so a
// non-interactive run with no TESTED_IMMICH_VERSION fails clean, without
// leaving Cargo.toml bumped and everything else stale.
//
// COMPATIBILITY.md still needs a new row by hand - that one carries
// free-text notes this script can't sensibly generate.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const versionFormat = /^\d+\.\d+\.\d+$/;

let testedVersion = process.env.TESTED_IMMICH_VERSION;
if (testedVersion && !versionFormat.test(testedVersion)) {
  throw new Error(`TESTED_IMMICH_VERSION "${testedVersion}" isn't in x.y.z form.`);
}

if (!testedVersion) {
  if (!stdin.isTTY) {
    throw new Error(
      "No TESTED_IMMICH_VERSION set and this isn't a TTY to prompt on. " +
        "Set TESTED_IMMICH_VERSION=x.y.z (the Immich server version this build was tested against) and re-run.",
    );
  }
  const rl = createInterface({ input: stdin, output: stdout });
  while (!testedVersion) {
    const answer = (await rl.question("Immich server version tested for this build (x.y.z): ")).trim();
    if (versionFormat.test(answer)) {
      testedVersion = answer;
    } else {
      console.log(`"${answer}" isn't in x.y.z form, try again.`);
    }
  }
  rl.close();
}

const [, tMajor, tMinor, tPatch] = testedVersion.match(/^(\d+)\.(\d+)\.(\d+)$/);

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

const modelsRsPath = join(scriptDir, "..", "src-tauri", "src", "immich", "models.rs");
const modelsRs = readFileSync(modelsRsPath, "utf8");
const floorLine = /MIN_TESTED_SERVER_VERSION: \(u32, u32, u32\) = \(\d+, \d+, \d+\)/;
if (!floorLine.test(modelsRs)) {
  throw new Error(`Could not find MIN_TESTED_SERVER_VERSION in ${modelsRsPath}`);
}
writeFileSync(
  modelsRsPath,
  modelsRs.replace(floorLine, `MIN_TESTED_SERVER_VERSION: (u32, u32, u32) = (${tMajor}, ${tMinor}, ${tPatch})`),
);

const aboutDialogPath = join(scriptDir, "..", "src", "components", "AboutDialog.tsx");
const aboutDialog = readFileSync(aboutDialogPath, "utf8");
const testedLine = /const TESTED_SERVER_VERSIONS = '.*';/;
if (!testedLine.test(aboutDialog)) {
  throw new Error(`Could not find TESTED_SERVER_VERSIONS line in ${aboutDialogPath}`);
}
writeFileSync(
  aboutDialogPath,
  aboutDialog.replace(testedLine, `const TESTED_SERVER_VERSIONS = '${testedVersion} (floor and confirmed)';`),
);

console.log(`Set tested Immich server version (floor and confirmed) to ${testedVersion}.`);
console.log("Remember to also add a row for this build to COMPATIBILITY.md by hand.");
