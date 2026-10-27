import fs from "node:fs/promises";
import { SubscriptionStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { attachmentAbsPath } from "@/lib/email/attachments.js";

// Effacement d'une fiche client à la demande de la personne (RGPD, art. 17 ; décision du 27/10/2026).
// - Aucun document ni abonnement : la fiche est supprimée, avec ses fils de messagerie.
// - Abonnement en cours : refus clair, l'abonnement se termine d'abord (factures à venir, prélèvement).
// - Client facturé : anonymisation partielle. Les documents émis (devis, factures, avoirs), leurs paiements et les
//   preuves de signature sont gardés 10 ans (obligation comptable, art. L123-22 du code de commerce) avec la copie du
//   client figée à l'émission ; tout le reste de la fiche est retiré.

export class ClientErasureError extends Error {
  constructor(
    message: string,
    public statusCode: number,
  ) {
    super(message);
  }
}

export type ErasureResult = { mode: "DELETED" | "ANONYMIZED"; keptDocuments: number };

/** Fils de messagerie du client, sauf ceux qui portent un accord sur un devis (preuve de signature gardée 10 ans). */
async function deleteClientThreads(clientId: string): Promise<void> {
  const threads = await prisma.emailThread.findMany({ where: { clientId, quoteAcceptanceAudits: { none: {} } }, select: { id: true } });
  if (threads.length === 0) return;
  const ids = threads.map((t) => t.id);
  const files = await prisma.emailAttachment.findMany({ where: { message: { threadId: { in: ids } } }, select: { storagePath: true } });
  await prisma.emailThread.deleteMany({ where: { id: { in: ids } } });
  for (const f of files) await fs.rm(attachmentAbsPath(f.storagePath), { force: true }).catch(() => undefined);
}

export async function eraseClient(clientId: string): Promise<ErasureResult> {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: {
      id: true,
      clientNumber: true,
      subscriptions: { select: { label: true, status: true } },
      _count: { select: { invoices: true } },
    },
  });
  if (!client) throw new ClientErasureError("Client introuvable", 404);

  const running = client.subscriptions.find((s) => s.status !== SubscriptionStatus.ENDED);
  if (running) {
    throw new ClientErasureError(
      `Abonnement en cours (« ${running.label} ») : terminez-le ou programmez sa fin, puis effacez la fiche une fois l'abonnement clôturé.`,
      409,
    );
  }

  await deleteClientThreads(clientId);

  if (client._count.invoices === 0 && client.subscriptions.length === 0) {
    await prisma.client.delete({ where: { id: clientId } });
    return { mode: "DELETED", keptDocuments: 0 };
  }

  await prisma.$transaction([
    prisma.clientContact.deleteMany({ where: { clientId } }),
    prisma.clientNote.deleteMany({ where: { clientId } }),
    prisma.clientServiceNeed.deleteMany({ where: { clientId } }),
    prisma.clientRenewal.deleteMany({ where: { clientId } }),
    prisma.clientEmailEvent.deleteMany({ where: { clientId } }),
    prisma.clientTestimonial.deleteMany({ where: { clientId } }),
    prisma.clientPortalSeen.deleteMany({ where: { clientId } }),
    prisma.portalCode.deleteMany({ where: { clientId } }),
    prisma.portalSession.deleteMany({ where: { clientId } }),
    prisma.onboardingInvitation.deleteMany({ where: { OR: [{ existingClientId: clientId }, { createdClientId: clientId }] } }),
    prisma.softwareRequest.deleteMany({ where: { clientId } }),
    prisma.emailThread.updateMany({ where: { clientId }, data: { clientId: null } }),
    prisma.client.update({
      where: { id: clientId },
      data: {
        displayName: `Client effacé${client.clientNumber ? ` ${client.clientNumber}` : ""}`,
        firstName: null,
        lastName: null,
        companyName: null,
        emailEncrypted: null,
        emailHash: null,
        phoneEncrypted: null,
        siretEncrypted: null,
        sirenEncrypted: null,
        apeCode: null,
        companyVerifiedAt: null,
        addressLine1: null,
        addressLine2: null,
        postalCode: null,
        city: null,
        addressCityCode: null,
        addressLat: null,
        addressLon: null,
        notes: null,
        notepadEncrypted: null,
        notepadConflictAt: null,
        needs: "[]",
        needsDetails: null,
        emailVerifiedAt: null,
        accessEmailSentAt: null,
      },
    }),
  ]);
  return { mode: "ANONYMIZED", keptDocuments: client._count.invoices };
}
