import type { OperationId } from "./contracts.js";
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
    name: "Power plan review",
    category: "System",
    risk: "Moderate",
    impact: "Power policy",
    description: "Review Windows power policy for your machine.",
    reason:
      "Power plans affect heat, battery life and energy use. Automated changes are unavailable in this release.",
    settings: ["Windows power plan"],
    prerequisites: ["Manual review in Windows Settings"],
    supported: false,
    rollback: "Unavailable; this app does not change power plans.",
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
    prerequisites: ["Manual review in Task Manager"],
    supported: false,
    rollback: "Unavailable; read-only catalogue entry.",
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
  },
];
export const presets = [
  {
    name: "Recommended",
    description: "One reversible input preference.",
    ids: ["mouse-precision"],
  },
  {
    name: "Beginner",
    description: "Start with consistent pointer movement.",
    ids: ["mouse-precision"],
  },
  {
    name: "Balanced",
    description: "Input consistency and capture preference.",
    ids: ["mouse-precision", "capture-off"],
  },
  {
    name: "Gaming",
    description: "Review both supported preferences for your setup.",
    ids: ["mouse-precision", "capture-off"],
  },
] as const;
