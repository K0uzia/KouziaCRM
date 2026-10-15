import type { ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { Modal, ModalActions } from "@/components/ui/Modal";

type ConfirmDialogProps = {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  /** Détail sous le message (récapitulatif avant une action sensible). */
  children?: ReactNode;
  onConfirm: () => void;
  onClose: () => void;
};

/** Confirmation unique pour actions destructrices / sensibles. */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirmer",
  cancelLabel = "Annuler",
  danger = false,
  busy = false,
  children,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  return (
    <Modal open={open} onClose={busy ? () => undefined : onClose} title={title}>
      <p className="text-sm text-[var(--text)]">{message}</p>
      {children}
      <ModalActions>
        <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>
          {cancelLabel}
        </Button>
        <Button
          type="button"
          variant={danger ? "danger" : "primary"}
          disabled={busy}
          onClick={onConfirm}
        >
          {busy ? "…" : confirmLabel}
        </Button>
      </ModalActions>
    </Modal>
  );
}
