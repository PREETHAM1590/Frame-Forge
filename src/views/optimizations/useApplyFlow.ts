import { useState } from "react";
import { request } from "../../api";
import { securityIds } from "../../../shared/catalogue";
import type {
  Activity,
  Bootstrap,
  Method,
  OperationId,
  Preview,
  Request,
  Response,
} from "../../../shared/contracts";

const dayMs = 24 * 60 * 60 * 1000;
const changeKey = (changes: Preview["changes"]) =>
  JSON.stringify(changes.map((c) => [c.setting, c.before, c.after]));
const sameChanges = (a: Preview["changes"], b: Preview["changes"]) =>
  changeKey(a) === changeKey(b);

export type RunFn = <M extends Method>(
  method: M,
  input: Request<M>,
  message?: string,
) => Promise<Response<M> | undefined>;
/** What the apply step is doing right now; only used to show progress. */
export type ApplyPhase = "point" | "recheck" | "apply";

/**
 * The preview, restore point offer, confirmation, apply and result state machine for the Optimizations apply flow.
 * `run` is the app's request wrapper; `notify` shows a toast; `data` supplies the capability list.
 */
export function useApplyFlow({
  data,
  run,
  notify,
}: {
  data: Bootstrap | null;
  run: RunFn;
  notify: (text: string, error: boolean) => void;
}) {
  const [selection, setSelection] = useState<OperationId[] | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  // Security trade-offs: the person must tick the acknowledgement and type the item name.
  const [understood, setUnderstood] = useState(false);
  const [typedName, setTypedName] = useState("");
  const [applying, setApplying] = useState(false);
  const [phase, setPhase] = useState<ApplyPhase>("apply");
  const [result, setResult] = useState<Activity | null>(null);
  const [restoreOffer, setRestoreOffer] = useState(false);
  const [createPoint, setCreatePoint] = useState(false);
  const [noPoint, setNoPoint] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  // Preset items whose prerequisite is missing on this PC (e.g. no performance power plan); the rest still apply.
  const [skipped, setSkipped] = useState<OperationId[]>([]);
  // The High performance plan can be created right where it turned out to be missing; afterwards the preview is rebuilt.
  const [planDialog, setPlanDialog] = useState(false);

  // `current`: the state to judge capabilities by; a caller that just changed them passes the fresh bootstrap.
  async function open(ids: OperationId[], current: Bootstrap | null = data) {
    setSelection(ids);
    setPreview(null);
    setPreviewError(null);
    setResult(null);
    setConfirmed(false);
    setUnderstood(false);
    setTypedName("");
    setNoPoint(null);
    setRestoreOffer(false);
    if (ids.length > 1 && ids.some((id) => securityIds.includes(id))) {
      setPreviewError(
        "Security trade-offs are applied one at a time, never together with other items.",
      );
      return;
    }
    const canSkip =
      current?.mode === "desktop" && current.capabilities.length > 0;
    const usable = canSkip
      ? ids.filter((id) => current.capabilities.includes(id))
      : ids;
    setSkipped(usable.length ? ids.filter((id) => !usable.includes(id)) : []);
    if (
      !current ||
      !usable.length ||
      usable.some((id) => !current.capabilities.includes(id))
    ) {
      if (current?.mode === "desktop" && current.capabilities.length)
        setPreviewError(
          "A prerequisite is not met on this PC; see Prerequisites in the optimization details.",
        );
      return;
    }
    setPreviewLoading(true);
    try {
      const restore = await request("restoreStatus", {}).catch(() => null);
      const offer =
        !!restore &&
        restore.protection !== "disabled" &&
        !restore.policyDisabled;
      setRestoreOffer(offer);
      setCreatePoint(offer);
      setPreview(await request("preview", { ids: usable }));
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : "Preview failed.");
    } finally {
      setPreviewLoading(false);
    }
  }
  // A restore point can outlast the preview token, so re-preview and only apply unchanged values.
  async function apply(withPoint: boolean, refresh: boolean) {
    if (!preview || !selection) return;
    setApplying(true);
    setNoPoint(null);
    try {
      let token = preview.token;
      if (withPoint) {
        setPhase("point");
        const point = await run("createRestorePoint", {
          name: `Frameforge ${new Date().toLocaleDateString("en-CA")}`,
          confirmed: true,
          bypassThrottle: false,
        });
        const covered =
          point?.outcome === "created" ||
          (point?.outcome === "throttled" &&
            !!point.lastPoint &&
            Date.now() - Date.parse(point.lastPoint.createdAt) < dayMs);
        if (!covered) {
          setNoPoint(point?.message ?? "The restore point was not created.");
          return;
        }
      }
      if (withPoint || refresh) {
        setPhase("recheck");
        const fresh = await request("preview", {
          ids: selection.filter((id) => !skipped.includes(id)),
        });
        if (!sameChanges(fresh.changes, preview.changes)) {
          setPreview(fresh);
          setConfirmed(false);
          notify(
            "Windows values changed meanwhile. Review the new preview before applying.",
            true,
          );
          return;
        }
        token = fresh.token;
      }
      setPhase("apply");
      const output = await run("confirm", {
        token,
        confirmed: true,
        acknowledged: preview.security,
      });
      if (output) setResult(output);
      else {
        setPreview(null);
        setConfirmed(false);
      }
    } catch (e) {
      notify(e instanceof Error ? e.message : "Preview failed.", true);
    } finally {
      setApplying(false);
    }
  }
  // The plan exists now: rebuild the preview with the new capability list, no restart needed.
  async function planCreated() {
    if (!selection) return;
    const fresh = await request("bootstrap", {}).catch(() => null);
    if (fresh) await open(selection, fresh);
  }
  return {
    selection,
    preview,
    previewLoading,
    confirmed,
    understood,
    typedName,
    applying,
    phase,
    result,
    restoreOffer,
    createPoint,
    noPoint,
    previewError,
    skipped,
    planDialog,
    open,
    apply,
    close: () => setSelection(null),
    planCreated,
    setConfirmed,
    setUnderstood,
    setTypedName,
    setCreatePoint,
    setPlanDialog,
  };
}
export type ApplyFlow = ReturnType<typeof useApplyFlow>;
