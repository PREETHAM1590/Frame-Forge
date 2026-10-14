import { useState } from "react";
import { FileArchive, FolderOpen, Bug } from "lucide-react";
import { Button } from "./ui";
import type { ViewProps } from "../types";
import type { DiagnosticsGroup, Response } from "../../shared/contracts";
type Preview = Response<"diagnosticsPreview">;
/** Settings > Diagnostics: preview what a diagnostics zip holds, then save it. Nothing is uploaded. */
export function DiagnosticsPanel({
  run,
  pending,
  desktop,
}: Pick<ViewProps, "run" | "pending"> & { desktop: boolean }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [chosen, setChosen] = useState<Set<DiagnosticsGroup>>(new Set());
  const open = async () => {
    const result = await run("diagnosticsPreview", {});
    if (!result) return;
    setPreview(result);
    setChosen(new Set(result.groups.map((g) => g.id)));
  };
  const toggle = (id: DiagnosticsGroup) =>
    setChosen((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const save = async () => {
    const result = await run("diagnosticsExport", { groups: [...chosen] });
    if (result?.saved) setPreview(null);
  };
  return (
    <section className="settings-section" aria-label="Diagnostics">
      <h2>
        <FileArchive size={20} />
        Diagnostics
      </h2>
      <div className="setting-row">
        <div>
          <strong>Export diagnostics</strong>
          <p className="muted">
            Saves a .zip you can attach to a GitHub issue. You see exactly what
            it holds first. Nothing is uploaded.
          </p>
        </div>
        <Button disabled={pending || !desktop} onClick={() => void open()}>
          Export diagnostics…
        </Button>
      </div>
      {preview && (
        <div className="diagnostics-preview">
          <p className="muted">
            Your user name, profile folder, PC name, game folders, emails, IP
            and MAC addresses, serial numbers and statistics ids are replaced
            before saving. Untick anything you do not want to share.
          </p>
          <ul className="muted">
            {preview.redactions.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          {preview.groups.map((g) => (
            <div key={g.id} className="setting-row">
              <div>
                <label>
                  <input
                    type="checkbox"
                    checked={chosen.has(g.id)}
                    onChange={() => toggle(g.id)}
                  />{" "}
                  <strong>{g.label}</strong>
                </label>
                <p className="muted">{g.description}</p>
                {g.files.map((f) => (
                  <details key={f.name}>
                    <summary>
                      {f.name} ({f.bytes.toLocaleString()} bytes)
                    </summary>
                    <pre
                      style={{
                        whiteSpace: "pre-wrap",
                        maxHeight: 240,
                        overflow: "auto",
                      }}
                    >
                      {f.preview}
                      {f.bytes > f.preview.length
                        ? "\n… (start of file shown)"
                        : ""}
                    </pre>
                  </details>
                ))}
              </div>
            </div>
          ))}
          <p className="muted">
            README.txt and manifest.json are always included.
          </p>
          <div className="setting-row">
            <Button
              disabled={pending || chosen.size === 0}
              onClick={() => void save()}
            >
              Save .zip…
            </Button>
            <Button disabled={pending} onClick={() => setPreview(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      <div className="setting-row">
        <div>
          <strong>Report a problem</strong>
          <p className="muted">
            Opens a new GitHub issue with only the app version and Windows build
            filled in.
          </p>
        </div>
        <Button
          disabled={pending || !desktop}
          onClick={() => void run("reportProblem", {})}
        >
          <Bug size={17} />
          Report a problem
        </Button>
      </div>
      <div className="setting-row">
        <div>
          <strong>Log files</strong>
          <p className="muted">
            Frameforge keeps short local logs (main.log, helper.log). They stay
            on this PC unless you attach them.
          </p>
        </div>
        <Button
          disabled={pending || !desktop}
          onClick={() => void run("openLogsFolder", {})}
        >
          <FolderOpen size={17} />
          Open logs folder
        </Button>
      </div>
    </section>
  );
}
