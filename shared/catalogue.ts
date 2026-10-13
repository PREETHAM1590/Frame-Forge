import type { OperationId, Request } from "./contracts.js";
export interface Optimization {
  id: OperationId;
  name: string;
  category: "Input" | "Capture" | "System" | "Network";
  risk: "Low" | "Moderate" | "High";
  impact: string;
  description: string;
  reason: string;
  settings: string[];
  prerequisites: string[];
  supported: boolean;
  rollback: string;
  /** Windows page for manual review of unsupported entries. */
  settingsPage?: Request<"openSettings">["page"];
}
export const catalogue: Optimization[] = [
  {
    id: "mouse-precision",
    name: "Consistent pointer movement",
    category: "Input",
    risk: "Low",
    impact: "Input preference",
    description: "Turn off Windows pointer acceleration for the current user.",
    reason:
      "Makes desktop pointer movement consistent. Games using raw input may ignore this setting. No FPS improvement is claimed.",
    settings: [
      "HKCU\\Control Panel\\Mouse: MouseSpeed, MouseThreshold1, MouseThreshold2",
    ],
    prerequisites: [
      "Windows desktop helper available",
      "Current-user registry writable",
    ],
    supported: true,
    rollback:
      "Restores captured string values, including deleting previously absent values. Sign out and back in for Windows to reload the preference.",
  },
  {
    id: "capture-off",
    name: "Disable background game capture",
    category: "Capture",
    risk: "Moderate",
    impact: "Capture preference",
    description: "Set the current-user Game DVR capture preference to off.",
    reason:
      "Disables the capture preference used by supported Windows Game DVR configurations. Other recording apps are unaffected; no performance gain is guaranteed.",
    settings: [
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\GameDVR: AppCaptureEnabled",
    ],
    prerequisites: [
      "Windows desktop helper available",
      "Current-user registry writable",
    ],
    supported: true,
    rollback:
      "Restores the original DWORD or removes the value if originally absent. Capture applications may need to be reopened.",
  },
  {
    id: "power-plan",
    name: "High performance power plan",
    category: "System",
    risk: "Moderate",
    impact: "Power policy",
    description:
      "Switch the active Windows power plan to a performance plan (High performance, then Ultimate performance, then Frameforge's own copy).",
    reason:
      "Lets the processor stay at higher clock states. It raises heat, fan noise and energy use, and shortens laptop battery life. No FPS improvement is claimed. Game Mode can switch plans for a single session instead; this switch stays until you roll it back. The preview names the plan it will switch to. High performance is used when present, otherwise Ultimate performance, otherwise the Frameforge High performance plan you created in Game Mode; if that plan is already active, nothing changes.",
    settings: ["Active Windows power plan (powrprof PowerSetActiveScheme)"],
    prerequisites: [
      "Windows desktop helper available",
      "A performance plan is present: Windows' High performance or Ultimate performance, or the Frameforge copy created in Game Mode (Modern Standby laptops often only have Balanced)",
    ],
    supported: true,
    rollback:
      "Switches back to the exact plan that was active before, only while the plan it switched to is still active. A plan you chose since is kept.",
  },
  {
    id: "hardware-scheduling",
    name: "GPU scheduling review",
    category: "System",
    risk: "Moderate",
    impact: "Display preference",
    description: "Review hardware-accelerated GPU scheduling.",
    reason:
      "Results vary by driver and game. Requires platform-specific verification before implementation.",
    settings: ["Windows graphics settings"],
    prerequisites: ["Compatible GPU and driver"],
    supported: false,
    rollback: "Unavailable; preview only.",
    settingsPage: "graphics",
  },
  {
    id: "startup-review",
    name: "Startup app review",
    category: "System",
    risk: "Low",
    impact: "Background workload",
    description: "Review software that starts when you sign in.",
    reason: "No third-party startup entries are modified by Frameforge.",
    settings: ["Third-party startup entries"],
    prerequisites: ["Manual review in Windows Settings > Apps > Startup"],
    supported: false,
    rollback: "Unavailable; read-only catalogue entry.",
    settingsPage: "startup",
  },
  {
    id: "driver-review",
    name: "Graphics driver review",
    category: "System",
    risk: "Moderate",
    impact: "Compatibility",
    description: "Inspect the detected driver version in System information.",
    reason:
      "Driver installation remains with the vendor. Frameforge does not download or install drivers.",
    settings: ["GPU driver"],
    prerequisites: ["Vendor installer"],
    supported: false,
    rollback: "Unavailable; no driver changes.",
  },
  {
    id: "dns-tuning",
    name: "DNS configuration",
    category: "Network",
    risk: "Moderate",
    impact: "Name resolution",
    description: "Review your resolver configuration.",
    reason:
      "Changing DNS does not generally improve in-game latency. Automated tuning is unsupported.",
    settings: ["Network adapter DNS"],
    prerequisites: ["Network configuration review"],
    supported: false,
    rollback: "Unavailable; no network changes.",
    settingsPage: "network",
  },
  {
    id: "service-tuning",
    name: "Service configuration",
    category: "System",
    risk: "High",
    impact: "System stability",
    description: "Windows service modifications are not supported.",
    reason:
      "Disabling services can break security and system functionality. This release deliberately provides no service-changing operation.",
    settings: ["Windows services"],
    prerequisites: ["Independent service-specific verification"],
    supported: false,
    rollback: "Unavailable; no service changes.",
    settingsPage: "services",
  },
];
export const presets = [
  {
    name: "Beginner",
    description: "Start with one reversible input preference.",
    ids: ["mouse-precision"],
  },
  {
    name: "Recommended",
    description: "Consistent pointer movement and the High performance plan.",
    ids: ["mouse-precision", "power-plan"],
  },
  {
    name: "Balanced",
    description: "Input consistency and capture preference.",
    ids: ["mouse-precision", "capture-off"],
  },
  {
    name: "Gaming",
    description: "All three supported changes, each reversible.",
    ids: ["mouse-precision", "capture-off", "power-plan"],
  },
] as const;
