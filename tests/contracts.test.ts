import { describe, expect, it } from "vitest";
import { requests, SettingsSchema, StateSchema } from "../shared/contracts";
describe("IPC trust boundary", () => {
  it("rejects unknown methods, extra fields and arbitrary commands", () => {
    expect(
      requests.preview.safeParse({
        ids: ["mouse-precision"],
        command: "cmd.exe",
      }).success,
    ).toBe(false);
    expect(
      requests.preview.safeParse({ ids: ["not-allowlisted"] }).success,
    ).toBe(false);
    expect(
      requests.confirm.safeParse({ token: "short", confirmed: false }).success,
    ).toBe(false);
  });
  it("requires explicit confirmation and bounded selections", () => {
    expect(requests.preview.safeParse({ ids: [] }).success).toBe(false);
    expect(
      requests.confirm.safeParse({
        token: crypto.randomUUID(),
        confirmed: true,
      }).success,
    ).toBe(true);
  });
  it("constrains settings and rejects malformed state", () => {
    expect(
      SettingsSchema.safeParse({
        theme: "dark",
        startup: false,
        notifications: true,
        diagnostics: false,
      }).success,
    ).toBe(true);
    expect(StateSchema.safeParse({ version: 999 }).success).toBe(false);
  });
});
