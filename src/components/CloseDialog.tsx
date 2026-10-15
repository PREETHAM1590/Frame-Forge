import { useEffect, useState } from "react";
import { Button, Modal, Toggle } from "./ui";

export type CloseReply = "tray" | "quit" | "cancel";
/** In-app replacement for the native close prompt. Esc or the close button leaves the window open. */
export function CloseDialog({
  onReply,
  onShown,
}: {
  onReply: (action: CloseReply, remember: boolean) => void;
  /** Called once the modal is on screen, so the main process knows not to fall back to its native box. */
  onShown: () => void;
}) {
  const [remember, setRemember] = useState(true);
  useEffect(onShown, [onShown]);
  return (
    <Modal
      title="Keep Frameforge running in the tray?"
      description="Auto-boost can start when you launch a game only while Frameforge is running. You can change this in Settings > General."
      onClose={() => onReply("cancel", false)}
    >
      <Toggle
        label="Remember my choice"
        description="Do not ask again."
        checked={remember}
        onChange={setRemember}
      />
      <div className="dialog-actions">
        <Button onClick={() => onReply("quit", remember)}>
          Quit Frameforge
        </Button>
        <Button
          variant="primary"
          autoFocus
          onClick={() => onReply("tray", remember)}
        >
          Minimize to tray
        </Button>
      </div>
    </Modal>
  );
}
