import { LegalClauseKind } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";

export const DEFAULT_LEGAL_CLAUSES: Array<{
  kind: LegalClauseKind;
  title: string;
  body: string;
  required: boolean;
  position: number;
}> = [
  {
    kind: LegalClauseKind.VAT,
    title: "Franchise en base de TVA",
    body: "TVA non applicable, art. 293 B du CGI",
    required: true,
    position: 0,
  },
  {
    kind: LegalClauseKind.PAYMENT,
    title: "Conditions de paiement",
    body: "Paiement à réception de facture",
    required: true,
    position: 1,
  },
  {
    kind: LegalClauseKind.PENALTY,
    title: "Pénalités de retard",
    body: "En cas de retard de paiement, une pénalité égale à 3 fois le taux d'intérêt légal sera due, ainsi qu'une indemnité forfaitaire de 40 € pour frais de recouvrement (art. L441-10 et D441-5 du code de commerce).",
    required: true,
    position: 2,
  },
  {
    kind: LegalClauseKind.SUSPENSION,
    title: "Suspension des prestations",
    body: "En cas de non-paiement d'une échéance, les prestations peuvent être suspendues jusqu'à régularisation.",
    required: true,
    position: 3,
  },
  {
    kind: LegalClauseKind.CUSTOM,
    title: "Facturation électronique (calendrier EI / micro)",
    body: "En tant qu'entreprise individuelle / micro-entreprise, le Prestataire est tenu de pouvoir recevoir des factures électroniques via une plateforme agréée depuis le 1er septembre 2026. L'obligation d'émettre ses propres factures de vente au format électronique via une plateforme agréée s'applique à compter du 1er septembre 2027 (réforme de la facturation électronique, art. 289 bis et suivants du CGI). Jusqu'à cette date, les factures peuvent être émises et transmises dans les formats habituellement utilisés (notamment PDF), sans préjudice des mentions légales obligatoires.",
    required: false,
    position: 4,
  },
];

export async function ensureDefaultLegalClauses() {
  const count = await prisma.legalClause.count();
  if (count === 0) {
    await prisma.legalClause.createMany({
      data: DEFAULT_LEGAL_CLAUSES.map((c) => ({
        ...c,
        active: true,
      })),
    });
    return;
  }

  // Bases déjà seedées : ajouter les clauses manquantes par titre (sans doublon).
  for (const clause of DEFAULT_LEGAL_CLAUSES) {
    const existing = await prisma.legalClause.findFirst({
      where: { title: clause.title },
    });
    if (!existing) {
      await prisma.legalClause.create({
        data: { ...clause, active: true },
      });
    }
  }
}

export async function listActiveLegalClauses() {
  await ensureDefaultLegalClauses();
  return prisma.legalClause.findMany({
    where: { active: true },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
  });
}

export async function listAllLegalClauses() {
  await ensureDefaultLegalClauses();
  return prisma.legalClause.findMany({
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
  });
}
