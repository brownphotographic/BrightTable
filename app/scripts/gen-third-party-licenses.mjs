#!/usr/bin/env node
// Regenerates THIRD-PARTY-LICENSES.md at the repo root by scanning every
// runtime/build dependency in Cargo.lock (via the `cargo-license` cargo
// subcommand: `cargo install cargo-license`) and package-lock.json (via the
// `license-checker` npm package). Run as part of `npm run build:appimage` so
// the file can't drift from the actual dependency tree.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import checker from "license-checker";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appDir = join(scriptDir, "..");
const srcTauriDir = join(appDir, "src-tauri");
const repoRoot = join(appDir, "..");
const outPath = join(repoRoot, "THIRD-PARTY-LICENSES.md");

// `cargo install cargo-license` puts the subcommand in ~/.cargo/bin, which
// isn't always on PATH (e.g. distro-packaged cargo, like Fedora's rpm build,
// doesn't add it). Append it so `cargo license` resolves regardless of shell setup.
const cargoBin = join(homedir(), ".cargo", "bin");
const envWithCargoBin = { ...process.env, PATH: `${process.env.PATH}:${cargoBin}` };

function getCargoLicenses() {
  let raw;
  try {
    raw = execFileSync(
      "cargo",
      ["license", "--json", "--avoid-dev-deps"],
      { cwd: srcTauriDir, encoding: "utf8", env: envWithCargoBin },
    );
  } catch (err) {
    throw new Error(
      "Failed to run `cargo license`. Install it with `cargo install cargo-license` " +
        `and make sure it's on PATH.\n${err.message}`,
    );
  }
  return JSON.parse(raw)
    .filter((crate) => crate.name !== "app")
    .map((crate) => ({
      name: crate.name,
      version: crate.version,
      license: crate.license || "UNKNOWN",
      repository: crate.repository || "",
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function getNpmLicenses() {
  return new Promise((resolve, reject) => {
    checker.init(
      { start: appDir, production: true, excludePrivatePackages: true },
      (err, packages) => {
        if (err) return reject(err);
        const items = Object.entries(packages).map(([key, meta]) => {
          const at = key.lastIndexOf("@");
          const name = key.slice(0, at);
          const version = key.slice(at + 1);
          return {
            name,
            version,
            license: Array.isArray(meta.licenses) ? meta.licenses.join(" OR ") : meta.licenses || "UNKNOWN",
            repository: meta.repository || "",
          };
        });
        items.sort((a, b) => a.name.localeCompare(b.name));
        resolve(items);
      },
    );
  });
}

function toTable(items) {
  const rows = items.map((i) => `| ${i.name} | ${i.version} | ${i.license} | ${i.repository} |`);
  return ["| Package | Version | License | Repository |", "|---|---|---|---|", ...rows].join("\n");
}

function toSummary(items) {
  const counts = new Map();
  for (const { license } of items) counts.set(license, (counts.get(license) ?? 0) + 1);
  const rows = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([license, count]) => `| ${license} | ${count} |`);
  return ["| License | Package count |", "|---|---|", ...rows].join("\n");
}

const [npmItems, cargoItems] = await Promise.all([getNpmLicenses(), getCargoLicenses()]);

const doc = `# Third-Party Licenses

ImmAture is distributed under the MIT License (see \`LICENSE\`). It is built on
the open-source packages listed below, each under its own license. This file
lists the package name, version, SPDX license identifier, and source
repository for every direct and transitive dependency, generated from
\`Cargo.lock\` (Rust/Tauri, via \`cargo-license\`) and \`package-lock.json\`
(frontend, via \`license-checker\`).

Full license text for any package can be found in its source repository
linked below, or in the corresponding file under \`node_modules/<pkg>/LICENSE\`
or the crate's source on crates.io.

This file is generated automatically by \`app/scripts/gen-third-party-licenses.mjs\`
as part of \`npm run build:appimage\` - do not edit it by hand.

## Frontend dependencies (npm)

${toTable(npmItems)}

${npmItems.length} packages.

## Backend dependencies (Rust / Tauri, via Cargo)

${toTable(cargoItems)}

${cargoItems.length} crates.

## License summary

${toSummary([...npmItems, ...cargoItems])}
`;

writeFileSync(outPath, doc);
console.log(`Wrote ${outPath} (${npmItems.length} npm packages, ${cargoItems.length} cargo crates)`);
