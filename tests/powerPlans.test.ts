import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { builtInPowerPlans } from "../shared/contracts";
// The helper's BoostSessionEngine is the one C# list of Windows plan GUIDs (the optimization uses it too); the TS names must match it.
describe("power plan GUID list", () => {
  it("matches the helper's built-in plans", () => {
    const source = readFileSync(
      "windows/Frameforge.Windows/BoostSession.cs",
      "utf8",
    );
    const helper = [
      ...source.matchAll(
        /new\("([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})"\)/g,
      ),
    ].map((m) => m[1]!);
    expect(helper.sort()).toEqual(Object.keys(builtInPowerPlans).sort());
  });
});
