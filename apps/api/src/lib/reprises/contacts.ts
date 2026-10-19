import { prisma } from "@/lib/prisma.js";
import { syncPrimaryContact } from "@/lib/clients/contacts.js";

/** Comptes de la reprise des contacts : des nombres seulement, jamais de nom, d'adresse ni d'identifiant. */
export type ContactsTakeoverCounts = {
  /** Contacts principaux créés. */
  contacts: number;
  withEmail: number;
  withPhone: number;
  /** Sans nom : libellé « Contact principal ». */
  unnamed: number;
  /** Fiches sans nom, e-mail ni téléphone : aucun contact. */
  skipped: number;
};

/**
 * Un contact principal par fiche qui n'a encore aucun contact et qui a un nom, un e-mail ou un téléphone : prénom
 * et nom repris de la fiche, e-mail et téléphone recopiés chiffrés tels quels, emailHash repris. Idempotente (une
 * fiche qui a déjà un contact n'est pas touchée) ; la date de la fiche ne change pas. À blanc : mêmes comptes.
 */
export async function contactsTakeover({ dryRun }: { dryRun: boolean }): Promise<ContactsTakeoverCounts> {
  const candidates = await prisma.client.findMany({
    where: { contacts: { none: {} } },
    select: { id: true, firstName: true, lastName: true, emailEncrypted: true, phoneEncrypted: true },
  });
  const counts: ContactsTakeoverCounts = { contacts: 0, withEmail: 0, withPhone: 0, unnamed: 0, skipped: 0 };
  for (const c of candidates) {
    const named = Boolean(c.firstName?.trim() || c.lastName?.trim());
    if (!named && !c.emailEncrypted && !c.phoneEncrypted) {
      counts.skipped++;
      continue;
    }
    if (!dryRun) {
      await prisma.$transaction(async (tx) => {
        // Relu dans la transaction : une fiche qui a reçu un contact entre-temps n'en reçoit pas un second.
        if ((await tx.clientContact.count({ where: { clientId: c.id } })) === 0) await syncPrimaryContact(c.id, tx);
      });
    }
    counts.contacts++;
    if (c.emailEncrypted) counts.withEmail++;
    if (c.phoneEncrypted) counts.withPhone++;
    if (!named) counts.unnamed++;
  }
  return counts;
}
