// Republishes windows/publish when any helper source is newer than the published exe (GC-2: a stale exe answers "Unsupported helper request").
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
const source = "windows/Frameforge.Windows";
const exe = "windows/publish/Frameforge.Windows.dll"; // the exe is a thin apphost; the code lives in the dll
const newest = Math.max(
  ...readdirSync(source)
    .filter((f) => /\.(cs|csproj)$/.test(f))
    .map((f) => statSync(path.join(source, f)).mtimeMs),
);
if (existsSync(exe) && statSync(exe).mtimeMs >= newest) process.exit(0);
console.log("Windows helper is missing or older than its sources; publishing.");
const npm = process.env.npm_execpath;
if (!npm) {
  console.error("Run this through npm (npm run windows:ensure).");
  process.exit(1);
}
const local = path.resolve(".tools/dotnet");
// No shell: node runs npm's script directly.
const run = spawnSync(process.execPath, [npm, "run", "windows:publish"], {
  stdio: "inherit",
  env: { ...process.env, PATH: `${local}${path.delimiter}${process.env.PATH}` },
});
process.exit(run.status ?? 1);
