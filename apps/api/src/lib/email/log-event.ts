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
  outboxId?: string | null;
  threadId?: string | null;
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
        outboxId: input.outboxId ?? null,
        threadId: input.threadId ?? null,
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
    obligation_reminder_j7: "Rappel obligation J-7",
    obligation_reminder_j3: "Rappel obligation J-3",
    obligation_reminder_j1: "Rappel obligation J-1",
    obligation_reminder_j0: "Rappel obligation jour J",
  };
  return labels[kind] ?? kind;
}
