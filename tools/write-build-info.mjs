// Writes the build-time Aptabase key next to the compiled main process. No key = analytics disabled.
import { mkdirSync, writeFileSync } from "node:fs";
const key = (process.env.APTABASE_APP_KEY ?? "").trim();
mkdirSync("dist-electron/electron", { recursive: true });
writeFileSync(
  "dist-electron/electron/build-info.json",
  JSON.stringify({ aptabaseKey: /^A-(US|EU)-\d+$/.test(key) ? key : "" }),
);
