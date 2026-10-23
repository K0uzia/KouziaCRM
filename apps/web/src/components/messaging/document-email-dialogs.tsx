import { toast } from "sonner";
import { api } from "@/lib/api";
import { VerifyEmailDialog } from "@/components/messaging/VerifyEmailDialog";

/** « Renvoyer par e-mail » d'un devis, d'une facture ou d'un avoir émis : PDF joint, e-mail relu avant l'envoi. */
export function ResendDocumentDialog({
  documentId,
  onClose,
  onSent,
}: {
  /** Document à renvoyer ; null : fenêtre fermée. */
  documentId: string | null;
  onClose: () => void;
  onSent?: () => void | Promise<void>;
}) {
  if (!documentId) return null;
  return (
    <VerifyEmailDialog
      open
      title="Vérifier l'e-mail : renvoi du document"
      draftUrl={`/api/invoices/${documentId}/send-email/draft`}
      onClose={onClose}
      onSend={async (edits) => {
        try {
          const r = await api<{ emailed: boolean; reason?: string | null }>(`/api/invoices/${documentId}/send-email`, {
            method: "POST",
            body: JSON.stringify(edits),
          });
          if (!r.emailed) {
            toast.error(r.reason === "smtp_off" ? "SMTP non configuré : e-mail non envoyé." : "L'e-mail n'a pas pu partir.");
            return;
          }
          toast.success("PDF en file d'envoi");
          onClose();
          await onSent?.();
        } catch (e) {
          toast.error(e instanceof Error ? e.message : "Envoi impossible");
        }
      }}
    />
  );
}

/** « Relancer le client » : relance relue avant l'envoi ; sans SMTP, le brouillon s'ouvre dans la messagerie du poste. */
export function ReminderDialog({
  documentId,
  onClose,
  onDone,
}: {
  documentId: string | null;
  onClose: () => void;
  onDone?: () => void | Promise<void>;
}) {
  if (!documentId) return null;
  return (
    <VerifyEmailDialog
      open
      title="Vérifier l'e-mail : relance"
      draftUrl={`/api/invoices/${documentId}/reminders/draft`}
      sendLabel="Envoyer la relance"
      onClose={onClose}
      onSend={async (edits) => {
        try {
          const res = await api<{ emailed: boolean; mailto: string | null }>(`/api/invoices/${documentId}/reminders/send`, {
            method: "POST",
            body: JSON.stringify(edits),
          });
          if (res.emailed) toast.success("Relance envoyée");
          else if (res.mailto) {
            window.location.href = res.mailto;
            toast.info("Client mail ouvert");
          } else toast.info("Relance enregistrée (pas d'e-mail client)");
          onClose();
          await onDone?.();
        } catch (e) {
          toast.error(e instanceof Error ? e.message : "Erreur");
        }
      }}
    />
  );
}

/** Reçu de paiement (reçu et facture joints), relu avant l'envoi ; paymentId absent : dernier paiement de la facture. */
export function ReceiptDialog({
  invoiceId,
  paymentId,
  onClose,
  onDone,
}: {
  invoiceId: string | null;
  paymentId?: string | null;
  onClose: () => void;
  onDone?: () => void | Promise<void>;
}) {
  if (!invoiceId) return null;
  const query = paymentId ? `?paymentId=${encodeURIComponent(paymentId)}` : "";
  return (
    <VerifyEmailDialog
      open
      title="Vérifier l'e-mail : reçu de paiement"
      draftUrl={`/api/invoices/${invoiceId}/receipt/draft${query}`}
      sendLabel="Envoyer le reçu"
      onClose={onClose}
      onSend={async (edits) => {
        try {
          const r = await api<{ sent: boolean; reason: string | null }>(`/api/invoices/${invoiceId}/receipt`, {
            method: "POST",
            body: JSON.stringify({ ...edits, ...(paymentId ? { paymentId } : {}) }),
          });
          if (!r.sent) {
            toast.error(r.reason === "smtp_off" ? "SMTP non configuré : reçu non envoyé." : "Le reçu n'a pas pu partir.");
            return;
          }
          toast.success("Reçu envoyé au client");
          onClose();
          await onDone?.();
        } catch (e) {
          toast.error(e instanceof Error ? e.message : "Envoi impossible");
        }
      }}
    />
  );
}

/** Lien de paiement d'une échéance d'acompte, relu avant l'envoi. */
export function MilestoneLinkDialog({
  quoteId,
  milestoneId,
  onClose,
  onDone,
}: {
  quoteId: string;
  milestoneId: string | null;
  onClose: () => void;
  onDone?: () => void | Promise<void>;
}) {
  if (!milestoneId) return null;
  return (
    <VerifyEmailDialog
      open
      title="Vérifier l'e-mail : lien de paiement de l'acompte"
      draftUrl={`/api/quotes/${quoteId}/milestones/${milestoneId}/payment-link/draft`}
      onClose={onClose}
      onSend={async (edits) => {
        try {
          await api(`/api/quotes/${quoteId}/milestones/${milestoneId}/payment-link/email`, { method: "POST", body: JSON.stringify(edits) });
          toast.success("E-mail d'encaissement envoyé");
          onClose();
          await onDone?.();
        } catch (e) {
          toast.error(e instanceof Error ? e.message : "Envoi impossible");
        }
      }}
    />
  );
}
