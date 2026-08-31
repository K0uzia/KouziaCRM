import { prisma } from "@/lib/prisma";

export type LogClientEmailInput = {
  clientId: string;
  kind: string;
  subject: string;
  toAddress: string;
  documentId?: string | null;
  documentNumber?: string | null;
  success?: boolean;
  errorMessage?: string | null;
};

/** Enregistre un email sortant pour le portail de suivi client. */
export async function logClientEmailEvent(input: LogClientEmailInput): Promise<void> {
  try {
    await prisma.clientEmailEvent.create({
      data: {
        clientId: input.clientId,
        kind: input.kind,
        subject: input.subject,
        toAddress: input.toAddress,
        documentId: input.documentId ?? null,
        documentNumber: input.documentNumber ?? null,
        success: input.success ?? true,
        errorMessage: input.errorMessage ?? null,
      },
    });
  } catch (err) {
    console.error("[email] log ClientEmailEvent échoué", err);
  }
}

export function emailKindLabel(kind: string): string {
  const labels: Record<string, string> = {
    quote: "Devis",
    invoice: "Facture",
    invoice_acompte: "Facture d'acompte",
    invoice_solde: "Facture de solde",
    credit_note: "Avoir",
    reminder_soft: "Relance douce",
    reminder_firm: "Relance ferme",
    reminder_formal: "Mise en demeure",
    access: "Identifiants de suivi",
    onboarding: "Invitation onboarding",
    custom: "Message",
  };
  return labels[kind] ?? kind;
}
