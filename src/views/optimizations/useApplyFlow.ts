import { useState } from "react";
import { request } from "../../api";
import { adminIds, catalogue } from "../../../shared/catalogue";
import { pendingStore } from "../../pendingChanges";
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
const recent = (iso: string) => Date.now() - Date.parse(iso) < dayMs;
const changeKey = (changes: Preview["changes"]) =>
  JSON.stringify(changes.map((c) => [c.setting, c.before, c.after]));
const sameChanges = (a: Preview["changes"], b: Preview["changes"]) =>
  changeKey(a) === changeKey(b);

/** A Frameforge-applied journal row the person is turning off; rolling it back restores every item it covers. */
export interface OffItem {
  activityId: string;
  ids: OperationId[];
}
/** What a saved row ended as, read back from Windows. */
export interface RowOutcome {
  id: OperationId;
  want: "on" | "off";
  got: "on" | "off" | "unknown";
}
export const securityPhrase = "lower my security";
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
  // The last confirm failed before finishing (its token is spent): the typed confirmation stays, and the next apply re-previews first.
  const [stale, setStale] = useState(false);
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
  // Turn-offs saved together with the turn-ons; undefined for a plain apply (Details, presets).
  const [offs, setOffs] = useState<OffItem[] | undefined>(undefined);
  const [rows, setRows] = useState<RowOutcome[]>([]);
  const [notes, setNotes] = useState<string[]>([]);

  // `current`: the state to judge capabilities by; a caller that just changed them passes the fresh bootstrap.
  async function open(
    ids: OperationId[],
    current: Bootstrap | null = data,
    turnOff?: OffItem[],
  ) {
    setOffs(turnOff);
    setRows([]);
    setNotes([]);
    setSelection(ids);
    setStale(false);
    setPreview(null);
    setPreviewError(null);
    setResult(null);
    setConfirmed(false);
    setUnderstood(false);
    setTypedName("");
    setNoPoint(null);
    setRestoreOffer(false);
    const machineCount = new Set(
      [...ids, ...(turnOff ?? []).flatMap((o) => o.ids)].filter((id) =>
        adminIds.includes(id),
      ),
    ).size;
    if (machineCount > 24) {
      setPreviewError(
        "That is more administrator-level changes than one approval can cover (24). Save some first, then the rest.",
      );
      return;
    }
    if (!ids.length && turnOff?.length) {
      const items = turnOff.flatMap((o) => o.ids);
      setRestoreOffer(false);
      setCreatePoint(false);
      setPreview({
        token: "",
        expiresAt: "",
        ids: [],
        changes: [],
        warnings: [...new Set(items)].map(
          (id) =>
            `${catalogue.find((o) => o.id === id)!.name}: ${catalogue.find((o) => o.id === id)!.rollback}`,
        ),
        restart: "none",
        admin: items.some((id) => adminIds.includes(id)),
        security: [],
      });
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
    refresh ||= stale;
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
            recent(point.lastPoint.createdAt));
        if (!covered) {
          setNoPoint(point?.message ?? "The restore point was not created.");
          return;
        }
      }
      let output: Activity | undefined;
      if (preview.token) {
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
        output = await run("confirm", {
          token,
          confirmed: true,
          acknowledged: preview.security,
        });
        if (!output) {
          // Keep the preview and the typed confirmation; the message is already shown. Retrying re-checks Windows first.
          setStale(true);
          return;
        }
      }
      let offDone: Activity[] | undefined;
      const notApplied =
        output?.status === "cancelled" &&
        output.message.startsWith("Not applied");
      const extra: string[] = [];
      if (offs?.length) {
        if (notApplied)
          extra.push(
            "Turning items off was not attempted: administrator approval for the turn-ons was not given. Nothing was changed.",
          );
        else {
          setPhase("apply");
          offDone = await run("rollbackBatch", {
            ids: offs.map((o) => o.activityId),
            confirmed: true,
          });
          if (!offDone) {
            extra.push(
              "Turning items off did not finish (see the message). Nothing was assumed; the switches show what Windows reports.",
            );
            if (!output) {
              setStale(true);
              return;
            }
          }
        }
      }
      setStale(false);
      if (offs) {
        const want = [
          ...(output && !notApplied ? applicable() : []).map(
            (id) => [id, "on"] as const,
          ),
          ...(offDone ? offs.flatMap((o) => o.ids) : []).map(
            (id) => [id, "off"] as const,
          ),
        ];
        const read = await request("optimizationStatus", {}).catch(() => []);
        setRows(
          want.map(([id, w]) => ({
            id,
            want: w,
            got: read.find((r) => r.id === id)?.state ?? "unknown",
          })),
        );
      }
      setNotes(extra);
      setResult(output ?? offDone![0]!);
    } catch (e) {
      notify(e instanceof Error ? e.message : "Preview failed.", true);
    } finally {
      setApplying(false);
    }
  }
  const applicable = () =>
    (selection ?? []).filter((id) => !skipped.includes(id));
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
    stale,
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
    close: () => {
      // A finished save settles every pending switch to what Windows reports; a closed review keeps them pending.
      if (result && offs) pendingStore.clear();
      setSelection(null);
    },
    offs,
    rows,
    notes,
    planCreated,
    setConfirmed,
    setUnderstood,
    setTypedName,
    setCreatePoint,
    setPlanDialog,
  };
}
export type ApplyFlow = ReturnType<typeof useApplyFlow>;
