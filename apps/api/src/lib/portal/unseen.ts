import { prisma } from "@/lib/prisma.js";

/**
 * Pastilles « non vu » de /suivi (contrat du 19/10/2026 avec KouziaWebsite) : un élément est nouveau s'il est apparu
 * ou a changé après la dernière ouverture de sa rubrique. Rubrique jamais ouverte : la référence est posée à la
 * première lecture, sans pastille (« À faire » couvre déjà ce qui demande une action).
 */
export const PORTAL_SECTIONS = ["projects", "documents", "payments"] as const;
export type PortalSection = (typeof PORTAL_SECTIONS)[number];
export type PortalSeen = Record<PortalSection, Date>;

export async function loadPortalSeen(clientId: string, now = new Date()): Promise<PortalSeen> {
  const rows = await prisma.clientPortalSeen.findMany({ where: { clientId } });
  const seen = new Map(rows.map((r) => [r.section, r.seenAt]));
  for (const section of PORTAL_SECTIONS) {
    if (seen.has(section)) continue;
    // upsert sans mise à jour : deux lectures simultanées gardent la première référence.
    const row = await prisma.clientPortalSeen.upsert({
      where: { clientId_section: { clientId, section } },
      create: { clientId, section, seenAt: now },
      update: {},
    });
    seen.set(section, row.seenAt);
  }
  return Object.fromEntries(PORTAL_SECTIONS.map((s) => [s, seen.get(s)!])) as PortalSeen;
}

export async function markPortalSeen(clientId: string, section: PortalSection, now = new Date()): Promise<void> {
  await prisma.clientPortalSeen.upsert({
    where: { clientId_section: { clientId, section } },
    create: { clientId, section, seenAt: now },
    update: { seenAt: now },
  });
}

const after = (d: Date | null | undefined, ref: Date) => Boolean(d && d.getTime() > ref.getTime());

/** Devis, facture ou avoir émis après la référence (heure d'émission, sinon date du document). */
export function isNewDocument(d: { issuedAt: Date | null; issueDate: Date | null; createdAt: Date }, ref: Date): boolean {
  return after(d.issuedAt ?? d.issueDate ?? d.createdAt, ref);
}

/** Échéance devenue exigible, en retard ou en échec après la référence (dernier changement de l'échéance). */
export function isNewMilestone(m: { status: string; updatedAt: Date }, ref: Date): boolean {
  return (m.status === "DUE" || m.status === "OVERDUE" || m.status === "FAILED") && after(m.updatedAt, ref);
}

/**
 * Entrées de paymentHistory nouvelles : règlement enregistré après la référence (date de saisie, pas la date de
 * paiement, qui peut être antérieure pour un virement) et échéance réglée après la référence.
 */
export function newPaymentEntryIds(
  docs: Array<{ payments: Array<{ id: string; createdAt: Date }> }>,
  milestones: Array<{ id: string; status: string; updatedAt: Date }>,
  ref: Date,
): Set<string> {
  const ids = new Set<string>();
  for (const d of docs) for (const p of d.payments) if (after(p.createdAt, ref)) ids.add(`payment-${p.id}`);
  for (const m of milestones) if (m.status === "PAID" && after(m.updatedAt, ref)) ids.add(`milestone-${m.id}`);
  return ids;
}

/** Projet modifié (étapes, liens, check-list, statut) ou témoignage publié ou refusé après la référence. */
export function isNewProject(
  p: { updatedAt: Date },
  testimonial: { publishedAt: Date | null; rejectedAt: Date | null } | undefined,
  ref: Date,
): boolean {
  return after(p.updatedAt, ref) || after(testimonial?.publishedAt, ref) || after(testimonial?.rejectedAt, ref);
}

export { after as changedAfter };
