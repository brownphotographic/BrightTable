#!/usr/bin/env node
// Regenerates src-tauri/resources/lensfun-catalog.json from a lensfun
// database checkout - the same database RawTherapee, ART and darktable match
// lens names against, so the Change Lens picker offers lensfun's exact
// `<maker>`/`<model>` strings (what has to land in EXIF LensMake/LensModel for
// those tools to auto-match a lens profile).
//
// Usage:
//   git clone --depth 1 https://github.com/lensfun/lensfun.git /tmp/lensfun
//   node scripts/gen-lens-catalog.mjs /tmp/lensfun
//
// The lensfun database is CC-BY-SA 3.0 (see THIRD-PARTY-LICENSES.md). The
// generated JSON is committed, so a normal build never needs network access.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const outPath = join(scriptDir, "..", "src-tauri", "resources", "lensfun-catalog.json");

const checkout = process.argv[2];
if (!checkout) {
  console.error("usage: node scripts/gen-lens-catalog.mjs <lensfun checkout>");
  process.exit(1);
}
const dbDir = join(checkout, "data", "db");

function unescape(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

// `<tag>text</tag>` occurrences with no `lang=` attribute - lensfun's
// canonical (matched-against) value - plus the `lang="en"` display alias.
function canonical(block, tag) {
  const m = block.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return m ? unescape(m[1]) : null;
}
function english(block, tag) {
  const m = block.match(new RegExp(`<${tag} lang="en">([^<]*)</${tag}>`));
  return m ? unescape(m[1]) : null;
}
function all(block, tag) {
  return [...block.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, "g"))].map((m) => unescape(m[1]));
}

const num = (s) => (s == null ? null : Number(s.replace(",", ".")));

// Mirrors lensfun's own `lfLens::GuessParameters` closely enough for the
// naming styles in its database: "24-70mm", "f/2.8", "F1.4", "1:2.8-4",
// Leica/Zeiss "1:2/50", "2,8/35", "2/50".
export function guessParameters(name) {
  let fmin = null;
  let fmax = null;
  let amin = null;
  let amax = null;

  let m = name.match(/(\d+(?:[.,]\d+)?)(?:\s*-\s*(\d+(?:[.,]\d+)?))?\s*mm/i);
  if (m) {
    fmin = num(m[1]);
    fmax = num(m[2] ?? m[1]);
  }
  // The f-number marker must not sit inside a word ("XF18" is a Fujifilm
  // lens line, not f/18) unless it directly follows "mm" ("18-55mmF2.8").
  m = name.match(/(?:^|[^A-Za-z]|mm)(?:[fF](?:\/\s?)?(?=\d)|1:|1\/)(\d+(?:[.,]\d+)?)(?:\s*-\s*(\d+(?:[.,]\d+)?))?/);
  if (m) {
    amin = num(m[1]);
    amax = num(m[2] ?? m[1]);
  }
  // Leica/Zeiss "<aperture>/<focal>" ("1:2/50", "2,8/35", "2.8/50M",
  // "1:2.8/28-90"), occasionally written the other way round ("56/1.4").
  m = name.match(/(?:1:)?(\d+(?:[.,]\d+)?)(?:-(\d+(?:[.,]\d+)?))?\/(\d+(?:[.,]\d+)?)(?:-(\d+))?(?!\d)/);
  if (m && (fmin == null || amin == null)) {
    let [ap, apTele, fo, foTele] = [num(m[1]), num(m[2] ?? m[1]), num(m[3]), num(m[4] ?? m[3])];
    if (ap > fo) [ap, apTele, fo, foTele] = [fo, foTele, ap, apTele];
    if (fmin == null) {
      fmin = fo;
      fmax = foTele;
    }
    if (amin == null) {
      amin = ap;
      amax = apTele;
    }
  }
  // "f/32.0-4.0" (a few medium-format entries list min-max backwards).
  if (amin != null && amax != null && amax < amin) [amin, amax] = [amax, amin];
  return { fmin, fmax, amin, amax };
}

const lenses = [];
const cameras = [];
for (const file of readdirSync(dbDir).filter((f) => f.endsWith(".xml")).sort()) {
  const xml = readFileSync(join(dbDir, file), "utf8").replace(/<!--[\s\S]*?-->/g, "");
  for (const [, block] of xml.matchAll(/<camera>([\s\S]*?)<\/camera>/g)) {
    const maker = canonical(block, "maker");
    const model = canonical(block, "model");
    const crop = num(canonical(block, "cropfactor"));
    if (maker && model && crop) cameras.push({ maker, model, crop });
  }
  for (const [, block] of xml.matchAll(/<lens>([\s\S]*?)<\/lens>/g)) {
    const maker = canonical(block, "maker");
    const model = canonical(block, "model");
    if (!maker || !model) continue;
    const mounts = all(block, "mount");
    // Fixed-lens compacts/action cams use lowercase internal mount ids
    // ("canonG12", "goproHero4") - those lenses can't be swapped onto
    // another body, so they never belong in a Change Lens picker.
    if (!mounts.some((m) => /^[A-Z0-9]/.test(m))) continue;
    const guess = guessParameters(model);
    // Calibration focal lengths as a fallback for names that don't spell
    // the focal length out (e.g. "Helios 44-2").
    const focals = [...block.matchAll(/focal="([\d.]+)"/g)].map((m) => Number(m[1]));
    const fmin = guess.fmin ?? (focals.length ? Math.min(...focals) : null);
    const fmax = guess.fmax ?? (focals.length ? Math.max(...focals) : null);
    lenses.push({
      maker,
      model,
      displayName: english(block, "model"),
      mounts,
      crop: num(canonical(block, "cropfactor")),
      focalMin: fmin,
      focalMax: fmax,
      apertureMax: guess.amin,
      apertureMaxTele: guess.amax !== guess.amin && fmin !== fmax ? guess.amax : null,
    });
  }
}

let source = { repo: "https://github.com/lensfun/lensfun", commit: null, date: null };
try {
  const [commit, date] = execFileSync("git", ["-C", checkout, "log", "-1", "--format=%H%n%cs"], { encoding: "utf8" }).trim().split("\n");
  source = { ...source, commit, date };
} catch {
  // Not a git checkout (e.g. a distro's /usr/share/lensfun) - leave unset.
}

writeFileSync(outPath, JSON.stringify({ source, license: "CC-BY-SA-3.0", lenses, cameras }) + "\n");
console.log(`Wrote ${lenses.length} lenses and ${cameras.length} cameras to ${outPath}`);
