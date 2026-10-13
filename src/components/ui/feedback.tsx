import * as Dialog from "@radix-ui/react-dialog";
import {
  X,
  LoaderCircle,
  Info,
  AlertTriangle,
  CheckCircle2,
} from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "./controls";
/** Radix Dialog traps focus and returns it to the opener on close. */
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
export function Toast({
  text,
  error,
  onDismiss,
}: {
  text: string;
  error: boolean;
  onDismiss: () => void;
}) {
  return (
    <div
      className={`toast ${error ? "error" : ""}`}
      role={error ? "alert" : "status"}
    >
      {error ? <AlertTriangle size={19} /> : <CheckCircle2 size={19} />}
      <span>{text}</span>
      <button
        className="icon-button"
        aria-label="Dismiss notification"
        onClick={onDismiss}
      >
        <X size={16} />
      </button>
    </div>
  );
}
export function Skeleton({
  width = "100%",
  height = 14,
}: {
  width?: number | string;
  height?: number | string;
}) {
  return <span className="skeleton" style={{ width, height }} aria-hidden />;
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
      <Info size={26} />
      <h3>{title}</h3>
      <p className="muted">{description}</p>
      {action}
    </div>
  );
}
export const EmptyState = Empty;
export function ErrorState({
  title,
  message,
  onRetry,
}: {
  title: string;
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="error-state" role="alert">
      <AlertTriangle size={26} />
      <h3>{title}</h3>
      <p>{message}</p>
      {onRetry && <Button onClick={onRetry}>Retry</Button>}
    </div>
  );
}
export function Busy({ label = "Working" }: { label?: string }) {
  return (
    <span className="busy">
      <LoaderCircle size={16} className="spin" />
      {label}
    </span>
  );
}
