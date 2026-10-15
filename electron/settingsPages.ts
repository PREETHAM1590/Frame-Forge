import path from "node:path";
import type { Request } from "../shared/contracts.js";
export type SettingsPage = Request<"openSettings">["page"];
/** Fixed targets selected by an enum; renderer text never becomes a URI or path. */
export function settingsTarget(
  page: SettingsPage,
  systemRoot = "C:\\Windows",
): { uri: string } | { file: string } {
  switch (page) {
    case "graphics":
      return { uri: "ms-settings:display-advancedgraphics" };
    case "startup":
      return { uri: "ms-settings:startupapps" };
    case "network":
      return { uri: "ms-settings:network-status" };
    case "defender":
      return { uri: "windowsdefender://threatsettings" };
    case "services":
      return { file: path.win32.join(systemRoot, "System32", "services.msc") };
    case "power":
      return { uri: "ms-settings:powersleep" };
    case "display":
      return { uri: "ms-settings:display-advanced" };
    case "windowsUpdate":
      return { uri: "ms-settings:windowsupdate" };
    case "storage":
      return { uri: "ms-settings:storagesense" };
    case "gameMode":
      return { uri: "ms-settings:gaming-gamemode" };
    case "coreIsolation":
      return { uri: "windowsdefender://coreisolation" };
  }
}
