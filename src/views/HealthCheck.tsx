import { useState } from "react";
import {
  ArrowUpRight,
  CheckCircle2,
  CircleHelp,
  RefreshCw,
  ShieldAlert,
  TriangleAlert,
} from "lucide-react";
import {
  Badge,
  Busy,
  Button,
  Modal,
  PageTitle,
  Panel,
  SegmentedControl,
} from "../components/ui";
import { request } from "../api";
import { clearHealth, useHealth } from "../useHealth";
import type {
  HealthCheck as Check,
  HealthFix,
  HealthStatus,
  LaunchPreview,
} from "../../shared/contracts";
import type { ViewProps } from "../types";

export const statusText: Record<HealthStatus, string> = {
  good: "Good",
  warn: "Look at",
  bad: "Fix",
  unknown: "Can't tell",
};
const tones = {
  good: "lime",
  warn: "amber",
  bad: "red",
  unknown: "neutral",
} as const;
const glyph = {
  good: CheckCircle2,
  warn: TriangleAlert,
  bad: ShieldAlert,
  unknown: CircleHelp,
} as const;
const filters = ["All", "Needs attention", "Good", "Can't tell"] as const;
type Filter = (typeof filters)[number];

export function StatusBadge({ status }: { status: HealthStatus }) {
  const Icon = glyph[status];
  return (
    <Badge tone={tones[status]}>
      <Icon size={12} aria-hidden="true" /> {statusText[status]}
    </Badge>
  );
}

/** Runs a check's fix through the paths that already exist (reviewed apply flow, launch settings, Windows Settings, navigation). */
export function useFix({
  run,
  preview,
  navigate,
  after,
}: Pick<ViewProps, "run" | "preview" | "navigate"> & { after: () => void }) {
  const [gpu, setGpu] = useState<{
    gameId: string;
    preview: LaunchPreview;
  } | null>(null);
  const [error, setError] = useState("");
  async function apply(fix: HealthFix) {
    setError("");
    if (fix.kind === "optimization") preview(fix.ids);
    else if (fix.kind === "navigate") navigate(fix.page);
    else if (fix.kind === "settings")
      await run("openSettings", { page: fix.page });
    else {
      try {
        const p = await request("launchSettingPreview", {
          gameId: fix.gameId,
          setting: fix.setting,
          action: "apply",
        });
        setGpu({ gameId: fix.gameId, preview: p });
      } catch (e) {
        setError(
          e instanceof Error ? e.message : "The preview could not be made.",
        );
      }
    }
  }
  const dialog = gpu && (
    <Modal
      title="Set this game to the high-performance GPU?"
      description="Frameforge writes only this one program's Windows graphics preference and saves what was there, so you can revert it."
      onClose={() => setGpu(null)}
    >
      <dl className="health-diff">
        <dt>Program</dt>
        <dd>{gpu.preview.exe}</dd>
        <dt>Before</dt>
        <dd>{gpu.preview.before ?? "(no entry: Windows decides)"}</dd>
        <dt>After</dt>
        <dd>{gpu.preview.after}</dd>
      </dl>
      <p className="muted">{gpu.preview.warning}</p>
      <div className="dialog-actions">
        <Button onClick={() => setGpu(null)}>Cancel</Button>
        <Button
          variant="primary"
          onClick={async () => {
            const target = gpu;
            setGpu(null);
            const done = await run(
              "launchSettingApply",
              {
                gameId: target.gameId,
                setting: "gpuPreference",
                action: "apply",
                confirmed: true,
              },
              "GPU preference set. Revert it any time under Game Mode > Launch settings.",
            );
            if (done) after();
          }}
        >
          Set to High performance
        </Button>
      </div>
    </Modal>
  );
  return { apply, dialog, error };
}

