import path from "node:path";
/**
 * Test-only profile override. Ignored in packaged builds unless FRAMEFORGE_TEST_MODE=1,
 * and limited to local absolute paths so the journal never lands on a share or device path.
 */
export function userDataOverride(
  env: Record<string, string | undefined>,
  packaged: boolean,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const value = env.FRAMEFORGE_USER_DATA;
  if (!value || (packaged && env.FRAMEFORGE_TEST_MODE !== "1")) return null;
  const local =
    platform === "win32"
      ? /^[A-Za-z]:[\\/]/.test(value)
      : value.startsWith("/") && !value.startsWith("//");
  if (!local)
    throw new Error(
      "FRAMEFORGE_USER_DATA must be a local absolute path (no relative, UNC or device paths).",
    );
  return path.normalize(value);
}
