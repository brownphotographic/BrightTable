#!/usr/bin/env node
// Sets the version in src-tauri/Cargo.toml, which tauri.conf.json
// (no "version" field of its own) inherits as the app/Flatpak version.
// The new version is set manually (prompted for, or via APP_VERSION) rather
// than auto-incremented, so the person cutting the build makes a deliberate
// call about major/minor/patch.
//
// Also requires an Immich server version this build was tested against.
// Policy: no backward-compat testing, so that version is used as both the
// floor (MIN_TESTED_SERVER_VERSION in immich/models.rs, which drives the
// "below floor" warning in Preferences/sidebar) and the confirmed version
// shown in the About dialog (AboutDialog.tsx) - they're always the same
// value now. Set TESTED_IMMICH_VERSION to skip the prompt (e.g.
// `TESTED_IMMICH_VERSION=3.1.0 npm run build:flatpak`); otherwise this
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

// Escape hatch for local iteration builds (e.g. chasing a packaging bug,
// not cutting a real release): skips both prompts and leaves Cargo.toml,
// models.rs, AboutDialog.tsx, and the Flatpak metainfo.xml untouched.
if (process.env.SKIP_VERSION_BUMP) {
  console.log("SKIP_VERSION_BUMP set - leaving version/tested-server-version untouched.");
  process.exit(0);
}

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
  console.log("\n>>> bump-version.mjs is waiting for input <<<");
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
const currentVersion = match[0].match(/"(.+)"/)[1];

let nextVersion = process.env.APP_VERSION;
if (nextVersion && !versionFormat.test(nextVersion)) {
  throw new Error(`APP_VERSION "${nextVersion}" isn't in x.y.z form.`);
}

if (!nextVersion) {
  if (!stdin.isTTY) {
    throw new Error(
      "No APP_VERSION set and this isn't a TTY to prompt on. " +
        "Set APP_VERSION=x.y.z (the new app version) and re-run.",
    );
  }
  console.log("\n>>> bump-version.mjs is waiting for input <<<");
  const rl = createInterface({ input: stdin, output: stdout });
  while (!nextVersion) {
    const answer = (await rl.question(`App version (current: ${currentVersion}, x.y.z): `)).trim();
    if (!versionFormat.test(answer)) {
      console.log(`"${answer}" isn't in x.y.z form, try again.`);
    } else if (answer === currentVersion) {
      console.log(`"${answer}" is the current version, enter a new one.`);
    } else {
      nextVersion = answer;
    }
  }
  rl.close();
}

writeFileSync(cargoTomlPath, cargoToml.replace(versionLine, `version = "${nextVersion}"`));
console.log(`Set version: ${currentVersion} -> ${nextVersion}`);

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

// The Flatpak's AppStream metadata carries its own separate `<release>`
// version - nothing else in the build reads or writes it, so without this
// it just sits frozen at whatever it was last hand-edited to forever. That's
// not cosmetic: `flatpak info` and Flatseal both read *this* field as "the
// version", not the actual binary's, which makes every build after the
// first look like the same never-updated release no matter how many times
// you actually bump Cargo.toml and rebuild.
const metainfoPath = join(scriptDir, "..", "flatpak", "io.github.brownphotographic.BrightTable.metainfo.xml");
const metainfo = readFileSync(metainfoPath, "utf8");
const releaseLine = /<release version="[^"]*" date="[^"]*" \/>/;
if (!releaseLine.test(metainfo)) {
  throw new Error(`Could not find a "<release version=... date=.../>" line in ${metainfoPath}`);
}
const releaseDate = new Date().toISOString().slice(0, 10);
writeFileSync(
  metainfoPath,
  metainfo.replace(releaseLine, `<release version="${nextVersion}" date="${releaseDate}" />`),
);
console.log(`Set Flatpak metainfo release to ${nextVersion} (${releaseDate}).`);

console.log("Remember to also add a row for this build to COMPATIBILITY.md by hand.");
