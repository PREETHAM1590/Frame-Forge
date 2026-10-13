import * as Dialog from "@radix-ui/react-dialog";
import * as Switch from "@radix-ui/react-switch";
import { X, LoaderCircle, ArrowRight, Info } from "lucide-react";
import type { ReactNode, ButtonHTMLAttributes } from "react";
export function Button({
  children,
  className = "",
  variant = "secondary",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "ghost";
}) {
  return (
    <button {...props} className={`button ${variant} ${className}`}>
      {children}
    </button>
  );
}
export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "lime" | "cyan" | "amber" | "red";
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
/** One colour per journal/session status, shared by every list. */
export function statusTone(
  status: string,
): "neutral" | "lime" | "cyan" | "amber" | "red" {
  if (status === "success" || status === "active") return "lime";
  if (status === "failed" || status === "recovery-needed") return "red";
  if (status === "running" || status === "preparing" || status === "restoring")
    return "amber";
  if (status === "rolled-back") return "cyan";
  return "neutral";
}
export function Modal({
  title,
  description,
  children,
  onClose,
  locked = false,
}: {
  title: string;
  description: string;
  children: ReactNode;
  onClose: () => void;
  locked?: boolean;
}) {
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !locked) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal">
          <div className="modal-header">
            <Dialog.Title>{title}</Dialog.Title>
            <Dialog.Close asChild disabled={locked}>
              <button
                className="icon-button"
                aria-label="Close dialog"
                title="Close dialog"
              >
                <X size={20} />
              </button>
            </Dialog.Close>
          </div>
          <Dialog.Description className="muted">
            {description}
          </Dialog.Description>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function Toggle({
  label,
  description,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="setting-row">
      <div>
        <label htmlFor={label}>{label}</label>
        <p className="muted">{description}</p>
      </div>
      <Switch.Root
        id={label}
        className="switch"
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
      >
        <Switch.Thumb className="switch-thumb" />
      </Switch.Root>
    </div>
  );
}
export function Empty({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <Info size={28} />
      <h3>{title}</h3>
      <p className="muted">{description}</p>
      {action}
    </div>
  );
}
export function Busy({ label = "Working" }: { label?: string }) {
  return (
    <span className="busy">
      <LoaderCircle size={18} className="spin" />
      {label}
    </span>
  );
}
export function PageTitle({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle: string;
  action?: ReactNode;
}) {
  return (
    <header className="page-title">
      <div>
        <h1>{title}</h1>
        <p className="muted">{subtitle}</p>
      </div>
      {action}
    </header>
  );
}
export function LinkButton({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button className="text-button" onClick={onClick}>
      {children}
      <ArrowRight size={16} />
    </button>
  );
}
export function formatBytes(bytes: number) {
  if (!bytes) return "Unavailable";
  return `${(bytes / 1024 ** 3).toFixed(bytes < 100 * 1024 ** 3 ? 1 : 0)} GB`;
}
export function formatTime(at: string) {
  return new Date(at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
