import {
  ShieldAlert,
  AlertTriangle,
  Activity as ActivityIcon,
} from "lucide-react";
import { Button } from "../../components/ui";

/** Security trade-offs, drifted settings and pending restarts, each with its own live role. */
export function Alerts({
  loweredNames,
  driftedNames,
  restartNames,
  busy,
  onRestoreSecurity,
}: {
  loweredNames: string[];
  driftedNames: string[];
  restartNames: string[];
  busy: boolean;
  onRestoreSecurity: () => void;
}) {
  if (!loweredNames.length && !driftedNames.length && !restartNames.length)
    return null;
  return (
    <div className="alerts stagger">
      {loweredNames.length > 0 && (
        <div className="notice security-banner" role="alert">
          <ShieldAlert size={18} />
          <div>
            <strong>Security settings are lowered on this PC.</strong>
            <p>{loweredNames.join(", ")}.</p>
            <Button
              variant="danger"
              disabled={busy}
              onClick={onRestoreSecurity}
            >
              Restore all security settings
            </Button>
          </div>
        </div>
      )}
      {driftedNames.length > 0 && (
        <p className="notice" role="alert">
          <AlertTriangle size={17} />
          Windows no longer has these settings as Frameforge set them:{" "}
          {driftedNames.join(", ")}. Windows or a policy changed them, so they
          may not be in effect. Check Activity and roll them back to clear this.
        </p>
      )}
      {restartNames.length > 0 && (
        <p className="notice" role="status">
          <ActivityIcon size={17} />
          Pending restart: {restartNames.join(", ")}. Windows reads these after
          the PC restarts.
        </p>
      )}
    </div>
  );
}
