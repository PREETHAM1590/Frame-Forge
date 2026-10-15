// "This session changed": what every mechanism of a boost session really did, in plain words. Pure, so the window, the tray and tests share it.
import type {
  BoostSession,
  MechanismId,
  MechanismResult,
} from "./contracts.js";

export type ChangeKind =
  "applied" | "already" | "skipped" | "unavailable" | "failed" | "pending";

export interface ChangeItem {
  id: MechanismId;
  kind: ChangeKind;
  /** Short reason for skipped / unavailable rows. */
  reason: string | null;
  /** What the helper said; for applied rows it names the old and new value where Windows has one. */
  detail: string;
  /** Old and new value, when the detail states them. */
  change: { from: string; to: string } | null;
  /** More rows of the same mechanism and outcome folded into this one (one per background process, for example). */
  more: number;
}

export interface SessionChanges {
  items: ChangeItem[];
  /** Restore problems at the end of the session, shown apart from the start results. */
  restoreIssues: ChangeItem[];
  restored: number;
  applied: number;
  /** Already set, skipped or unavailable: nothing was changed for these. */
  notChanged: number;
  failed: number;
  pending: number;
  /** At least one setting was really changed. */
  material: boolean;
  headline: string;
  /** One line for the tray notification. */
  tray: string;
}

const skipReasons: Record<string, string> = {
  policy: "already off by Windows policy",
  "admin-not-requested": "administrator approval not requested",
  managed: "managed by an optimization",
  "never-touch":
    "protected app: audio, voice chat, input, security or launcher",
  "still-open": "the app did not close",
  "no-change": "nothing measurable to free",
};

/** "from X to Y" or "X -> Y" style wording in a helper detail. */
export function parseChange(
  detail: string,
): { from: string; to: string } | null {
  const was = /(\w+) priority verified \(was (\w+)\)/.exec(detail);
  if (was) return { from: was[2]!, to: was[1]! };
  const m = /\bfrom (.+?) to (.+?)(?: and verified|\.|,| \(|$)/i.exec(detail);
  return m
    ? { from: m[1]!.trim().slice(0, 60), to: m[2]!.trim().slice(0, 60) }
    : null;
}

function classify(m: MechanismResult): {
  kind: ChangeKind;
  reason: string | null;
} {
  switch (m.state) {
    case "applied":
      return { kind: "applied", reason: null };
    case "pending":
      return { kind: "pending", reason: "waiting for administrator approval" };
    case "unsupported":
    case "unavailable":
      return { kind: "unavailable", reason: "not available on this PC" };
    case "failed":
    case "conflict":
      return { kind: "failed", reason: null };
    case "skipped": {
      if (
        m.code === "already-set" ||
        (!m.code && /\balready\b/i.test(m.detail))
      )
        return { kind: "already", reason: null };
      if (m.code === "policy")
        return { kind: "already", reason: skipReasons.policy! };
      return {
        kind: "skipped",
        reason:
          (m.code && skipReasons[m.code]) || "not selected or nothing to do",
      };
    }
    default:
      return { kind: "skipped", reason: null };
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function summarizeSession(
  input: Pick<BoostSession, "restoreFrom" | "status"> & {
    mechanisms?: MechanismResult[];
  },
): SessionChanges {
  const session = { ...input, mechanisms: input.mechanisms ?? [] };
  const from =
    session.restoreFrom ??
    session.mechanisms.findIndex((m) => m.state === "reverted");
  const start =
    from >= 0 ? session.mechanisms.slice(0, from) : session.mechanisms;
  const end = from >= 0 ? session.mechanisms.slice(from) : [];
  const items: ChangeItem[] = [];
  for (const m of start) {
    const { kind, reason } = classify(m);
    const same = items.find((i) => i.id === m.id && i.kind === kind);
    if (same) same.more++;
    else
      items.push({
        id: m.id,
        kind,
        reason,
        detail: m.detail,
        // The freed-RAM sentence ("Freed 0.4 GB ...") is the point of that row; a from/to pair would hide it.
        change:
          kind === "applied" && m.id !== "freeMemory"
            ? parseChange(m.detail)
            : null,
        more: 0,
      });
  }
  const restoreIssues = end
    .filter((m) => m.state === "failed" || m.state === "conflict")
    .map((m) => ({
      id: m.id,
      kind: "failed" as const,
      reason:
        m.state === "conflict"
          ? "changed by something else, left as it is"
          : null,
      detail: m.detail,
      change: null,
      more: 0,
    }));
  const restored = end.filter((m) => m.state === "reverted").length;
  const count = (k: ChangeKind) =>
    items.filter((i) => i.kind === k).reduce((n, i) => n + 1 + i.more, 0);
  const applied = count("applied");
  const failed = count("failed");
  const pending = count("pending");
  const notChanged = count("already") + count("skipped") + count("unavailable");
  const material = applied > 0;
  const rest = notChanged ? `, ${notChanged} already set/skipped` : "";
  const bad = failed ? `, ${failed} failed` : "";
  let headline: string;
  if (!items.length) headline = "No mechanism ran in this session.";
  else if (material)
    headline = `${plural(applied, "change")} applied${rest}${bad}. Use the benchmark to see whether FPS actually changed.`;
  else if (failed)
    headline = `Nothing was changed${bad}. See the failed rows below.`;
  else if (pending)
    headline =
      "Waiting for administrator approval before anything more is changed.";
  else
    headline =
      "This PC was already configured; expect little or no FPS difference.";
  const tray = !items.length
    ? "No changes were recorded."
    : material
      ? `${plural(applied, "change")} applied${rest}${bad}.`
      : failed
        ? `Nothing changed${bad}.`
        : "Nothing changed: this PC was already configured.";
  // The start clean-up in a few words for the tray: apps closed and what memory really did.
  const closed = items
    .filter((i) => i.id === "closeBackground" && i.kind === "applied")
    .reduce((n, i) => n + 1 + i.more, 0);
  const memory = items.find((i) => i.id === "freeMemory");
  const cleanup = [
    closed ? `Closed ${plural(closed, "app")}.` : "",
    memory?.kind === "applied"
      ? (/^Freed [\d.]+ GB/.exec(memory.detail)?.[0] ?? "") + "."
      : memory?.kind === "already"
        ? "Memory was already fine."
        : "",
  ]
    .filter((x) => x.length > 1)
    .join(" ");
  return {
    items,
    restoreIssues,
    restored,
    applied,
    notChanged,
    failed,
    pending,
    material,
    headline,
    tray: cleanup ? `${tray} ${cleanup}` : tray,
  };
}
