// Writes latest.yml for electron-updater from the installer that is actually published.
// Needed because SignPath changes the installer's bytes after electron-builder wrote its own latest.yml.
// Usage: node tools/make-latest-yml.mjs <installer.exe> <out-dir>
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
const [exe, outDir] = process.argv.slice(2);
if (!exe || !outDir) throw new Error("usage: make-latest-yml <exe> <out-dir>");
const name = path.basename(exe);
const version = /^Frameforge-Setup-(.+)\.exe$/.exec(name)?.[1];
if (!version) throw new Error(`Unexpected installer name: ${name}`);
const sha512 = createHash("sha512").update(readFileSync(exe)).digest("base64");
const size = statSync(exe).size;
writeFileSync(
  path.join(outDir, "latest.yml"),
  `version: ${version}
files:
  - url: ${name}
    sha512: ${sha512}
    size: ${size}
path: ${name}
sha512: ${sha512}
releaseDate: '${new Date().toISOString()}'
`,
);
