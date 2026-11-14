#!/usr/bin/env node
// Regenerates the table of contents in the repo-root README.md, between the
// <!-- START doctoc --> / <!-- END doctoc --> markers. Lists ## and ###
// headings (skipping fenced code blocks) with GitHub-style anchors. Run as
// part of `npm run build:flatpak` so the TOC can't drift from the headings.
// No dependencies; the markers stay compatible with `npx doctoc`.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const readmePath = join(scriptDir, "..", "..", "README.md");

const START = "<!-- START doctoc -->";
const END = "<!-- END doctoc -->";

const text = readFileSync(readmePath, "utf8");
const startIdx = text.indexOf(START);
const endIdx = text.indexOf(END);
if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
  console.error(`gen-readme-toc: TOC markers not found in ${readmePath}`);
  process.exit(1);
}

const before = text.slice(0, startIdx);
const after = text.slice(endIdx + END.length);

const entries = [];
const seen = new Map();
let inCode = false;
for (const line of after.split("\n")) {
  if (line.trim().startsWith("```")) {
    inCode = !inCode;
    continue;
  }
  if (inCode) continue;
  const m = line.match(/^(#{2,3})\s+(.*?)\s*#*\s*$/);
  if (!m) continue;
  const level = m[1].length;
  const title = m[2];
  // GitHub anchor: lowercase, drop punctuation (keep letters, digits, _ - and
  // spaces), spaces -> hyphens, de-duplicate with -1, -2, ...
  let slug = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\- ]/gu, "")
    .replace(/ /g, "-");
  const n = seen.get(slug) ?? 0;
  seen.set(slug, n + 1);
  if (n) slug = `${slug}-${n}`;
  const label = title.replace(/[*_`]/g, "").replace(/:$/, "");
  entries.push(`${"  ".repeat(level - 2)}- [${label}](#${slug})`);
}

const toc = ["**Contents**", "", ...entries].join("\n");
const updated = `${before}${START}\n${toc}\n${END}${after}`;

if (updated === text) {
  console.log("gen-readme-toc: README TOC already up to date");
} else {
  writeFileSync(readmePath, updated);
  console.log(`gen-readme-toc: updated TOC (${entries.length} entries)`);
}
