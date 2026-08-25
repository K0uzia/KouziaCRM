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
];

export async function ensureDefaultLegalClauses() {
  const count = await prisma.legalClause.count();
  if (count > 0) return;
  await prisma.legalClause.createMany({
    data: DEFAULT_LEGAL_CLAUSES.map((c) => ({
      ...c,
      active: true,
    })),
  });
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
