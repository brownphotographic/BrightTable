#!/usr/bin/env node
// Bumps the patch version in src-tauri/Cargo.toml, which tauri.conf.json
// (no "version" field of its own) inherits as the app/AppImage version.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const cargoTomlPath = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "Cargo.toml");
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
