"use client";

import { Button } from "@/components/ui/button";
import { useModal } from "@/components/providers/modal-provider";

export function NewClientButton({
  variant = "default",
  className,
}: {
  variant?: "default" | "outline" | "secondary" | "ghost";
  className?: string;
}) {
  const { openModal } = useModal();
  return (
    <Button
      type="button"
      variant={variant}
      className={className}
      onClick={() => openModal("client-create")}
    >
      Nouveau client
    </Button>
  );
}

export function NewInvoiceButton({
  clientId,
  variant = "default",
  className,
  label = "Nouvelle facture",
}: {
  clientId?: string;
  variant?: "default" | "outline" | "secondary" | "ghost";
  className?: string;
  label?: string;
}) {
  const { openModal } = useModal();
  return (
    <Button
      type="button"
      variant={variant}
      className={className}
      onClick={() => openModal("invoice-create", clientId ? { clientId } : undefined)}
    >
      {label}
    </Button>
  );
}
