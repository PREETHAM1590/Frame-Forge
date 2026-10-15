import { HeartPulse } from "lucide-react";
import { Busy, LinkButton, Panel } from "../../components/ui";
import { StatusBadge } from "../HealthCheck";
import { useHealth } from "../../useHealth";
import type { Page } from "../../types";

/** The score and the three things to look at first. Read once per few minutes and only in the desktop app. */
export function HealthCard({
  desktop,
  navigate,
}: {
  desktop: boolean;
  navigate: (page: Page) => void;
}) {
  const { report, loading, error } = useHealth(desktop);
  const top = (report?.topIssues ?? [])
    .map((id) => report?.checks.find((c) => c.id === id))
    .filter((c) => !!c);
  return (
    <Panel className="health-card" aria-label="PC health">
      <div className="health-card-head">
        <h2>
          <HeartPulse size={18} /> PC health
        </h2>
        {report && (
          <strong
            className="hc-score"
            aria-label={`Health score ${report.score} of 100`}
          >
            {report.score}
            <span> / 100</span>
          </strong>
        )}
      </div>
      {!desktop ? (
        <p className="muted">
          The Health Check reads this PC and needs the desktop app.
        </p>
      ) : error ? (
        <p className="muted" role="alert">
          {error}
        </p>
      ) : loading && !report ? (
        <Busy label="Reading this PC" />
      ) : report ? (
        top.length ? (
          <ol aria-label="Top issues">
            {top.map((c) => (
              <li key={c.id}>
                <StatusBadge status={c.status} />
                <span>
                  <strong>{c.title}</strong>{" "}
                  <span className="muted">{c.summary}</span>
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted">{report.headline}</p>
        )
      ) : null}
      <LinkButton onClick={() => navigate("Health Check")}>
        Open the Health Check
      </LinkButton>
    </Panel>
  );
}