function CheckCard({
  check,
  onFix,
  busy,
}: {
  check: Check;
  onFix: (fix: HealthFix) => void;
  busy: boolean;
}) {
  return (
    <article
      className={`health-check ${check.status}`}
      aria-label={check.title}
      data-status={check.status}
    >
      <header>
        <StatusBadge status={check.status} />
        <h3>{check.title}</h3>
        {check.top && check.status !== "good" && (
          <Badge tone="amber">check first</Badge>
        )}
      </header>
      <p className="health-summary">{check.summary}</p>
      <dl>
        <dt>What it means</dt>
        <dd>{check.explanation}</dd>
        <dt>Expected impact</dt>
        <dd>{check.impact}</dd>
      </dl>
      {check.steps.length > 0 && (
        <ol className="health-steps" aria-label={`How to fix: ${check.title}`}>
          {check.steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
      )}
      {check.fix && (
        <Button
          variant={check.fix.kind === "optimization" ? "primary" : "secondary"}
          disabled={busy}
          onClick={() => onFix(check.fix!)}
        >
          {check.fix.label}
          {check.fix.kind === "settings" && <ArrowUpRight size={15} />}
        </Button>
      )}
    </article>
  );
}

export function HealthCheck(props: ViewProps) {
  const { data, pending } = props;
  const desktop = data.mode === "desktop";
  const { report, loading, error, refresh } = useHealth(desktop);
  const [filter, setFilter] = useState<Filter>("All");
  const fixes = useFix({
    ...props,
    after: () => {
      clearHealth();
      void refresh();
    },
  });
  const checks = report?.checks ?? [];
  const shown = checks.filter((c) =>
    filter === "All"
      ? true
      : filter === "Needs attention"
        ? c.status === "bad" || c.status === "warn"
        : filter === "Good"
          ? c.status === "good"
          : c.status === "unknown",
  );
  const order: HealthStatus[] = ["bad", "warn", "unknown", "good"];
  const sorted = [...shown].sort(
    (a, b) =>
      order.indexOf(a.status) - order.indexOf(b.status) ||
      Number(b.top) - Number(a.top),
  );
  const top = (report?.topIssues ?? [])
    .map((id) => checks.find((c) => c.id === id))
    .filter((c): c is Check => !!c);
  return (
    <div className="health">
      <PageTitle
        title="PC Health Check"
        subtitle="What may be holding your games back on this PC, why it matters, and what to do. Nothing is changed unless you press a fix button."
        action={
          <Button
            disabled={!desktop || loading || pending}
            onClick={() => {
              clearHealth();
              void refresh();
            }}
          >
            <RefreshCw size={16} /> {report ? "Run again" : "Run the check"}
          </Button>
        }
      />
      {!desktop && (
        <p className="notice" role="status">
          The Health Check reads this PC and needs the desktop app.
        </p>
      )}
      {error && (
        <p className="notice" role="alert" data-error="true">
          {error}
        </p>
      )}
      {loading && !report && <Busy label="Reading this PC" />}
      {report && (
        <>
          <Panel tone="accent" className="health-summary-panel">
            <div className="health-score" aria-label="Health score">
              <strong>{report.score}</strong>
              <span>/ 100</span>
            </div>
            <div>
              <span className="label">{report.headline}</span>
              {top.length > 0 ? (
                <>
                  <h2>Look at these first</h2>
                  <ol className="health-top">
                    {top.map((c) => (
                      <li key={c.id}>
                        <StatusBadge status={c.status} />{" "}
                        <strong>{c.title}</strong>
                        <span className="muted"> {c.summary}</span>
                      </li>
                    ))}
                  </ol>
                </>
              ) : (
                <h2>Nothing needs attention right now.</h2>
              )}
              <p className="muted">
                The score only counts what could be read; &quot;Can&apos;t
                tell&quot; items do not change it. Read{" "}
                {new Date(report.at).toLocaleTimeString()}.
              </p>
            </div>
          </Panel>
          <div className="health-filter">
            <SegmentedControl
              label="Show"
              value={filter}
              options={filters.map((f) => ({ value: f, label: f }))}
              onChange={setFilter}
            />
          </div>
          {fixes.error && (
            <p className="notice" role="alert" data-error="true">
              {fixes.error}
            </p>
          )}
          <div className="health-list">
            {sorted.map((c) => (
              <CheckCard
                key={c.id}
                check={c}
                busy={pending}
                onFix={(fix) => void fixes.apply(fix)}
              />
            ))}
            {!sorted.length && <p className="muted">Nothing in this view.</p>}
          </div>
        </>
      )}
      {fixes.dialog}
    </div>
  );
}
