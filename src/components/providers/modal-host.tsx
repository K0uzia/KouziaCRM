"use client";

import { useRouter } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import dynamic from "next/dynamic";
import type { ModalPayload, ModalType } from "@/components/providers/modal-types";

const ClientForm = dynamic(
  () => import("@/components/clients/client-form").then((m) => m.ClientForm),
  { loading: () => <Skeleton className="h-48 w-full" />, ssr: false },
);

const InvoiceForm = dynamic(
  () => import("@/components/invoices/invoice-form").then((m) => m.InvoiceForm),
  { loading: () => <Skeleton className="h-48 w-full" />, ssr: false },
);

const titles: Record<Exclude<ModalType, null>, string> = {
  "client-create": "Nouveau client",
  "client-edit": "Modifier le client",
  "invoice-create": "Nouvelle facture",
  "invoice-edit": "Modifier la facture",
};

type Props = {
  type: ModalType;
  payload: ModalPayload;
  onClose: () => void;
};

export default function ModalHost({ type, payload, onClose }: Props) {
  const router = useRouter();

  function afterSave(path?: string) {
    onClose();
    router.refresh();
    if (path) router.push(path);
  }

  return (
    <Dialog open={type !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{payload.title ?? (type ? titles[type] : "")}</DialogTitle>
          <DialogDescription className="sr-only">
            {payload.description ?? "Formulaire"}
          </DialogDescription>
        </DialogHeader>

        {type === "client-create" || type === "client-edit" ? (
          <ClientForm
            mode={type === "client-create" ? "create" : "edit"}
            clientId={payload.clientId}
            variant="modal"
            onCancel={onClose}
            onSuccess={(client) => afterSave(`/clients/${client.id}`)}
          />
        ) : null}

        {type === "invoice-create" ? (
          <InvoiceForm
            variant="modal"
            defaultClientId={payload.clientId}
            onCancel={onClose}
            onSuccess={(invoice) => afterSave(`/invoices/${invoice.id}`)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
