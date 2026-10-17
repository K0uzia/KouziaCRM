import { z } from "zod";
import { prisma } from "@/lib/prisma.js";
import { formatEUR } from "@/lib/money.js";

/**
 * Brouillon préparé hors ligne : ce que l'appareil a vu au moment de la préparation, pour signaler ce qui a changé
 * depuis. Rien n'est corrigé d'office : le brouillon est créé tel que saisi, les écarts sont rendus à relire.
 */
export const offlineQuoteFields = {
  /** UUID de l'appareil : un renvoi rend le brouillon déjà créé (idempotence). */
  clientRequestId: z.string().uuid().optional(),
  /** Dernière modification de la fiche client connue de l'appareil (copie locale). */
  clientSeenUpdatedAt: z.iso.datetime({ offset: true }).optional().nullable(),
  /** Prix catalogue des prestations vus à la préparation. */
  servicePricesSeen: z
    .array(z.object({ serviceId: z.string().min(1).max(64), unitPriceCents: z.number().int() }))
    .max(200)
    .optional(),
};

export type OfflineConflict = { kind: "client_changed" | "price_changed"; message: string };

export async function offlineConflicts(
  client: { updatedAt: Date },
  seen: { clientSeenUpdatedAt?: string | null; servicePricesSeen?: Array<{ serviceId: string; unitPriceCents: number }> },
): Promise<OfflineConflict[]> {
  const conflicts: OfflineConflict[] = [];
  if (seen.clientSeenUpdatedAt && client.updatedAt.getTime() > new Date(seen.clientSeenUpdatedAt).getTime()) {
    conflicts.push({ kind: "client_changed", message: "Fiche client modifiée depuis la préparation du devis." });
  }
  const prices = seen.servicePricesSeen ?? [];
  if (prices.length) {
    const services = await prisma.service.findMany({
      where: { id: { in: [...new Set(prices.map((p) => p.serviceId))] } },
      select: { id: true, name: true, unitPriceCents: true },
    });
    const byId = new Map(services.map((s) => [s.id, s]));
    const reported = new Set<string>();
    for (const p of prices) {
      const current = byId.get(p.serviceId);
      if (!current || current.unitPriceCents === p.unitPriceCents || reported.has(p.serviceId)) continue;
      reported.add(p.serviceId);
      conflicts.push({
        kind: "price_changed",
        message: `Prix de « ${current.name} » changé depuis la préparation : ${formatEUR(p.unitPriceCents)} à la préparation, ${formatEUR(current.unitPriceCents)} au catalogue. Le prix saisi est gardé.`,
      });
    }
  }
  return conflicts;
}

const REASON_LABEL: Record<OfflineConflict["kind"], string> = { client_changed: "client modifié", price_changed: "prix changé" };

/** Motif court gardé sur le devis (« client modifié, prix changé »), ou null sans écart. */
export function offlineReviewReason(conflicts: OfflineConflict[]): string | null {
  const kinds = (["client_changed", "price_changed"] as const).filter((k) => conflicts.some((c) => c.kind === k));
  return kinds.length ? kinds.map((k) => REASON_LABEL[k]).join(", ") : null;
}
