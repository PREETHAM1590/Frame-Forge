import { useEffect, useState } from "react";
import { onEvent, request } from "./api";
import type { UpdateStatus } from "../shared/contracts";
/** Live update status: loaded once, then pushed by the main process. */
export function useUpdate() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    request("updateStatus", {})
      .then((s) => active && setStatus(s))
      .catch(() => undefined);
    const off = onEvent((e) => {
      if (e.type === "update") setStatus(e.status);
    });
    return () => {
      active = false;
      off();
    };
  }, []);
  async function act(
    method: "updateCheck" | "updateDownload" | "updateInstall",
    when: "now" | "onQuit" = "now",
  ) {
    setError("");
    try {
      setStatus(
        method === "updateInstall"
          ? await request(method, { when })
          : await request(method, {}),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Update request failed.");
    }
  }
  return { status, error, act };
}
