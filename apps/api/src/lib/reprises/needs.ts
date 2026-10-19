import { prisma } from "@/lib/prisma.js";
import { legacyNeedsToDetails, parseNeeds } from "@/lib/clients/needs.js";

/** Comptes de la reprise des besoins : des nombres seulement, jamais de libellé. */
export type NeedsTakeoverCounts = {
  /** Fiches dont les Précisions sont remplies. */
  clients: number;
  /** Besoins repris, une ligne chacun. */
  needs: number;
  /** Dont cochés « traité » (mention « (traité) » gardée). */
  done: number;
};

/**
 * Anciens besoins en texte libre (Client.needs) recopiés dans les Précisions, un par ligne (« - libellé »,
 * « (traité) » s'il était coché). Aucune correspondance automatique avec le catalogue : Alexandre coche lui-même.
 * Seulement les fiches dont les Précisions n'ont jamais été écrites (null) : idempotente, et une saisie faite
 * entre-temps l'emporte. Client.needs reste en place, en lecture seule ; la date de la fiche ne change pas.
 */
export async function needsTakeover({ dryRun }: { dryRun: boolean }): Promise<NeedsTakeoverCounts> {
  const candidates = await prisma.client.findMany({
    where: { needsDetails: null, NOT: { needs: "[]" } },
    select: { id: true, needs: true, updatedAt: true },
  });
  const counts: NeedsTakeoverCounts = { clients: 0, needs: 0, done: 0 };
  for (const c of candidates) {
    const needs = parseNeeds(c.needs);
    if (!needs.length) continue;
    if (!dryRun) {
      const { count } = await prisma.client.updateMany({
        where: { id: c.id, needsDetails: null },
        data: { needsDetails: legacyNeedsToDetails(needs), updatedAt: c.updatedAt },
      });
      if (count === 0) continue;
    }
    counts.clients++;
    counts.needs += needs.length;
    counts.done += needs.filter((n) => n.done).length;
  }
  return counts;
}
