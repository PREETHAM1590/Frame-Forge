import { useEffect, useState } from "react";
import { Cpu } from "lucide-react";
import { Badge, Button } from "../../components/ui";
import { request } from "../../api";
import type { DriverVendor, GpuDrivers } from "../../../shared/contracts";
import { driverAge, driverPageName } from "../../../shared/drivers";

const tone = {
  unknown: "neutral",
  recent: "lime",
  aging: "amber",
  old: "amber",
} as const;

/** Installed GPU driver and its age. Frameforge does not know the newest version, download or install drivers; the button opens the vendor's own page. */
export function DriverCheck() {
  const [info, setInfo] = useState<GpuDrivers | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    request("gpuDrivers", {})
      .then((r) => live && setInfo(r))
      .catch((e) => live && setError(e instanceof Error ? e.message : ""));
    return () => {
      live = false;
    };
  }, []);
  // The browser preview and a missing helper stay quiet.
  if (!info)
    return error && !/desktop|helper/i.test(error) ? (
      <p className="field-error">{error}</p>
    ) : null;
  return (
    <section className="system-section" aria-label="GPU driver check">
      <h2>
        <Cpu size={20} />
        GPU driver
      </h2>
      {info.adapters.length === 0 && (
        <p className="muted">No graphics adapter was reported.</p>
      )}
      {info.adapters.map((a) => {
        const age = driverAge(a.driverDate);
        const vendor = a.vendor === "other" ? null : (a.vendor as DriverVendor);
        return (
          <div key={a.name} className="driver-row">
            <h3>{a.name}</h3>
            <dl>
              <dt>Driver version</dt>
              <dd>
                {a.displayVersion ?? a.driverVersion}
                {a.displayVersion && (
                  <span className="muted">
                    {" "}
                    (Windows reports {a.driverVersion})
                  </span>
                )}
              </dd>
              <dt>Driver date</dt>
              <dd>
                {a.driverDate ?? "unknown"}{" "}
                <Badge tone={tone[age.level]}>{age.text}</Badge>
              </dd>
            </dl>
            {age.level === "old" && (
              <p className="muted">
                This driver is over a year old. A newer one may exist, but a
                newer driver is not automatically faster; check the vendor's
                release notes for the games you play.
              </p>
            )}
            {vendor && (
              <Button
                onClick={() =>
                  void request("openDriverPage", { vendor }).catch((e) =>
                    setError(e instanceof Error ? e.message : ""),
                  )
                }
              >
                Open {driverPageName[vendor]}
              </Button>
            )}
          </div>
        );
      })}
      <p className="muted">
        Frameforge does not check for the newest version or download or install
        drivers.
      </p>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
