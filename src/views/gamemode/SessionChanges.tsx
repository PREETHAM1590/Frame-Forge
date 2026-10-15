import { useEffect, useState } from "react";
import { Badge } from "../../components/ui";
import { request } from "../../api";
import type { BoostSession } from "../../../shared/contracts";
import {
  summarizeSession,
  type ChangeKind,
} from "../../../shared/sessionChanges";
import { labels } from "./model";

const kindText: Record<ChangeKind, string> = {
  applied: "applied",
  already: "already set",
  skipped: "skipped",
  unavailable: "unavailable",
  failed: "failed",
  pending: "waiting",
};
const kindTone = {
  applied: "lime",
  already: "neutral",
  skipped: "neutral",
  unavailable: "amber",
  failed: "red",
  pending: "amber",
} as const;

/** "This session changed": every mechanism with its outcome, updating live while the session runs. */
export function SessionChanges({
  session,
  title = "This session changed",
}: {
  session: BoostSession;
  title?: string;
}) {
  const s = summarizeSession(session);
  return (
    <section className="session-changes" aria-label={title}>
      <h3 className="label">{title}</h3>
      <p role="status" className={s.material ? undefined : "notice-text"}>
        {s.headline}
      </p>
      {s.items.length > 0 && (
        <ul className="booster-log" aria-label="Mechanism outcomes">
          {s.items.map((i, n) => (
            <li key={n} title={i.detail}>
              <Badge tone={kindTone[i.kind]}>{kindText[i.kind]}</Badge>{" "}
              <strong>{labels[i.id]}</strong>
              {i.more > 0 && ` (+${i.more} more)`}
              {": "}
              {i.change
                ? `${i.change.from} → ${i.change.to}`
                : i.reason
                  ? i.reason
                  : i.detail}
            </li>
          ))}
        </ul>
      )}
      {s.restored > 0 && (
        <p className="muted">
          {s.restored} change{s.restored === 1 ? "" : "s"} restored when the
          session ended.
        </p>
      )}
      {s.restoreIssues.map((i, n) => (
        <p key={n} className="notice-text" role="alert">
          Restore problem, {labels[i.id]}: {i.reason ?? i.detail}
        </p>
      ))}
    </section>
  );
}

/** Finished sessions, newest first. Quiet when there are none or in the browser preview. */
export function SessionHistory({
  gameId,
  limit = 3,
  names = {},
}: {
  gameId?: string;
  limit?: number;
  names?: Record<string, string>;
}) {
  const [rows, setRows] = useState<BoostSession[]>([]);
  useEffect(() => {
    let live = true;
    request("boostHistory", gameId ? { gameId } : {})
      .then((r) => live && setRows(r.filter((x) => x.status === "ended")))
      .catch(() => live && setRows([]));
    return () => {
      live = false;
    };
  }, [gameId]);
  if (!rows.length) return null;
  return (
    <div className="session-history">
      {rows.slice(0, limit).map((row) => (
        <SessionChanges
          key={row.id}
          session={row}
          title={`${names[row.gameId] ? `${names[row.gameId]}, ` : ""}Session ${new Date(row.startedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`}
        />
      ))}
    </div>
  );
}
