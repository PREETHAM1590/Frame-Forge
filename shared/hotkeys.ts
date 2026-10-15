// Global hotkeys: accelerator parsing/validation shared by the IPC boundary (zod), the main process and the Settings recorder.
import { z } from "zod";

export const hotkeyIds = [
  "toggleBoost",
  "stopBoost",
  "toggleOverlay",
  "cycleMode",
] as const;
export type HotkeyId = (typeof hotkeyIds)[number];
export const hotkeyLabels: Record<HotkeyId, string> = {
  toggleBoost: "Toggle boost for the foreground game",
  stopBoost: "Stop boost",
  toggleOverlay: "Toggle overlay",
  cycleMode: "Cycle boost mode",
};
export const defaultBindings: Record<HotkeyId, string> = {
  toggleBoost: "Ctrl+Alt+B",
  stopBoost: "Ctrl+Alt+S",
  toggleOverlay: "Ctrl+Alt+O",
  cycleMode: "Ctrl+Alt+M",
};

const named = [
  "Space",
  "Tab",
  "Backspace",
  "Delete",
  "Insert",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Up",
  "Down",
  "Left",
  "Right",
  "Enter",
  "Escape",
  "Plus",
  ..."-=[];',./\\`",
];
const aliases: Record<string, string> = {
  control: "ctrl",
  commandorcontrol: "ctrl",
  cmdorctrl: "ctrl",
  option: "alt",
  esc: "escape",
  return: "enter",
  del: "delete",
  ins: "insert",
  pgup: "pageup",
  pgdn: "pagedown",
  arrowup: "up",
  arrowdown: "down",
  arrowleft: "left",
  arrowright: "right",
  spacebar: "space",
};
const superNames = ["super", "win", "windows", "meta", "cmd", "command"];
// Canonical strings that Windows or everyday typing already uses.
const reserved = new Set([
  "Alt+F4",
  "Alt+Tab",
  "Alt+Escape",
  "Alt+Space",
  "Ctrl+Escape",
  "Ctrl+Shift+Escape",
  "Ctrl+Alt+Delete",
  "Ctrl+Alt+Tab",
  "Ctrl+C",
  "Ctrl+V",
  "Ctrl+X",
  "Ctrl+Z",
  "Ctrl+Y",
  "Ctrl+A",
  "Ctrl+S",
  "Ctrl+W",
  "Ctrl+F4",
]);

export type Parsed =
  { ok: true; accelerator: string } | { ok: false; error: string };
/** Canonicalises "ctrl + alt + b" to "Ctrl+Alt+B", or says why it cannot be a hotkey. */
export function parseAccelerator(input: string): Parsed {
  const fail = (error: string): Parsed => ({ ok: false, error });
  if (input.length > 60) return fail("That shortcut is too long.");
  const parts = input.split("+").map((p) => p.trim());
  // "Ctrl++" splits to [Ctrl, "", ""]: the plus key.
  if (parts.length > 1 && parts.at(-1) === "" && parts.at(-2) === "")
    parts.splice(-2, 2, "Plus");
  if (parts.some((p) => p === "")) return fail("That is not a valid shortcut.");
  const mods = new Set<string>();
  let key: string | undefined;
  for (const raw of parts) {
    const lower = raw.toLowerCase();
    if (superNames.includes(lower))
      return fail("Windows key shortcuts are reserved by Windows.");
    const name = aliases[lower] ?? lower;
    if (name === "ctrl" || name === "alt" || name === "shift") {
      mods.add(name === "ctrl" ? "Ctrl" : name === "alt" ? "Alt" : "Shift");
      continue;
    }
    if (key !== undefined) return fail("Use one key plus modifiers.");
    const canon = /^(f([1-9]|1\d|2[0-4])|[a-z0-9])$/i.test(raw)
      ? raw.toUpperCase()
      : named.find((n) => n.toLowerCase() === name);
    if (!canon) return fail(`"${raw}" cannot be used as a hotkey.`);
    key = canon;
  }
  if (key === undefined) return fail("Add a key as well as the modifiers.");
  if (!mods.has("Ctrl") && !mods.has("Alt"))
    return fail(
      "Include Ctrl or Alt so the shortcut does not clash with typing.",
    );
  const accelerator = [
    ...["Ctrl", "Alt", "Shift"].filter((m) => mods.has(m)),
    key,
  ].join("+");
  if (reserved.has(accelerator))
    return fail(`${accelerator} is reserved by Windows or by common apps.`);
  return { ok: true, accelerator };
}
export const Accelerator = z.string().transform((value, ctx) => {
  const parsed = parseAccelerator(value);
  if (!parsed.ok) {
    ctx.addIssue({ code: "custom", message: parsed.error });
    return z.NEVER;
  }
  return parsed.accelerator;
});

export const HotkeysSchema = z
  .object({
    /** Off: nothing is registered with Windows at all. */
    enabled: z.boolean(),
    /** Hotkey-started boosts open a Windows administrator prompt only when this is on; otherwise those steps are skipped. */
    allowAdmin: z.boolean(),
    bindings: z
      .object({
        toggleBoost: Accelerator,
        stopBoost: Accelerator,
        toggleOverlay: Accelerator,
        cycleMode: Accelerator,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (const id of hotkeyIds) {
      const accelerator = value.bindings[id];
      if (seen.has(accelerator))
        ctx.addIssue({
          code: "custom",
          path: ["bindings", id],
          message: `${accelerator} is already used by another hotkey.`,
        });
      seen.add(accelerator);
    }
  });
export type Hotkeys = z.infer<typeof HotkeysSchema>;
export const defaultHotkeys: Hotkeys = {
  enabled: true,
  allowAdmin: false,
  bindings: { ...defaultBindings } as Hotkeys["bindings"],
};

const codeKeys: Record<string, string> = {
  Space: "Space",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Enter: "Enter",
  Escape: "Escape",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  Backquote: "`",
};
/** The accelerator for a keydown in the recorder, or null while only modifiers are held. */
export function acceleratorFromEvent(e: {
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}): string | null {
  const c = e.code;
  const key = /^Key[A-Z]$/.test(c)
    ? c.slice(3)
    : /^Digit\d$/.test(c)
      ? c.slice(5)
      : /^F\d{1,2}$/.test(c)
        ? c
        : codeKeys[c];
  if (!key) return null;
  // The Windows key is passed through so parseAccelerator can refuse it with a reason.
  return [
    e.metaKey && "Super",
    e.ctrlKey && "Ctrl",
    e.altKey && "Alt",
    e.shiftKey && "Shift",
    key,
  ]
    .filter(Boolean)
    .join("+");
}
