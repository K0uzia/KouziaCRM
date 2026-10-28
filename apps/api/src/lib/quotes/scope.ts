import { LegalClauseKind } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma.js";
import { clausesForClient, fillClauseVariables, type ClauseText } from "@/lib/company/legal-clauses.js";
import { readSiteText } from "@/lib/site/texts.js";
import type { BillingMode } from "@/lib/quotes/payment-plans.js";
import type { Db } from "@/lib/subscriptions/subscription-service.js";

/**
 * Ce qui est compris ou non dans une formule (décisions du 28/10/2026), pour que les deux propositions d'un devis ne
 * disent plus la même chose. Abonnement : « Compris dans l'abonnement », la liste de l'offre du site (SiteText offres,
 * formule site ou logiciel). Paiement unique : « Non compris », la clause ONE_OFF_SCOPE (ou sa variante logiciel), une
 * ligne « - » par point. Figé à l'émission (Invoice.scopeSnapshot, QuoteOption.scopeSnapshot).
 */
export type ScopeKind = "SITE" | "SOFTWARE";
export type QuoteScope = { kind: ScopeKind; included: string[]; excluded: string[] };

const scopeSchema = z.object({
  kind: z.enum(["SITE", "SOFTWARE"]),
  included: z.array(z.string()),
  excluded: z.array(z.string()),
});

/** Périmètre figé, ou null (brouillon, devis sans mode, devis émis avant la migration 20261223090000, illisible). */
export function readScope(json: unknown): QuoteScope | null {
  if (json == null) return null;
  const parsed = scopeSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/** Points d'une clause : une ligne « - » par point ; sans aucune ligne « - », chaque ligne non vide. */
export function scopeItems(body: string): string[] {
  const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const dashed = lines.filter((l) => l.startsWith("- ")).map((l) => l.slice(2).trim()).filter(Boolean);
  return dashed.length ? dashed : lines;
}

/** Logiciel dès qu'une prestation du devis, ou du contenu d'un de ses packs, est de la catégorie LOGICIEL. */
export async function scopeKindOf(serviceIds: ReadonlyArray<string | null | undefined>, db: Db | typeof prisma = prisma): Promise<ScopeKind> {
  const ids = [...new Set(serviceIds.filter((id): id is string => Boolean(id)))];
  if (!ids.length) return "SITE";
  const software = await db.service.count({
    where: {
      id: { in: ids },
      OR: [{ category: "LOGICIEL" }, { packItems: { some: { service: { category: "LOGICIEL" } } } }],
    },
  });
  return software > 0 ? "SOFTWARE" : "SITE";
}

type ScopeCompany = Parameters<typeof fillClauseVariables>[1];

/**
 * Périmètre d'une formule, calculé maintenant : à l'émission (puis figé) et pour l'aperçu d'un brouillon.
 * clauses : clauses actives (ou figées) du document ; clientType filtre leur public. null : pas de mode.
 */
export async function buildQuoteScope(
  mode: BillingMode | null,
  lines: ReadonlyArray<{ serviceId?: string | null }>,
  ctx: { clauses: ReadonlyArray<ClauseText>; clientType: string | null | undefined; company: ScopeCompany },
  db: Db | typeof prisma = prisma,
): Promise<QuoteScope | null> {
  if (!mode) return null;
  const kind = await scopeKindOf(lines.map((l) => l.serviceId), db);
  if (mode === "RECURRING") {
    const offres = await readSiteText("offres");
    const formule = kind === "SOFTWARE" ? offres?.formules.logiciel : offres?.formules.site;
    return { kind, included: [...(formule?.items ?? [])], excluded: [] };
  }
  const forClient = clausesForClient([...ctx.clauses], ctx.clientType);
  const ofKind = (k: LegalClauseKind) => forClient.filter((c) => c.kind === k);
  // Logiciel sans variante active : le texte commun.
  const clauses = (kind === "SOFTWARE" && ofKind(LegalClauseKind.ONE_OFF_SCOPE_SOFTWARE).length ? ofKind(LegalClauseKind.ONE_OFF_SCOPE_SOFTWARE) : ofKind(LegalClauseKind.ONE_OFF_SCOPE));
  const excluded = clauses.flatMap((c) => scopeItems(fillClauseVariables(c.body, ctx.company)));
  return { kind, included: [], excluded };
}
